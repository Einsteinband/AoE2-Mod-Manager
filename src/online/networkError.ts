/**
 * 全局网络可用性状态（断网防呆）。
 *
 * 为什么要有它：
 * - 会话 Cookie 存在 ≠ 网络可用。断网后 `online_session_status` 仍然返回 loggedIn=true，
 *   底栏会一直挂着绿灯，用户以为能下载，实际每个请求都在 DNS 解析阶段失败。
 * - 所以把「请求层面的失败」提炼成一个全局标志：任一 Find / Detail / Tags / Installed
 *   命中 DNS 失败、传输层错误或超时 → 立刻置 true；下次有请求成功 → 自动清零。
 *
 * 这个模块只依赖 vue，避免和 sessionState / service 互相 import 形成环。
 */
import { ref } from "vue";

/** true = 最近一次网络请求因网络原因失败（断网 / DNS / 超时） */
export const isNetworkError = ref(false);
/** 最近一次网络失败时间（底栏可用来显示“刚刚断开”） */
export const lastNetworkErrorAt = ref(0);

/** 视为「网络不可用」的 ApiFailure.kind */
const NETWORK_KINDS = new Set(["network", "timeout", "dns", "offline"]);

/** 兜底文案判断（用来兼容 kind 缺失、或 ureq 直接抛字符串的场景） */
const MESSAGE_HINTS =
  /(dns|lookup|failed to resolve|name or service|timed out|timeout|network is unreachable|connection refused|连接|无法解析|网络)/i;

interface FailureLike {
  kind?: unknown;
  message?: unknown;
}

function readFailure(error: unknown): { kind: string; message: string } {
  if (typeof error === "string") return { kind: "", message: error };
  if (error && typeof error === "object") {
    const value = error as FailureLike;
    return {
      kind: typeof value.kind === "string" ? value.kind : "",
      message:
        typeof value.message === "string"
          ? value.message
          : error instanceof Error
            ? error.message
            : "",
    };
  }
  return { kind: "", message: "" };
}

/** 判定一个错误是否属于「网络不可用」 */
export function isNetworkFailure(error: unknown): boolean {
  const { kind, message } = readFailure(error);
  if (NETWORK_KINDS.has(kind.toLowerCase())) return true;
  return MESSAGE_HINTS.test(message);
}

/** 记录一次请求失败：网络类失败 → 点亮全局断网标志 */
export function noteRequestFailure(error: unknown): void {
  if (!isNetworkFailure(error)) return;
  isNetworkError.value = true;
  lastNetworkErrorAt.value = Date.now();
}

/** 记录一次请求成功：自动清除断网标志（网络恢复） */
export function noteRequestSuccess(): void {
  if (isNetworkError.value) isNetworkError.value = false;
}
