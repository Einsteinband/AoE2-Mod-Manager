import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import type { ModEntry } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  createI18n: () => ({
    global: { t: (key: string) => key, locale: { value: "zh" }, availableLocales: ["zh"] },
    install: () => undefined,
  }),
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock("../../userData", () => ({
  displayTitle: (_id: number, title: string) => title,
  customNameOf: () => null,
}));

const refresh = vi.fn();
const install = vi.fn();
const entries = ref<ModEntry[]>([]);
const scope = ref<"all" | "installed" | "uninstalled">("all");
const installedCount = ref(0);
const uninstalledCount = ref(0);

vi.mock("../../favorites/useFavorites", () => ({
  useFavorites: () => ({
    loading: ref(false),
    error: ref(null),
    entries,
    scope,
    installedCount,
    uninstalledCount,
    refresh,
    install,
  }),
}));

import FavoritesBrowser from "../favorites/FavoritesBrowser.vue";

function entry(id: number, name: string, uninstalled = false): ModEntry {
  return {
    id: `favorite:${id}`,
    folderName: name,
    path: "",
    kind: "subscribed",
    workshopId: id,
    nameFromFolder: name,
    displayName: name,
    displayNameSource: "folder",
    author: "PoisonousSnakes",
    description: null,
    thumbnail: null,
    enabled: null,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: [],
    categorySource: "heuristic",
    officialTags: [],
    source: "official",
    metadataRecorded: false,
    issues: [],
    infoJsonPresent: false,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    uninstalled,
    origin: "online",
  };
}

const stubs = {
  PageShell: {
    template: '<div><slot name="sidebar" /><slot name="content" /><slot name="detail" /></div>',
  },
  ModGrid: { template: '<div><slot /><slot name="cards" /></div>' },
  ModCard: {
    props: ["mod"],
    template: '<i class="card">{{ mod.displayName }}</i>',
  },
  ModDetail: {
    props: ["mod"],
    template: '<div class="detail">{{ mod?.displayName }}</div>',
  },
};

function mountBrowser(props: Record<string, unknown> = {}) {
  return mount(FavoritesBrowser, { props, global: { stubs } });
}

function cardNames(wrapper: ReturnType<typeof mountBrowser>): string[] {
  return wrapper.findAll(".card").map((n) => n.text());
}

describe("FavoritesBrowser：收藏内部二级分类（与顶部本地 / 在线无关）", () => {
  beforeEach(() => {
    refresh.mockClear();
    entries.value = [
      entry(1, "InstalledA", false),
      entry(2, "InstalledB", false),
      entry(3, "OnlineOnly", true),
    ];
    scope.value = "all";
  });

  it("全部收藏 = 已安装 + 未安装都在同一页", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    expect(cardNames(wrapper).sort()).toEqual(["InstalledA", "InstalledB", "OnlineOnly"]);
  });

  it("本地模组分类只留已安装收藏，在线模组分类只留未安装收藏", async () => {
    const wrapper = mountBrowser();
    scope.value = "installed";
    await wrapper.vm.$nextTick();
    expect(cardNames(wrapper).sort()).toEqual(["InstalledA", "InstalledB"]);

    scope.value = "uninstalled";
    await wrapper.vm.$nextTick();
    expect(cardNames(wrapper)).toEqual(["OnlineOnly"]);
  });

  it("搜索与分类叠加；清空筛选时同时回到全部分类并请求 App 清搜索", async () => {
    entries.value = [entry(1, "InstalledA"), entry(9, "MagicFox", true)];
    const wrapper = mountBrowser({ search: "magic" });
    await wrapper.vm.$nextTick();
    expect(cardNames(wrapper)).toEqual(["MagicFox"]);

    scope.value = "installed";
    await wrapper.vm.$nextTick();
    const clear = wrapper.find(".actions button");
    expect(wrapper.find(".state-panel").exists()).toBe(true);
    await clear.trigger("click");
    expect(scope.value).toBe("all");
    expect(wrapper.emitted("reset-search")).toHaveLength(1);
  });

  it("收藏页侧栏是固定骨架：收藏入口 + 普通分类都在，且不出现两个收藏入口", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    // 收藏入口只渲染一次（收藏页自己的高亮版），下面的本地分类继续存在
    expect(wrapper.findAll(".fav-nav-root")).toHaveLength(1);
    expect(wrapper.find(".fav-nav-root").text()).toContain("favorites.groupTitle");

    const titles = wrapper.findAll(".side-title").map((n) => n.text());
    expect(titles).toContain("sidebar.source");
    expect(titles).toContain("sidebar.status");

    const labels = wrapper.findAll(".label").map((n) => n.text());
    expect(labels).toContain("sidebar.allMods");
    expect(labels).toContain("sidebar.all");
    // 收藏内部不再有「本地 / 在线」二级分类
    expect(wrapper.find(".fav-nav-children").exists()).toBe(false);
    expect(labels).not.toContain("favorites.stateLocal");
    expect(labels).not.toContain("favorites.stateOnline");
  });

  it("选中项跟随当前可见列表：分类切换后详情不会是已被过滤掉的条目", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").text()).toBe("InstalledA");

    scope.value = "uninstalled";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").text()).toBe("OnlineOnly");
  });
});
