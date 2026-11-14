import { describe, expect, it } from "vitest";
import {
  checkKeyParity,
  checkPlaceholders,
  checkRustCoverage,
  checkVariableWhitelist,
  collectFrontendProtocolCodes,
  collectReferences,
  collectRustFacts,
  extractPlaceholders,
  flattenLeaves,
  hasSuspiciousBraces,
  maskComments,
  stripRustTestModules,
  validateReferences,
} from "../../../scripts/i18n/i18n-checks.mjs";
import { VARIABLE_EMISSION_WHITELIST } from "../../../scripts/i18n/i18n-checks.mjs";
import type { RustFacts } from "../../../scripts/i18n/i18n-checks.mjs";

/**
 * 这些用例用合成数据验证检查器「真的能发现问题」：
 * 每一个 it 都是一条人为构造的错误样例或已知合法样例（防止误报）。
 */

describe("T1 语言包 key 完整性", () => {
  it("展开时只输出叶节点（不含中间对象）", () => {
    const flat = flattenLeaves({ a: { b: "x" }, c: "y" });
    expect(Object.keys(flat)).toEqual(["a.b", "c"]);
  });

  it("识别缺失的叶 key（不只比较顶层）", () => {
    const ref = { a: { b: "x", c: "y" }, d: { e: "z" } };
    const other = { a: { b: "x" }, d: { e: "z" } };
    const result = checkKeyParity("en", ref, [{ code: "zh", tree: other }]);
    expect(result.missing).toEqual([{ locale: "zh", key: "a.c" }]);
    expect(result.extra).toEqual([]);
  });

  it("识别多余 key", () => {
    const ref = { a: { b: "x" } };
    const other = { a: { b: "x", ghost: "y" } };
    const result = checkKeyParity("en", ref, [{ code: "es", tree: other }]);
    expect(result.extra).toEqual([{ locale: "es", key: "a.ghost" }]);
  });

  it("识别「叶 vs 对象」结构类型不一致，且不重复计为缺失", () => {
    const ref = { a: { b: "x" } };
    const other = { a: { b: { c: "x" } } };
    const result = checkKeyParity("en", ref, [{ code: "es", tree: other }]);
    expect(result.typeMismatch).toEqual([{ locale: "es", key: "a.b", ref: "leaf", actual: "object" }]);
    expect(result.missing.map((item) => item.key)).not.toContain("a.b");
  });

  it("多种语言各自报告", () => {
    const ref = { a: { b: "x", c: "y" } };
    const result = checkKeyParity("en", ref, [
      { code: "zh", tree: { a: { b: "x" } } },
      { code: "es", tree: { a: { b: "x", c: "y" } } },
    ]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].locale).toBe("zh");
  });
});

describe("T2 动态参数一致性", () => {
  it("识别缺失占位符", () => {
    const ref = { k: "{n} mods" };
    const other = { k: "mods" };
    const result = checkPlaceholders("en", ref, [{ code: "es", leaves: other }]);
    expect(result.mismatches).toEqual([{ locale: "es", key: "k", missing: ["n"], extra: [] }]);
  });

  it("识别占位符改名（缺失 + 多余同时报告）", () => {
    const ref = { k: "{count} items" };
    const other = { k: "{n} items" };
    const result = checkPlaceholders("en", ref, [{ code: "zh", leaves: other }]);
    expect(result.mismatches[0]).toMatchObject({ key: "k", missing: ["count"], extra: ["n"] });
  });

  it("多参数一致时不报告问题", () => {
    const ref = { k: "{name} · {n} mods" };
    const other = { k: "{name} · {n} mods" };
    const result = checkPlaceholders("en", ref, [{ code: "es", leaves: other }]);
    expect(result.mismatches).toEqual([]);
  });

  it("不会把普通文本里的花括号当成占位符", () => {
    expect(extractPlaceholders("JSON { } 和 {\"a\":1}")).toEqual([]);
    expect(hasSuspiciousBraces("JSON { }")).toBe(true);
    expect(hasSuspiciousBraces("plain text")).toBe(false);
    expect(hasSuspiciousBraces("{n} items")).toBe(false);
  });

  it("可疑花括号只进入提示，不进入 mismatch", () => {
    const ref = { k: "value { }" };
    const result = checkPlaceholders("en", ref, []);
    expect(result.mismatches).toEqual([]);
    expect(result.suspicious).toHaveLength(1);
  });
});

