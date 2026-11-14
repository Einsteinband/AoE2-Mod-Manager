import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyLocale, translate } from "../index";
import {
  FALLBACK_TAGS,
  TAG_KEY_BY_ID,
  TAG_KEY_BY_NAME,
  TAG_RANK_BY_NAME,
  localizedTagName,
  tagLabel,
} from "../../online/types";
import zh from "../locales/zh";
import en from "../locales/en";
import es from "../locales/es";
import de from "../locales/de";
import ru from "../locales/ru";

/**
 * R3 回归：分类标签必须走语言包，五语齐全。
 *
 * 改造前的二值映射只有「中文 → 英文」：西语界面会退化成英文或中文原文，
 * 新增第四种语言还要再补一套映射表。这里的断言同时锁三件事：
 *   1. 显示文案来自 tagNames.*（五语都可切换）；
 *   2. 分类身份（筛选 / 排序用的原始名）不随界面语言变化；
 *   3. scan.rs 的所有兜底分类名都有对应 key，不会被漏掉。
 */

/** scan.rs 实际会发射的兜底分类名（本地特征推断） */
const SCAN_FALLBACK_NAMES = [
  "音频",
  "美术贴图",
  "材质",
  "数据表",
  "场景",
  "战役",
  "历史条目",
  "本地化",
  "界面 UI",
];

const officialNames = FALLBACK_TAGS.map((tag) => tag.modTypeName);

describe("tagNames 语言包完整性", () => {
  it("官方 17 项 id 都有 tagNames key", () => {
    expect(Object.keys(TAG_KEY_BY_ID)).toHaveLength(17);
    for (const tag of FALLBACK_TAGS) {
      expect(TAG_KEY_BY_ID[tag.modTypeId]).toBeTruthy();
    }
  });

  it("每个 key 在 zh / en / es / de / ru 中都有非空文案", () => {
    for (const key of Object.values(TAG_KEY_BY_ID)) {
      for (const tree of [zh, en, es, de, ru]) {
        const text = (tree.tagNames as Record<string, string>)[key];
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it("scan.rs 的兜底分类名全部能映射到 tagNames key", () => {
    for (const name of SCAN_FALLBACK_NAMES) {
      expect(TAG_KEY_BY_NAME[name], `缺少映射：${name}`).toBeTruthy();
    }
  });

  it("官方英文名也能映射（接口偶尔回英文名）", () => {
    for (const name of officialNames) {
      expect(TAG_KEY_BY_NAME[name], `缺少映射：${name}`).toBeTruthy();
    }
  });
});

describe("分类显示随界面语言切换，身份不变", () => {
  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("同一原始分类名在五语下显示各自文案", () => {
    const name = "美术贴图";
    expect(localizedTagName(name)).toBe("美术贴图");
    applyLocale("en");
    expect(localizedTagName(name)).toBe("Textures");
    applyLocale("es");
    expect(localizedTagName(name)).toBe("Texturas");
    applyLocale("de");
    expect(localizedTagName(name)).toBe("Texturen");
    applyLocale("ru");
    expect(localizedTagName(name)).toBe("Текстуры");
  });

  it("tagLabel 按官方 id 取文案（不依赖数据里存的名称）", () => {
    const tag = { modTypeId: 22, modTypeName: "User Interface" };
    expect(tagLabel(tag)).toBe("用户界面");
    applyLocale("es");
    expect(tagLabel(tag)).toBe("Interfaz de usuario");
    applyLocale("de");
    expect(tagLabel(tag)).toBe("Benutzeroberfläche");
    applyLocale("ru");
    expect(tagLabel(tag)).toBe("Интерфейс");
  });

  it("未知分类名原样返回，不吞掉数据", () => {
    expect(localizedTagName("某个自定义分类")).toBe("某个自定义分类");
    applyLocale("en");
    expect(localizedTagName("某个自定义分类")).toBe("某个自定义分类");
  });

  it("排序权重表的键仍是原始中文名（筛选身份不翻译）", () => {
    // 只看官方 17 项：键必须是数据层原始中文名，不能是英文/西语文案
    expect(Object.keys(TAG_RANK_BY_NAME)).toHaveLength(17);
    expect(TAG_RANK_BY_NAME["战役"]).toBeGreaterThanOrEqual(0);
    expect(Object.keys(TAG_RANK_BY_NAME).every((key) => /[\u4e00-\u9fff]/.test(key))).toBe(true);
  });

  it("语言包里确实存在对应的 tagNames 文案（防 key 拼错）", () => {
    expect(translate("tagNames.materials")).toBe("材质");
    applyLocale("en");
    expect(translate("tagNames.materials")).toBe("Materials");
    applyLocale("de");
    expect(translate("tagNames.materials")).toBe("Materialien");
    applyLocale("ru");
    expect(translate("tagNames.materials")).toBe("Материалы");
  });
});
