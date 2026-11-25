/**
 * 网络 / 代理诊断（与会话登录态正交）。
 *
 * 为什么独立一层：SessionAuthState 表达的是「凭证对服务端是否有效」，
 * LoginFlowState 表达的是「登录窗口走到哪一步」；代理是否存在、官网/API 各自可达、
 * 两条链路是否分叉，都不属于身份态，不能塞进 authenticated/anonymous/expired。
 *
 * 本模块职责：
 * - 唯一发放 diagnosisId / generation，旧一轮晚到结果一律丢弃，不允许覆盖新一轮；
 * - 纯分类器只看 Rust 结构化探针结果，不解析后端错误文案关键词；
 * - 保留 DNS / timeout / refused / TLS 细分类别，不压成笼统「网络不通」；
 * - 每一轮结构化日志落盘（脱敏），最近 N 轮供详情入口查看；
 * - 只在结论真正变化时产出通知决策，相同故障持续不刷屏。
 *
 * 安全边界：只读探测，不读 Cookie、不触发 OAuth、不写 SessionAuthState、
 * 不清缓存、不影响下载队列与模组列表。
 */
import { ref } from "vue";
import { authState, flowState } from "../session/controller";
import { networkDiagnosis as fetchDiagnosis, uiLog } from "./service";
import {
  diagnosisNotify,
  type DiagnosisNotifyRequest,
} from "./diagnosisNotify";
import { applyDiagnosisProxy } from "./proxySourceStore";
import type {
  DiagnosisProbeOutcome,
  DiagnosisProxyOutcome,
  DiagnosisRound,
  DiagnosisTrigger,
  NetworkDiagnosisOutcome,
  ProbeErrorKind,
} from "./types";

/**
 * 诊断结论（粗粒度主分类）：
 * - unknown：尚未诊断，或诊断命令本身失败
 * - healthy：官网与 API 均可达，无代理
 * - systemProxyDetected：两条链路均正常，仅检测到代理（不提示错误）
 * - unauthenticated：API 可达但返回 401，属于认证问题，不是网络问题
 * - officialServerError：官方服务 5xx（或官网 5xx），不是用户网络/代理问题
 * - websiteUnreachable：官网链路失败
 * - apiUnreachable：官网正常但 API 链路失败（非分叉场景兜底）
 * - pathMismatch：Rust 官网探针可达，但 Rust API 探针不可达，两条链路分叉
 *   （注意：这是 Rust/ureq 链路结果，不代表 WebView2 登录页面已可达）
 * - networkUnavailable：两条链路都失败，且证据不足以归咎代理
 * - proxySuspected：存在代理，且失败形态为拒绝/TLS —— 仅间接证据，推测代理嫌疑
 * - proxyFailed：代理服务器直连握手失败的确定性结论（当前无独立代理探针，暂不产出）
 */
export type DiagnosisVerdict =
  | "unknown"
  | "healthy"
  | "systemProxyDetected"
  | "unauthenticated"
  | "officialServerError"
  | "websiteUnreachable"
  | "apiUnreachable"
  | "pathMismatch"
  | "networkUnavailable"
  | "proxySuspected"
  | "proxyFailed";

/** 分类器输出：粗结论 + 保留下来的传输层细分类别 */
export interface DiagnosisClassified {
  verdict: DiagnosisVerdict;
  primaryError: ProbeErrorKind;
}

/** 最近一次诊断结论（模块级单例，供底栏等只读消费） */
export const diagnosisVerdict = ref<DiagnosisVerdict>("unknown");
/** 最近一次诊断的传输层细分类别（DNS / timeout / refused / tls / other） */
export const diagnosisPrimaryError = ref<ProbeErrorKind>(null);
/** 最近一次诊断原始结果（排查用，不在 UI 直接展示技术细节） */
export const diagnosisPayload = ref<NetworkDiagnosisOutcome | null>(null);
/** 诊断是否正在执行 */
export const diagnosisRunning = ref(false);
/** 最近若干轮诊断记录（详情入口只读消费；不含 Cookie / 凭证） */
export const diagnosisRounds = ref<DiagnosisRound[]>([]);

