/**
 * 全局网络可用性状态（断网防呆）。
 *
 * 为什么要有它：
 * - 会话 Cookie 存在 ≠ 网络可用。断网后 `online_session_status` 仍然返回 loggedIn=true，
 *   底栏会一直挂着绿灯，用户以为能下载，实际每个请求都在 DNS 解析阶段失败。
 * - 所以把「请求层面的失败」提炼成一个全局标志：任一 Find / Detail / Tags / Installed
 *   命中 DNS 失败、传输层错误或超时 → 立刻置 true；下次有请求成功 → 自动清零。
 *
 * v0.4.7 补丁：
 * 1. **失败形态分级**：以前一律显示「网络已断开」，但实际情况可能是
 *    「代理节点挂了」「TLS 被中途掐断」「DNS 解析失败」，用户不知道该修什么。
 *    现在额外记录 `networkFailureKind`，底栏按形态给出可操作提示。
 * 2. **收紧误判**：原兜底正则包含裸的 `连接` / `网络` 两个中文词，
 *    任何含这两个字的后端消息（例如 HTTP 状态错误里恰好提到「网络」）都会被判成断网。
 *    改为只匹配明确的传输层短语。
 *
 * 这个模块只依赖 vue，避免和 sessionState / service 互相 import 形成环。
 */
import { ref } from "vue";

/** true = 最近一次网络请求因网络原因失败（断网 / DNS / 超时） */
export const isNetworkError = ref(false);
/** 最近一次网络失败时间（底栏可用来显示“刚刚断开”） */
export const lastNetworkErrorAt = ref(0);

/**
 * 最近一次网络失败的形态。
 * - `tls`：TCP 已建立但 TLS 握手被中断（对端/中间设备掐断、代理节点不可用）
 * - `dns`：域名解析失败
 * - `timeout`：请求超时
 * - `unreachable`：连接被拒绝 / 不可达
 * - `other`：其他网络类失败
 */
export type NetworkFailureKind = "tls" | "dns" | "timeout" | "unreachable" | "other";

/** null = 还没有发生过网络失败 */
export const networkFailureKind = ref<NetworkFailureKind | null>(null);

/** 视为「网络不可用」的 ApiFailure.kind */
const NETWORK_KINDS = new Set(["network", "timeout", "dns", "offline"]);

/**
 * 兜底文案判断（用来兼容 kind 缺失、或 ureq 直接抛字符串的场景）。
 * 只保留明确的传输层短语：裸的「连接」「网络」会把无关错误也判成断网。
 */
const MESSAGE_HINTS =
  /(dns|lookup|failed to resolve|name or service|timed out|timeout|network is unreachable|connection refused|no route to host|连接被中断|连接被意外中断|连接失败|连接超时|无法解析|无法连接|网络不可用|网络请求失败)/i;

/** 失败形态特征词：命中即归入对应类别，顺序有意义（tls 最具体，先判） */
const TLS_HINTS =
  /(tls|handshake|peer closed|closed connection|unexpected end of file|unexpected eof|certificate|rustls|ssl|握手)/i;
const DNS_HINTS = /(dns|lookup|failed to resolve|name or service|无法解析|解析失败)/i;
const TIMEOUT_HINTS = /(timed out|timeout|超时)/i;
const UNREACHABLE_HINTS =
  /(network is unreachable|connection refused|no route to host|拒绝连接|不可达|连接被拒绝)/i;

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

/** 按错误文本判定失败形态（前端拿不到 Rust 的连接阶段，只能靠特征词） */
function classifyFailure(kind: string, message: string): NetworkFailureKind {
  const lowerKind = kind.toLowerCase();
  if (lowerKind === "timeout") return "timeout";
  if (lowerKind === "dns") return "dns";
  if (TLS_HINTS.test(message)) return "tls";
  if (DNS_HINTS.test(message)) return "dns";
  if (TIMEOUT_HINTS.test(message)) return "timeout";
  if (UNREACHABLE_HINTS.test(message)) return "unreachable";
  return "other";
}

/** 判定一个错误是否属于「网络不可用」 */
export function isNetworkFailure(error: unknown): boolean {
  const { kind, message } = readFailure(error);
  if (NETWORK_KINDS.has(kind.toLowerCase())) return true;
  return MESSAGE_HINTS.test(message);
}

/**
 * 只判定失败形态，不改动全局标志。
 *
 * 给那些不走 `service.tracked()` 的路径用（例如下载队列：它自己决定要不要点亮底栏），
 * 这样「下载失败该提示换节点还是查网络」和底栏用的是同一套判据。
 */
export function classifyNetworkFailure(error: unknown): NetworkFailureKind {
  const { kind, message } = readFailure(error);
  return classifyFailure(kind, message);
}

/** 记录一次请求失败：网络类失败 → 点亮全局断网标志并记下形态 */
export function noteRequestFailure(error: unknown): void {
  if (!isNetworkFailure(error)) return;
  const { kind, message } = readFailure(error);
  isNetworkError.value = true;
  lastNetworkErrorAt.value = Date.now();
  networkFailureKind.value = classifyFailure(kind, message);
}

/** 记录一次请求成功：自动清除断网标志（网络恢复） */
export function noteRequestSuccess(): void {
  if (isNetworkError.value) isNetworkError.value = false;
  if (networkFailureKind.value !== null) networkFailureKind.value = null;
}
