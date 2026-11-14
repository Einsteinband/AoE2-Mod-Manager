import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyLocale } from "../index";
import { normalizeBackendError, normalizeError, translateBackendMessage } from "../../format";

/**
 * R1 回归：`aoe2mm:err:<code>:<json>` 协议串的翻译链路。
 *
 * 重点不是「有文案」，而是「参数不丢」：
 * Rust 侧确实存在把多条协议串用全角分号拼成一句的写法（install 的 info/缩略图备注、
 * 卸载的备份备注），旧实现只按单条信封解析，整串匹配失败后原样甩给用户，
 * 各段的 `:json` 参数一起消失。
 */

const ENVELOPE = (code: string, params?: Record<string, unknown>) =>
  params ? `aoe2mm:err:${code}:${JSON.stringify(params)}` : `aoe2mm:err:${code}`;

describe("translateBackendMessage：单条协议串", () => {
  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("错误码按语言包文案翻译，动态参数被填进去", () => {
    const text = translateBackendMessage(
      ENVELOPE("install.targetExistsForeign", { path: "D:\\AoE2DE\\local\\123_mod" }),
    );
    expect(text).toContain("D:\\AoE2DE\\local\\123_mod");
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toContain("{path}");
  });

  it("未登记的 code 走 protocolUnknown，并且保留 code 供用户反馈", () => {
    const text = translateBackendMessage(ENVELOPE("install.noSuchCode"));
    expect(text).toContain("install.noSuchCode");
    expect(text).not.toContain("aoe2mm:err:");
  });

  it("参数 JSON 损坏时仍然输出文案，只是占位符为空", () => {
    const text = translateBackendMessage("aoe2mm:err:install.targetExistsForeign:{broken");
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toContain("{path}");
  });
});

describe("translateBackendMessage：多段拼接串（R1 缺陷）", () => {
  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("全角分号拼接的两段各自翻译，两段参数都不丢", () => {
    const raw = [
      ENVELOPE("install.zipOpenFailed", { error: "E1" }),
      ENVELOPE("install.mkdirFailed", { error: "E2" }),
    ].join("；");
    const text = translateBackendMessage(raw);
    expect(text).toContain("E1");
    expect(text).toContain("E2");
    expect(text).not.toContain("aoe2mm:err:");
  });

  it("英文/西班牙语界面的段连接符跟随语言包，不会残留中文分号", () => {
    const raw = [
      ENVELOPE("install.zipOpenFailed", { error: "E1" }),
      ENVELOPE("install.mkdirFailed", { error: "E2" }),
    ].join("；");

    applyLocale("en");
    const en = translateBackendMessage(raw);
    expect(en).toContain("E1");
    expect(en.split("; ").length).toBe(2);

    applyLocale("es");
    const es = translateBackendMessage(raw);
    expect(es).toContain("E1");
    expect(es.split("; ").length).toBe(2);
  });

  it("普通中文分号不是段边界（含分号的路径不会被切开）", () => {
    const raw = ENVELOPE("install.zipOpenFailed", { error: "a；b" });
    const text = translateBackendMessage(raw);
    expect(text).toContain("a；b");
  });

  it("三段拼接同样逐段翻译", () => {
    const raw = [
      ENVELOPE("install.zipOpenFailed", { error: "E1" }),
      ENVELOPE("install.zipCorrupt", { error: "E2" }),
      ENVELOPE("install.mkdirFailed", { error: "E3" }),
    ].join("；");
    const text = translateBackendMessage(raw);
    expect(text).toContain("E1");
    expect(text).toContain("E2");
    expect(text).toContain("E3");
  });
});