/** 历史轮次保留上限 */
const MAX_ROUNDS = 8;

/** 失败类结论集合：用于判断「故障持续中」与「恢复」通知 */
const FAILURE_VERDICTS: ReadonlySet<DiagnosisVerdict> = new Set([
  "networkUnavailable",
  "proxySuspected",
  "proxyFailed",
  "officialServerError",
  "websiteUnreachable",
  "apiUnreachable",
  "pathMismatch",
]);

// ---------------- 内部单飞 / 代际 ----------------

let generation = 0;
let activeRoundId: string | null = null;

// ---------------- 纯工具函数（可单测） ----------------

function proxyPresent(p: DiagnosisProxyOutcome): boolean {
  return p.proxyUrl !== null || p.enabled || p.envProxyDetected;
}

function transportKind(p: DiagnosisProbeOutcome): ProbeErrorKind {
  const kind = p.errorKind;
  if (kind === "dns" || kind === "timeout" || kind === "refused" || kind === "tls") return kind;
  if (kind === "other") return "other";
  return null;
}

/** 纯分类器：给定探针结果输出诊断结论与细分错误类别。 */
export function classifyDiagnosis(payload: NetworkDiagnosisOutcome): DiagnosisClassified {
  const { website, api, proxy } = payload;

  if (api.category === "unauthenticated") {
    return { verdict: "unauthenticated", primaryError: null };
  }
  if (api.category === "server" || website.category === "server") {
    return { verdict: "officialServerError", primaryError: null };
  }

  const apiNet = api.category === "network";
  const webNet = website.category === "network";

  if (apiNet && webNet) {
    const kind = transportKind(api) ?? transportKind(website) ?? "other";
    // 仅有代理存在 + refused/TLS 形态属于间接证据，不足以证明代理服务器本身不可达；
    // 降级为 proxySuspected（推测）。确定性 proxyFailed 需独立代理握手探针的直接证据。
    const proxySuspectable = proxyPresent(proxy) && (kind === "refused" || kind === "tls");
    return proxySuspectable
      ? { verdict: "proxySuspected", primaryError: kind }
      : { verdict: "networkUnavailable", primaryError: kind };
  }
  if (webNet) {
    return { verdict: "websiteUnreachable", primaryError: transportKind(website) ?? "other" };
  }
  if (apiNet) {
    if (website.category === "ok") {
      return { verdict: "pathMismatch", primaryError: transportKind(api) ?? "other" };
    }
    return { verdict: "apiUnreachable", primaryError: transportKind(api) ?? "other" };
  }
  if (api.category === "ok" && website.category === "ok") {
    return proxyPresent(proxy)
      ? { verdict: "systemProxyDetected", primaryError: null }
      : { verdict: "healthy", primaryError: null };
  }
  return { verdict: "unknown", primaryError: null };
}

/** 传输细分类别 → 短标签 key；无对应细分时返回 null（回落到粗结论文案） */
function probeErrorLabel(kind: ProbeErrorKind): string | null {
  switch (kind) {
    case "dns":
      return "statusbar.diagDns";
    case "timeout":
      return "statusbar.diagTimeout";
    case "refused":
      return "statusbar.diagRefused";
    case "tls":
      return "statusbar.diagTls";
    default:
      return null;
  }
}

