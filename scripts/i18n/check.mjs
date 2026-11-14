#!/usr/bin/env node
/**
 * 多语言一致性检查 CLI（T1–T4）
 *
 * 用法：
 *   npm run check:i18n            # 常规输出
 *   npm run check:i18n -- --verbose   # 输出全部问题明细
 *
 * 退出码：0 = 通过；1 = 存在必须修复的硬性问题（缺失 key / 占位符不一致 /
 * 无效引用 / Rust 错误码缺译文）。静态盲区与待人工确认项只打印，不计失败。
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadLocaleModule,
  flattenLeaves,
  checkKeyParity,
  checkPlaceholders,
  collectReferences,
  validateReferences,
  collectRustFacts,
  collectFrontendProtocolCodes,
  checkRustCoverage,
  checkVariableWhitelist,
} from "./i18n-checks.mjs";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const ROOT = rootArg ? path.resolve(rootArg.slice("--root=".length)) : process.cwd();
const VERBOSE = process.argv.includes("--verbose");
const MAX_ITEMS = VERBOSE ? Infinity : 20;

const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join("/");
const fail = [];
const note = [];

function walk(dir, exts, options = {}) {
  const { skipDirs = [] } = options;
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      out.push(...walk(full, exts, options));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function readSource(file) {
  return { path: rel(file), content: fs.readFileSync(file, "utf8") };
}

function head(title) {
  console.log(`\n[${title}]`);
}

function pass() {
  console.log("  ✅ PASS");
}

function failed(count) {
  console.log(`  ❌ FAIL — ${count} 处问题`);
}

function printList(items, format) {
  for (const item of items.slice(0, MAX_ITEMS)) console.log(`    - ${format(item)}`);
  if (items.length > MAX_ITEMS) console.log(`    … 其余 ${items.length - MAX_ITEMS} 条见 --verbose`);
}

/* ------------------------------------------------------------------ *
 * 载入语言包
 * ------------------------------------------------------------------ */

const localeDir = path.join(ROOT, "src/i18n/locales");
if (!fs.existsSync(localeDir)) {
  console.error(`找不到语言包目录：${rel(localeDir)}`);
  process.exit(1);
}

