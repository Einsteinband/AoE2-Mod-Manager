import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ViewSwitch from "../common/ViewSwitch.vue";
import viewSwitchSrc from "../common/ViewSwitch.vue?raw";
import favoritesSrc from "../favorites/FavoritesBrowser.vue?raw";
import localSrc from "../local/LocalSidebar.vue?raw";
import onlineSrc from "../online/OnlineSidebar.vue?raw";

describe("ViewSwitch 窄容器收缩（图标态）", () => {
  it("两个按钮都保留 tooltip 与独立的 aria-label：文字隐藏后仍有明确含义", () => {
    const wrapper = mount(ViewSwitch, { props: { viewMode: "grid" } });
    const buttons = wrapper.findAll(".view-btn");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].attributes("title")).toBe("toolbar.viewToGrid");
    expect(buttons[0].attributes("aria-label")).toBe("viewSwitch.grid");
    expect(buttons[1].attributes("title")).toBe("toolbar.viewToList");
    expect(buttons[1].attributes("aria-label")).toBe("viewSwitch.list");
  });

  it("文字节点始终渲染，隐藏只发生在样式层", () => {
    const wrapper = mount(ViewSwitch, { props: { viewMode: "grid" } });
    expect(wrapper.findAll(".view-text")).toHaveLength(2);
  });

  it("选中态由 viewMode 驱动，点击只切换视图不改变其他状态", async () => {
    const wrapper = mount(ViewSwitch, { props: { viewMode: "grid" } });
    const buttons = wrapper.findAll(".view-btn");
    expect(buttons[0].attributes("aria-pressed")).toBe("true");
    expect(buttons[1].attributes("aria-pressed")).toBe("false");
    expect(buttons[0].classes()).toContain("active");

    await buttons[1].trigger("click");
    // 除原生 click 外只抛 update:viewMode 一个事件，不夹带任何副作用
    const customEmits = Object.keys(wrapper.emitted()).filter((k) => k !== "click");
    expect(customEmits).toEqual(["update:viewMode"]);
    expect(wrapper.emitted("update:viewMode")?.[0]).toEqual(["list"]);

    // 父层回填后选中态随之切换
    await wrapper.setProps({ viewMode: "list" });
    const after = wrapper.findAll(".view-btn");
    expect(after[0].attributes("aria-pressed")).toBe("false");
    expect(after[1].attributes("aria-pressed")).toBe("true");
    expect(after[1].classes()).toContain("active");
  });

  it("收缩基准来自侧栏容器，阈值作用在控件自身样式上", () => {
    expect(viewSwitchSrc).toContain("@container (max-width: 160px)");
    expect(viewSwitchSrc).toMatch(/@container \(max-width: 160px\) \{[\s\S]*?\.view-text \{[\s\S]*?display: none;/);

    for (const src of [favoritesSrc, localSrc, onlineSrc]) {
      expect(src).toMatch(/\.sidebar-top \{[\s\S]*?container-type: inline-size;/);
    }
  });
});