/** 分类结果 → 底栏主标签 key；null 表示健康态不覆盖身份/离线文案 */
export function resolveDiagnosisLabelKey(c: DiagnosisClassified): string | null {
  switch (c.verdict) {
    case "healthy":
    case "systemProxyDetected":
      return null;
    case "unauthenticated":
      return "statusbar.diagUnauthenticated";
    case "officialServerError":
      return "statusbar.diagOfficialError";
    case "websiteUnreachable":
      return probeErrorLabel(c.primaryError) ?? "statusbar.diagWebsiteDown";
    case "apiUnreachable":
      return "statusbar.diagApiDown";
    case "pathMismatch":
      return "statusbar.diagPathMismatch";
    case "proxySuspected":
      return "statusbar.diagProxySuspected";
    case "proxyFailed":
      return "statusbar.diagProxyFailed";
    case "networkUnavailable":
      return probeErrorLabel(c.primaryError) ?? "statusbar.diagNetworkUnavailable";
    default:
      return "statusbar.diagUnknown";
  }
}

/**
 * 菜单「最近诊断」详情行文案 key：与底栏主标签解析分离。
 *
 * 底栏对 healthy / systemProxyDetected 返回 null，以保留「已登录」身份文案；
 * 详情行必须给出可读结论，因此健康态映射到各自健康文案，unknown 回退 diagUnknown，
 * 其余故障态复用主标签的真实分类文案，不得统一压成 unknown。
 */
export function resolveDiagnosisDetailLabelKey(c: DiagnosisClassified): string {
  switch (c.verdict) {
    case "healthy":
      return "statusbar.diagHealthy";
    case "systemProxyDetected":
      return "statusbar.diagProxyDetected";
    case "unknown":
      return "statusbar.diagUnknown";
    default:
      return resolveDiagnosisLabelKey(c) ?? "statusbar.diagUnknown";
  }
}

/** 失败通知文案 key（按粗结论 + 细分类别选择） */
function failureToastKey(c: DiagnosisClassified): string {
  switch (c.verdict) {
    case "proxyFailed":
      return "statusbar.toastProxyFailed";
    case "proxySuspected":
      return "statusbar.toastProxySuspected";
    case "websiteUnreachable":
      return probeErrorLabel(c.primaryError)?.replace("diag", "toast") ?? "statusbar.toastWebsiteDown";
    case "apiUnreachable":
      return "statusbar.toastApiDown";
    case "pathMismatch":
      return "statusbar.toastPathMismatch";
    case "officialServerError":
      return "statusbar.toastOfficialError";
    default:
      return probeErrorLabel(c.primaryError)?.replace("diag", "toast") ?? "statusbar.toastNetworkDown";
  }
}

function proxyFactsChanged(a: DiagnosisProxyOutcome | null, b: DiagnosisProxyOutcome | null): boolean {
  if (!a || !b) return false;
  return (
    a.source !== b.source ||
    a.enabled !== b.enabled ||
    a.pacDetected !== b.pacDetected ||
    a.hasExplicitServer !== b.hasExplicitServer ||
    a.envProxyDetected !== b.envProxyDetected
  );
}

export interface DiagnosisNotifyDecision {
  shouldNotify: boolean;
  key: string | null;
  kind: "ok" | "error";
  dedupeKey: string;
}

/**
 * 通知决策：只在重要状态变化时通知。
 * - 相同故障持续：不重复弹；
 * - 故障 → 健康：恢复只弹一次；
 * - 代理事实变化：单独提示；
 * - 401 仅在从非失效态进入时提示。
 */