describe("P0/P1 迁移回归：复用已有 code 的参数传递", () => {
  /**
   * 这批 code 在语言包里早已存在，但 Rust 侧之前发的是中文 `format!` 串，
   * 只能靠 `format.ts` 的关键词兜底（实测多数 untranslated、少数被误标成
   * createFailed/timeout）。迁移后必须满足：参数完整、非中文语言都不残留中文。
   */
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["lib.explorerFailed", { error: "E1" }, "E1"],
    ["dataDir.createTargetFailed", { path: "D:\\AoE2Data", error: "E2" }, "D:\\AoE2Data"],
    ["index.taskFailed", { error: "E3" }, "E3"],
    ["session.threadFailed", { error: "E4" }, "E4"],
    ["session.coreFailed", { error: "E5" }, "E5"],
    ["session.interfaceUpgradeFailed", { error: "E6" }, "E6"],
    ["session.cookieManagerFailed", { error: "E7" }, "E7"],
    ["net.configInvalid", { error: "E8" }, "E8"],
  ];

  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("zh：8 个 code 都有文案，参数被填进去且不留协议/占位符", () => {
    for (const [code, params, expectParam] of cases) {
      const text = translateBackendMessage(ENVELOPE(code, params));
      expect(text, code).not.toContain("aoe2mm:err:");
      expect(text, code).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(text, code).toContain(expectParam);
    }
  });

  it("en / es / de / ru：同一批 code 不残留任何中文，参数仍然保留", () => {
    for (const locale of ["en", "es", "de", "ru"] as const) {
      applyLocale(locale);
      for (const [code, params, expectParam] of cases) {
        const text = translateBackendMessage(ENVELOPE(code, params));
        expect(text, `${locale}:${code}`).not.toContain("aoe2mm:err:");
        // `dataDir.createTargetFailed` 的 path 是 ASCII；其余参数也是 ASCII，
        // 因此这里只要结果里出现 CJK 就说明仍在走中文兜底 / 文案缺翻译。
        expect(text, `${locale}:${code}`).not.toMatch(/[\u4e00-\u9fff]/);
        expect(text, `${locale}:${code}`).toContain(expectParam);
      }
      applyLocale("zh");
    }
  });

  it("dataDir.createTargetFailed 同时保留 path 与 error 两个参数（不再被 createFailed 误标）", () => {
    applyLocale("en");
    const text = translateBackendMessage(
      ENVELOPE("dataDir.createTargetFailed", { path: "D:\\AoE2Data", error: "access denied" }),
    );
    expect(text).toContain("D:\\AoE2Data");
    expect(text).toContain("access denied");
    expect(text.toLowerCase()).toContain("directory");
    applyLocale("zh");
  });
});