const localeFiles = fs
  .readdirSync(localeDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
  .sort();

const locales = localeFiles.map((name) => {
  const code = name.replace(/\.ts$/, "");
  const abs = path.join(localeDir, name);
  const { label, tree } = loadLocaleModule(abs);
  return { code, label, file: rel(abs), tree, leaves: flattenLeaves(tree) };
});

if (locales.length < 2) {
  console.error(`语言包数量不足（${locales.length}），无法做一致性比较`);
  process.exit(1);
}

const ref = locales.find((locale) => locale.code === "en") ?? locales[0];
const others = locales.filter((locale) => locale.code !== ref.code);
const namespaces = Object.keys(ref.tree);

console.log("=== 多语言一致性检查（T1–T4） ===");
console.log(`基准语言：${ref.code}（${ref.label}）｜语言包：${locales.map((l) => l.code).join(", ")}`);

/* ------------------------------------------------------------------ *
 * T1 key 完整性
 * ------------------------------------------------------------------ */

head("T1 语言包 key 完整性");
for (const locale of locales) {
  console.log(`  ${locale.code}: ${Object.keys(locale.leaves).length} 个叶 key（${locale.file}）`);
}

const parity = checkKeyParity(ref.code, ref.tree, others.map(({ code, tree }) => ({ code, tree })));
const t1Count = parity.missing.length + parity.extra.length + parity.typeMismatch.length;
if (parity.missing.length) {
  console.log(`  缺失 key：${parity.missing.length}`);
  printList(parity.missing, (i) => `${i.locale}: ${i.key}`);
}
if (parity.extra.length) {
  console.log(`  多余 key：${parity.extra.length}`);
  printList(parity.extra, (i) => `${i.locale}: ${i.key}`);
}
if (parity.typeMismatch.length) {
  console.log(`  结构类型不一致：${parity.typeMismatch.length}`);
  printList(parity.typeMismatch, (i) => `${i.locale}: ${i.key}（基准 ${i.ref} / 实际 ${i.actual}）`);
}
if (t1Count === 0) pass();
else {
  failed(t1Count);
  fail.push(`T1 发现 ${t1Count} 处 key 不一致`);
}

/* ------------------------------------------------------------------ *
 * T2 占位符一致性
 * ------------------------------------------------------------------ */

head("T2 动态参数一致性");
const placeholder = checkPlaceholders(
  ref.code,
  ref.leaves,
  others.map(({ code, leaves }) => ({ code, leaves })),
);
const comparedPairs = Object.keys(ref.leaves).length * others.length;
console.log(`  比较 ${comparedPairs} 组（${Object.keys(ref.leaves).length} key × ${others.length} 语言）`);
if (placeholder.mismatches.length) {
  console.log(`  占位符不一致：${placeholder.mismatches.length}`);
  printList(placeholder.mismatches, (i) => {
    const parts = [];
    if (i.missing.length) parts.push(`缺 ${i.missing.join(",")}`);
    if (i.extra.length) parts.push(`多 ${i.extra.join(",")}`);
    return `${i.locale}: ${i.key}（${parts.join("；")}）`;
  });
}
if (placeholder.suspicious.length) {
  console.log(`  非占位符花括号（不计失败，需人工确认）：${placeholder.suspicious.length}`);
  printList(placeholder.suspicious, (i) => `${i.locale}: ${i.key} → ${i.text}`);
  note.push(`T2 有 ${placeholder.suspicious.length} 条文本含非 {name} 花括号，已人工复核清单`);
}
if (placeholder.mismatches.length === 0) pass();
else {
  failed(placeholder.mismatches.length);
  fail.push(`T2 发现 ${placeholder.mismatches.length} 处占位符不一致`);
}

/* ------------------------------------------------------------------ *
 * T3 引用有效性
 * ------------------------------------------------------------------ */

head("T3 翻译引用有效性");
const frontendFiles = walk(path.join(ROOT, "src"), [".ts", ".vue"], {
  skipDirs: ["__tests__", "locales"],
}).map(readSource);

const refs = collectReferences(frontendFiles, namespaces);
const validated = validateReferences(ref.leaves, refs.static);

console.log(
  `  扫描 ${frontendFiles.length} 个文件｜静态引用 ${refs.static.length} 处 / ${validated.uniqueKeys} 个唯一 key｜动态盲区 ${refs.dynamic.length} 处`,
);
if (validated.invalid.length) {
  console.log(`  引用不存在的 key：${validated.invalid.length}`);
  printList(validated.invalid, (i) => `${i.file}:${i.line} ${i.key}（${i.kind}）`);
  failed(validated.invalid.length);
  fail.push(`T3 发现 ${validated.invalid.length} 处无效引用`);
} else {
  pass();
}

/* ------------------------------------------------------------------ *
 * T4 Rust 错误码覆盖
 * ------------------------------------------------------------------ */

head("T4 Rust 错误码覆盖");
const rustFiles = walk(path.join(ROOT, "src-tauri/src"), [".rs"]).map(readSource);
const rustFacts = collectRustFacts(rustFiles);
const frontendCodes = collectFrontendProtocolCodes(frontendFiles);
const coverage = checkRustCoverage(ref.leaves, rustFacts, frontendCodes);
const variableWhitelist = checkVariableWhitelist(ref.leaves, rustFacts);

console.log(
  `  Rust ${rustFiles.length} 个文件｜user_err 字面量 ${coverage.stats.literalSites} 处｜协议常量 ${coverage.stats.protocolLiterals} 处｜变量发射 ${coverage.stats.variableSites} 处`,
);
console.log(`  错误码：Rust ${coverage.stats.rustCodes} 个 / 语言包 ${coverage.stats.localeCodes} 个`);

if (coverage.missing.length) {
  console.log(`  缺少译文（Rust 有、语言包无）：${coverage.missing.length}`);
  printList(coverage.missing, (i) => `${i.code}（${i.sites.map((s) => `${s.file}:${s.line}`).join(", ")}）`);
}
const t4Failures = coverage.missing.length + variableWhitelist.problems.length;
if (variableWhitelist.problems.length) {
  console.log(`  变量发射白名单校验失败：${variableWhitelist.problems.length}`);
  printList(variableWhitelist.problems, (i) => `${i.kind} ${i.file} ${i.code ?? i.variable ?? ""}：${i.detail}`);
}
if (t4Failures === 0) {
  pass();
} else {
  failed(t4Failures);
  fail.push(`T4 发现 ${t4Failures} 处错误码问题（缺译文 ${coverage.missing.length} / 白名单 ${variableWhitelist.problems.length}）`);
}
if (coverage.frontendIssues.length) {
  console.log(`  前端协议串未登记 code 文案：${coverage.frontendIssues.length}（提示项，不计失败）`);
  printList(
    coverage.frontendIssues,
    (i) => `${i.code}（${i.kind === "sentinel" ? "code 本身是普通 UI key，会落到 protocolUnknown" : "Rust 未发射该码"}）`,
  );
}

if (coverage.internalOnly.length) {
  console.log(`  仅出现在日志上下文（不要求译文）：${coverage.internalOnly.length}`);
  printList(coverage.internalOnly, (i) => i.code);
}

const byReason = { frontend: [], "rust-literal": [], variable: [], unconfirmed: [] };
for (const item of coverage.localeOnly) byReason[item.reason].push(item.code);
console.log(
  `  语言包多出（Rust 无字面量发射）：${coverage.localeOnly.length}｜前端自造 ${byReason.frontend.length}｜常量/变量发射 ${byReason["rust-literal"].length}｜变量站点候选 ${byReason.variable.length}｜待人工确认 ${byReason.unconfirmed.length}`,
);
if (byReason.unconfirmed.length) {
  printList(byReason.unconfirmed, (code) => `backendErrors.code.${code}`);
  console.log("    ↳ 这些 code 在 Rust 与前端都没有可见发射点：可能是死键，也可能经动态路径发射，需人工确认（不计失败）");
}

/* ------------------------------------------------------------------ *
 * 静态盲区（不计失败）
 * ------------------------------------------------------------------ */

console.log("\n=== 静态分析盲区与待人工确认（不计失败） ===");

if (refs.dynamic.length) {
  console.log(`T3 动态 key：${refs.dynamic.length} 处`);
  printList(refs.dynamic, (i) => `${i.file}:${i.line} ${i.kind} ${i.expr}`);
  console.log("    ↳ 这些 key 由运行时拼装，无法静态判定；T3 的「0 无效引用」不代表已覆盖它们");
} else {
  console.log("T3 动态 key：0 处");
}

if (coverage.variableSites.length) {
  console.log(`T4 变量发射错误码：${coverage.variableSites.length} 处`);
  printList(
    coverage.variableSites,
    (i) => `${i.file}:${i.line} user_err(${i.variable}, …)｜候选 ${i.candidates.length} 个 code`,
  );
} else {
  console.log("T4 变量发射错误码：0 处");
}

console.log(
  `T4 变量发射白名单：${variableWhitelist.whitelistSize} 条｜已确认 code ${variableWhitelist.coveredSites.reduce(
    (sum, site) => sum + site.codes.length,
    0,
  )} 个｜未被白名单解释的发射点 ${variableWhitelist.uncoveredSites.length} 处（静态盲区，不计失败）`,
);
for (const site of variableWhitelist.coveredSites) {
  console.log(
    `    ✔ ${site.file} user_err(${site.variable}, …) → ${site.codes.join(", ")}（存在性 + 文件内字面量 + 译文 三项已校验）`,
  );
}

const riskyFormats = coverage.protocolFormats.filter((item) => !item.builder);
const builderFormats = coverage.protocolFormats.filter((item) => item.builder);
if (builderFormats.length) {
  console.log(`T4 协议构造函数定义：${builderFormats.length} 处（非静态盲区，已排除）`);
}
if (riskyFormats.length) {
  console.log(`T4 运行时拼接协议前缀（需人工确认）：${riskyFormats.length} 处`);
  printList(riskyFormats, (i) => `${i.file}:${i.line}`);
}

if (coverage.nested.length) {
  console.log(`T4 嵌套错误码线索：${coverage.nested.length} 处（内层由 user_err 产生，需确认是否递归翻译）`);
  printList(coverage.nested, (i) => `${i.file}:${i.line} 参数 ${i.param} ← ${i.variable}`);
} else {
  console.log("T4 嵌套错误码线索：0 处");
}

if (coverage.internalOnly.length) {
  console.log(`T4 内部日志专用错误码：${coverage.internalOnly.length} 个（按规则不强制翻译）`);
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log("\n=== 汇总 ===");
console.log(`  T1 key 完整性: ${t1Count === 0 ? "通过" : `${t1Count} 处不一致`}`);
console.log(`  T2 占位符: ${placeholder.mismatches.length === 0 ? "通过" : `${placeholder.mismatches.length} 处不一致`}`);
console.log(`  T3 引用: ${validated.invalid.length === 0 ? "通过" : `${validated.invalid.length} 处无效引用`}`);
console.log(`  T4 错误码覆盖: ${t4Failures === 0 ? "通过" : `${t4Failures} 个缺译文`}`);
console.log(`  覆盖范围：T3 静态引用 ${refs.static.length} 处；动态盲区 ${refs.dynamic.length} 处未纳入断言`);
console.log(
  `  覆盖范围：T4 字面量/常量发射已覆盖；变量发射 ${coverage.variableSites.length} 处（其中 ${coverage.variableSites.length - variableWhitelist.uncoveredSites.length} 处已由白名单断言）、内部日志 ${coverage.internalOnly.length} 个、未确认 ${byReason.unconfirmed.length} 个未纳入断言`,
);

if (fail.length) {
  console.log("\n❌ 检查未通过：");
  for (const item of fail) console.log(`  - ${item}`);
  process.exit(1);
}

console.log("\n✅ 全部检查通过");
process.exit(0);
