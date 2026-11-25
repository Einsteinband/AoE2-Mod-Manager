/**
 * 会话 / 认证错误的统一分类。
 *
 * 为什么单独一层：旧实现里列表（useOnlineList）、下载队列（downloadQueue）、
 * 索引同步（indexStatusStore）各自判断 `kind === "unauthenticated"`，索引层甚至用
 * 正则匹配中文 raw 串，口径互相漂移。这里把「401 凭证失效 / 网络不可达 / 服务端错误 /
 * 其他」收敛成唯一判据，三个调用方只消费分类结果，不再各写一套。
 *
 * 分类只看结构化失败（ApiFailure.kind / status）与 networkError 既有判据，
 * 不解析后端错误文案里的中文关键词。
 */
import { isApiFailure } from "./types";
import { isNetworkFailure } from "./networkError";

/**
 * - `unauthenticated`：401，本地凭证对服务端已无效，必须回到未登录 / 重新登录
 * - `network`：DNS / TLS / 超时 / 连接拒绝等传输层失败，与登录态无关
 * - `server`：服务端 5xx 或其他 HTTP 错误，凭证未必失效，只是当前不可用
 * - `other`：解析失败 / 404 / 未归类错误
 */
export type AuthClass = "unauthenticated" | "network" | "server" | "other";

const NETWORK_KINDS = new Set(["network", "timeout", "dns", "offline"]);

export function classifyAuthError(error: unknown): AuthClass {
  if (isApiFailure(error)) {
    if (error.kind === "unauthenticated" || error.status === 401) return "unauthenticated";
    if (NETWORK_KINDS.has(error.kind)) return "network";
    const status = error.status;
    if (typeof status === "number" && status >= 500) return "server";
    if (error.kind === "http") return "server";
    if (error.kind === "not_found") return "other";
    return "other";
  }
  if (isNetworkFailure(error)) return "network";
  return "other";
}

/** 是否为凭证失效（401） */
export function isUnauthenticatedError(error: unknown): boolean {
  return classifyAuthError(error) === "unauthenticated";
}
