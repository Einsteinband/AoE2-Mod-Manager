#!/usr/bin/env node
/**
 * 把 GitHub Releases 导出（JSON）整理成仓库内唯一更新记录 RELEASE_NOTES.md。
 *
 * 用法：
 *   gh api 'repos/Einsteinband/AoE2-Mod-Manager/releases?per_page=100' > releases.json
 *   node scripts/changelog/build-archive.mjs releases.json [RELEASE_NOTES.md]
 *
 * 为什么存在：设置 → 关于的「更新历史」改为读取随包构建的本地记录（src/releaseHistory.ts），
 * 而历史上 RELEASE_NOTES.md 只保留了最近几个版本、也没有日期，无法直接作为内置数据源。
 * 这个脚本只做一次性归档（以及日后补历史用）；日常发版仍是「在文件顶部加一节」，
 * 不需要重新跑它。
 *
 * 归档格式（src/releaseHistory.ts 按此解析，改动必须同步解析器与测试）：
 *
 *   # v0.5.2 — 2026-11-14
 *
 *   <正文，原样保留 GitHub Release 的 Markdown>
 *
 *   ---
 *
 *   # v0.2.0 — 2026-10-29 — v0.2.0 - Drag & Drop Sorting & Update Checker
 *
 * 头部三段：tag、发布日期（发布者本地日历日）、可选的 Release 标题。
 * 标题只在和 tag 不同的时候才写第三段。
 */
import fs from "node:fs";

const [, , jsonPath, outPath] = process.argv;
if (!jsonPath) {
  console.error("用法：node scripts/changelog/build-archive.mjs <releases.json> [RELEASE_NOTES.md]");
  process.exit(1);
}

const releases = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
if (!Array.isArray(releases) || releases.length === 0) {
  console.error("输入不是 Release 数组");
  process.exit(1);
}

/** ISO 时间 → 发布者本地日历日 YYYY-MM-DD（与用户在「关于」里看到的日期口径一致） */
function localDate(iso) {
  const ts = Date.parse(String(iso ?? ""));
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 正文规范化：统一换行、去掉与自身 tag 重复的首个 H1、裁掉首尾空行与结尾分隔线 */
function normalizeBody(body, tag) {
  const lines = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && lines[0].trim().toLowerCase() === `# ${tag}`.toLowerCase()) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && lines[lines.length - 1].trim() === "---") lines.pop();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

const entries = [];
for (const release of releases) {
  const tag = String(release.tag_name ?? "").trim();
  if (!tag) continue;
  const date = localDate(release.published_at);
  if (!date) {
    console.error(`跳过没有发布时间的版本：${tag}`);
    continue;
  }
  const rawName = String(release.name ?? "").trim();
  const namePart = rawName && rawName !== tag ? ` — ${rawName}` : "";
  const body = normalizeBody(release.body, tag);
  entries.push(`# ${tag} — ${date}${namePart}\n\n${body ? `${body}\n\n` : ""}---\n`);
}

const text = `${entries.join("\n")}`.trimEnd() + "\n";
const target = outPath ?? "RELEASE_NOTES.md";
fs.writeFileSync(target, text, "utf8");
console.log(`已写入 ${target}：${entries.length} 个版本，${text.length} 字符`);
