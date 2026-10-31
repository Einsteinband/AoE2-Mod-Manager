/**
 * 全局登录态（底栏 / 在线页 / App 启动共用），v0.6「静默登录」的实现基础。
 *
 * 设计要点：
 * - **绝不阻塞首屏**：`ensureSession()` 永远不 await 在渲染路径上，界面先出、灯后变。
 * - **并发去重**：App 启动、底栏点击、在线页 boot 三处都会调，同一时刻只有一个 invoke。
 * - **单一刷新信号**：每次确认登录态有效就 `sessionEpoch += 1`，
 *   在线页 watch 它做静默刷新，不需要登录成功回调层层往上抛。
 */
import { ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { clearLoginCache, sessionStatus, startupSession } from "./online/service";
import { translate } from "./i18n";
import { translateBackendMessage } from "./format";
import type { SessionStatus } from "./online/types";

export type SessionPhase = "offline" | "checking" | "online";

/** 底栏的灯：checking=🟡 offline=⚪ online=🟢 */
export const sessionPhase = ref<SessionPhase>("checking");
/** 最近一次探测到的完整会话信息（Cookie 数 / 来源 / 错误） */
export const sessionInfo = ref<SessionStatus | null>(null);
export const sessionError = ref<string | null>(null);
/** 登录态确认有效的次数；**只在 离线/校验中 → 在线 这一跳 +1**，在线页 watch 它静默刷新 */
export const sessionEpoch = ref(0);
/**
 * 会话代际（v1.5）：退出登录成功就 +1。
 * 退出前一瞬发出去的探测请求晚一点回来时，代际已变 → 结果一律丢弃，
 * 避免“刚退出、灯又变绿”的横跳，也让进行中的在线请求自然作废。
 */
export const sessionGeneration = ref(0);
/** 用户明确要求重刷列表时 +1（底栏「立即重新校验」成功后推一次） */
export const manualRefreshNonce = ref(0);
/** 底栏中间那行动态提示（“已从缓存加载” / “正在请求网络数据…” 等） */
export const statusMessage = ref("");
export const lastCheckedMs = ref(0);

/** 单次探测上限：超过就当作离线，绝不让界面挂在「检查中」 */
const CHECK_TIMEOUT_MS = 20_000;
/** 启动兜底上限：Rust 侧静默重登自带 25s 预算，这里再宽一点做最后兜底 */
const STARTUP_TIMEOUT_MS = 45_000;
let inflight: Promise<boolean> | null = null;

function describe(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  return translate("labels.unknown");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(translate("statusbar.checkTimeout"))), ms);
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

export function setStatusMessage(text: string): void {
  statusMessage.value = text;
}

/** 用户明确意图：要求在线页重刷（不受自动刷新的 30 秒闸门限制） */
export function requestManualRefresh(): void {
  manualRefreshNonce.value += 1;
}

/** 用户明确意图：打开设置弹窗（在线页「本地索引未开启」的快捷入口用） */
export const openSettingsNonce = ref(0);

export function requestOpenSettings(): void {
  openSettingsNonce.value += 1;
}

/**
 * 在线页本地搜索框开关的**运行时镜像**（真正的持久化在 settings.json 的
 * `enable_local_search`）：App.vue 启动时载入，设置页改完立即写回这里，
 * 在线页（KeepAlive 常驻）靠它即时隐藏/显示搜索框。
 */
export const localSearchEnabled = ref(false);

/**
 * 登录态有效：点亮绿灯。
 *
 * 关键：**只有从未登录/校验中变成在线时才 bump sessionEpoch**。
 * 否则登录轮询（2.5 秒一次）每次都会把整个在线列表重刷一遗，
 * 表现就是“登录后列表疯狂转圈 + 每 2 秒一个 POST /Find”。
 */
export function markOnline(status?: SessionStatus | null): void {
  if (status) {
    sessionInfo.value = status;
    sessionError.value = status.error ?? null;
  }
  const wasOnline = sessionPhase.value === "online";
  sessionPhase.value = "online";
  if (!wasOnline) sessionEpoch.value += 1;
  lastCheckedMs.value = Date.now();
}

/** 未登录 / 探测失败：灯变灰 */
export function markOffline(reason: string | null = null): void {
  sessionPhase.value = "offline";
  sessionError.value = reason;
  lastCheckedMs.value = Date.now();
}

/**
 * 接口明确返回 401：立刻把底栏打回离线。
 * 不能等下一次探测，否则底栏还挂着绿灯、用户点下载才报错。
 */
