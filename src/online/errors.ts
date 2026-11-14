/**
 * 在线页的错误文案转写（唯一出处）。
 *
 * 三种输入都要能显示：后端结构化失败（ApiFailure）、普通 Error、字符串。
 * 与本地页共用 `translateBackendMessage`，保证中英两边口径一致。
 */
import { translateBackendMessage } from "../format";
import { isApiFailure } from "./types";

/** 提取原始错误串（不翻译），存进 ref，渲染时再 translateBackendMessage。 */
export function rawMessageOf(e: unknown): string {
  if (isApiFailure(e)) return e.message;
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "aoe2mm:err:common.unknownError";
}

/** 即时翻译（事件回调里弹 toast 用，不进 ref）。 */
export function messageOf(e: unknown): string {
  return translateBackendMessage(rawMessageOf(e));
}