export function decideNotification(
  prev: DiagnosisVerdict,
  next: DiagnosisClassified,
  prevProxy: DiagnosisProxyOutcome | null,
  nextProxy: DiagnosisProxyOutcome | null,
): DiagnosisNotifyDecision {
  const nextFailure = FAILURE_VERDICTS.has(next.verdict);
  const prevFailure = FAILURE_VERDICTS.has(prev);

  if (next.verdict === "healthy" || next.verdict === "systemProxyDetected") {
    if (prevFailure) {
      return { shouldNotify: true, key: "statusbar.toastNetworkRecovered", kind: "ok", dedupeKey: "recovered" };
    }
    if (proxyFactsChanged(prevProxy, nextProxy)) {
      return { shouldNotify: true, key: "statusbar.toastProxyChanged", kind: "ok", dedupeKey: `proxy:${nextProxy?.source ?? "direct"}` };
    }
    return { shouldNotify: false, key: null, kind: "ok", dedupeKey: "none" };
  }

  if (next.verdict === "unauthenticated") {
    if (prev !== "unauthenticated") {
      return { shouldNotify: true, key: "statusbar.toastSessionExpired", kind: "error", dedupeKey: "unauthenticated" };
    }
    return { shouldNotify: false, key: null, kind: "error", dedupeKey: "unauthenticated" };
  }

  if (nextFailure && !prevFailure) {
    return {
      shouldNotify: true,
      key: failureToastKey(next),
      kind: "error",
      dedupeKey: `${next.verdict}:${next.primaryError ?? "none"}:${nextProxy?.source ?? "direct"}`,
    };
  }
  return {
    shouldNotify: false,
    key: null,
    kind: "error",
    dedupeKey: `${next.verdict}:${next.primaryError ?? "none"}:${nextProxy?.source ?? "direct"}`,
  };
}

// ---------------- 日志脱敏 ----------------

/** 代理地址只保留主机端口元数据；用户名 / 密码 / 认证参数一律抹掉 */
function redactProxyUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "[redacted]";
  }
}

/** 错误串脱敏：去掉 URL query / fragment 与内嵌凭证，避免 Cookie / OAuth 参数落盘 */
function redactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return raw
    .replace(/[?#][^\s"']*/gu, "[redacted-url]")
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@]+@/gu, "[redacted]@");
}

function proxyMeta(p: DiagnosisProxyOutcome): string {
  return [
    `source=${p.source}`,
    `enabled=${p.enabled}`,
    `pac=${p.pacDetected}`,
    `explicit=${p.hasExplicitServer}`,
    `env=${p.envProxyDetected}`,
    `mismatch=${p.pathMismatch}`,
    `webviewFollows=${p.webviewFollowsSystem}`,
    `proxy=${redactProxyUrl(p.proxyUrl) ?? "none"}`,
  ].join(" ");
}

function probeLog(
  roundId: string,
  name: string,
  target: string,
  probe: DiagnosisProbeOutcome,
  proxyPath: string,
): void {
  void uiLog(
    "info",
    `[Diagnosis] probe ${name} id=${roundId} target=${target} reachable=${probe.reachable} ` +
      `status=${probe.status ?? "-"} latencyMs=${probe.latencyMs} category=${probe.category} ` +
      `errorKind=${probe.errorKind ?? "-"} proxyPath=${proxyPath}`,
  );
}

// ---------------- 轮次登记 ----------------

function pushRound(round: DiagnosisRound): void {
  diagnosisRounds.value = [round, ...diagnosisRounds.value].slice(0, MAX_ROUNDS);
}

function markReplaced(roundId: string): void {
  const target = diagnosisRounds.value.find((r) => r.id === roundId);
  if (target) target.replaced = true;
}

// ---------------- 诊断执行（唯一入口） ----------------

/**
 * 跑一轮网络 / 代理诊断。
 *
 * - 每轮自增 generation：旧一轮的晚到结果在写状态前比对 generation，不符则丢弃；
 * - 不修改 SessionAuthState / LoginFlowState，只读取快照写进日志；
 * - 命令失败回 unknown，不清空既有缓存以外的状态，不触碰下载队列。
 */
