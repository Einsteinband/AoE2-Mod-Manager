import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ModToolbar from "../common/ModToolbar.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${params.current}:${params.next}` : key,
  }),
}));

describe("ModToolbar online order control", () => {
  it("keeps the order model in v-model and toggles descending/ascending", async () => {
    const wrapper = mount(ModToolbar, {
      props: {
        order: "DESC",
        orderLabels: { desc: "Desc", asc: "Asc" },
        orderTitle: "Order",
      },
    });

    const button = wrapper.find(".order-toggle");
    expect(button.exists()).toBe(true);
    expect(button.attributes("aria-pressed")).toBe("true");
    expect(button.attributes("title")).toContain("Desc");

    await button.trigger("click");
    expect(wrapper.emitted("update:order")?.at(0)).toEqual(["ASC"]);

    await wrapper.setProps({ order: "ASC" });
    expect(wrapper.find(".order-toggle").attributes("aria-pressed")).toBe("false");
    expect(wrapper.find(".order-toggle").attributes("title")).toContain("Asc");

    await wrapper.find(".order-toggle").trigger("click");
    expect(wrapper.emitted("update:order")?.at(1)).toEqual(["DESC"]);
  });

  it("renders the order control as a pure SVG button inside the search box", () => {
    const wrapper = mount(ModToolbar, {
      props: {
        order: "DESC",
        orderLabels: { desc: "Desc", asc: "Asc" },
      },
    });

    const button = wrapper.find(".search-box .order-toggle");
    expect(button.exists()).toBe(true);
    expect(button.find("svg").exists()).toBe(true);
    expect(button.find("svg path").exists()).toBe(true);
    expect(button.text().trim()).toBe("");
  });

  it("does not render the order button when order labels are absent", () => {
    const wrapper = mount(ModToolbar, { props: { order: "DESC" } });
    expect(wrapper.find(".order-toggle").exists()).toBe(false);
    expect(wrapper.find('select[aria-label="Order"]').exists()).toBe(false);
  });
});
