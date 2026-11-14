import { describe, it, expect, afterEach } from "vitest";
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  applyLocale,
  normalizeLocale,
  translate,
} from "../index";

/**
 * v0.6 五语注册回归。
 *
 * 语言注册是**目录驱动**的（`import.meta.glob("./locales/*.ts")` + 文件里的
 * `export const label`），所以新增语言不需要改 index.ts。但这恰恰意味着
 * 一旦文件没被 glob 到、`label` 写错或排序被破坏，界面上不会报错、只会
 * 悄悄少一个语言。这里把「注册结果」本身钉死：
 *   1. 五种语言全部出现在选择器里，且显示的是语言自身名称；
 *   2. en 永远排第一，其余按代码排序（行为与新增语言前一致）；
 *   3. `de-AT → de`、`ru-RU → ru` 这类区域变体回退到主语言。
 */

const EXPECTED = ["en", "de", "es", "ru", "zh"];

describe("语言注册：五语全部进入选择器", () => {
  afterEach(() => applyLocale(DEFAULT_LOCALE));

  it("选择器候选恰好是 en/de/es/ru/zh，且 en 在首位", () => {
    expect(AVAILABLE_LOCALES).toEqual(EXPECTED);
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual(EXPECTED);
    expect(LOCALE_OPTIONS[0].value).toBe(DEFAULT_LOCALE);
  });

  it("新增语言显示语言自身名称，不随当前界面语言变化", () => {
    const byCode = new Map(LOCALE_OPTIONS.map((option) => [option.value, option.label]));
    expect(byCode.get("de")).toBe("Deutsch");
    expect(byCode.get("ru")).toBe("Русский");

    // 切到德语 / 俄语界面后，选择器里的名字不能变成「德语」「俄语」的译名
    applyLocale("de");
    const deLabels = LOCALE_OPTIONS.map((option) => option.label);
    applyLocale("ru");
    expect(LOCALE_OPTIONS.map((option) => option.label)).toEqual(deLabels);
    expect(deLabels).toEqual(["English", "Deutsch", "Español", "Русский", "中文"]);
  });

  it("区域变体回退到主语言（de-AT → de、ru-RU → ru）", () => {
    expect(normalizeLocale("de-AT")).toBe("de");
    expect(normalizeLocale("de_CH")).toBe("de");
    expect(normalizeLocale("ru-RU")).toBe("ru");
    // 既有语言的既有行为不能被新语言带坏
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("es-419")).toBe("es");
    expect(normalizeLocale("nope")).toBeNull();
  });

  it("切换到 de / ru 后翻译取的是对应语言包", () => {
    applyLocale("de");
    const de = translate("nav.local");
    applyLocale("ru");
    const ru = translate("nav.local");
    applyLocale("zh");
    const zh = translate("nav.local");
    expect(de).not.toBe(ru);
    expect(zh).not.toBe(de);
    expect(de).not.toBe("nav.local");
    expect(ru).not.toBe("nav.local");
  });
});
