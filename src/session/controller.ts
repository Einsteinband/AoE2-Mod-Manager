/**
 * SessionController：全应用唯一的登录生命周期 Owner。
 *
 * 职责收口：
 * - 身份状态（SessionAuthState）唯一写入方；
 * - 登录流程状态（LoginFlowState）唯一写入方；
 * - manual / silent / startup 三类流程唯一协调方（优先级 manual > silent > startup）；
 * - 登录轮询 / 静默重登定时器唯一持有方；
 * - 登录窗口动作唯一入口（组件不直接调 openLogin / openLoginSilent）；
 * - generation + attemptId 唯一发放与校验方；
 * - 真实只读认证探针唯一调用方。
 *
 * 组件只允许：发起意图（startLogin / logout / recheck）、订阅状态、按状态渲染。
 * 任何旧模块不得再自持登录轮询、登录定时器或直接写 authState。
 */
import { computed, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  clearLoginCache,
  closeLoginWindow,
  installedMods,
  modTags,
  openLogin,
  openLoginSilent,
  sessionStatus,
  startupSession,
} from "../online/service";
import { classifyAuthError } from "../online/sessionVerdict";
import { translate } from "../i18n";
import { translateBackendMessage } from "../format";
import { isNetworkError } from "../online/networkError";
import type {
  ActiveAttempt,
  LoginKind,
  LoginReason,
  LoginFlowState,
  SessionAuthState,
  SessionSnapshot,
} from "./types";
import { sessionLog } from "./log";

// ---------------- 超时 / 节拍常量 ----------------

const CHECK_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 45_000;
const MANUAL_POLL_INTERVAL_MS = 2_500;
const MANUAL_POLL_TRIES = 24;
const SILENT_POLL_INTERVAL_MS = 2_500;
const SILENT_POLL_TRIES = 6;
const NETWORK_PROBE_INTERVAL_MS = 30_000;
/** Rust 账号窗口关闭 / 销毁事件（与 Rust `ACCOUNT_WINDOW_CLOSED_EVENT` 同名） */
const ACCOUNT_WINDOW_CLOSED_EVENT = "online://account-window-closed";
/** 真正清除会话凭证后的失效事件（与索引中止事件 `online://index-cancelled` 分离） */
const SESSION_INVALIDATED_EVENT = "online://session-invalidated";

// ---------------- 身份 / 流程状态（唯一真源） ----------------

/** 精细认证态：只有探针 200 才能进入 authenticated */
export const authState = ref<SessionAuthState>("unknown");
/** 登录流程态：与身份态正交 */
export const flowState = ref<LoginFlowState>("idle");
/** 最近一次 Rust 会话探测快照（Cookie 数 / 来源 / 错误），不等于已登录 */
export const sessionInfo = ref<SessionSnapshot | null>(null);
/** raw 错误串（aoe2mm:err:... 或后端原文），渲染时再翻译 */
const sessionErrorRaw = ref<string | null>(null);
/** 离线 → 在线 跳变计数，在线页 watch 它做统一刷新 */
export const sessionEpoch = ref(0);
/** 会话代际：logout / 生命周期边界 +1，旧任务结果一律作废 */
export const sessionGeneration = ref(0);
export const lastCheckedMs = ref(0);

/** 用户明确要求重刷列表的非ce */
export const manualRefreshNonce = ref(0);
/** 用户明确要求打开设置弹窗的非ce */
export const openSettingsNonce = ref(0);
/** 本地搜索开关运行时镜像（持久化在 settings.json） */
export const localSearchEnabled = ref(false);

type StatusMessageSpec =
  | { kind: "key"; key: string; params?: Record<string, unknown> }
  | { kind: "text"; text: string };
const statusMessageSpec = ref<StatusMessageSpec | null>(null);

export const statusMessage = computed(() => {
  const spec = statusMessageSpec.value;
  if (!spec) return "";
  return spec.kind === "key" ? translate(spec.key, spec.params) : spec.text;
});

export const sessionError = computed(() =>
  sessionErrorRaw.value ? translateBackendMessage(sessionErrorRaw.value) : null,
);

