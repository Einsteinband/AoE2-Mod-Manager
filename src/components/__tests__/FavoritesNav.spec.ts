import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import type { ModEntry } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const entries = ref<ModEntry[]>([]);
const scope = ref<"all" | "installed" | "uninstalled">("all");

vi.mock("../../favorites/useFavorites", () => ({
  useFavorites: () => ({
    entries,
    scope,
  }),
}));

import FavoritesNav from "../favorites/FavoritesNav.vue";

function mountNav(active = false) {
  return mount(FavoritesNav, { props: { active } });
}

describe("FavoritesNav：收藏一级入口，内部不再有本地 / 在线二级分类", () => {
  beforeEach(() => {
    entries.value = [];
    scope.value = "all";
  });

  it("只显示收藏总数，不渲染任何二级分类", () => {
    entries.value = [{ id: "favorite:1" } as ModEntry, { id: "favorite:2" } as ModEntry];
    const wrapper = mountNav();
    expect(wrapper.findAll(".count").map((n) => n.text())).toEqual(["2"]);
    const labels = wrapper.findAll(".label").map((n) => n.text());
    expect(labels).toEqual(["⭐ favorites.groupTitle"]);
    expect(wrapper.find(".fav-nav-children").exists()).toBe(false);
    expect(wrapper.find(".fav-nav-child").exists()).toBe(false);
    expect(wrapper.find(".fav-nav-caret").exists()).toBe(false);
  });

  it("点击一级行直接进入收藏全部分类（无论当前是否已在收藏页）", async () => {
    const fromLocal = mountNav(false);
    await fromLocal.find(".fav-nav-root").trigger("click");
    expect(fromLocal.emitted("open-favorites")).toEqual([["all"]]);

    const fromFavorites = mountNav(true);
    await fromFavorites.find(".fav-nav-root").trigger("click");
    expect(fromFavorites.emitted("open-favorites")).toEqual([["all"]]);
  });

  it("只有处于收藏工作区时高亮", () => {
    expect(mountNav(false).find(".fav-nav-root").classes()).not.toContain("active");
    expect(mountNav(true).find(".fav-nav-root").classes()).toContain("active");
  });
});
