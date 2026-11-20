import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { SourceFilter, StatusFilter } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  createI18n: () => ({
    global: { t: (key: string) => key, locale: { value: "zh" }, availableLocales: ["zh"] },
    install: () => undefined,
  }),
}));

import OnlineSidebar from "../online/OnlineSidebar.vue";

const onlineProps = {
  onlySubscribed: false,
  activeTag: null,
  tags: [],
  tagsError: null,
  session: null,
  netClearing: false,
  netError: null,
  netMessage: null,
};

const localProps: {
  sortMode: boolean;
  source: SourceFilter;
  status: StatusFilter;
  updatesOnly: boolean;
  updatesAvailableCount: number;
  activeTag: string | null;
  officialTagList: { name: string; count: number }[];
  inferredTagList: { name: string; count: number }[];
  sourceCounts: { all: number; local: number; subscribed: number; imported: number };
  statusCounts: { enabled: number; disabled: number; unknown: number; hidden: number };
} = {
  sortMode: false,
  source: "all",
  status: "all",
  updatesOnly: false,
  updatesAvailableCount: 0,
  activeTag: null,
  officialTagList: [],
  inferredTagList: [],
  sourceCounts: { all: 0, local: 0, subscribed: 0, imported: 0 },
  statusCounts: { enabled: 0, disabled: 0, unknown: 0, hidden: 0 },
};

/**
 * 网格 / 列表切换统一放在侧栏顶部；收藏入口改由顶栏 FavoritesNav 承载。
 * 本地页与在线页必须复用同一个 ViewSwitch，不再在侧栏渲染收藏入口。
 */
describe("侧栏顶部视图切换与收藏入口分离", () => {
  it("在线侧栏顶部渲染唯一一个视图切换，且不渲染收藏入口", () => {
    const wrapper = mount(OnlineSidebar, { props: onlineProps });

    expect(wrapper.findAll(".view-switch")).toHaveLength(1);
    expect(wrapper.findAll(".fav-nav-root")).toHaveLength(0);
    const html = wrapper.html();
    expect(html.indexOf("view-switch")).toBeLessThan(html.indexOf("side-title"));
  });

  it("点击列表视图只上抛 update:viewMode(list)，不触发在线筛选", async () => {
    const wrapper = mount(OnlineSidebar, { props: onlineProps });

    const listButton = wrapper.findAll(".view-btn")[1];
    await listButton.trigger("click");

    expect(wrapper.emitted("update:viewMode")).toEqual([["list"]]);
    expect(wrapper.emitted("pick-subscribed")).toBeUndefined();
    expect(wrapper.emitted("pick-tag")).toBeUndefined();
  });

  it("本地侧栏同样复用同一个顶部视图切换，不渲染收藏入口", async () => {
    const localSidebar = await import("../local/LocalSidebar.vue");
    const wrapper = mount(localSidebar.default, { props: localProps });

    expect(wrapper.findAll(".view-switch")).toHaveLength(1);
    expect(wrapper.findAll(".fav-nav-root")).toHaveLength(0);
  });
});
