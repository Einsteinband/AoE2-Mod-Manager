import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import BackToTop from "../common/BackToTop.vue";
import ModGrid from "../common/ModGrid.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const modGrid = readFileSync(join("src", "components", "common", "ModGrid.vue"), "utf8");
const pageShell = readFileSync(join("src", "components", "layout", "PageShell.vue"), "utf8");
const backToTop = readFileSync(join("src", "components", "common", "BackToTop.vue"), "utf8");
const downloader = readFileSync(join("src", "components", "DownloadManager.vue"), "utf8");
const styleCss = readFileSync(join("src", "style.css"), "utf8");

/** 取组件 scoped style 里以 `selector {` 开头的规则块 */
function cssBlock(source: string, selector: string): string {
  const match = source.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m"));
  expect(match).not.toBeNull();
  const open = (match?.index ?? 0) + (match?.[0].length ?? 0) - 1;
  const close = source.indexOf("}", open);
  return source.slice(open, close + 1);
}

/** jsdom 没有真实滚动：造一个可写 scrollTop + 可断言的 scrollTo 的目标容器 */
function makeScroller(initialTop = 0) {
  const el = document.createElement("div");
  let top = initialTop;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => { top = v; },
    configurable: true,
  });
  const scrollTo = vi.fn();
  (el as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
  return { el, scrollTo, setTop: (v: number) => { top = v; } };
}

function mountButton(target: HTMLElement | null) {
  return mount(BackToTop, { props: { target } });
}

describe("回到顶部按钮：位置与外观契约", () => {
  it("绝对定位挂在列表区域（.content）里，水平居中、贴列表下沿，不是右下角", () => {
    const block = cssBlock(backToTop, ".back-to-top");
    expect(block).toContain("position: absolute;");
    expect(block).toContain("left: 50%;");
    expect(block).toContain("transform: translateX(-50%);");
    expect(block).toContain("bottom: 10px;");
    // 不得出现右下角固定的写法
    expect(block).not.toContain("right:");
    expect(block).not.toContain("position: fixed;");
  });

  it("层级低于下载管理悬浮按钮，不抢它的位置", () => {
    expect(cssBlock(backToTop, ".back-to-top")).toContain("z-index: 20;");
    expect(cssBlock(downloader, ".dlmgr")).toContain("z-index: 55;");
  });

  it("加宽后的圆角矩形：64×24、圆角 12、半透明表面（能透出卡片）", () => {
    const block = cssBlock(backToTop, ".back-to-top");
    expect(block).toContain("border-radius: 12px;");
    expect(block).toContain("width: 64px;");
    expect(block).toContain("height: 24px;");
    // 半透明表面走主题变量，不在组件里写死颜色
    expect(block).toContain("background: var(--back-to-top-bg);");
    expect(block).not.toContain("linear-gradient(180deg, var(--bg-grad-top)");
    expect(cssBlock(backToTop, ".back-to-top:hover")).toContain(
      "background: var(--back-to-top-bg-hover);",
    );
    // 两个主题都必须定义半透明表面（42% ≈ 0.42）
    const darkVar = cssBlock(styleCss, ":root");
    const lightVar = cssBlock(styleCss, 'html[data-theme="light"]');
    expect(darkVar).toContain("--back-to-top-bg: rgba(");
    expect(darkVar).toMatch(/--back-to-top-bg: rgba\([^)]*0\.42\)/);
    expect(lightVar).toContain("--back-to-top-bg: rgba(");
    expect(lightVar).toMatch(/--back-to-top-bg: rgba\([^)]*0\.42\)/);
  });

  it("图标只有两笔折线（无竖线），不使用 ↑ 之类的字符", () => {
    expect(backToTop).toContain('<svg viewBox="0 0 24 24" aria-hidden="true">');
    expect(backToTop).toContain("stroke-linecap: round;");
    // 只有一个 path，且不含任何竖直主干
    const svgPathCount = (backToTop.match(/<path/g) ?? []).length;
    expect(svgPathCount).toBe(1);
    expect(backToTop).not.toMatch(/d="M12 19\.2V6/);
    expect(backToTop).not.toContain("V6");
    // 模板里不能出现文字箭头字符 / 插值文字
    expect(backToTop).not.toContain("↑");
    expect(backToTop).not.toContain("⇧");
    expect(backToTop).not.toContain("回到顶部</");
  });

  it("无障碍：原生 button + title / aria-label + 图标对屏幕阅读器隐藏", () => {
    expect(backToTop).toContain('type="button"');
    expect(backToTop).toContain(':title="t(\'content.backToTop\')"');
    expect(backToTop).toContain(':aria-label="t(\'content.backToTop\')"');
  });

  it("定位基准：三栏骨架的 .content 已经是 position: relative", () => {
    expect(cssBlock(pageShell, ".content")).toContain("position: relative;");
  });

  it("ModGrid 把按钮渲染在滚动容器之外，不进卡片 Grid", () => {
    const gridClose = modGrid.indexOf("</div>");
    const btn = modGrid.indexOf("<BackToTop");
    expect(btn).toBeGreaterThan(gridClose);
    expect(modGrid).toContain('<BackToTop :target="scrollEl" />');
    // 「不属于 Grid」由下方 DOM 用例保证（.card-grid 内找不到按钮）
  });

  it("五语都提供 content.backToTop 文案", () => {
    for (const lang of ["zh", "en", "es", "de", "ru"]) {
      const text = readFileSync(join("src", "i18n", "locales", `${lang}.ts`), "utf8");
      expect(text).toMatch(/backToTop: "[^"]+"/);
    }
  });
});

describe("回到顶部按钮：显隐与滚动行为", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("目标为空时不渲染按钮", () => {
    expect(mountButton(null).find(".back-to-top").exists()).toBe(false);
  });

  it("顶部时隐藏，向下滚动超过阈值才出现", async () => {
    const { el, setTop } = makeScroller(0);
    const wrapper = mountButton(el);
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(false);

    setTop(600);
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(true);

    setTop(0);
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(false);
  });

  it("点击后对真实滚动容器做平滑回顶（不是 window.scrollTo），并立即隐藏", async () => {
    const { el, scrollTo, setTop } = makeScroller(800);
    const windowSpy = vi.spyOn(window, "scrollTo");
    const wrapper = mountButton(el);
    await nextTick();
    const btn = wrapper.find(".back-to-top");
    expect(btn.exists()).toBe(true);

    await btn.trigger("click");
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(windowSpy).not.toHaveBeenCalled();
    setTop(0);
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(false);
  });

  it("容器切换时解绑旧监听，旧容器滚动不再影响显隐", async () => {
    const first = makeScroller(900);
    const second = makeScroller(0);
    const wrapper = mountButton(first.el);
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(true);

    await wrapper.setProps({ target: second.el });
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(false);

    first.el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find(".back-to-top").exists()).toBe(false);
  });

  it("ModGrid 挂载后按钮默认隐藏（列表在顶部），且不占 Grid 单元格", async () => {
    const wrapper = mount(ModGrid, { props: { viewMode: "grid", cardSize: 200 } });
    await nextTick();
    expect(wrapper.find(".grid-scroll").exists()).toBe(true);
    expect(wrapper.find(".back-to-top").exists()).toBe(false);
    expect(wrapper.find(".card-grid").find(".back-to-top").exists()).toBe(false);
    expect(wrapper.findComponent(BackToTop).exists()).toBe(true);
  });
});
