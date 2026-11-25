/**
 * 会话系统的共享类型定义。
 *
 * 身份状态（SessionAuthState）与登录流程状态（LoginFlowState）彻底分离：
 * - 身份态只回答「当前凭证对服务端是否真实可用」；
 * - 流程态只回答「当前有没有一轮登录流程在跑、跑到哪一步」。
 * 两者允许正交组合，例如 `expired + waitingBrowser` 表示旧凭证已失效、用户正在重新登录。
 */

/** 当前身份是否真正可用（唯一背书标准：只读认证探针 200） */
export type SessionAuthState =
  | "unknown"
  | "anonymous"
  | "authenticated"
  | "expired"
  | "serverError"
  | "networkUnreachable";

/** 当前登录流程所处阶段（与身份态正交，不允许把「正在登录」混进身份态） */
export type LoginFlowState =
  | "idle"
  | "openingWindow"
  | "waitingBrowser"
  | "checking"
  | "success"
  | "failed"
  | "cancelled";

/** 一轮登录流程的来源 */
export type LoginKind = "manual" | "silent" | "startup";

/** 触发登录 / 重登的原因（仅用于日志与文案参数，不参与状态判定） */
export type LoginReason =
  | "manual"
  | "silent"
  | "startup"
  | "unauthorized"
  | "recheck";

/** 本机可用于恢复会话的凭证来源；来源 ≠ 已登录，最终仍必须过真实 API 探针 */
export type CredentialSource = "webview" | "encryptedCache" | "none";

/** Rust `online_session_status` / `online_startup_session` 回传的会话快照（字段对齐既有协议） */
export interface SessionSnapshot {
  loggedIn: boolean;
  cookieCount: number;
  windowReady: boolean;
  storage: string;
  cookieSource: string | null;
  error: string | null;
}

/** 一轮活动登录流程的登记信息；attemptId 用于识别并丢弃旧流程的晚到结果 */
export interface ActiveAttempt {
  id: number;
  generation: number;
  kind: LoginKind;
  reason: string;
  startedAtMs: number;
  cancelled: boolean;
  /** 本轮是否已经完成 success transition：同一 attempt 只能成功一次，幂等保护 */
  succeeded: boolean;
  /** 本轮是否已有一轮认证探针（/Installed）在飞：防止轮询节拍重叠重复提交 */
  verifying: boolean;
}
