/**
 * 多语言一致性检查器（T1–T4）—— 纯函数集合，供 CLI 与测试复用。
 *
 * 设计约束：
 *   1. 不读取业务状态，只接收「内存中的树 / 文本」，便于用合成样例做单元测试。
 *   2. 只有真正违反对应关系的检查项才计入 failures；动态 key、变量发射错误码、
 *      内部日志等静态盲区一律进入 advisory，避免误报成缺陷。
 *   3. 不新增第三方依赖：语言包通过项目已有的 `typescript` 转译后求值。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const requireFromHere = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * 语言包载入
 * ------------------------------------------------------------------ */

/** 读取并求值语言包模块，返回 { label, tree }。 */
export function loadLocaleModule(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filePath,
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const run = new Function("exports", "require", "module", output);
  run(mod.exports, requireFromHere, mod);
  return { label: mod.exports.label, tree: mod.exports.default };
}

/** 展开为「叶 key → 字符串值」。非字符串叶（数字/布尔）按字符串处理。 */
export function flattenLeaves(tree, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(tree ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenLeaves(value, path, out);
    } else {
      out[path] = typeof value === "string" ? value : String(value);
    }
  }
  return out;
}

/** 展开为「所有节点 → object / leaf」，用于检测结构类型不一致。 */
export function nodeKinds(tree, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(tree ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[path] = "object";
      nodeKinds(value, path, out);
    } else {
      out[path] = "leaf";
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * T1 语言包 key 完整性
 * ------------------------------------------------------------------ */

/**
 * 以 reference 语言为基准，比较完整叶 key 集合与节点结构类型。
 * @returns {{missing:Array, extra:Array, typeMismatch:Array}}
 */
export function checkKeyParity(refCode, refTree, others) {
  const refLeaves = flattenLeaves(refTree);
  const refKinds = nodeKinds(refTree);
  const missing = [];
  const extra = [];
  const typeMismatch = [];

  for (const other of others) {
    if (other.code === refCode) continue;
    const leaves = flattenLeaves(other.tree);
    const kinds = nodeKinds(other.tree);

    for (const key of Object.keys(refLeaves)) {
      if (!(key in leaves)) {
        // 只有当对方完全不存在该路径节点时才算缺失；
        // 若对方把叶写成了对象，交给 typeMismatch 归类，避免同一问题报两次。
        if (!(key in kinds)) missing.push({ locale: other.code, key });
      }
    }
    for (const key of Object.keys(leaves)) {
      if (!(key in refLeaves) && !(key in refKinds)) extra.push({ locale: other.code, key });
    }
    for (const [key, kind] of Object.entries(refKinds)) {
      const actual = kinds[key];
      if (actual && actual !== kind) {
        typeMismatch.push({ locale: other.code, key, ref: kind, actual });
      }
    }
  }
  return { missing, extra, typeMismatch };
}

/* ------------------------------------------------------------------ *
 * T2 动态参数一致性
 * ------------------------------------------------------------------ */

const PLACEHOLDER = /\{([^{}]*)\}/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 提取合法占位符（仅 `{identifier}` 形式），忽略普通文本里的花括号。 */
export function extractPlaceholders(text) {
  const names = [];
  for (const match of String(text ?? "").matchAll(PLACEHOLDER)) {
    if (IDENTIFIER.test(match[1])) names.push(match[1]);
  }
  return names;
}

/** 是否存在「看起来像花括号但不是合法占位符」的内容（如 `{ }`、`{"a":1}`）。 */
export function hasSuspiciousBraces(text) {
  for (const match of String(text ?? "").matchAll(PLACEHOLDER)) {
    if (!IDENTIFIER.test(match[1])) return true;
  }
  return false;
}

/**
 * 比较同一 key 在各语言的占位符集合。
 * 只比较双方都存在的 key；缺失 key 由 T1 负责。
 */
export function checkPlaceholders(refCode, refLeaves, others) {
  const mismatches = [];
  const suspicious = [];

  for (const [key, text] of Object.entries(refLeaves)) {
    if (hasSuspiciousBraces(text)) suspicious.push({ locale: refCode, key, text });
  }

  for (const other of others) {
    if (other.code === refCode) continue;
    for (const [key, text] of Object.entries(other.leaves)) {
      if (hasSuspiciousBraces(text)) suspicious.push({ locale: other.code, key, text });
      if (!(key in refLeaves)) continue;
      const expected = new Set(extractPlaceholders(refLeaves[key]));
      const actual = new Set(extractPlaceholders(text));
      const missing = [...expected].filter((n) => !actual.has(n));
      const extra = [...actual].filter((n) => !expected.has(n));
      if (missing.length || extra.length) {
        mismatches.push({ locale: other.code, key, missing, extra });
      }
    }
  }
  return { mismatches, suspicious };
}

/* ------------------------------------------------------------------ *
 * T3 翻译引用有效性
 * ------------------------------------------------------------------ */

const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const CALL_NAMES = ["t", "te", "tm", "tc", "translate"];
const DOLLAR_CALL_NAMES = ["$t", "$te", "$tm", "$tc"];

/** 把注释替换为等长空白，保留换行与偏移，避免注释里的示例 key 被当成引用。 */
export function maskComments(source) {
  let masked = source.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  masked = masked
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      // `http://` 之类的字符串内部 // 不当作注释：要求 // 前是行首、空白或语句边界
      const trimmed = before.trimEnd();
      const safe =
        trimmed === "" ||
        trimmed.endsWith(";") ||
        trimmed.endsWith("{") ||
        trimmed.endsWith("}") ||
        trimmed.endsWith(")") ||
        trimmed.endsWith(",") ||
        trimmed.endsWith("]");
      return safe ? before + " ".repeat(line.length - before.length) : line;
    })
    .join("\n");
  return masked;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function unquote(literal) {
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}

function looksLikeAnyKey(key) {
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(key);
}

function looksLikeKey(key, namespaces) {
  if (!looksLikeAnyKey(key)) return false;
  const head = key.split(".")[0];
  return namespaces.includes(head);
}

/**
 * 扫描前端源码中的翻译引用。
 * - static：可静态解析的 key（t/translate/$t/labelKey/setStatusMessageKey/对象 key 字段）
 * - dynamic：无法静态解析的调用（模板拼接、变量实参、字符串拼接）——只报告，不计缺陷
 */
export function collectReferences(files, namespaces) {
  const statics = [];
  const dynamic = [];
  const seen = new Set();

  const pushStatic = (file, line, key, kind) => {
    const id = `${file}:${line}:${key}:${kind}`;
    if (seen.has(id)) return;
    seen.add(id);
    statics.push({ file, line, key, kind });
  };

  for (const file of files) {
    const masked = maskComments(file.content);
    const callRe = new RegExp(
      String.raw`(?<![\w$.])(${CALL_NAMES.join("|")})\s*\(\s*(?:(` + STRING_LITERAL + String.raw`)|\x60([^\x60]*)\x60|([A-Za-z_$][\w$]*))`,
      "g",
    );
    for (const match of masked.matchAll(callRe)) {
      const index = match.index ?? 0;
      const line = lineAt(masked, index);
      const [, callName, literal, template, identifier] = match;
      if (literal) {
        const key = unquote(literal);
        // 翻译函数实参必然是 key：不套命名空间白名单，否则拼错命名空间会漏报
        if (looksLikeAnyKey(key)) pushStatic(file.path, line, key, callName);
      } else if (template !== undefined && template.includes("${")) {
        dynamic.push({
          file: file.path,
          line,
          kind: "template",
          expr: `${callName}(\`${template.slice(0, 60)}\`)`,
        });
      } else if (identifier) {
        dynamic.push({
          file: file.path,
          line,
          kind: "variable",
          expr: `${callName}(${identifier})`,
        });
      }
    }

    const dollarRe = new RegExp(
      String.raw`(?<![\w$.])(${DOLLAR_CALL_NAMES.join("|")})\s*\(\s*(?:(` + STRING_LITERAL + String.raw`)|[A-Za-z_$][\w$]*)`,
      "g",
    );
    for (const match of masked.matchAll(dollarRe)) {
      const index = match.index ?? 0;
      const line = lineAt(masked, index);
      if (match[2]) {
        const key = unquote(match[2]);
        if (looksLikeKey(key, namespaces)) pushStatic(file.path, line, key, match[1]);
      }
    }

    for (const match of masked.matchAll(/(?<![\w$])labelKey\s*:\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = match[1] ?? match[2] ?? "";
      if (looksLikeAnyKey(key)) {
        pushStatic(file.path, lineAt(masked, match.index ?? 0), key, "labelKey");
      }
    }

    for (const match of masked.matchAll(/setStatusMessageKey\s*\(\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = match[1] ?? match[2] ?? "";
      if (looksLikeAnyKey(key)) {
        pushStatic(file.path, lineAt(masked, match.index ?? 0), key, "setStatusMessageKey");
      }
    }

    // 对象字面量里的 { key: "a.b" }（Msg / 通知载体）；仅接受带命名空间的点号 key，
    // 避免把键盘事件 { key: "Enter" } 之类误判为翻译 key。
    for (const match of masked.matchAll(/(?<![\w$])key\s*:\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = match[1] ?? match[2] ?? "";
      if (looksLikeKey(key, namespaces)) {
        pushStatic(file.path, lineAt(masked, match.index ?? 0), key, "objectKey");
      }
    }

    // 字符串拼接构造 key：t("prefix." + x)
    for (const match of masked.matchAll(
      /(?<![\w$.])(?:t|te|tm|translate)\s*\(\s*(?:"[^"\n]*"|'[^'\n]*')\s*\+/g,
    )) {
      dynamic.push({
        file: file.path,
        line: lineAt(masked, match.index ?? 0),
        kind: "concat",
        expr: match[0].trim().slice(0, 60),
      });
    }

    // 模板拼接：`...${}` 出现在已知命名空间前缀上（如 `translate.langName.${code}`）
    for (const match of masked.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
      const body = match[1];
      const head = body.split(".")[0];
      if (namespaces.includes(head) && body.includes("${")) {
        dynamic.push({
          file: file.path,
          line: lineAt(masked, match.index ?? 0),
          kind: "key-template",
          expr: `\`${body.slice(0, 60)}\``,
        });
      }
    }
  }

  return { static: statics, dynamic };
}

/** 校验静态引用是否存在于基准语言（T1 已保证三语一致）。 */
export function validateReferences(refLeaves, refs) {
  const invalid = refs.filter((ref) => !(ref.key in refLeaves));
  const uniqueKeys = new Set(refs.map((ref) => ref.key)).size;
  return { invalid, uniqueKeys };
}

/* ------------------------------------------------------------------ *
 * T4 Rust 错误码覆盖
 * ------------------------------------------------------------------ */

const USER_ERR_LITERAL = /user_err\s*\(\s*"([A-Za-z0-9_.-]+)"/g;
const USER_ERR_VARIABLE = /user_err\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g;
const PROTOCOL_LITERAL = /"aoe2mm:err:([A-Za-z0-9_.-]+)"/g;
const PROTOCOL_FORMAT = /format!\s*\(\s*"aoe2mm:err:\{[^}]*\}"/g;
const DOTTED_LITERAL = /"([a-z][A-Za-z0-9]*\.(?:[A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)*)"/g;
const ASSIGN_FROM_USER_ERR = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*user_err\s*\(/g;

/**
 * 把 Rust 的 `#[cfg(test)]` 模块替换为等长空白，保留换行与偏移。
 * 测试里的 `"aoe2mm:err:install."` 之类前缀断言不是发射点，必须排除，
 * 否则会把 install. / account. / scan. 误报成缺译文的错误码。
 */
export function stripRustTestModules(source) {
  const marker = /#\[cfg\(test\)\]/g;
  let masked = source;
  let match;
  while ((match = marker.exec(masked))) {
    const open = masked.indexOf("{", match.index + match[0].length);
    if (open < 0) break;
    const end = findBlockEnd(masked, open);
    const blank = masked.slice(match.index, end).replace(/[^\n]/g, " ");
    masked = masked.slice(0, match.index) + blank + masked.slice(end);
    marker.lastIndex = end;
  }
  return masked;
}

/** 从 `{` 开始做括号匹配（跳过字符串 / 字符 / 行注释 / 块注释）。 */
function findBlockEnd(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      // 字符字面量：'a' / '\n'；生命周期标注 'a 后面不是闭合引号，按非字符处理
      if (text[i + 2] === "'" || (text[i + 1] === "\\" && text[i + 3] === "'")) {
        i += text[i + 2] === "'" ? 3 : 4;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

/**
 * 从 Rust 源码提取错误码相关事实。
 * - literalSites：字面量发射点（logContext = 该行处于 log 宏参数中）
 * - protocolLiterals：以 "aoe2mm:err:code" 常量形式存在的码
 * - variableSites：首参为变量的发射点（静态不可解析）
 * - dottedLiterals：全仓点号字面量（用于判断「语言包多出」是否为常量/变量发射）
 * - dottedLiteralsByFile：按文件分组的点号字面量（变量发射白名单要按文件做双向校验）
 * - nestedHints：user_err 参数里引用了由 user_err 赋值的变量（嵌套错误码线索）
 */
export function collectRustFacts(sources) {
  const literalSites = [];
  const protocolLiterals = [];
  const variableSites = [];
  const protocolFormats = [];
  const dottedLiterals = new Set();
  const dottedLiteralsByFile = new Map();
  const nestedHints = [];

  for (const source of sources) {
    const text = stripRustTestModules(source.content);
    const lines = text.split(/\r?\n/);
    const assignedVars = new Set();
    const fileLiterals = new Set();
    for (const match of text.matchAll(ASSIGN_FROM_USER_ERR)) assignedVars.add(match[1]);

    for (const match of text.matchAll(USER_ERR_LITERAL)) {
      const index = match.index ?? 0;
      if (match[1].endsWith(".")) continue; // 前缀断言，不是错误码
      const line = lineAt(text, index);
      const lineText = lines[line - 1] ?? "";
      literalSites.push({
        file: source.path,
        line,
        code: match[1],
        logContext: lineText.includes("log::"),
      });
    }

    for (const match of text.matchAll(PROTOCOL_LITERAL)) {
      const code = match[1];
      // `"aoe2mm:err:scan."` 这类以点结尾的串是前缀判断（starts_with），不是错误码
      if (code.endsWith(".")) continue;
      protocolLiterals.push({ file: source.path, line: lineAt(text, match.index ?? 0), code });
    }

    for (const match of text.matchAll(PROTOCOL_FORMAT)) {
      const index = match.index ?? 0;
      const line = lineAt(text, index);
      const lineText = lines[line - 1] ?? "";
      protocolFormats.push({
        file: source.path,
        line,
        // user_err 自身的 `format!("aoe2mm:err:{code}")` 是协议构造定义，不是拼接风险
        builder: lineText.includes("aoe2mm:err:{code}"),
      });
    }

    for (const match of text.matchAll(USER_ERR_VARIABLE)) {
      const index = match.index ?? 0;
      // 排除字面量首参（"code"）后的误命中：变量名不能带引号，正则已保证
      variableSites.push({
        file: source.path,
        line: lineAt(text, index),
        variable: match[1],
      });
    }

    for (const match of text.matchAll(DOTTED_LITERAL)) {
      dottedLiterals.add(match[1]);
      fileLiterals.add(match[1]);
    }
    dottedLiteralsByFile.set(source.path, fileLiterals);

    // 嵌套线索：形如 "xxx": <var>，且该 var 在同一文件里由 user_err(...) 赋值
    for (const match of text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)":\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const [, param, variable] = match;
      if (!assignedVars.has(variable)) continue;
      const line = lineAt(text, match.index ?? 0);
      nestedHints.push({ file: source.path, line, param, variable });
    }
  }

  return { literalSites, protocolLiterals, protocolFormats, variableSites, dottedLiterals, dottedLiteralsByFile, nestedHints };
}

/** 从源码中提取前端自造的协议码（`aoe2mm:err:xxx` 字符串字面量）。 */
export function collectFrontendProtocolCodes(files) {
  const codes = new Set();
  for (const file of files) {
    const masked = maskComments(file.content);
    for (const match of masked.matchAll(/"aoe2mm:err:([A-Za-z0-9_.-]+)"/g)) codes.add(match[1]);
    for (const match of masked.matchAll(/'aoe2mm:err:([A-Za-z0-9_.-]+)'/g)) codes.add(match[1]);
  }
  return [...codes];
}

/**
 * 判定 Rust 错误码与语言包 code 表的覆盖关系。
 * 规则：
 *   - Rust 有、语言包无，且发射点不在 log 上下文 → failures（需要译文）
 *   - Rust 有、语言包无，但仅出现在 log 上下文 → internalOnly（advisory，不要求译文）
 *   - 语言包有、Rust 无 → 逐条归类：前端自造 / 常量或变量发射 / 待人工确认（advisory）
 */
export function checkRustCoverage(refLeaves, facts, frontendCodes) {
  const prefixOf = (key) => key.split(".")[0];
  const codeKeyPrefix = "backendErrors.code.";

  const localeCodes = new Map(); // code -> locale key
  for (const key of Object.keys(refLeaves)) {
    if (key.startsWith(codeKeyPrefix)) localeCodes.set(key.slice(codeKeyPrefix.length), key);
  }

  // 已知错误码命名空间：来自 user_err 字面量与协议常量，避免把普通点号字符串当错误码
  const prefixes = new Set();
  for (const site of facts.literalSites) prefixes.add(prefixOf(site.code));
  for (const site of facts.protocolLiterals) prefixes.add(prefixOf(site.code));
  for (const code of frontendCodes) prefixes.add(prefixOf(code));

  const rustCodes = new Map(); // code -> { sites, logOnly }
  const addSite = (code, site, isLog) => {
    const head = prefixOf(code);
    if (!prefixes.has(head)) return;
    const entry = rustCodes.get(code) ?? { sites: [], logSites: 0 };
    entry.sites.push(site);
    if (isLog) entry.logSites++;
    rustCodes.set(code, entry);
  };

  for (const site of facts.literalSites) {
    addSite(site.code, { file: site.file, line: site.line }, site.logContext);
  }
  for (const site of facts.protocolLiterals) {
    addSite(site.code, { file: site.file, line: site.line }, false);
  }

  const variableCandidates = [];
  for (const site of facts.variableSites) {
    const candidates = [];
    for (const literal of facts.dottedLiterals) {
      if (!prefixes.has(prefixOf(literal))) continue;
      if (/\.(rs|json|txt|md|toml|yaml|yml|png|jpg|webp|exe|dll|log)$/i.test(literal)) continue;
      candidates.push(literal);
    }
    variableCandidates.push({ ...site, candidates });
  }

  const missing = [];
  const internalOnly = [];
  for (const [code, entry] of rustCodes) {
    if (localeCodes.has(code)) continue;
    if (entry.sites.length === entry.logSites) {
      internalOnly.push({ code, sites: entry.sites });
    } else {
      missing.push({ code, sites: entry.sites.slice(0, 3) });
    }
  }

  const frontendSet = new Set(frontendCodes);
  const localeOnly = [];
  for (const code of localeCodes.keys()) {
    if (rustCodes.has(code)) continue;
    let reason = "unconfirmed";
    if (frontendSet.has(code)) reason = "frontend";
    else if (facts.dottedLiterals.has(code)) reason = "rust-literal";
    else if (variableCandidates.some((site) => site.candidates.includes(code))) reason = "variable";
    localeOnly.push({ code, reason });
  }

  // 前端自造协议码：有 backendErrors.code 文案即正常；否则只作提示（不判失败）
  //   sentinel：code 本身是普通 UI key（如 labels.unknown），会落到 protocolUnknown
  //   unbacked：Rust 从未发射过该码（疑似失效分支）
  const frontendIssues = [];
  for (const code of frontendCodes) {
    if (localeCodes.has(code)) continue;
    frontendIssues.push({
      code,
      kind: code in refLeaves ? "sentinel" : "unbacked",
      inRust: rustCodes.has(code),
    });
  }

  return {
    prefixes: [...prefixes],
    required: [...rustCodes.keys()].filter((code) => !internalOnly.some((i) => i.code === code)),
    missing,
    frontendIssues,
    internalOnly,
    localeOnly,
    nested: facts.nestedHints,
    protocolFormats: facts.protocolFormats,
    variableSites: variableCandidates,
    stats: {
      rustCodes: rustCodes.size,
      localeCodes: localeCodes.size,
      literalSites: facts.literalSites.length,
      protocolLiterals: facts.protocolLiterals.length,
      variableSites: facts.variableSites.length,
    },
  };
}

/**
 * 变量发射白名单。
 *
 * `user_err(<变量>, …)` 这类发射点的取值静态不可解析。人工确认后把它登记在这里，
 * 换来的不是「跳过检查」，而是三向断言：
 *   1. 该白名单条目对应的发射点必须仍然存在（文件 + 变量名），否则条目过期 → 失败；
 *   2. 每个 code 都必须真的以点号字面量出现在**该文件**里（不允许凭空写入 → 掩盖缺陷）；
 *   3. 每个 code 都必须在语言包 backendErrors.code 下有文案（否则译文缺失会被白名单悄悄放过）。
 *
 * 空白名单 = 不承认任何变量发射，所有变量站点都会落进「待人工确认」。
 * 新增一条必须同时提供 reason（人工确认依据），便于以后复核。
 */
export const VARIABLE_EMISSION_WHITELIST = [
  {
    file: "src-tauri/src/translator.rs",
    variable: "code",
    reason:
      "transport_failure：dns / timeout / refused(含 unreachable) / reset / 兜底五路分支，值全是 translate.* 字面量",
    codes: [
      "translate.dnsFailed",
      "translate.timeout",
      "translate.connectionRefused",
      "translate.connectionReset",
      "translate.networkFailed",
    ],
  },
];

/**
 * 校验变量发射白名单（返回 problems 即视为 T4 失败）。
 * coveredSites 记录被白名单解释掉的变量发射点；uncoveredSites 仍属静态盲区，只报告不判失败。
 */
export function checkVariableWhitelist(refLeaves, facts, whitelist = VARIABLE_EMISSION_WHITELIST) {
  const codeKeyPrefix = "backendErrors.code.";
  const localeCodes = new Set(
    Object.keys(refLeaves)
      .filter((key) => key.startsWith(codeKeyPrefix))
      .map((key) => key.slice(codeKeyPrefix.length)),
  );

  const problems = [];
  const coveredSites = [];

  for (const entry of whitelist) {
    const literalSet = facts.dottedLiteralsByFile?.get(entry.file) ?? new Set();
    const sites = facts.variableSites.filter(
      (site) => site.file === entry.file && site.variable === entry.variable,
    );
    if (!sites.length) {
      problems.push({
        kind: "staleSite",
        file: entry.file,
        variable: entry.variable,
        detail: "白名单里的发射点已不存在（改名 / 删除 / 换成字面量），条目需要复核",
      });
      continue;
    }

    for (const code of entry.codes) {
      if (!literalSet.has(code)) {
        problems.push({
          kind: "codeNotInFile",
          file: entry.file,
          code,
          detail: "白名单登记的 code 在该文件里从未以点号字面量出现",
        });
      }
      if (!localeCodes.has(code)) {
        problems.push({
          kind: "missingTranslation",
          file: entry.file,
          code,
          detail: "白名单登记的 code 在语言包里没有 backendErrors.code 文案",
        });
      }
    }

    coveredSites.push({ file: entry.file, variable: entry.variable, sites, codes: entry.codes });
  }

  // 没有被任何白名单条目解释的变量发射点：仍是盲区，单独报告，不判失败
  const uncoveredSites = facts.variableSites.filter(
    (site) =>
      !whitelist.some((entry) => entry.file === site.file && entry.variable === site.variable),
  );

  return { problems, coveredSites, uncoveredSites, whitelistSize: whitelist.length };
}
