import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENT_THEMES } from "../../config/accentThemes";

const css = readFileSync(join("src", "style.css"), "utf8");
const accentById = new Map(ACCENT_THEMES.map((theme) => [theme.id, theme]));
const onlineCard = readFileSync(join("src", "components", "OnlineModCard.vue"), "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`^${escaped}\\s*\\{`, "m"));
  expect(ruleMatch).not.toBeNull();
  const openIndex = (ruleMatch?.index ?? 0) + (ruleMatch?.[0].length ?? 0) - 1;
  const closeIndex = css.indexOf("}", openIndex);
  return css.slice(openIndex, closeIndex + 1);
}

function expectToken(selector: string, expected: string) {
  const block = cssBlock(selector);
  expect(block).toContain(`--installed-card-bg: ${expected};`);
}

describe("已安装卡片信息区主题 Token", () => {
  it("默认金档深浅主题分别定义专用背景", () => {
    expectToken(":root", "#30281a");
    expectToken('html[data-theme="light"]', "#eee2c4");
  });

  it("蓝、琥珀、砖红的深色与浅色档位专用不透明背景由注册表提供（色值锁死，不漂移）", () => {
    expect(accentById.get("blue")!.dark.installedCardBg).toBe("#243344");
    expect(accentById.get("blue")!.light.installedCardBg).toBe("#d8e7f3");
    expect(accentById.get("amber")!.dark.installedCardBg).toBe("#332717");
    expect(accentById.get("amber")!.light.installedCardBg).toBe("#f2e2ca");
    expect(accentById.get("brick")!.dark.installedCardBg).toBe("#32221e");
    expect(accentById.get("brick")!.light.installedCardBg).toBe("#f0d9d4");
  });

  it("卡片规则统一消费专用变量，不残留旧绿色表面变量", () => {
    const installedBody = cssBlock(".card-body.is-installed");
    expect(installedBody).toContain("background: var(--installed-card-bg);");
    expect(css).not.toContain("--installed-surface");
    expect(installedBody).not.toMatch(/rgba\(|gradient|backdrop-filter|blur/);
  });

  it("C 方案左侧标识条使用当前 accent 且不拦截交互", () => {
    const root = cssBlock(":root");
    expect(root).toContain("--installed-mark-bar: var(--accent);");
    expect(root).toContain("--installed-mark-stripe: var(--accent-dim);");

    const markBar = cssBlock(".card-body.is-installed::before");
    expect(markBar).toContain("width: 3px;");
    expect(markBar).toContain("background: var(--installed-mark-bar);");
    expect(markBar).toContain("pointer-events: none;");
  });

  it("角落斜纹为缩小后的低对比装饰层，不覆盖交互内容", () => {
    const cornerMark = cssBlock(".card-body.is-installed::after");
    expect(cornerMark).toContain("width: 18px;");
    expect(cornerMark).toContain("height: 18px;");
    expect(cornerMark).toContain("var(--installed-mark-stripe) 0 1.4px,");
    expect(cornerMark).toContain("transparent 1.4px 4.2px");
    expect(cornerMark).toContain("clip-path: polygon(100% 0, 100% 100%, 0 100%);");
    expect(cornerMark).toContain("pointer-events: none;");

    const contentLayer = cssBlock(".card-body.is-installed > *");
    expect(contentLayer).toContain("position: relative;");
    expect(contentLayer).toContain("z-index: 1;");
  });

  it("三个装饰开关可分别关闭，且只隐藏对应视觉层", () => {
    const bgOff = cssBlock('html[data-installed-card-bg="off"] .card-body.is-installed');
    expect(bgOff).toContain("background: transparent;");

    const barOff = cssBlock('html[data-installed-card-bar="off"] .card-body.is-installed::before');
    expect(barOff).toContain("display: none;");

    const stripesOff = cssBlock('html[data-installed-card-stripes="off"] .card-body.is-installed::after');
    expect(stripesOff).toContain("display: none;");
  });

  it("封面右上角已安装角标继续使用成功语义表面色", () => {
    const installedBadge = onlineCard.match(/\.badge\.installed\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(installedBadge).toContain("background: var(--ok-surface-top);");
    expect(installedBadge).toContain("border-color: var(--ok-border);");
  });
});