describe("P2 迁移回归：新增 code 的参数与嵌套翻译", () => {
  /**
   * P2 这批是**新码**（语言包里原本没有），Rust 侧此前发中文 `format!` 串。
   * 三个必须验证的点：
   * 1. 三个参数的混合文案（`install.*`）一个都不能丢；
   * 2. 多数字（`session.cookieClearTimeout` 的 replies/total/deleted）不能被清零；
   * 3. 参数里套协议码（rollback / error / detail）必须递归翻成文案，而不是残留 `aoe2mm:err:`。
   */
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["lib.updateThreadFailed", { error: "E1" }, "E1"],
    ["lib.releaseThreadFailed", { error: "E2" }, "E2"],
    ["lib.scanThreadFailed", { error: "E3" }, "E3"],
    ["lib.presetThreadFailed", { error: "E4" }, "E4"],
    ["lib.openDataDirFailed", { error: "E5" }, "E5"],
    ["lib.logsDirLocateFailed", { error: "E6" }, "E6"],
    ["lib.logsDirCreateFailed", { path: "D:\\AoE2Logs", error: "E7" }, "D:\\AoE2Logs"],
    ["lib.logsDirOpenFailed", { error: "E8" }, "E8"],
    ["lib.diagnosticsReadFailed", { error: "E9" }, "E9"],
    ["dataDir.migrateThreadFailed", { error: "E10" }, "E10"],
    ["game.launchFailed", { error: "E11" }, "E11"],
    ["settings.gameRootSaveFailed", { error: "E12" }, "E12"],
    ["session.cookieClearTimeout", { replies: 1, total: 3, deleted: 0 }, "1/3"],
    ["session.cookieCountFailed", { error: "E13" }, "E13"],
    ["session.reloginNavigateFailed", { error: "E14" }, "E14"],
  ];

  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("zh：15 个单层 code 都有文案，参数填入且不留协议/占位符", () => {
    for (const [code, params, marker] of cases) {
      const text = translateBackendMessage(ENVELOPE(code, params));
      expect(text, code).not.toContain("aoe2mm:err:");
      expect(text, code).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(text, code).toContain(marker);
    }
  });

  it("en / es / de / ru：同一批 code 不残留中文，数字参数原样保留", () => {
    for (const locale of ["en", "es", "de", "ru"] as const) {
      applyLocale(locale);
      for (const [code, params, marker] of cases) {
        const text = translateBackendMessage(ENVELOPE(code, params));
        expect(text, `${locale}:${code}`).not.toContain("aoe2mm:err:");
        expect(text, `${locale}:${code}`).not.toMatch(/[\u4e00-\u9fff]/);
        expect(text, `${locale}:${code}`).toContain(marker);
      }
      applyLocale("zh");
    }
  });

  it("session.cookieClearTimeout 三个计数全部保留（不再退化成 “Timed out.”）", () => {
    applyLocale("en");
    const text = translateBackendMessage(
      ENVELOPE("session.cookieClearTimeout", { replies: 2, total: 3, deleted: 7 }),
    );
    expect(text).toContain("2/3");
    expect(text).toContain("7");
    expect(text.toLowerCase()).not.toBe("timed out.");
    applyLocale("zh");
  });

  it("install.statusWriteFailed 保留 path/error/retryError/rollback 四个参数", () => {
    applyLocale("en");
    const rollback = ENVELOPE("install.rolledBackToSubscribed", {});
    const text = translateBackendMessage(
      ENVELOPE("install.statusWriteFailed", {
        path: "D:\\AoE2DE\\local\\555_mod",
        error: "E-io",
        retryError: "E-retry",
        rollback,
      }),
    );
    expect(text).toContain("D:\\AoE2DE\\local\\555_mod");
    expect(text).toContain("E-io");
    expect(text).toContain("E-retry");
    expect(text).not.toContain("aoe2mm:err:");
    // rollback 是嵌套协议码，必须已翻成文案
    expect(text).not.toContain(rollback);
    applyLocale("zh");
  });

  it("install.statusRetryNote 的 note/rollback 两个嵌套码都被递归翻译", () => {
    applyLocale("en");
    const note = ENVELOPE("install.infoJsonFailed", { error: "N-inner" });
    const rollback = ENVELOPE("install.rollbackFailed", { error: "R-inner" });
    const text = translateBackendMessage(
      ENVELOPE("install.statusRetryNote", { note, error: "E-first", rollback }),
    );
    expect(text).toContain("N-inner");
    expect(text).toContain("R-inner");
    expect(text).toContain("E-first");
    expect(text).not.toContain("aoe2mm:err:");
    applyLocale("zh");
  });

  it("三层嵌套：logoutFailed{detail} → cookieClearTimeout / cacheClearFailed 逐段翻译", () => {
    applyLocale("en");
    const detail = [
      ENVELOPE("session.cookieClearTimeout", { replies: 1, total: 3, deleted: 0 }),
      ENVELOPE("session.cacheClearFailed", { error: "E-cache" }),
    ].join("；");
    const text = translateBackendMessage(ENVELOPE("session.logoutFailed", { detail }));
    expect(text).toContain("1/3");
    expect(text).toContain("E-cache");
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    applyLocale("zh");
  });
});

