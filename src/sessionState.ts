/**
 * 兼容 Façade：登录生命周期的唯一 Owner 已迁移到 `src/session/controller.ts`。
 *
 * 本文件只做转发与再导出，保留既有 import 路径，避免分散在各组件的引用面大范围改动。
 * 新代码请直接从 `./session/controller` 取状态与动作；本文件内不得再写独立轮询 / 定时器 / 状态判定。
 */
export {
  authState,
  flowState,
  sessionInfo,
  sessionError,
  sessionEpoch,
  sessionGeneration,
  lastCheckedMs,
  statusMessage,
  sessionPhase,
  manualRefreshNonce,
  openSettingsNonce,
  localSearchEnabled,
  ensureSession,
  ensureStartupSession,
  verifyAuthenticated,
  probeNetwork,
  logout,
  logout as logoutAndClearSession,
  startLogin,
  cancelLogin,
  closeLoginAfterSuccess,
  startSilentReauth,
  handleAuthFailure,
  setStatusMessage,
  setStatusMessageKey,
  clearStatusMessage,
  requestManualRefresh,
  requestOpenSettings,
  silentActive,
  manualActive,
  silentNote,
} from "./session/controller";

export {
  type SessionAuthState,
  type LoginFlowState,
  type LoginKind,
  type LoginReason,
  type SessionSnapshot,
} from "./session/types";

