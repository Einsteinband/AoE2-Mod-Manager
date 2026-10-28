import { i18n, translate } from "./i18n";
import type { ModSource } from "./types";

/**
 * 后端报错的多语言兜底：Rust 侧消息仍是中文，英文界面下按关键词转写。
 * 不重构后端命令，遇到未知报错时**原样返回原文**，绝不吞掉信息。
 */
const BACKEND_PATTERNS: [RegExp, string][] = [
  [/^路径不存在[:：]\s*(.+)$/, "Path does not exist: $1"],
  [/^该路径不是文件夹[:：]\s*(.+)$/, "Not a folder: $1"],
  [/没有 local 或 subscribed 子目录/, "No local/ or subscribed/ subfolder here — this is not an AoE2DE mod root folder."],
  [/尚未设置.*根目录/, "No mod root folder configured yet."],
  [/游戏正在运行|请先关闭游戏|游戏启动中/, "The game is running — please close it first."],
  [/没有该模组的记录/, "No record of this mod in mod-status.json (launch the game once so it registers)."],
  [/文件夹为空/, "The mod folder is empty."],
  [/无法创建解压目录|解压失败/, "Could not extract the archive."],
  [/写入失败/, "Write failed."],
  [/备份失败/, "Backup failed."],
  [/校验失败|回读失败|回读校验/, "Verification after writing failed."],
  [/拒绝访问|权限不足|无权访问/, "Access denied."],
  [/不在模组根目录内/, "Refused: the target path is outside the mod root folder."],
  [/无法读取|读取失败/, "Read failed."],
  [/无法创建|创建目录失败/, "Could not create the folder."],
  [/无法删除|删除失败/, "Delete failed."],
  [/下载失败|下载中断/, "Download failed."],
  [/网络|连接失败|代理/, "Network problem."],
  [/超时/, "Timed out."],
  [/未知错误/, "Unknown error."],
];

export function translateBackendMessage(message: string | null | undefined): string {
  const raw = (message ?? "").toString();
  if (!raw.trim()) return raw;
  // 中文界面：后端本来就是中文，原样返回；其余语言统一转为英文（以后加其它语言时也不会出现中文裸文）
  if (i18n.global.locale.value === "zh") return raw;
  for (const [pattern, english] of BACKEND_PATTERNS) {
    if (pattern.test(raw)) return raw.replace(pattern, english);
  }
  return raw;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(ms: number | null): string {
  if (!ms || ms <= 0) return translate("labels.notProvided");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return translate("labels.notProvided");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function kindLabel(kind: string): string {
  if (kind === "local") return translate("labels.kindLocal");
  if (kind === "subscribed") return translate("labels.kindSubscribed");
  return kind;
}

export function statusLabel(enabled: boolean | null): string {
  if (enabled === true) return translate("labels.statusEnabled");
  if (enabled === false) return translate("labels.statusDisabled");
  return translate("labels.statusUnknown");
}

/** 来源徽章的文案（唯一出处，卡片与详情共用） */
export function sourceLabel(source: ModSource | undefined): string {
  if (source === "tool") return translate("labels.sourceTool");
  if (source === "official") return translate("labels.sourceOfficial");
  return translate("labels.sourceUnknown");
}

/** 徽章的悬停解释：把判定依据说清楚，不靠用户猜 */
export function sourceHint(source: ModSource | undefined): string {
  if (source === "tool") return translate("labels.sourceToolHint");
  if (source === "official") return translate("labels.sourceOfficialHint");
  return translate("labels.sourceUnknownHint");
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0] ?? "?";
  return first.toUpperCase();
}
