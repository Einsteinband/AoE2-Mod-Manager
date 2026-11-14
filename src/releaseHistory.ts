/**
 * 内置更新历史（设置 → 关于 → 更新历史）
 *
 * 数据源是仓库根目录的 `RELEASE_NOTES.md`：构建时由 Vite 以 `?raw` 方式把整份文件
 * 打进前端产物，运行期只做纯字符串解析，不发送任何网络请求。因此断网、GitHub
 * 不可达、API 限流都不会再让「更新历史」空掉或报错。
 *
 * 文件格式（由 scripts/changelog/build-archive.mjs 生成，手工新增版本也必须照此写）：
 *
 *   # v0.5.2 — 2026-11-14
 *
 *   <正文 Markdown>
 *
 *   ---
 *
 *   # v0.2.0 — 2026-10-29 — v0.2.0 - Drag & Drop Sorting & Update Checker
 *
 * 头部三段：`tag`、发布日期（`YYYY-MM-DD`，发布者本地日历日，直接展示不再做时区换算）、
 * 可选的 Release 标题（只有和 tag 不同时才写）。正文与正文之间的 `---` 是分隔线，不进正文。
 *
 * 将来发版：在文件顶部追加一节（含日期），然后照常打包。发布到 GitHub 时仍用
 * `--notes-file`，正文会在创建后用 `gh release edit` 收窄为当前版本（见 DECISIONS D067）。
 */
import releaseNotesRaw from "../RELEASE_NOTES.md?raw";

export interface ReleaseHistoryEntry {
  /** 原始 tag，如 v0.5.2 */
  tagName: string;
  /** 去掉 v 前缀的版本号，如 0.5.2 */
  version: string;
  /** Release 标题（没有单独标题时等于 tagName） */
  name: string;
  /** 发布日期 `YYYY-MM-DD`；格式不合规时为空串 */
  publishedAt: string;
  /** 更新说明 Markdown 原文（可能为空） */
  body: string;
}

/** 版本头部：`# v0.5.2 — 2026-11-14 [— 标题]`（破折号必须是 U+2014，两侧各一个空格） */
const ENTRY_HEAD = /^#\s+v(\d+(?:\.\d+)*)\s+—\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+?))?\s*$/;

/** 只保留真正的内容行：结尾的分隔线与空行都不属于正文 */
function trimBody(lines: string[]): string {
  const copy = [...lines];
  while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
  if (copy.length && copy[copy.length - 1].trim() === "---") copy.pop();
  while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
  while (copy.length && !copy[0].trim()) copy.shift();
  return copy.join("\n");
}

/**
 * 解析整份更新记录。没有条目时返回空数组（「关于」页据此显示空状态）。
 * 同一日期内保持文件顺序（文件本身就是从新到旧手写的）。
 */
export function parseReleaseHistory(raw: string): ReleaseHistoryEntry[] {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n");
  const entries: ReleaseHistoryEntry[] = [];
  let current: ReleaseHistoryEntry | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (!current) return;
    entries.push({ ...current, body: trimBody(bodyLines) });
    bodyLines = [];
  };

  for (const line of lines) {
    const head = line.match(ENTRY_HEAD);
    if (head) {
      flush();
      const tagName = `v${head[1]}`;
      current = {
        tagName,
        version: head[1],
        name: head[3]?.trim() || tagName,
        publishedAt: head[2],
        body: "",
      };
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();

  // 文件按从新到旧维护；这里再按日期兜底排序，写错顺序也不会让历史倒着显示
  return entries.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** 随软件构建、安装的更新历史；「关于」页直接读它，不触网 */
export const releaseHistory: ReleaseHistoryEntry[] = parseReleaseHistory(releaseNotesRaw);
