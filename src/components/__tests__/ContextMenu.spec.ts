import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ContextMenu from "../common/ContextMenu.vue";
import type { ContextMenuItem } from "../common/contextMenuTypes";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function makeItems(): ContextMenuItem[] {
  return [
    { id: "first", label: "First", icon: "⭐" },
    { id: "disabled", label: "Disabled", disabled: true },
    { id: "danger", label: "Delete", danger: true, dividerBefore: true },
  ];
}

describe("ContextMenu", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders item labels, icons, danger class and divider", () => {
    const wrapper = mount(ContextMenu, {
      props: { x: 40, y: 40, items: makeItems() },
    });
    const buttons = wrapper.findAll(".ctx-menu-item");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text()).toContain("First");
    expect(buttons[0].find(".ctx-menu-icon").text()).toBe("⭐");
    expect(buttons[1].attributes("disabled")).toBeDefined();
    expect(buttons[2].classes()).toContain("danger");
    expect(wrapper.findAll(".ctx-menu-divider")).toHaveLength(1);
  });

  it("emits select with item id on enabled click; disabled item does not", async () => {
    const wrapper = mount(ContextMenu, {
      props: { x: 40, y: 40, items: makeItems() },
    });
    const buttons = wrapper.findAll(".ctx-menu-item");
    await buttons[0].trigger("click");
    expect(wrapper.emitted("select")).toEqual([["first"]]);

    await buttons[1].trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
  });

  it("closes on outside mousedown", async () => {
    const wrapper = mount(ContextMenu, {
      props: { x: 40, y: 40, items: makeItems() },
    });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes on Escape", async () => {
    const wrapper = mount(ContextMenu, {
      props: { x: 40, y: 40, items: makeItems() },
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("moves between enabled items with ArrowDown and activates on Enter", async () => {
    const wrapper = mount(ContextMenu, {
      props: { x: 40, y: 40, items: makeItems() },
    });
    const root = wrapper.find(".ctx-menu");
    // 跳过 disabled 项：first → danger
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();
    let buttons = wrapper.findAll(".ctx-menu-item");
    expect(buttons[0].classes()).toContain("active");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();
    buttons = wrapper.findAll(".ctx-menu-item");
    expect(buttons[2].classes()).toContain("active");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("select")).toEqual([["danger"]]);
    expect(root.exists()).toBe(true);
  });
});