export function markUnauthenticated(reason: string | null = null): void {
  sessionInfo.value = null;
  markOffline(reason ?? translate("statusbar.sessionExpired"));
}

/**
 * 共用探测器：`ensureSession` 与启动兜底走同一条路径，
 * 保证并发去重、超时、epoch 递增语义完全一致。
 */
function runSessionCheck(
  task: () => Promise<SessionStatus>,
  timeoutMs: number,
  waitingMessage: string,
): Promise<boolean> {
  const generation = sessionGeneration.value;
  sessionPhase.value = "checking";
  statusMessage.value = waitingMessage;

  inflight = (async () => {
    try {
      const status = await withTimeout(task(), timeoutMs);
      // 等结果的这段时间里用户退出了登录：这次结果作废，绝不把灯点回绿色
      if (generation !== sessionGeneration.value) return false;
      sessionInfo.value = status;
      sessionError.value = status.error ?? null;
      lastCheckedMs.value = Date.now();
      if (status.loggedIn) {
        markOnline(status);
        statusMessage.value = translate("statusbar.onlineReady");
        return true;
      }
      markOffline(status.error ?? null);
      statusMessage.value = translate("statusbar.offlineHint");
      return false;
    } catch (e) {
      if (generation !== sessionGeneration.value) return false;
      markOffline(describe(e));
      statusMessage.value = translate("statusbar.offlineHint");
      return false;
    } finally {
      if (generation === sessionGeneration.value) inflight = null;
    }
  })();

  return inflight;
}

/**
 * 退出登录（或后端宣告会话结束）后的**本地状态归零**（v1.5）：
 * - `sessionInfo` 置 null，底栏立刻变 ⚪；
 * - `sessionGeneration` +1 → 所有进行中的探测结果全部作废；
 * - `inflight` 置 null，下一次校验重新计。
 */
export function markLoggedOut(reason: string | null = null): void {
  sessionGeneration.value += 1;
  inflight = null;
  sessionInfo.value = null;
  sessionPhase.value = "offline";
  sessionError.value = reason;
  lastCheckedMs.value = Date.now();
  statusMessage.value = "";
}

/**
 * 退出登录：清本机凭证 + 立刻把前端状态归零。
 *
 * **失败必须如实抛出**：后端会返回“退出登录失败：文件被占用，请重启软件后清理”，
 * 调用方拿到 Err 就必须显示失败，绝不能在失败时也说“已退出登录”。
 */
export async function logoutAndClearSession(): Promise<string> {
  try {
    const text = await clearLoginCache();
    markLoggedOut(null);
    return text;
  } catch (e) {
    const message = describe(e);
    // 清空失败：保持离线态并把真实原因交给调用方显示
    markLoggedOut(message);
    throw new Error(message);
  }
}

/**
 * 后端退出登录 / 中止索引时会广播 `online://index-cancelled`
 * （Rust：`online_index::CANCEL_EVENT`）。不管退出是从哪个入口触发的，
 * 这里都立刻把登录态归零，底栏不会继续挂着绿灯。
 */
void listen("online://index-cancelled", () => {
  markLoggedOut(null);
}).catch(() => undefined);

/**
 * 启动期登录态检查（默认关闭持久登录时的兜底）。
 *
 * 与 `ensureSession` 唯一区别：走 Rust 的 `online_startup_session`，
 * 那边在 `remember_login=false` 且无有效会话时会自己用隐藏窗口跑一次静默重登（≤ 25s）。
 * 同样**不 await 在渲染路径上**，界面先出、底栏文案先显示「正在恢复登录…」。
 */
export function ensureStartupSession(): Promise<boolean> {
  if (inflight) return inflight;
  if (sessionPhase.value === "online") return Promise.resolve(true);
  return runSessionCheck(
    () => startupSession(),
    STARTUP_TIMEOUT_MS,
    translate("statusbar.restoring"),
  );
}

/**
 * 静默校验登录态（复用 Rust 的 `online_session_status`，含 DPAPI 缓存回退）。
 *
 * @param force true = 用户显式要求（点底栏「重新校验」/ 登录轮询），否则在线态直接复用结果
 * @returns 是否已登录
 */
export function ensureSession(force = false): Promise<boolean> {
  if (inflight) return inflight;
  if (!force && sessionPhase.value === "online") return Promise.resolve(true);
  return runSessionCheck(
    () => sessionStatus(),
    CHECK_TIMEOUT_MS,
    translate("statusbar.checking"),
  );
}