describe("T3 翻译引用有效性", () => {
  const namespaces = ["online", "statusbar", "labels"];

  it("识别不存在的 key", () => {
    const refs = collectReferences([{ path: "a.ts", content: `const x = t("online.missing");` }], namespaces);
    const result = validateReferences({ "online.ok": "ok" }, refs.static);
    expect(result.invalid).toEqual([
      { file: "a.ts", line: 1, key: "online.missing", kind: "t" },
    ]);
  });

  it("识别 labelKey / setStatusMessageKey / 对象 key 的间接引用", () => {
    const content = [
      `const opts = [{ labelKey: "online.sortName" }];`,
      `setStatusMessageKey("statusbar.onlineReady");`,
      `setStatusMessage({ key: "statusbar.offlineHint" });`,
    ].join("\n");
    const refs = collectReferences([{ path: "b.ts", content }], namespaces);
    expect(refs.static.map((ref) => `${ref.kind}:${ref.key}`)).toEqual(
      expect.arrayContaining([
        "labelKey:online.sortName",
        "setStatusMessageKey:statusbar.onlineReady",
        "objectKey:statusbar.offlineHint",
      ]),
    );
  });

  it("不把键盘事件 key 误判为翻译 key", () => {
    const refs = collectReferences([{ path: "c.ts", content: `onKey({ key: "Enter" });` }], namespaces);
    expect(refs.static).toHaveLength(0);
  });

  it("忽略注释里的示例 key", () => {
    const content = `// t("online.commented")\nconst ok = t("online.real");`;
    const refs = collectReferences([{ path: "d.ts", content }], namespaces);
    expect(refs.static.map((ref) => ref.key)).toEqual(["online.real"]);
  });

  it("模板拼接与变量实参进入动态盲区，不误报为无效引用", () => {
    const content = [
      "translate(`translate.langName.${code}`);",
      "t(key);",
      't("online." + suffix);',
    ].join("\n");
    const refs = collectReferences([{ path: "e.ts", content }], namespaces);
    expect(refs.static).toHaveLength(0);
    expect(refs.dynamic.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["template", "variable", "concat"]),
    );
  });

  it("注释屏蔽保留行号", () => {
    const masked = maskComments("const a = 1; // t(\"online.x\")\nconst b = t(\"online.y\");");
    expect(masked.split("\n")).toHaveLength(2);
    expect(masked).not.toContain("online.x");
  });
});

describe("T4 Rust 错误码覆盖", () => {
  const baseFacts = (overrides: Partial<RustFacts> = {}): RustFacts => ({
    literalSites: [],
    protocolLiterals: [],
    protocolFormats: [],
    variableSites: [],
    dottedLiterals: new Set<string>(),
    dottedLiteralsByFile: new Map<string, Set<string>>(),
    nestedHints: [],
    ...overrides,
  });

  it("Rust 有、语言包无 → 缺少译文", () => {
    const facts = baseFacts({
      literalSites: [{ file: "install.rs", line: 3, code: "install.saveFailed", logContext: false }],
    });
    const result = checkRustCoverage({}, facts, []);
    expect(result.missing).toEqual([
      { code: "install.saveFailed", sites: [{ file: "install.rs", line: 3 }] },
    ]);
  });

  it("语言包有、Rust 无 → 归为待人工确认（不产生 missing）", () => {
    const result = checkRustCoverage({ "backendErrors.code.net.timeout": "超时" }, baseFacts(), []);
    expect(result.missing).toEqual([]);
    expect(result.localeOnly).toEqual([{ code: "net.timeout", reason: "unconfirmed" }]);
  });

  it("仅出现在 log 上下文 → internalOnly，不要求译文", () => {
    const result = checkRustCoverage(
      {},
      baseFacts({ literalSites: [{ file: "cache.rs", line: 9, code: "cache.internal", logContext: true }] }),
      [],
    );
    expect(result.missing).toEqual([]);
    expect(result.internalOnly[0].code).toBe("cache.internal");
  });

  it("变量发射只记录盲区，不判定缺失", () => {
    const facts = baseFacts({ variableSites: [{ file: "translator.rs", line: 936, variable: "code" }] });
    const result = checkRustCoverage({ "backendErrors.code.a.b": "x" }, facts, []);
    expect(result.variableSites[0].variable).toBe("code");
    expect(result.missing).toEqual([]);
  });

  it("排除 Rust 测试模块里的前缀断言", () => {
    const source = [
      'pub fn f() { let _ = user_err("install.real", json!({})); }',
      "#[cfg(test)]",
      "mod tests {",
      "  #[test]",
      '  fn t() { assert!(err.starts_with("aoe2mm:err:install.")); }',
      "}",
    ].join("\n");
    const stripped = stripRustTestModules(source);
    expect(stripped).not.toContain("aoe2mm:err:install.");
    const facts = collectRustFacts([{ path: "install.rs", content: source }]);
    expect(facts.literalSites.map((site) => site.code)).toEqual(["install.real"]);
    expect(facts.protocolLiterals).toEqual([]);
  });

  it("识别嵌套错误码线索", () => {
    const source = [
      'let inner = user_err("install.inner", json!({ "path": p }));',
      'let outer = user_err("install.outer", json!({ "error": inner }));',
    ].join("\n");
    const facts = collectRustFacts([{ path: "install.rs", content: source }]);
    expect(facts.nestedHints).toHaveLength(1);
    expect(facts.nestedHints[0]).toMatchObject({ param: "error", variable: "inner" });
  });

  it("前端协议串未登记 code 文案 → 提示项，不计失败", () => {
    const files = [{ path: "a.ts", content: 'throw new Error("aoe2mm:err:labels.unknown");' }];
    const codes = collectFrontendProtocolCodes(files);
    const result = checkRustCoverage({ "labels.unknown": "Unknown" }, baseFacts(), codes);
    expect(result.frontendIssues).toEqual([
      { code: "labels.unknown", kind: "sentinel", inRust: false },
    ]);
  });

  it("统计字段反映真实发射点数量", () => {
    const facts = baseFacts({
      literalSites: [
        { file: "a.rs", line: 1, code: "install.a", logContext: false },
        { file: "a.rs", line: 2, code: "install.b", logContext: false },
      ],
      protocolLiterals: [{ file: "b.rs", line: 5, code: "index.needLogin" }],
    });
    const result = checkRustCoverage(
      { "backendErrors.code.install.a": "A", "backendErrors.code.install.b": "B", "backendErrors.code.index.needLogin": "L" },
      facts,
      [],
    );
    expect(result.stats.rustCodes).toBe(3);
    expect(result.stats.literalSites).toBe(2);
    expect(result.missing).toEqual([]);
  });
});

