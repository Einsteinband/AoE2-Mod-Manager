import { flushPromises, shallowMount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import AppShell from "../layout/AppShell.vue";
import TopBar from "../layout/TopBar.vue";

vi.mock("../StatusBar.vue", () => ({ default: { template: "<div />" } }));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref("zh") }),
}));

describe("AppShell topbar stage propagation", () => {
  it("maps view-icon and compact stages onto the application layout root", async () => {
    const wrapper = shallowMount(AppShell, { props: { mode: "local" } });

    expect(wrapper.classes("is-view-icon")).toBe(false);
    expect(wrapper.classes("is-compact")).toBe(false);

    await wrapper.findComponent(TopBar).vm.$emit("stage-change", "view-icon");
    await flushPromises();
    expect(wrapper.classes("is-view-icon")).toBe(true);
    expect(wrapper.classes("is-compact")).toBe(false);

    await wrapper.findComponent(TopBar).vm.$emit("stage-change", "compact");
    await flushPromises();
    expect(wrapper.classes("is-view-icon")).toBe(false);
    expect(wrapper.classes("is-compact")).toBe(true);
  });
});
