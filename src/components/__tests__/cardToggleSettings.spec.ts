import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  CARD_TOGGLE_DEFAULTS,
  cardTogglePrefs,
  normalizeCardTogglePrefs,
  setCardTogglePrefs,
} from "../../composables/local/cardTogglePrefs";

const modCard = readFileSync(join("src", "components", "ModCard.vue"), "utf8");
const baseCard = readFileSync(join("src", "components", "base", "BaseModCard.vue"), "utf8");
const styleCss = readFileSync(join("src", "style.css"), "utf8");
const appearance = readFileSync(join("src", "components", "settings", "AppearanceTab.vue"), "utf8");
const prefsSource = readFileSync(join("src", "composables", "local", "cardTogglePrefs.ts"), "utf8");

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^${escaped} \\{`, "m"));
  expect(match).not.toBeNull();
  const open = (match?.index ?? 0) + (match?.[0].length ?? 0) - 1;
  const close = source.indexOf("}", open);
  return source.slice(open, close + 1);
}

describe("启用/禁用按钮偏好：默认值与持久化", () => {
  beforeEach(() => {
    setCardTogglePrefs(CARD_TOGGLE_DEFAULTS);
  });

  it("出厂默认：不显示按钮；样式默认仍是原有圆形按钮", () => {
    expect(CARD_TOGGLE_DEFAULTS).toEqual({ show: false, style: "circle" });
    expect(cardTogglePrefs.show).toBe(false);
    expect(cardTogglePrefs.style).toBe("circle");
  });

  it("坏值一律回落：show 非布尔 → 关闭，style 非 switch → 圆形", () => {
    expect(normalizeCardTogglePrefs(null)).toEqual({ show: false, style: "circle" });
    expect(normalizeCardTogglePrefs({ show: "no", style: "squircle" })).toEqual({
      show: false,
      style: "circle",
    });
    expect(normalizeCardTogglePrefs({ show: true, style: "switch" })).toEqual({
      show: true,
      style: "switch",
    });
  });

  it("关闭显示不清掉已选样式，再次开启即恢复", () => {
    setCardTogglePrefs({ show: true, style: "switch" });
    setCardTogglePrefs({ show: false });
    expect(cardTogglePrefs).toMatchObject({ show: false, style: "switch" });
    setCardTogglePrefs({ show: true });
    expect(cardTogglePrefs).toMatchObject({ show: true, style: "switch" });
  });

  it("只用一个 localStorage 键，与 settings.json / 侧边栏配置互不干扰", () => {
    expect(prefsSource).toContain('const STORAGE_KEY = "aoe2mm:cardTogglePrefs";');
    expect(prefsSource).toContain("window.localStorage.setItem(");
    expect(prefsSource).not.toContain("save_installed_card_decor_prefs");
    expect(prefsSource).not.toContain("cardBarPrefs");
  });
});

describe("启用/禁用按钮：组件与设置界面契约", () => {
  it("ModCard 保留两种控件样式，并由设置切换外观类名（业务逻辑共用一处）", () => {
    expect(modCard).toContain('cardTogglePrefs.style === "switch" ? "card-switch" : "card-toggle"');
    expect(modCard).toContain(':class="toggleControlClass"');
    expect(modCard).toContain('v-if="!uninstalled && cardTogglePrefs.show"');
    // 只有一个 toggleEnabled 调用点，没有第二套读写逻辑
    expect(modCard.match(/toggleEnabled/g) ?? []).toHaveLength(2); // 定义 + 绑定各一次
  });

  it("原有圆形按钮样式完整保留（绿勾 / 灰杠 / 虚线未知 / 缩放悬停）", () => {
    const base = cssBlock(modCard, ".card-toggle");
    expect(base).toContain("width: 18px;");
    expect(base).toContain("height: 18px;");
    expect(base).toContain("border-radius: 50%;");
    const on = cssBlock(modCard, ".card-toggle.on");
    expect(on).toContain("background: var(--ok);");
    expect(on).toContain("border-color: var(--ok-border-bright);");
    const off = cssBlock(modCard, ".card-toggle.off");
    expect(off).toContain("background: var(--panel-hi);");
    expect(off).toContain("border-color: var(--switch-off-border);");
    const unknown = cssBlock(modCard, ".card-toggle.unknown");
    expect(unknown).toContain("border-style: dashed;");
    expect(modCard).toContain(".card-toggle:hover {");
    expect(modCard).toContain("transform: scale(1.14);");
  });

  it("Apple 风格开关样式未被改动（36×20 / 16px 滑块 / 0.18s 曲线）", () => {
    const base = cssBlock(modCard, ".card-switch");
    expect(base).toContain("width: 36px;");
    expect(base).toContain("height: 20px;");
    const knob = cssBlock(modCard, ".card-switch-knob");
    expect(knob).toContain("width: 16px;");
    expect(knob).toContain("transition: transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);");
  });

  it("设置页用左右切换式分段控件选样式，不用下拉菜单", () => {
    expect(appearance).toContain('class="card-toggle-seg"');
    expect(appearance).toContain('@click="setCardToggleStyle(\'circle\')"');
    expect(appearance).toContain('@click="setCardToggleStyle(\'switch\')"');
    expect(appearance).toContain(':aria-pressed="cardToggleStyle === \'circle\'"');
    // 样式选择区域不得出现 select
    const styleRowStart = appearance.indexOf('t("settingsUi.cardToggleStyleTitle")');
    expect(styleRowStart).toBeGreaterThan(0);
    const styleRowChunk = appearance.slice(styleRowStart, styleRowStart + 900);
    expect(styleRowChunk).not.toContain("<select");
  });

  it("设置页显示开关绑定同一个全局单例，两组设置分别保存", () => {
    expect(appearance).toContain('v-model="cardToggleShow"');
    expect(appearance).toContain("setCardTogglePrefs({ show: val })");
    expect(appearance).toContain("setCardTogglePrefs({ style })");
  });
});

describe("底部操作行：控件显隐不改变卡片高度，安装时间不左移", () => {
  it("底部操作行由 --card-action-row-height 固定高度（≥ Apple 开关 20px）", () => {
    expect(styleCss).toContain("--card-action-row-height: 20px;");
    const row = cssBlock(styleCss, ".card-meta.meta-top");
    expect(row).toContain("min-height: var(--card-action-row-height);");
    // 行高必须容纳最高的控件（Apple 开关 20px），否则该行会被控件撑高、另外两种状态又变矮
    const switchBox = cssBlock(modCard, ".card-switch");
    expect(switchBox).toContain("height: 20px;");
  });

  it("显示开关只门控控件元素，不门控底部操作行本身", () => {
    // 控件在 meta-top 槽内部被 v-if 门控；<template #meta-top> 这一层永远渲染
    expect(modCard).toMatch(/<template\s+#meta-top\s*>/);
    const metaTopStart = modCard.indexOf("<template #meta-top>");
    expect(metaTopStart).toBeGreaterThan(0);
    const chunk = modCard.slice(metaTopStart, metaTopStart + 1200);
    expect(chunk).toContain('v-if="!uninstalled && cardTogglePrefs.show"');
    // 底座无条件渲染这一行（只要调用方给了槽）
    expect(baseCard).toContain("v-if=\"$slots['meta-top']\" class=\"card-meta meta-top\"");
  });

  it("安装时间用 margin-left:auto 锚定行末，控件隐藏时不会左移", () => {
    const time = cssBlock(modCard, ".card-installed-time");
    expect(time).toContain("margin-left: auto;");
  });

  it("安装时间用 --muted（二级信息），不得退回 --text-dim（暗色主题下看不清）", () => {
    const time = cssBlock(modCard, ".card-installed-time");
    expect(time).toContain("color: var(--muted);");
    expect(time).not.toContain("color: var(--text-dim);");
    // 与同卡片里的 ID / 作者行同色：.card-meta 的 color 就是 --muted
    expect(cssBlock(styleCss, ".card-meta")).toContain("color: var(--muted);");
  });
});