/**
 * 粗粒度阶段灯：由身份态 + 流程态派生，保留既有 `sessionPhase` 闸门语义。
 * - authenticated → online
 * - 流程进行中（opening/waiting/checking）→ checking
 * - 其余 → offline
 */
export const sessionPhase = computed<"offline" | "checking" | "online">(() => {
  if (authState.value === "authenticated") return "online";
  if (
    flowState.value === "openingWindow" ||
    flowState.value === "waitingBrowser" ||
    flowState.value === "checking"
  ) {
    return "checking";
  }
  return "offline";
});

// ---------------- 尝试登记 / 定时器 / 单飞任务 ----------------

let attemptSeq = 0;
const currentAttempt = ref<ActiveAttempt | null>(null);

let pollTimer: number | null = null;
let silentTimer: number | null = null;

let checkInflight: Promise<boolean> | null = null;
let verifyInflight: Promise<boolean> | null = null;
let probeInflight: Promise<boolean> | null = null;
let lastAutoProbeAt = 0;

const subscribers = new Set<() => void>();

// ---------------- 内部工具 ----------------

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "aoe2mm:err:common.unknownError";
}

function errorText(raw: string | null | undefined): string | null {
  return raw ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(translate("statusbar.checkTimeout"))),
      ms,
    );
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

function notify(): void {
  subscribers.forEach((fn) => fn());
}

/** 只读状态快照：身份态 / 流程态 / 代际 / 当前 attempt（测试与观测用，组件不要回写） */
export function getState(): {
  authState: SessionAuthState;
  flowState: LoginFlowState;
  generation: number;
  attemptId: number | null;
  attemptKind: LoginKind | null;
  attemptSucceeded: boolean;
  attemptVerifying: boolean;
} {
  return {
    authState: authState.value,
    flowState: flowState.value,
    generation: sessionGeneration.value,
    attemptId: currentAttempt.value?.id ?? null,
    attemptKind: currentAttempt.value?.kind ?? null,
    attemptSucceeded: currentAttempt.value?.succeeded ?? false,
    attemptVerifying: currentAttempt.value?.verifying ?? false,
  };
}

/** 订阅状态变化；返回取消订阅函数 */
export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function setFlow(next: LoginFlowState, attempt?: ActiveAttempt | null): void {
  const prev = flowState.value;
  flowState.value = next;
  sessionLog("info", `flow ${prev} -> ${next}`, {
    generation: sessionGeneration.value,
    attempt: attempt?.id ?? currentAttempt.value?.id ?? "-",
    kind: attempt?.kind ?? currentAttempt.value?.kind ?? "-",
  });
  notify();
}

/** 该 attempt 是否仍为当前有效流程；不符则记录 warn 并返回 false */
function isLive(attempt: ActiveAttempt): boolean {
  if (attempt.cancelled) return false;
  if (attempt.generation !== sessionGeneration.value) return false;
  return currentAttempt.value?.id === attempt.id;
}

function discardStale(attempt: ActiveAttempt, label: string): boolean {
  if (isLive(attempt)) return false;
  sessionLog("warn", "discard stale result", {
    label,
    attempt: attempt.id,
    currentAttempt: currentAttempt.value?.id ?? "-",
    attemptGeneration: attempt.generation,
    currentGeneration: sessionGeneration.value,
  });
  return true;
}