describe("协议解析边界专项（P2 验收）", () => {
  /**
   * `translateBackendMessage` 的解析顺序是：
   *   ① 整串按单条信封解析（要求 `:json` 合法）→ 成功即结束（参数里的「；」视为内容）
   *   ①a 失败才按 `；(?=aoe2mm:err:)` 拆段 → 每段递归
   *   ①b 仍只有一段时按宽松单条解析（JSON 坏了仍出文案，参数为空）
   *   ② zh 原样返回 ③ 非 zh 走整句锚定 + 片段兜底
   * 下面每条都直接打这个生产入口，不另写模拟解析器。
   */
  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("单条信封的 JSON 里含「；+协议前缀」时整串按一条解析，不被误拆", () => {
    // 参数值以中文开头：它是内容，不是嵌套码；若被拆段，第二段会被翻成
    // 「压缩包损坏…」且第一段 JSON 被截断 —— 用这个负向断言证明没有拆。
    const raw = ENVELOPE("install.zipOpenFailed", {
      error: '片段 A；aoe2mm:err:install.zipCorrupt:{"error":"B"} 结束',
    });
    const text = translateBackendMessage(raw);
    expect(text).toContain("片段 A；aoe2mm:err:install.zipCorrupt");
    expect(text).toContain("结束");
    expect(text).not.toContain("压缩包损坏");
  });

  it("JSON 参数值以前缀开头时按嵌套码递归翻译（一层，无参数）", () => {
    applyLocale("en");
    const raw = ENVELOPE("install.localizeFailed", {
      error: ENVELOPE("install.mkdirFailed", { error: "E-inner" }),
    });
    const text = translateBackendMessage(raw);
    expect(text).toContain("E-inner");
    expect(text.toLowerCase()).toContain("directory");
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    applyLocale("zh");
  });

  it("三层嵌套（信封→信封→信封）逐层翻译，最内层参数不丢", () => {
    applyLocale("en");
    const lvl1 = ENVELOPE("net.proxyEmpty", {});
    const lvl2 = ENVELOPE("session.cookieClearFailed", { error: lvl1, deleted: 3 });
    const text = translateBackendMessage(ENVELOPE("session.logoutFailed", { detail: lvl2 }));
    expect(text).toContain("3"); // 第三层的 deleted 没有被丢
    expect(text.toLowerCase()).toContain("proxy"); // 第三层 code 已翻成文案
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    applyLocale("zh");
  });

  it("多段：已知码与未知码混排时，未知码走 protocolUnknown 并保留 code", () => {
    const raw = [
      ENVELOPE("install.zipCorrupt", { error: "E1" }),
      ENVELOPE("install.noSuchCode"),
    ].join("；");
    const text = translateBackendMessage(raw);
    expect(text).toContain("E1");
    expect(text).toContain("install.noSuchCode"); // 保留 code 供反馈
    expect(text).not.toContain("aoe2mm:err:");
    // 两段都在：已知段文案 + 未知段文案
    expect(text).toContain("未识别的错误类型");
  });

  it("多段：一段合法、一段 JSON 损坏时互不影响，且不泄漏协议串", () => {
    const raw = [
      ENVELOPE("install.zipCorrupt", { error: "E1" }),
      "aoe2mm:err:install.mkdirFailed:{broken",
    ].join("；");
    const text = translateBackendMessage(raw);
    expect(text).toContain("E1");
    expect(text).toContain("创建目录失败");
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).not.toContain("{error}"); // 坏 JSON 只让占位符为空，不残留模板
  });

  it("空参数 / 缺失参数 / 额外参数都不会抛异常或泄漏占位符", () => {
    // 空对象：模板里的 {error} 渲染为空，不残留花括号
    const empty = translateBackendMessage(ENVELOPE("install.zipCorrupt", {}));
    expect(empty).not.toContain("aoe2mm:err:");
    expect(empty).not.toMatch(/\{[a-zA-Z]+\}/);

    // 四个参数全缺：不抛异常，也不把 {path}/{rollback} 之类模板字面量甩给用户
    const missing = translateBackendMessage(ENVELOPE("install.statusWriteFailed"));
    expect(missing).not.toContain("aoe2mm:err:");
    expect(missing).not.toMatch(/\{[a-zA-Z]+\}/);

    // 多出来的参数被忽略，不会拼接进用户可见文案
    const extra = translateBackendMessage(
      ENVELOPE("install.zipCorrupt", {
        error: "E1",
        EXTRA_TOKEN_9: "EXTRA-VALUE-9",
        nested: { deep: 1 },
        flag: true,
      }),
    );
    expect(extra).toContain("E1");
    expect(extra).not.toContain("EXTRA-VALUE-9");
    expect(extra).not.toContain("aoe2mm:err:");
  });

  it("参数值里带花括号按普通文本插值，不会被二次求值", () => {
    const text = translateBackendMessage(
      ENVELOPE("install.zipCorrupt", { error: "路径 C:\\{a}\\b" }),
    );
    expect(text).toContain("{a}");
    expect(text).not.toContain("aoe2mm:err:");
  });

  it("同一条 raw 在三语下各自渲染，切回中文结果与切换前一致", () => {
    const raw = ENVELOPE("install.statusWriteFailed", {
      path: "D:\\AoE2DE\\local\\777_mod",
      error: "E-io",
      retryError: "E-retry",
      rollback: ENVELOPE("install.rolledBackToSubscribed", {}),
    });

    const zhText = translateBackendMessage(raw);
    expect(zhText).toMatch(/[\u4e00-\u9fff]/);
    for (const marker of ["D:\\AoE2DE\\local\\777_mod", "E-io", "E-retry"]) {
      expect(zhText).toContain(marker);
    }
    expect(zhText).not.toContain("aoe2mm:err:");

    applyLocale("en");
    const enText = translateBackendMessage(raw);
    expect(enText).not.toMatch(/[\u4e00-\u9fff]/);
    for (const marker of ["D:\\AoE2DE\\local\\777_mod", "E-io", "E-retry"]) {
      expect(enText).toContain(marker);
    }

    applyLocale("es");
    const esText = translateBackendMessage(raw);
    expect(esText).not.toMatch(/[\u4e00-\u9fff]/);
    expect(esText).toContain("D:\\AoE2DE\\local\\777_mod");

    applyLocale("zh");
    expect(translateBackendMessage(raw)).toBe(zhText); // 切回来不丢、不变
  });

  it("中文界面下普通中文错误原样返回，不被关键词表整句替换", () => {
    // 这条串曾是 P2 的迁移对象（现由 session.cookieClearTimeout 承载）；
    // 中文界面必须原样返回，否则「1/3 个域、已删 0 条」这类诊断上下文会被吞。
    const raw = "清空 AoE Cookie 超时（1/3 个域已回，已删 0 条）";
    expect(translateBackendMessage(raw)).toBe(raw);
  });
});

describe("本地错误：raw 与翻译的职责分工（R2）", () => {
  beforeEach(() => applyLocale("en"));
  afterEach(() => applyLocale("zh"));

  it("normalizeError 只提取原文，不做翻译（存 ref 用）", () => {
    const raw = normalizeError(new Error(ENVELOPE("install.mkdirFailed", { error: "boom" })));
    expect(raw).toBe(ENVELOPE("install.mkdirFailed", { error: "boom" }));
  });

  it("normalizeBackendError 直接可用于 toast（已翻译）", () => {
    const text = normalizeBackendError(new Error(ENVELOPE("install.mkdirFailed", { error: "boom" })));
    expect(text).not.toContain("aoe2mm:err:");
    expect(text).toContain("boom");
  });

  it("未知对象兜底成 common.unknownError 文案，而不是协议串", () => {
    const text = normalizeBackendError({ weird: true });
    expect(text).not.toContain("labels.unknown");
    expect(text.length).toBeGreaterThan(0);
  });
});
