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
import { sessionStatus } from "./online/service";
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
/** 用户明确要求重刷列表时 +1（底栏「立即重新校验」成功后推一次） */
export const manualRefreshNonce = ref(0);
/** 底栏中间那行动态提示（“已从缓存加载” / “正在请求网络数据…” 等） */
export const statusMessage = ref("");
export const lastCheckedMs = ref(0);

/** 单次探测上限：超过就当作离线，绝不让界面挂在「检查中」 */
const CHECK_TIMEOUT_MS = 20_000;
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
 * 静默校验登录态（复用 Rust 的 `online_session_status`，含 DPAPI 缓存回退）。
 *
 * @param force true = 用户显式要求（点底栏「重新校验」/ 登录轮询），否则在线态直接复用结果
 * @returns 是否已登录
 */
export function ensureSession(force = false): Promise<boolean> {
  if (inflight) return inflight;
  if (!force && sessionPhase.value === "online") return Promise.resolve(true);

  sessionPhase.value = "checking";
  statusMessage.value = translate("statusbar.checking");

  inflight = (async () => {
    try {
      const status = await withTimeout(sessionStatus(), CHECK_TIMEOUT_MS);
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
      markOffline(describe(e));
      statusMessage.value = translate("statusbar.offlineHint");
      return false;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