export async function runNetworkDiagnosis(
  trigger: DiagnosisTrigger = "manual",
): Promise<DiagnosisVerdict> {
  generation += 1;
  const gid = generation;
  const roundId = `${Date.now().toString(36)}-${gid}`;
  const startedAt = Date.now();
  const snapshot = {
    auth: authState.value,
    flow: flowState.value,
    proxy: diagnosisPayload.value?.proxy.source ?? "unknown",
  };

  diagnosisRunning.value = true;
  if (activeRoundId) markReplaced(activeRoundId);
  activeRoundId = roundId;

  const round: DiagnosisRound = {
    id: roundId,
    generation: gid,
    trigger,
    startedAtMs: startedAt,
    finishedAtMs: null,
    authState: snapshot.auth,
    flowState: snapshot.flow,
    proxySource: snapshot.proxy,
    verdict: "unknown",
    primaryError: null,
    labelKey: null,
    payload: null,
    notified: false,
    stale: false,
    replaced: false,
    durationMs: null,
  };

  void uiLog(
    "info",
    `[Diagnosis] start id=${roundId} trigger=${trigger} generation=${gid} ` +
      `auth=${snapshot.auth} flow=${snapshot.flow} proxy=${snapshot.proxy}`,
  );

  const prevVerdict = diagnosisVerdict.value;
  const prevProxy = diagnosisPayload.value?.proxy ?? null;
  let payload: NetworkDiagnosisOutcome | null = null;
  let classified: DiagnosisClassified = { verdict: "unknown", primaryError: null };

  try {
    payload = await fetchDiagnosis();
    if (gid !== generation) {
      round.stale = true;
      round.replaced = true;
      void uiLog("warn", `[Diagnosis] stale result discarded id=${roundId} generation=${gid} current=${generation}`);
      return "unknown";
    }
    classified = classifyDiagnosis(payload);
    round.payload = payload;
    round.proxySource = payload.proxy.source;
    // 诊断成功：把最新链路事实写进独立来源单例；探针可达性结论仍走 verdict，两者不混用
    applyDiagnosisProxy(payload.proxy.source);
    probeLog(roundId, "website", "www.ageofempires.com/mods/", payload.website, payload.proxy.source);
    probeLog(roundId, "api", "api.ageofempires.com/Tags", payload.api, payload.proxy.source);
  } catch (error) {
    if (gid !== generation) {
      round.stale = true;
      void uiLog("warn", `[Diagnosis] stale failure discarded id=${roundId}`);
      return "unknown";
    }
    void uiLog("error", `[Diagnosis] command failed id=${roundId} error=${redactError(error)}`);
  }

  const finishedAt = Date.now();
  round.finishedAtMs = finishedAt;
  round.durationMs = finishedAt - startedAt;
  round.verdict = classified.verdict;
  round.primaryError = classified.primaryError;
  round.labelKey = resolveDiagnosisLabelKey(classified);

  diagnosisPayload.value = payload;
  diagnosisVerdict.value = classified.verdict;
  diagnosisPrimaryError.value = classified.primaryError;

  const decision = decideNotification(prevVerdict, classified, prevProxy, payload?.proxy ?? null);
  round.notified = decision.shouldNotify;
  if (decision.shouldNotify && decision.key) {
    const request: DiagnosisNotifyRequest = {
      key: decision.key,
      kind: decision.kind,
      dedupeKey: decision.dedupeKey,
      generation: gid,
    };
    diagnosisNotify(request);
  }

  void uiLog(
    "info",
    `[Diagnosis] end id=${roundId} trigger=${trigger} verdict=${classified.verdict} ` +
      `primaryError=${classified.primaryError ?? "-"} label=${round.labelKey ?? "-"} prev=${prevVerdict} ` +
      `notified=${decision.shouldNotify} replaced=${round.replaced} durationMs=${round.durationMs}`,
  );
  if (payload) {
    void uiLog("info", `[Diagnosis] proxy id=${roundId} ${proxyMeta(payload.proxy)}`);
  }

  pushRound(round);
  if (gid === generation) diagnosisRunning.value = false;
  return classified.verdict;
}

/** 重置诊断状态（退出登录 / 强边界时调用）：代际 +1 作废在途结果，清空展示态。 */
export function resetDiagnosis(): void {
  generation += 1;
  activeRoundId = null;
  diagnosisVerdict.value = "unknown";
  diagnosisPrimaryError.value = null;
  diagnosisPayload.value = null;
  diagnosisRunning.value = false;
}
