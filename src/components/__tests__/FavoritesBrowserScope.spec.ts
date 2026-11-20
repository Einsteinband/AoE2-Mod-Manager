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
    installedCount.value = 2;
    uninstalledCount.value = 1;
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

  it("收藏页侧栏只保留已安装 / 未安装两个收藏分类，不再镜像本地模组分类", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll(".view-switch")).toHaveLength(1);
    expect(wrapper.findAll(".fav-nav-root")).toHaveLength(0);

    const titles = wrapper.findAll(".side-title").map((n) => n.text());
    expect(titles).toEqual(["favorites.groupTitle"]);

    const labels = wrapper.findAll(".side-item .label").map((n) => n.text());
    expect(labels).toEqual(["favorites.filterInstalled", "favorites.filterUninstalled"]);
    expect(labels).not.toContain("sidebar.allMods");
    expect(labels).not.toContain("sidebar.all");
    expect(wrapper.text()).not.toContain("sidebar.source");
    expect(wrapper.text()).not.toContain("sidebar.status");

    const counts = wrapper.findAll(".side-item .count").map((n) => n.text());
    expect(counts).toEqual(["2", "1"]);
  });

  it("点击侧栏分类只切换收藏安装状态，不跳转本地页", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    const buttons = wrapper.findAll(".side-item");
    await buttons[0].trigger("click");
    expect(scope.value).toBe("installed");
    expect(cardNames(wrapper).sort()).toEqual(["InstalledA", "InstalledB"]);

    await buttons[1].trigger("click");
    expect(scope.value).toBe("uninstalled");
    expect(cardNames(wrapper)).toEqual(["OnlineOnly"]);
    expect(wrapper.emitted("open-local")).toBeUndefined();
  });

  it("选中项跟随当前可见列表：分类切换后详情不会是已被过滤掉的条目", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").text()).toBe("InstalledA");

    scope.value = "uninstalled";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").text()).toBe("OnlineOnly");
  });

  it("收藏页侧栏视图切换只更新 viewMode，不触发本地页跳转", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    const listButton = wrapper.findAll(".view-btn")[1];
    await listButton.trigger("click");

    expect(wrapper.emitted("update:viewMode")?.at(-1)).toEqual(["list"]);
    expect(wrapper.emitted("open-local")).toBeUndefined();
  });
});
