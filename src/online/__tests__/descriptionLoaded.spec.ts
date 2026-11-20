import { describe, expect, it } from "vitest";
import {
  canTranslateDescription,
  canTranslateText,
  hasTranslatableText,
  isDescriptionLoaded,
} from "../translation";

/**
 * 描述加载状态 + 标题/描述独立判断（纯函数回归）。
 *
 * 1) 加载态：null / undefined 才是未加载；"🙂" 这类符号是**已加载**的真实内容。
 * 2) 字段独立：标题可翻译时，描述为空 / 过短 / 未加载都不允许让翻译入口失效。
 * 3) 描述长度规则（MIN_DESC_CHARS）只保留在 canTranslateText，用来回答
 *    「描述这一个字段够不够拿去翻译」，不再决定整个模组能不能翻译。
 */
describe("isDescriptionLoaded", () => {
  it("null / undefined = 未加载", () => {
    expect(isDescriptionLoaded(null)).toBe(false);
    expect(isDescriptionLoaded(undefined)).toBe(false);
  });

  it("任何字符串（含符号 / 空串）= 已加载", () => {
    expect(isDescriptionLoaded("🙂")).toBe(true);
    expect(isDescriptionLoaded(":)")).toBe(true);
    expect(isDescriptionLoaded("?")).toBe(true);
    expect(isDescriptionLoaded("test")).toBe(true);
    expect(isDescriptionLoaded("")).toBe(true);
  });
});

describe("canTranslateDescription（只代表描述字段）", () => {
  it("有内容就提交描述，长短不在前端拦（后端既有规则决定是否真的翻）", () => {
    expect(canTranslateDescription("🙂")).toBe(true);
    expect(canTranslateDescription("👍")).toBe(true);
    expect(canTranslateDescription(":)")).toBe(true);
    expect(canTranslateDescription("test")).toBe(true);
    expect(canTranslateDescription("一段正常的中文描述")).toBe(true);
  });

  it("null / undefined / 空串 / 纯空白 = 没有可提交的描述", () => {
    expect(canTranslateDescription(null)).toBe(false);
    expect(canTranslateDescription(undefined)).toBe(false);
    expect(canTranslateDescription("")).toBe(false);
    expect(canTranslateDescription("   ")).toBe(false);
  });
});

describe("hasTranslatableText（标题与描述独立判断）", () => {
  it("正常标题 + 正常描述 → 可翻译", () => {
    expect(hasTranslatableText("Villager Highlighter", "Replaces the tech tree panel.")).toBe(true);
  });

  it("正常标题 + 🙂 描述 → 仍然可翻译（只翻标题）", () => {
    expect(hasTranslatableText("Villager Highlighter", "🙂")).toBe(true);
  });

  it("正常标题 + 空描述 → 仍然可翻译（只翻标题）", () => {
    expect(hasTranslatableText("Villager Highlighter", "")).toBe(true);
  });

  it("正常标题 + null / undefined 描述 → 仍然可翻译（不再等描述）", () => {
    expect(hasTranslatableText("Villager Highlighter", null)).toBe(true);
    expect(hasTranslatableText("Villager Highlighter", undefined)).toBe(true);
    expect(hasTranslatableText("Villager Highlighter")).toBe(true);
  });

  it("空标题 + 正常描述 → 描述仍可翻译", () => {
    expect(hasTranslatableText("", "Replaces the tech tree panel.")).toBe(true);
  });

  it("空标题 + 🙂 描述 → 描述有内容，不会变成「等待描述加载」", () => {
    expect(hasTranslatableText("", "🙂")).toBe(true);
    expect(isDescriptionLoaded("🙂")).toBe(true);
  });

  it("空标题 + 空描述 → 没有任何可翻译字段，才可置灰", () => {
    expect(hasTranslatableText("", "")).toBe(false);
    expect(hasTranslatableText(null, null)).toBe(false);
    expect(hasTranslatableText("   ", "  ")).toBe(false);
  });
});

describe("canTranslateText（描述字段长度规则保持原样）", () => {
  it("仍然按 MIN_DESC_CHARS 判断描述够不够翻译，供描述字段使用", () => {
    expect(canTranslateText("🙂")).toBe(false);
    expect(canTranslateText("test")).toBe(false);
    expect(canTranslateText("description")).toBe(true);
    expect(canTranslateText(null)).toBe(false);
  });
});
