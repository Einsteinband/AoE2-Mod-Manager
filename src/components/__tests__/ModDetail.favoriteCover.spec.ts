import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { ModEntry } from "../../types";

/**
 * 本地详情面板里的「在线收藏项」：
 * - 无封面时只能说「无封面」，不能冒出「该模组文件夹内没有 thumbnail.jpg」这种本地目录文案；
 * - 封面刷新必须走在线链路（online_images_fetch），绝不能调用本地封面恢复命令；
 * - 本地已安装条目反过来仍走本地恢复（回归保护）。
 */

const mocks = vi.hoisted(() => ({
  fetchImages: vi.fn(async (_tasks: { modId: number; url: string; force?: boolean }[]) => 1),
  refreshLocalCover: vi.fn(async () => ({ status: "refreshed", bytes: 1, installPath: "F:/x/thumb.jpg", sourceUrl: null })),
  favoriteMetaOf: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("../../api", () => ({
  toggleModEnabled: vi.fn(),
  deleteModFiles: vi.fn(),
  revealModFolder: vi.fn(),
  refreshLocalCover: mocks.refreshLocalCover,
  fileUrl: vi.fn((p: string) => `asset://localhost/${p}`),
}));

vi.mock("../../online/images", () => ({
  fetchImages: mocks.fetchImages,
  assetUrl: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("../../favoriteMeta", () => ({ favoriteMetaOf: mocks.favoriteMetaOf }));

vi.mock("../../online/downloadQueue", () => ({
  activeTaskOfMod: vi.fn(() => null),
  latestTaskOfMod: vi.fn(() => null),
}));

vi.mock("../../online/translation", () => ({
  activeTranslation: vi.fn(() => null),
  canTranslateText: vi.fn(() => true),
  currentTargetLanguageName: vi.fn(() => "中文"),
  ensureTranslation: vi.fn(),
  isQueued: vi.fn(() => false),
  isShowingOriginal: vi.fn(() => false),
  isTranslating: vi.fn(() => false),
  loadCachedTranslation: vi.fn(() => Promise.resolve()),
  toggleOriginal: vi.fn(),
  translationErrorKind: vi.fn(() => "generic"),
  translationLangEpoch: vi.fn(() => 0),
  translationOf: vi.fn(() => null),
}));

vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  isFavorite: vi.fn(() => true),
  setCustomName: vi.fn(() => Promise.resolve()),
  setFavorite: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../online/service", () => ({ openModWebpage: vi.fn(() => Promise.resolve()) }));

vi.mock("../../format", () => ({
  formatBytes: vi.fn(() => "0 B"),
  formatDateTime: vi.fn(() => ""),
  kindLabel: vi.fn(() => "LOCAL_KIND_LABEL"),
  sourceLabel: vi.fn(() => "LOCAL_SOURCE_LABEL"),
  statusLabel: vi.fn(() => "Enabled"),
  translateBackendMessage: vi.fn((m: string) => m),
}));

vi.mock("../../online/types", () => ({ localizedTagName: vi.fn((t: string) => t) }));

function makeMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "fav:45782",
    folderName: "",
    path: "",
    kind: "subscribed",
    workshopId: 45782,
    nameFromFolder: "#45782",
    displayName: "abewwwe",
    displayNameSource: "folder",
    author: "Someone",
    description: "No Description",
    thumbnail: null,
    coverUrl: null,
    enabled: null,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: [],
    categorySource: "heuristic",
    officialTags: [],
    source: "unknown",
    metadataRecorded: false,
    issues: [],
    infoJsonPresent: false,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    uninstalled: true,
    origin: "online",
    ...overrides,
  };
}

function mountDetail(mod: ModEntry) {
  return mount(ModDetailForTest, {
    props: { mod, stats: null, statsLoading: false, statsError: null },
  });
}

async function mountDetailAsync(mod: ModEntry) {
  return mountDetail(mod);
}

let ModDetailForTest: typeof import("../ModDetail.vue").default;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.favoriteMetaOf.mockReturnValue({
    modId: 45782,
    title: "abewwwe",
    creator: "Someone",
    description: "No Description",
    tagIds: [],
    tagNames: [],
    thumbnailUrl: "https://api.ageofempires.com/thumb/45782.jpg",
    savedAtMs: 1,
  });
  ModDetailForTest = (await import("../ModDetail.vue")).default;
});

describe("ModDetail 在线收藏项的封面与来源文案", () => {
  it("没有封面时只说「无封面」，不出现本地文件夹文案，也不显示本地来源/类型徽章", async () => {
    const wrapper = await mountDetailAsync(makeMod({ coverUrl: null, thumbnail: null }));
    const noCover = wrapper.find(".no-cover-box");
    expect(noCover.exists()).toBe(true);
    expect(noCover.text()).toContain("detail.coverMissing");
    expect(noCover.text()).not.toContain("detail.coverMissingDetail");
    expect(wrapper.text()).not.toContain("LOCAL_SOURCE_LABEL");
    expect(wrapper.text()).not.toContain("LOCAL_KIND_LABEL");
  });

  it("有官方缩略图地址时显示刷新按钮，点击走在线获取而非本地恢复", async () => {
    const wrapper = await mountDetailAsync(makeMod());
    const button = wrapper.find(".cover-reload-btn");
    expect(button.exists()).toBe(true);
    await button.trigger("click");
    await flushPromises();
    expect(mocks.fetchImages).toHaveBeenCalledTimes(1);
    const tasks = mocks.fetchImages.mock.calls[0][0];
    expect(tasks[0]).toEqual({
      modId: 45782,
      url: "https://api.ageofempires.com/thumb/45782.jpg",
      force: true,
    });
    expect(mocks.refreshLocalCover).not.toHaveBeenCalled();
  });

  it("没有官方缩略图地址时干脆不给刷新按钮（不存在可点的在线链路）", async () => {
    mocks.favoriteMetaOf.mockReturnValue(null);
    const wrapper = await mountDetailAsync(makeMod());
    expect(wrapper.find(".cover-reload-btn").exists()).toBe(false);
    expect(wrapper.find(".no-cover-box").text()).toContain("detail.coverMissing");
  });

  it("本地已安装条目仍保留本地来源/类型徽章，封面刷新仍走本地恢复（回归保护）", async () => {
    const wrapper = await mountDetailAsync(
      makeMod({
        id: "local/abewwwe",
        path: "F:/Games/AoE2DE/local/abewwwe",
        kind: "local",
        folderName: "abewwwe",
        uninstalled: false,
        origin: "local",
        source: "tool",
        enabled: true,
      }),
    );
    expect(wrapper.text()).toContain("LOCAL_SOURCE_LABEL");
    expect(wrapper.text()).toContain("LOCAL_KIND_LABEL");
    await wrapper.find(".cover-reload-btn").trigger("click");
    await flushPromises();
    expect(mocks.refreshLocalCover).toHaveBeenCalledWith(45782, "local", "abewwwe");
    expect(mocks.fetchImages).not.toHaveBeenCalled();
  });
});