function clearPollTimer(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function clearSilentTimer(): void {
  if (silentTimer !== null) {
    window.clearInterval(silentTimer);
    silentTimer = null;
  }
}

// ---------------- 身份态写入（唯一入口） ----------------

function markAuthenticated(status: SessionSnapshot | null, attempt?: ActiveAttempt): void {
  if (attempt && discardStale(attempt, "markAuthenticated")) return;
  if (status) {
    sessionInfo.value = status;
    sessionErrorRaw.value = errorText(status.error);
  }
  const alreadyAuthenticated = authState.value === "authenticated";
  authState.value = "authenticated";
  if (!alreadyAuthenticated) {
    sessionLog("info", "auth state -> authenticated", {
      attempt: attempt?.id ?? "-",
      kind: attempt?.kind ?? "-",
      generation: sessionGeneration.value,
    });
    const wasOnline = sessionPhase.value === "online";
    if (!wasOnline) sessionEpoch.value += 1;
  }
  probeNetworkIfNeeded();
  lastCheckedMs.value = Date.now();
  notify();
}

function applyFailure(error: unknown, attempt?: ActiveAttempt): void {
  if (attempt && discardStale(attempt, "applyFailure")) return;
  const reason = describe(error);
  switch (classifyAuthError(error)) {
    case "unauthenticated":
      sessionInfo.value = null;
      authState.value = "expired";
      sessionErrorRaw.value = reason;
      break;
    case "network":
      authState.value = "networkUnreachable";
      sessionErrorRaw.value = reason;
      break;
    case "server":
    case "other":
      authState.value = "serverError";
      sessionErrorRaw.value = reason;
      break;
  }
  sessionLog("info", "auth failure classified", {
    category: classifyAuthError(error),
    authState: authState.value,
    attempt: attempt?.id ?? "-",
  });
  lastCheckedMs.value = Date.now();
  notify();
}

// ---------------- 真实认证探针（只读 API 背书） ----------------

/**
 * 只读认证探针：`online_installed`（/Installed，count=1）需要登录态、零副作用。
 * Cookie / DPAPI / 本地缓存存在都不能背书，必须真实回包 200。
 */
export function verifyAuthenticated(): Promise<boolean> {
  if (verifyInflight) return verifyInflight;
  const generation = sessionGeneration.value;
  const attemptId = currentAttempt.value?.id ?? null;
  const task = installedMods(1, 1)
    .then(() => {
      if (generation !== sessionGeneration.value) return false;
      // 同一代际内旧 attempt 已被新流程抢占：晚到探针不得写回身份态
      if (attemptId !== null && currentAttempt.value?.id !== attemptId) {
        sessionLog("warn", "discard stale verify result", {
          attempt: attemptId,
          currentAttempt: currentAttempt.value?.id ?? "-",
        });
        return false;
      }
      markAuthenticated(sessionInfo.value);
      return true;
    })
    .catch((error: unknown) => {
      if (generation !== sessionGeneration.value) return false;
      if (attemptId !== null && currentAttempt.value?.id !== attemptId) return false;
      applyFailure(error);
      return false;
    })
    .finally(() => {
      verifyInflight = null;
    });
  verifyInflight = task;
  return task;
}

// ---------------- 会话探测 ----------------

/** manual 流程活动期间（openingWindow / waitingBrowser / checking），后台校验探针必须避让：
 *  避免后台 probe 复用 / 导航正在进行 OAuth 的可见登录窗口，也避免旧探针结果回写流程态。 */
function isManualAttemptActive(): boolean {
  return currentAttempt.value?.kind === "manual";
}

function runCheck(
  task: () => Promise<SessionSnapshot>,
  timeoutMs: number,
  waitingKey: string,
): Promise<boolean> {
  const generation = sessionGeneration.value;
  // defense in depth：manual 流程主导期间，后台校验连 checking 流程态都不翻转，
  // 也不发起 sessionStatus / startupSession 探针（入口 ensureSession / ensureStartupSession 已先挡一层）。
  if (isManualAttemptActive()) {
    return Promise.resolve(authState.value === "authenticated");
  }
  setFlow("checking");
  statusMessageSpec.value = { kind: "key", key: waitingKey };

  checkInflight = (async () => {
    try {
      const status = await withTimeout(task(), timeoutMs);
      if (generation !== sessionGeneration.value) return false;
      // 等待回包期间 manual 流程被发起：后台结果不得改写可见登录流程
      if (isManualAttemptActive()) return false;
      sessionInfo.value = status;
      sessionErrorRaw.value = errorText(status.error);
      lastCheckedMs.value = Date.now();
      if (status.loggedIn) {
        const ok = await verifyAuthenticated();
        if (ok) {
          markAuthenticated(status);
          statusMessageSpec.value = { kind: "key", key: "statusbar.onlineReady" };
        }
        return ok;
      }
      authState.value = "anonymous";
      sessionErrorRaw.value = errorText(status.error);
      statusMessageSpec.value = { kind: "key", key: "statusbar.offlineHint" };
      return false;
    } catch (e) {
      if (generation !== sessionGeneration.value) return false;
      applyFailure(e);
      statusMessageSpec.value = { kind: "key", key: "statusbar.offlineHint" };
      return false;
    } finally {
      if (generation === sessionGeneration.value) checkInflight = null;
      notify();
    }
  })();

  return checkInflight;
}

/** 静默校验登录态；force=true 时在线态也重新探测。manual 流程活动期间直接避让。 */
export function ensureSession(force = false): Promise<boolean> {
  if (isManualAttemptActive()) return Promise.resolve(authState.value === "authenticated");
  if (checkInflight) return checkInflight;
  if (!force && authState.value === "authenticated") return Promise.resolve(true);
  return runCheck(() => sessionStatus(), CHECK_TIMEOUT_MS, "statusbar.checking");
}

/** 启动期兜底：remember_login=false 且无有效会话时，Rust 隐藏窗口跑一次静默 SSO。
 *  manual 流程活动期间同样避让，不抢占用户正在进行的登录。 */
export function ensureStartupSession(): Promise<boolean> {
  if (isManualAttemptActive()) return Promise.resolve(authState.value === "authenticated");
  if (checkInflight) return checkInflight;
  if (authState.value === "authenticated") return Promise.resolve(true);
  return runCheck(() => startupSession(), STARTUP_TIMEOUT_MS, "statusbar.restoring");
}

// ---------------- 网络探测（与身份探针分离） ----------------

function probeNetworkIfNeeded(): void {
  if (!isNetworkError.value) return;
  const now = Date.now();
  if (now - lastAutoProbeAt < NETWORK_PROBE_INTERVAL_MS) return;
  lastAutoProbeAt = now;
  void probeNetwork();
}

/** 匿名网络探针（/Tags）：只证明链路可达，不能背书登录态；共享单飞去重 */
export function probeNetwork(): Promise<boolean> {
  if (probeInflight) return probeInflight;
  const task = modTags()
    .then(
      () => true,
      () => false,
    )
    .finally(() => {
      probeInflight = null;
    });
  probeInflight = task;
  return task;
}

// ---------------- 流程登记 / 取消 ----------------

function beginAttempt(kind: LoginKind, reason: string): ActiveAttempt {
  const existing = currentAttempt.value;
  if (existing) cancelAttempt(existing, "preempted");
  attemptSeq += 1;
  const attempt: ActiveAttempt = {
    id: attemptSeq,
    generation: sessionGeneration.value,
    kind,
    reason,
    startedAtMs: Date.now(),
    cancelled: false,
    succeeded: false,
    verifying: false,
  };
  currentAttempt.value = attempt;
  sessionLog("info", "attempt begin", {
    generation: attempt.generation,
    attempt: attempt.id,
    kind,
    reason,
  });
  return attempt;
}

function cancelAttempt(attempt: ActiveAttempt, reason: string): void {
  if (attempt.cancelled) return;
  attempt.cancelled = true;
  if (attempt.kind === "manual") clearPollTimer();
  if (attempt.kind === "silent") clearSilentTimer();
  sessionLog("info", "attempt cancelled", {
    attempt: attempt.id,
    kind: attempt.kind,
    reason,
  });
  if (currentAttempt.value?.id === attempt.id) currentAttempt.value = null;
  notify();
}

function finishAttempt(
  attempt: ActiveAttempt,
  outcome: "success" | "failed" | "cancelled",
  messageKey?: string,
): void {
  if (discardStale(attempt, `finishAttempt:${outcome}`)) return;
  if (attempt.kind === "manual") clearPollTimer();
  if (attempt.kind === "silent") clearSilentTimer();
  currentAttempt.value = null;
  setFlow(outcome === "success" ? "success" : outcome === "cancelled" ? "cancelled" : "failed", attempt);
  if (messageKey) statusMessageSpec.value = { kind: "key", key: messageKey };
  setFlow("idle", attempt);
  sessionLog("info", "attempt finished", { attempt: attempt.id, kind: attempt.kind, outcome });
  notify();
}

/** 只结束当前尝试、不改身份态（成功后关窗、被新一轮流程抢占时用） */
function dismissActiveAttempt(attempt: ActiveAttempt, reason: string): void {
  attempt.cancelled = true;
  if (attempt.kind === "manual") clearPollTimer();
  if (attempt.kind === "silent") clearSilentTimer();
  if (currentAttempt.value?.id === attempt.id) currentAttempt.value = null;
  sessionLog("info", "attempt dismissed", { attempt: attempt.id, kind: attempt.kind, reason });
}

/**
 * 手动登录成功：保留已打开的登录窗口，flowState 停在 success 等待用户关闭。
 * 不调 closeLoginWindow、不立即回 idle；身份态由探针 200 背书为 authenticated。
 */
function finishManualSuccess(attempt: ActiveAttempt): void {
  if (discardStale(attempt, "finishManualSuccess")) return;
  // 幂等：同一 attempt 的 success transition 只能完成一次，避免重叠轮询节拍重复提交副作用
  if (attempt.succeeded) return;
  attempt.succeeded = true;
  clearPollTimer();
  setFlow("success", attempt);
  statusMessageSpec.value = { kind: "key", key: "statusbar.loginSuccess" };
  sessionLog("info", "manual login success: window kept open", {
    attempt: attempt.id,
    kind: attempt.kind,
    authState: authState.value,
  });
  notify();
}

/** 用户在成功提示下手动关闭登录窗口：只关窗、回 idle，保持 authenticated 不变 */
export async function closeLoginAfterSuccess(): Promise<void> {
  const attempt = currentAttempt.value;
  sessionLog("info", "close login window after success", {
    attempt: attempt?.id ?? "-",
    kind: attempt?.kind ?? "-",
    authState: authState.value,
  });
  await closeLoginWindow().catch(() => undefined);
  if (attempt) dismissActiveAttempt(attempt, "user-closed-after-success");
  setFlow("idle");
  statusMessageSpec.value = { kind: "key", key: "statusbar.onlineReady" };
  notify();
}

// ---------------- 手动登录（唯一手动流程入口） ----------------

export function startLogin(reason: LoginReason = "manual"): void {
  if (currentAttempt.value?.kind === "manual") return;
  const attempt = beginAttempt("manual", reason);
  setFlow("openingWindow", attempt);
  statusMessageSpec.value = { kind: "key", key: "statusbar.loginOpening" };

  // 身份态已是 authenticated 时，这只是「重新显示登录窗口」，不得清掉当前有效 AoE Cookie；
  // 其余身份态（anonymous / expired / 网络或服务错误 / unknown）才在开窗前清理旧凭证。
  const purgeCookies = authState.value !== "authenticated";
  sessionLog("info", "manual login intent", {
    attempt: attempt.id,
    reason,
    authState: authState.value,
    purgeCookies,
  });

  void (async () => {
    try {
      await withTimeout(openLogin(purgeCookies), 25_000);
    } catch (e) {
      sessionLog("warn", "open login window failed", { attempt: attempt.id, error: describe(e) });
      finishAttempt(attempt, "failed", "statusbar.loginFailed");
      return;
    }
    if (!isLive(attempt)) return;
    sessionLog("info", "manual login window open; waiting browser sign-in", {
      attempt: attempt.id,
      generation: sessionGeneration.value,
      kind: attempt.kind,
    });
    setFlow("waitingBrowser", attempt);
    statusMessageSpec.value = { kind: "key", key: "statusbar.loginWaitingBrowser" };

    let ticks = 0;
    clearPollTimer();
    pollTimer = window.setInterval(async () => {
      if (!isLive(attempt)) {
        clearPollTimer();
        return;
      }
      if (attempt.succeeded) {
        clearPollTimer();
        return;
      }
      // 上一轮认证探针仍在飞：本节拍直接跳过，避免并发重复提交 success transition
      if (attempt.verifying) return;
      ticks += 1;
      try {
        const status = await withTimeout(sessionStatus(), 15_000);
        if (!status.loggedIn) return;
        attempt.verifying = true;
        setFlow("checking", attempt);
        statusMessageSpec.value = { kind: "key", key: "statusbar.loginVerifying" };
        const ok = await verifyAuthenticated();
        attempt.verifying = false;
        if (!isLive(attempt)) return;
        if (ok) {
          clearPollTimer();
          markAuthenticated(status, attempt);
          finishManualSuccess(attempt);
          return;
        }
        // 有名但探针未过：保留窗口，继续等下一轮
        setFlow("waitingBrowser", attempt);
      } catch (e) {
        attempt.verifying = false;
        sessionLog("info", "manual poll tick did not finish", {
          attempt: attempt.id,
          error: describe(e),
        });
      }
      if (ticks >= MANUAL_POLL_TRIES) {
        finishAttempt(attempt, "failed", "statusbar.loginTimeout");
      }
    }, MANUAL_POLL_INTERVAL_MS);
  })();
}

/** 用户主动取消等待：停轮询、隐藏窗口、流程回 idle */
export function cancelLogin(reason = "user-cancelled"): void {
  const attempt = currentAttempt.value;
  if (!attempt) return;
  cancelAttempt(attempt, reason);
  void closeLoginWindow().catch(() => undefined);
  setFlow("idle", attempt);
  notify();
}

// ---------------- 静默重登（唯一静默流程入口） ----------------

const silentNoteState = ref<{ key: string; params?: Record<string, unknown> } | null>(null);
export const silentActive = computed(() => currentAttempt.value?.kind === "silent");
export const manualActive = computed(() => currentAttempt.value?.kind === "manual");
export const silentNote = computed(() => {
  const spec = silentNoteState.value;
  return spec ? translate(spec.key, spec.params) : "";
});

export function startSilentReauth(reason: string): void {
  if (currentAttempt.value?.kind === "manual") return;
  if (currentAttempt.value?.kind === "silent") return;
  const attempt = beginAttempt("silent", reason);
  silentNoteState.value = { key: "online.silentNote", params: { reason } };

  void (async () => {
    try {
      await withTimeout(openLoginSilent(), 15_000);
    } catch (e) {
      sessionLog("warn", "silent open window failed", { attempt: attempt.id, error: describe(e) });
      silentNoteState.value = { key: "online.silentFailedStart", params: { msg: describe(e) } };
      finishAttempt(attempt, "failed");
      return;
    }
    if (!isLive(attempt)) return;

    let ticks = 0;
    clearSilentTimer();
    silentTimer = window.setInterval(async () => {
      if (!isLive(attempt)) {
        clearSilentTimer();
        return;
      }
      if (attempt.succeeded || attempt.verifying) return;
      ticks += 1;
      try {
        const status = await withTimeout(sessionStatus(), 15_000);
        if (status.loggedIn) {
          attempt.verifying = true;
          const authed = await verifyAuthenticated();
          attempt.verifying = false;
          if (!isLive(attempt)) return;
          if (authed) {
            attempt.succeeded = true;
            clearSilentTimer();
            await closeLoginWindow();
            markAuthenticated(status, attempt);
            silentNoteState.value = null;
            finishAttempt(attempt, "success", "statusbar.loginDone");
            return;
          }
        }
      } catch (e) {
        attempt.verifying = false;
        sessionLog("info", "silent poll tick did not finish", {
          attempt: attempt.id,
          error: describe(e),
        });
      }
      if (ticks >= SILENT_POLL_TRIES) {
        silentNoteState.value = { key: "online.silentFailed" };
        finishAttempt(attempt, "failed");
      }
    }, SILENT_POLL_INTERVAL_MS);
  })();
}

// ---------------- 401 / 错误统一入口 ----------------

/**
 * 所有业务模块的认证失败统一走这里：分类 → 身份态 → 按策略触发静默恢复。
 * 下载队列 / 列表 / 详情 / 探针不得各自维护认证状态。
 */
export function handleAuthFailure(error: unknown, message?: string): void {
  applyFailure(error);
  if (message) sessionErrorRaw.value = message;
  if (classifyAuthError(error) === "unauthenticated") {
    // manual 流程活动期间不打断用户操作；其余情况尝试一次静默恢复
    if (currentAttempt.value?.kind !== "manual") {
      startSilentReauth(translate("online.reasonUnauthorized"));
    }
  }
  sessionLog("info", "auth failure handled", {
    kind: classifyAuthError(error),
    authState: authState.value,
  });
  notify();
}

// ---------------- Logout 强边界 ----------------

function markLoggedOut(reason: string | null): void {
  currentAttempt.value = null;
  clearPollTimer();
  clearSilentTimer();
  sessionInfo.value = null;
  authState.value = "anonymous";
  flowState.value = "idle";
  sessionErrorRaw.value = reason;
  statusMessageSpec.value = null;
  silentNoteState.value = null;
  lastCheckedMs.value = Date.now();
  notify();
}

/**
 * 退出登录：终止整个当前 Session 生命周期。
 * 顺序：取消当前 attempt → 停 timer → 推进 generation → 作废旧任务 → 清凭证 → 状态复位 → 广播。
 */
export async function logout(): Promise<string> {
  sessionLog("info", "logout requested");
  sessionGeneration.value += 1;

  const active = currentAttempt.value;
  if (active) cancelAttempt(active, "logout");
  clearPollTimer();
  clearSilentTimer();
  checkInflight = null;
  verifyInflight = null;
  probeInflight = null;

  try {
    const text = await clearLoginCache();
    markLoggedOut(null);
    sessionLog("info", "credentials cleared; authState=anonymous flowState=idle", {
      generation: sessionGeneration.value,
    });
    return text;
  } catch (e) {
    const message = describe(e);
    markLoggedOut(message);
    sessionLog("error", "logout clear failed", { error: message });
    throw new Error(message);
  }
}

// ---------------- 提示 / 非ce 工具 ----------------

export function setStatusMessage(text: string): void {
  statusMessageSpec.value = text ? { kind: "text", text } : null;
  notify();
}

export function setStatusMessageKey(key: string, params?: Record<string, unknown>): void {
  statusMessageSpec.value = { kind: "key", key, params };
  notify();
}

export function clearStatusMessage(): void {
  statusMessageSpec.value = null;
}

export function requestManualRefresh(): void {
  manualRefreshNonce.value += 1;
}

export function requestOpenSettings(): void {
  openSettingsNonce.value += 1;
}

// ---------------- 跨端事件订阅（唯一注册点） ----------------

let unlistenInvalidated: UnlistenFn | null = null;
let unlistenClosed: UnlistenFn | null = null;

/** 账号窗口被用户关闭 / 程序销毁：结束当前等待中的登录尝试，不改身份态 */
function onAccountWindowClosed(payload: unknown): void {
  const reason =
    payload && typeof payload === "object"
      ? String((payload as { reason?: unknown }).reason ?? "unknown")
      : "unknown";
  sessionLog("info", "account window closed", {
    reason,
    flowState: flowState.value,
    authState: authState.value,
  });
  const attempt = currentAttempt.value;
  if (!attempt) return;
  if (flowState.value === "success") {
    // 成功后用户手动关窗：保持 authenticated，只把流程收回 idle。
    dismissActiveAttempt(attempt, `window-${reason}`);
    setFlow("idle", attempt);
    return;
  }
  if (flowState.value === "openingWindow" || flowState.value === "waitingBrowser") {
    cancelAttempt(attempt, `window-${reason}`);
    setFlow("idle", attempt);
  }
}

/** 真正会话失效（退出登录清凭证）：代际 +1 并复位身份态。索引中止事件不进这里。 */
function onSessionInvalidated(payload: unknown): void {
  const detail =
    payload && typeof payload === "object"
      ? String((payload as { reason?: unknown }).reason ?? "invalidated")
      : "invalidated";
  sessionLog("info", "session invalidated event", { detail, authState: authState.value });
  sessionGeneration.value += 1;
  markLoggedOut(null);
}

function registerEvents(): void {
  if (unlistenInvalidated || unlistenClosed) return;
  void listen(SESSION_INVALIDATED_EVENT, (e) => onSessionInvalidated(e.payload))
    .then((unlisten) => {
      unlistenInvalidated = unlisten;
    })
    .catch(() => undefined);
  void listen(ACCOUNT_WINDOW_CLOSED_EVENT, (e) => onAccountWindowClosed(e.payload))
    .then((unlisten) => {
      unlistenClosed = unlisten;
    })
    .catch(() => undefined);
}

registerEvents();
