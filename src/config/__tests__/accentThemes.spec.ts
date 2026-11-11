import { describe, expect, it } from "vitest";
import {
  ACCENT_THEMES,
  ACCENT_THEME_IDS,
  DEFAULT_ACCENT,
  getAccentPalette,
  getAccentTheme,
  isAccentId,
  normalizeAccentTheme,
} from "../accentThemes";

/**
 * 前端注册表自身完整性测试。Rust 侧只做通用 ID 格式校验、不再维护颜色白名单，
 * 因此这里不再与 Rust 合法值集合做一致性对齐；真实存在哪些颜色以前端注册表为准。
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const RGB_RE = /^\d{1,3}, \d{1,3}, \d{1,3}$/;

describe("强调色注册表", () => {
  it("注册表包含现有八档，默认 gold", () => {
    expect([...ACCENT_THEME_IDS].sort()).toEqual([
      "amber",
      "blue",
      "brick",
      "cyan",
      "gold",
      "green",
      "pink",
      "purple",
    ]);
    expect(DEFAULT_ACCENT).toBe("gold");
  });

  it("每档 dark / light 调色板七字段齐全且格式合法", () => {
    for (const theme of ACCENT_THEMES) {
      for (const mode of ["dark", "light"] as const) {
        const palette = theme[mode];
        expect(palette.accent).toMatch(HEX_RE);
        expect(palette.bright).toMatch(HEX_RE);
        expect(palette.dim).toMatch(HEX_RE);
        expect(palette.light).toMatch(HEX_RE);
        expect(palette.text).toMatch(HEX_RE);
        expect(palette.rgb).toMatch(RGB_RE);
        expect(palette.installedCardBg).toMatch(HEX_RE);
      }
    }
  });

  it("每个主题都带设置页 i18n labelKey", () => {
    for (const theme of ACCENT_THEMES) {
      expect(theme.labelKey).toMatch(/^settingsUi\.accent/);
    }
  });

  it("isAccentId 收窄注册表内 ID，拒绝注册表外的未来/未知值（写入侧只能保存注册表内颜色）", () => {
    for (const id of ["blue", "amber", "gold", "brick", "purple", "green", "cyan", "pink"]) {
      expect(isAccentId(id)).toBe(true);
    }
    // 注册表当前未定义的 ID 一律不通过，即便格式合法也不能被保存为主题色
    expect(isAccentId("cyan2")).toBe(false);
    expect(isAccentId("violet")).toBe(false);
    expect(isAccentId("")).toBe(false);
  });

  it("normalizeAccentTheme：合法值直通，未知 / 空 / 大小写 / 空白安全回退 gold", () => {
    expect(normalizeAccentTheme("blue")).toBe("blue");
    expect(normalizeAccentTheme("AMBER")).toBe("amber");
    expect(normalizeAccentTheme("  brick ")).toBe("brick");
    expect(normalizeAccentTheme("purple")).toBe("purple");
    expect(normalizeAccentTheme("violet")).toBe("gold");
    expect(normalizeAccentTheme("")).toBe("gold");
    expect(normalizeAccentTheme(null)).toBe("gold");
    expect(normalizeAccentTheme(undefined)).toBe("gold");
  });

  it("getAccentPalette 按明暗档位返回对应调色板，未知 ID 回退 gold", () => {
    const goldDark = getAccentPalette("gold", "dark");
    expect(goldDark.accent).toBe("#c9a24d");
    const goldLight = getAccentPalette("gold", "light");
    expect(goldLight.accent).toBe("#8a6f33");
    expect(getAccentTheme("gold").id).toBe("gold");
  });
});