describe("T4 变量发射白名单（双向校验）", () => {
  const FILE = "src-tauri/src/translator.rs";

  /** 构造一个 translator.rs 风格的站点：5 个 translate.* 字面量 + user_err(code, …) */
  const translatorFacts = (overrides: Partial<RustFacts> = {}): RustFacts => {
    const literals = new Set([
      "translate.dnsFailed",
      "translate.timeout",
      "translate.connectionRefused",
      "translate.connectionReset",
      "translate.networkFailed",
    ]);
    return {
      literalSites: [],
      protocolLiterals: [],
      protocolFormats: [],
      variableSites: [{ file: FILE, line: 936, variable: "code" }],
      dottedLiterals: literals,
      dottedLiteralsByFile: new Map([[FILE, literals]]),
      nestedHints: [],
      ...overrides,
    };
  };

  const localeWithCodes = (codes: string[]) =>
    Object.fromEntries(codes.map((code) => [`backendErrors.code.${code}`, "x"]));

  const whitelist = [
    {
      file: FILE,
      variable: "code",
      reason: "test",
      codes: [
        "translate.dnsFailed",
        "translate.timeout",
        "translate.connectionRefused",
        "translate.connectionReset",
        "translate.networkFailed",
      ],
    },
  ];

  it("白名单命中：三项校验全过时 problems 为空，并把站点算作已确认", () => {
    const result = checkVariableWhitelist(localeWithCodes(whitelist[0].codes), translatorFacts(), whitelist);
    expect(result.problems).toEqual([]);
    expect(result.coveredSites[0].codes).toHaveLength(5);
    expect(result.uncoveredSites).toEqual([]);
  });

  it("白名单里的 code 在该文件里没有对应字面量 → codeNotInFile（防止凭空登记掩盖缺陷）", () => {
    const facts = translatorFacts({
      dottedLiteralsByFile: new Map([[FILE, new Set(["translate.dnsFailed"])]]),
    });
    const result = checkVariableWhitelist(localeWithCodes(whitelist[0].codes), facts, whitelist);
    expect(result.problems.some((item) => item.kind === "codeNotInFile")).toBe(true);
  });

  it("白名单里的 code 缺译文 → missingTranslation", () => {
    const result = checkVariableWhitelist({}, translatorFacts(), whitelist);
    expect(result.problems.every((item) => item.kind === "missingTranslation")).toBe(true);
    expect(result.problems).toHaveLength(5);
  });

  it("发射点没了（改名/删除/换成字面量）→ staleSite，白名单必须复核", () => {
    const facts = translatorFacts({ variableSites: [] });
    const result = checkVariableWhitelist(localeWithCodes(whitelist[0].codes), facts, whitelist);
    expect(result.problems).toEqual([
      {
        kind: "staleSite",
        file: FILE,
        variable: "code",
        detail: "白名单里的发射点已不存在（改名 / 删除 / 换成字面量），条目需要复核",
      },
    ]);
  });

  it("没有被白名单解释的变量站点只报告，不判失败", () => {
    const facts = translatorFacts({
      variableSites: [
        { file: FILE, line: 936, variable: "code" },
        { file: "src-tauri/src/install.rs", line: 12, variable: "code" },
      ],
    });
    const result = checkVariableWhitelist(localeWithCodes(whitelist[0].codes), facts, whitelist);
    expect(result.problems).toEqual([]);
    expect(result.uncoveredSites.map((site) => site.file)).toEqual(["src-tauri/src/install.rs"]);
  });

  it("默认白名单只登记 translator.rs 的 5 个 translate.* code（不得随意扩大）", () => {
    expect(VARIABLE_EMISSION_WHITELIST).toHaveLength(1);
    expect(VARIABLE_EMISSION_WHITELIST[0].file).toBe(FILE);
    expect(VARIABLE_EMISSION_WHITELIST[0].variable).toBe("code");
    expect(VARIABLE_EMISSION_WHITELIST[0].codes).toHaveLength(5);
    expect(VARIABLE_EMISSION_WHITELIST[0].codes.every((code) => code.startsWith("translate."))).toBe(true);
  });
});
