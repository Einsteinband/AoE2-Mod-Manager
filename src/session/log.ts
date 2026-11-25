/**
 * 会话生命周期日志。
 *
 * 每一条 attempt 日志都带 generation / attemptId / reason / 阶段迁移，
 * stale callback 被丢弃时打 warn，便于定位是哪一个旧任务污染了状态。
 * 敏感信息（OAuth code / state / nonce、Cookie value）一律不进日志。
 */
import { uiLog } from "../online/service";

type LogLevel = "info" | "warn" | "error";

/** 把 URL 里的 query / fragment 整体抹掉（OAuth 回跳带 code/state/nonce，禁止落盘） */
export function redactUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.replace(/[?#].*$/u, "");
  }
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return parts ? ` ${parts}` : "";
}

export function sessionLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  void uiLog(level, `[Session] ${message}${formatFields(fields)}`);
}
