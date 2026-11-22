import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join("src", "style.css"), "utf8");
const app = readFileSync(join("src", "App.vue"), "utf8");
const appearance = readFileSync(join("src", "components", "settings", "AppearanceTab.vue"), "utf8");
const modal = readFileSync(join("src", "components", "SettingsModal.vue"), "utf8");
const baseCard = readFileSync(join("src", "components", "base", "BaseModCard.vue"), "utf8");

/** 取以 `selector` 开头的规则块正文（允许选择器内部换行，用平铺空白归一化后匹配） */
function ruleBlock(selector: string): string | null {
  const normalizedCss = css.replace(/\s+/g, " ");
  const normalizedSelector = selector.replace(/\s+/g, " ");
  const pattern = new RegExp(`${normalizedSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "g");
  const match = pattern.exec(normalizedCss);
  if (!match) return null;
  const start = match.index ?? 0;
  const open = normalizedCss.indexOf("{", start);
  const close = normalizedCss.indexOf("}", open);
  return normalizedCss.slice(open, close + 1);
}

describe("已启用状态侧边栏：样式契约", () => {
  it("绿条与本地身份条同宿主、同宽 3px、同上下范围，用 --ok 且不拦截交互", () => {
    const block = ruleBlock(".card-body.is-installed > .card-enabled-bar");
    expect(block).not.toBeNull();
    expect(block).toContain("position: absolute;");
    expect(block).toContain("top: 0;");
    expect(block).toContain("bottom: 0;");
    expect(block).toContain("width: 3px;");
    expect(block).toContain("background: var(--ok);");
    expect(block).toContain("pointer-events: none;");
    expect(block).toContain("z-index: 0;");
  });

  it("关闭「已启用状态侧边栏」时整条隐藏", () => {
    const block = ruleBlock('html[data-enabled-card-bar="off"] .card-body.is-installed > .card-enabled-bar');
    expect(block).toContain("display: none;");
  });

  it("原有身份条可镜像到右侧", () => {
    const block = ruleBlock('html[data-installed-card-bar-side="right"] .card-body.is-installed::before');
    expect(block).toContain("left: auto;");
    expect(block).toContain("right: 0;");
  });

  it("绿条左右两侧各自贴边", () => {
    expect(ruleBlock('html[data-enabled-card-bar-side="left"] .card-body.is-installed > .card-enabled-bar')).toContain(
      "left: 0;",
    );
    expect(ruleBlock('html[data-enabled-card-bar-side="right"] .card-body.is-installed > .card-enabled-bar')).toContain(
      "right: 0;",
    );
  });

  it("同侧并排：原有条贴边，绿条内移 6px（3px 宽 + 3px 间距）", () => {
    const leftSame = ruleBlock(
      'html[data-installed-card-bar="on"][data-installed-card-bar-side="left"][data-enabled-card-bar-side="left"] .card-body.is-installed > .card-enabled-bar',
    );
    expect(leftSame).toContain("left: 6px;");
    const rightSame = ruleBlock(
      'html[data-installed-card-bar="on"][data-installed-card-bar-side="right"][data-enabled-card-bar-side="right"] .card-body.is-installed > .card-enabled-bar',
    );
    expect(rightSame).toContain("right: 6px;");
  });

  it("同侧并排规则必须先满足身份条开启，否则关闭后绿条仍会留在 6px 处", () => {
    expect(css).toContain(
      'html[data-installed-card-bar="on"][data-installed-card-bar-side="left"][data-enabled-card-bar-side="left"]',
    );
    expect(css).not.toMatch(
      /html\[data-installed-card-bar-side="left"\]\[data-enabled-card-bar-side="left"\]\s*\.card-body/,
    );
  });
});

describe("已启用状态侧边栏：设置与持久化契约", () => {
  it("App.vue 把两组设置写到 html data 属性并落到 localStorage（默认：身份条在左、绿条开启且在左）", () => {
    expect(app).toContain("root.dataset.installedCardBarSide");
    expect(app).toContain("root.dataset.enabledCardBar");
    expect(app).toContain("root.dataset.enabledCardBarSide");
    expect(app).toContain('const CARD_BAR_KEY = "aoe2mm:cardBarPrefs";');
    expect(app).toMatch(
      /const CARD_BAR_DEFAULTS: CardBarPrefs = \{[\s\S]*?installedSide: "left"[\s\S]*?enabledOn: true[\s\S]*?enabledSide: "left"[\s\S]*?\};/,
    );
    expect(app).toContain('v-model:installed-card-bar-side="installedCardBarSide"');
    expect(app).toContain('v-model:enabled-card-bar="enabledCardBar"');
    expect(app).toContain('v-model:enabled-card-bar-side="enabledCardBarSide"');
  });

  it("设置弹窗与外观页透传两组独立设置", () => {
    expect(modal).toContain('defineModel<boolean>("enabledCardBar", { default: true })');
    expect(modal).toContain('defineModel<string>("installedCardBarSide", { default: "left" })');
    expect(modal).toContain('defineModel<string>("enabledCardBarSide", { default: "left" })');
    expect(appearance).toContain('v-model="installedCardBarSide"');
    expect(appearance).toContain('v-model="enabledCardBar"');
    expect(appearance).toContain('v-model="enabledCardBarSide"');
  });

  it("开关关闭时位置下拉禁用，且两组各自独立", () => {
    expect(appearance).toContain(':disabled="!installedCardBar"');
    expect(appearance).toContain(':disabled="!enabledCardBar"');
    // 原有三个装饰开关仍然各自绑定，未被合并或替换
    expect(appearance).toContain('v-model="installedCardBg"');
    expect(appearance).toContain('v-model="installedCardBar"');
    expect(appearance).toContain('v-model="installedCardStripes"');
  });

  it("卡片信息区为附加竖条提供挂载点，且绿条只由 ModCard 按启用状态渲染", () => {
    expect(baseCard).toContain('<slot name="body-bar" />');
    const modCard = readFileSync(join("src", "components", "ModCard.vue"), "utf8");
    expect(modCard).toMatch(/<template #body-bar>[\s\S]*?class="card-enabled-bar"[\s\S]*?<\/template>/);
    expect(modCard).toContain('v-if="installed && mod.enabled === true"');
  });
});

describe("卡片信息区填满剩余高度（消除被拉伸卡片底部的浅色横条）", () => {
  it(".card-body 纵向可增长，卡片被网格行高拉伸时底色铺到卡片底边", () => {
    // 行首锚定，避开 `.card-grid.list-mode .card-body` 这种同名前缀匹配
    const block = css.match(/\n\.card-body \{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).toContain("flex: 1 1 auto;");
    // 不能被 0 增长覆盖：否则拉伸出来的高度会露出卡片自身渐变底（浅色主题 = 一条白条）
    expect(block).not.toContain("flex: 0 1 auto;");
    expect(block).toContain("overflow: hidden;");
  });

  it("列表模式仍是横排布局，保留自己的 flex 覆盖（填充不产生异常空白）", () => {
    const listBlock = ruleBlock(".card-grid.list-mode .card-body");
    expect(listBlock).not.toBeNull();
    expect(listBlock).toContain("flex: 1 1 auto;");
    expect(listBlock).toContain("flex-direction: row;");
  });
});

describe("卡片分隔线：纯装饰、不参与布局（默认显示）", () => {
  it("分隔线绝对定位、不占布局空间，位置由卡片字号推导", () => {
    const block = ruleBlock(".mod-card .card-body > .card-divider");
    expect(block).not.toBeNull();
    expect(block).toContain("position: absolute;");
    expect(block).toContain("height: 1px;");
    expect(block).toContain("left: 10px;");
    expect(block).toContain("right: 10px;");
    // 位置 = 9px 上内边距 + 标题区 2.88em + 半个行间距 3px
    expect(block).toContain("top: calc(9px + var(--card-font-size) * 2.88 + 3px);");
    expect(block).toContain("pointer-events: none;");
    // 不得参与 flex 布局（margin / flex 会改变卡片高度或信息区填充）
    expect(block).not.toContain("margin");
    expect(block).not.toContain("flex:");
  });

  it(".card-body 是分隔线的定位基准", () => {
    const body = css.match(/\n\.card-body \{[\s\S]*?\}/)?.[0] ?? "";
    expect(body).toContain("position: relative;");
  });

  it("设置项关闭时隐藏；列表模式（横排紧凑行）不画分隔线", () => {
    expect(ruleBlock('html[data-card-divider="off"] .mod-card .card-body > .card-divider')).toContain(
      "display: none;",
    );
    expect(ruleBlock(".card-grid.list-mode .card-divider")).toContain("display: none;");
  });

  it("底座在标题与底部操作行之间渲染分隔线元素（装饰性、无障碍隐藏）", () => {
    expect(baseCard).toContain('<span class="card-divider" aria-hidden="true"></span>');
    const titleIdx = baseCard.indexOf('<div class="card-title"');
    const dividerIdx = baseCard.indexOf('<span class="card-divider"');
    const metaTopIdx = baseCard.indexOf('class="card-meta meta-top"');
    expect(dividerIdx).toBeGreaterThan(titleIdx);
    expect(dividerIdx).toBeLessThan(metaTopIdx);
  });

  it("默认显示：偏好默认 true，坏值回落 true，并写到 html data 属性", () => {
    expect(app).toContain("root.dataset.cardDivider = next.dividerOn ? \"on\" : \"off\";");
    expect(app).toMatch(/dividerOn: typeof parsed\?\.dividerOn === "boolean" \? parsed\.dividerOn : true/);
    expect(app).toMatch(/dividerOn: true,/);
    expect(app).toContain('v-model:card-divider="cardDivider"');
    expect(modal).toContain('defineModel<boolean>("cardDivider", { default: true })');
    expect(appearance).toContain('v-model="cardDivider"');
    expect(appearance).toContain('t("settingsUi.cardDividerGroupTitle")');
    expect(appearance).toContain('t("settingsUi.cardDividerShowTitle")');
  });

  it("分隔线规则不使用 !important", () => {
    expect(ruleBlock(".mod-card .card-body > .card-divider")).not.toContain("!important");
  });
});

describe("「回到列表顶部」按钮：设置项（默认开启，可关）", () => {
  it("关闭时整颗按钮立即隐藏，且规则不使用 !important", () => {
    const block = ruleBlock('html[data-back-to-top="off"] .back-to-top');
    expect(block).not.toBeNull();
    expect(block).toContain("display: none;");
    expect(block).not.toContain("!important");
  });

  it("偏好默认 true、坏值回落 true，并写到 html data 属性、经 v-model 接线", () => {
    expect(app).toContain('root.dataset.backToTop = next.backToTopOn ? "on" : "off";');
    expect(app).toMatch(/backToTopOn: typeof parsed\?\.backToTopOn === "boolean" \? parsed\.backToTopOn : true/);
    expect(app).toMatch(/backToTopOn: true,/);
    expect(app).toContain('v-model:back-to-top="backToTopOn"');
    expect(modal).toContain('defineModel<boolean>("backToTop", { default: true })');
    expect(modal).toMatch(/provide\("appearanceSettings"[\s\S]*?backToTop,/);
    expect(appearance).toContain('v-model="backToTop"');
    expect(appearance).toContain('t("settingsUi.backToTopGroupTitle")');
    expect(appearance).toContain('t("settingsUi.backToTopShowTitle")');
  });

  it("五语都提供该分组的标题 / 说明 / 开关文案", () => {
    for (const lang of ["zh", "en", "es", "de", "ru"]) {
      const text = readFileSync(join("src", "i18n", "locales", `${lang}.ts`), "utf8");
      expect(text).toMatch(/backToTopGroupTitle: "[^"]+"/);
      expect(text).toMatch(/backToTopGroupNote: "[^"]+"/);
      expect(text).toMatch(/backToTopShowTitle: "[^"]+"/);
    }
  });

  it("关掉开关不影响按钮自身的滚动逻辑（组件里不读偏好，纯由样式隐藏）", () => {
    const backToTopVue = readFileSync(join("src", "components", "common", "BackToTop.vue"), "utf8");
    expect(backToTopVue).not.toContain("backToTopOn");
    expect(backToTopVue).not.toContain("data-back-to-top");
  });
});
