/**
 * 在线页的错误文案转写（唯一出处）。
 *
 * 三种输入都要能显示：后端结构化失败（ApiFailure）、普通 Error、字符串。
 * 与本地页共用 `translateBackendMessage`，保证中英两边口径一致。
 */
import { translateBackendMessage } from "../format";
import { translate } from "../i18n";
import { isApiFailure } from "./types";

export function messageOf(e: unknown): string {
  if (isApiFailure(e)) return translateBackendMessage(e.message);
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  return translate("labels.unknown");
}
