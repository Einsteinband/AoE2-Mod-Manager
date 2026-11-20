import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import type { ModEntry } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    locale: { value: "zh" },
  }),
  createI18n: () => ({
    global: { t: (key: string) => key, locale: { value: "zh" }, availableLocales: ["zh"] },
    install: () => undefined,
  }),
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ toast: ref(null), showToast: vi.fn() }),
}));
vi.mock("../../userData", () => ({
  displayTitle: (_id: number, title: string) => title,
  customNameOf: () => null,
  ensureUserData: async () => undefined,
  isFavorite: () => true,
  setFavorite: vi.fn(async () => false),
  setCustomName: vi.fn(async () => undefined),
}));
vi.mock("../../api", () => ({
  deleteModFiles: vi.fn(async () => undefined),
  revealModFolder: vi.fn(async () => undefined),
  toggleModEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("../../online/service", () => ({ openModWebpage: vi.fn(async () => undefined) }));
vi.mock("../../online/translation", () => ({
  canTranslateText: (text: string | null | undefined) => (text ?? "").trim().length >= 5,
  // 「描述是否已加载」只看数据是否存在；标题与描述各自独立判断
  isDescriptionLoaded: (text: string | null | undefined) => text !== null && text !== undefined,
  canTranslateDescription: (text: string | null | undefined) =>
    typeof text === "string" && text.trim().length > 0,
  hasTranslatableText: (title: string | null | undefined, description?: string | null) =>
    (title ?? "").trim().length > 0 ||
    (typeof description === "string" && description.trim().length > 0),
  currentTargetLanguageName: () => "中文",
  ensureTranslation: vi.fn(async () => ({ cached: false, truncated: false, charCount: 0 })),
  isQueued: () => false,
  isShowingOriginal: () => false,
  isTranslating: () => false,
  toggleOriginal: vi.fn(),
  translationErrorKind: () => "generic",
  translationOf: () => null,
}));

const entries = ref<ModEntry[]>([]);
const scope = ref<"all" | "installed" | "uninstalled">("all");

vi.mock("../../favorites/useFavorites", () => ({
  useFavorites: () => ({
    loading: ref(false),
    error: ref(null),
    entries,
    scope,
    installedCount: ref(0),
    uninstalledCount: ref(0),
    refresh: vi.fn(),
    install: vi.fn(() => ({ accepted: true })),
  }),
}));

import FavoritesBrowser from "../favorites/FavoritesBrowser.vue";

function entry(id: number, name: string, uninstalled: boolean, extra: Partial<ModEntry> = {}): ModEntry {
  return {
    id: `favorite:${id}`,
    folderName: name,
    path: uninstalled ? "" : `D:/mods/${name}`,
    kind: "subscribed",
    workshopId: id,
    nameFromFolder: name,
    displayName: name,
    displayNameSource: "folder",
    author: "Pocho32",
    description: "描述文本足够长可以翻译",
    thumbnail: null,
    enabled: uninstalled ? null : true,
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
    infoJsonPresent: !uninstalled,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    uninstalled,
    origin: uninstalled ? "online" : "local",
    ...extra,
  };
}

/** 用带右键事件的卡片替身，验证收藏页是否真的接上了 context-menu 链路 */
const ModCardStub = {
  props: ["mod"],
  emits: ["select", "context-menu", "toggled", "toggle-error"],
  template: `<i class="card" @contextmenu="$emit('context-menu', mod, $event)">{{ mod.displayName }}</i>`,
};

const stubs = {
  PageShell: {
    template: '<div><slot name="sidebar" /><slot name="content" /><slot name="detail" /></div>',
  },
  ModGrid: { template: '<div><slot /><slot name="cards" /></div>' },
  ModCard: ModCardStub,
  ModDetail: {
    props: ["mod"],
    template: '<div class="detail">{{ mod?.displayName }}</div>',
  },
};

function mountBrowser() {
  return mount(FavoritesBrowser, { props: {}, global: { stubs } });
}

function menuLabels(wrapper: ReturnType<typeof mountBrowser>): string[] {
  return wrapper.findAll(".ctx-menu-label").map((node) => node.text());
}

describe("FavoritesBrowser：收藏卡片右键菜单", () => {
  beforeEach(() => {
    scope.value = "all";
    entries.value = [
      entry(583536, "InstalledOne", false),
      entry(583212, "OnlineOnly", true),
    ];
  });

  it("已安装收藏右键能打开菜单，且给出启停 / 卸载等本地操作", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".ctx-menu").exists()).toBe(false);

    await wrapper.findAll(".card")[0].trigger("contextmenu");
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".ctx-menu").exists()).toBe(true);
    const labels = menuLabels(wrapper);
    // 已安装：启用 / 停用（enabled=true → 停用）
    expect(labels).toContain("menu.disable");
    expect(labels).toContain("detail.deleteMod");
    expect(labels).toContain("favorites.favorited");
  });

  it("未安装收藏右键也能打开菜单，给出下载安装而不是卸载", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    await wrapper.findAll(".card")[1].trigger("contextmenu");
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".ctx-menu").exists()).toBe(true);
    const labels = menuLabels(wrapper);
    expect(labels).toContain("online.installLocal");
    expect(labels).not.toContain("detail.deleteMod");
    expect(labels).not.toContain("menu.enable");
  });

  it("菜单打开后目标固定为右键的那张卡，不受选中项变化影响", async () => {
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    await wrapper.findAll(".card")[1].trigger("contextmenu");
    await wrapper.vm.$nextTick();
    // 打开后切到第一条（选中态变化），菜单内容仍对应 OnlineOnly
    await wrapper.findAll(".card")[0].trigger("click");
    await wrapper.vm.$nextTick();
    expect(menuLabels(wrapper)).toContain("online.installLocal");
    expect(wrapper.find(".detail").text()).toBe("InstalledOne");
  });
});
