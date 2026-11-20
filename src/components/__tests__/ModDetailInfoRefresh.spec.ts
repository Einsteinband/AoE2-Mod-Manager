import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ModDetail from "../ModDetail.vue";
import type { ModEntry, FavoriteOnlineInfo } from "../../types";
import type { FavoriteMeta } from "../../favoriteMeta";

const mocks = vi.hoisted(() => ({
  modDetail: vi.fn(),
  rememberOfficialMeta: vi.fn(),
  favoriteMetaOf: vi.fn((): FavoriteMeta | null => null),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../api", () => ({
  toggleModEnabled: vi.fn(),
  deleteModFiles: vi.fn(),
  revealModFolder: vi.fn(),
  refreshLocalCover: vi.fn(),
  fileUrl: vi.fn((p: string) => p),
}));

vi.mock("../../online/downloadQueue", () => ({
  activeTaskOfMod: vi.fn(() => null),
  latestTaskOfMod: vi.fn(() => null),
}));

vi.mock("../../online/translation", () => ({
  activeTranslation: vi.fn(() => null),
  canTranslateText: vi.fn(() => true),
  isDescriptionLoaded: vi.fn(
    (text: string | null | undefined) => text !== null && text !== undefined,
  ),
  canTranslateDescription: vi.fn(
    (text: string | null | undefined) => typeof text === "string" && text.trim().length > 0,
  ),
  hasTranslatableText: vi.fn(
    (title: string | null | undefined, description?: string | null) =>
      (title ?? "").trim().length > 0 ||
      (typeof description === "string" && description.trim().length > 0),
  ),
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
  isFavorite: vi.fn(() => false),
  setCustomName: vi.fn(() => Promise.resolve()),
  setFavorite: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../../online/service", () => ({
  openModWebpage: vi.fn(() => Promise.resolve()),
  modDetail: mocks.modDetail,
}));

vi.mock("../../favoriteMeta", () => ({
  favoriteMetaOf: mocks.favoriteMetaOf,
  rememberOfficialMeta: mocks.rememberOfficialMeta,
  rememberOnlineMeta: vi.fn(),
  hydrateFavoriteMeta: vi.fn(() => Promise.resolve()),
  enrichFavoriteMetaFromDetail: vi.fn(() => Promise.resolve()),
  favoriteMetaMap: { value: {} },
}));

vi.mock("../../format", () => ({
  formatBytes: vi.fn((n: number | null) => (n === null ? "NP" : `B:${n}`)),
  formatDateTime: vi.fn((ms: number | null) => (ms && ms > 0 ? `DATE:${ms}` : "NP")),
  kindLabel: vi.fn(() => "local"),
  sourceLabel: vi.fn(() => "tool"),
  statusLabel: vi.fn(() => "Enabled"),
  translateBackendMessage: vi.fn((m: string) => m),
}));

vi.mock("../../online/types", () => ({
  localizedTagName: vi.fn((t: string) => t),
}));

function makeMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "local/test_mod_12345",
    folderName: "test_mod_12345",
    path: "C:/AoE2DE/mods/local/test_mod_12345",
    kind: "local",
    workshopId: 12345,
    nameFromFolder: "test_mod_12345",
    displayName: "Test Mod",
    displayNameSource: "info.json",
    author: "AoE Official",
    description: "desc",
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: 1650000000000,
    installedAtMs: 1700000000000,
    checksum: null,
    contentTags: [],
    categories: ["ui"],
    categorySource: "heuristic",
    officialTags: [],
    source: "tool",
    metadataRecorded: true,
    issues: [],
    infoJsonPresent: true,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    uninstalled: false,
    ...overrides,
  };
}

function mountDetail(mod: ModEntry) {
  return mount(ModDetail, {
    props: { mod, stats: null, statsLoading: false, statsError: null },
  });
}

/** 「更多信息」区所有字段值 */
function metaValues(wrapper: ReturnType<typeof mountDetail>): string[] {
  return wrapper
    .findAll(".dv-zone-meta .field .v")
    .map((node) => node.text());
}

beforeEach(() => {
  mocks.modDetail.mockReset();
  mocks.rememberOfficialMeta.mockReset();
  mocks.favoriteMetaOf.mockReset();
  mocks.favoriteMetaOf.mockReturnValue(null);
});

describe("ModDetail: 刷新 Mod 信息", () => {
  it("成功后走既有 online_detail，并把官方字段覆盖写入元数据缓存", async () => {
    mocks.modDetail.mockResolvedValue({
      modName: "Official Title",
      creatorName: "PoisonousSnakes",
      modDescription: "<p>official desc</p>",
      modVersion: "2.7",
      createDate: "2026-08-22T13:43:00",
      lastUpdate: "2026-09-10T06:18:00",
      installs: 1281,
    });

    const wrapper = mountDetail(makeMod({ author: null }));
    const button = wrapper.find(".info-refresh-btn");
    expect(button.exists()).toBe(true);

    await button.trigger("click");
    await flushPromises();

    expect(mocks.modDetail).toHaveBeenCalledTimes(1);
    expect(mocks.modDetail).toHaveBeenCalledWith(12345);
    expect(mocks.rememberOfficialMeta).toHaveBeenCalledTimes(1);
    const payload = mocks.rememberOfficialMeta.mock.calls[0][0];
    expect(payload).toMatchObject({
      modId: 12345,
      creator: "PoisonousSnakes",
      version: "2.7",
      installs: 1281,
    });
    expect(payload.publishedMs).toBe(Date.parse("2026-08-22T13:43:00"));
    expect(payload.updatedMs).toBe(Date.parse("2026-09-10T06:18:00"));
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("刷新中按钮禁用，重复点击不会发第二次请求", async () => {
    const deferred: { resolve: ((value: Record<string, unknown>) => void) | null } = { resolve: null };
    mocks.modDetail.mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        deferred.resolve = resolve;
      }),
    );

    const wrapper = mountDetail(makeMod());
    const button = wrapper.find(".info-refresh-btn");
    await button.trigger("click");
    await button.trigger("click");
    await flushPromises();

    expect(mocks.modDetail).toHaveBeenCalledTimes(1);
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    deferred.resolve?.({ creatorName: "PoisonousSnakes" });
    await flushPromises();
  });

  it("收藏条目（无本地 stats）用 onlineInfo 显示体积 / 文件数 / 评分", () => {
    const wrapper = mountDetail(
      makeMod({
        author: null,
        onlineInfo: {
          publishedMs: 1790000000000,
          updatedMs: 1791000000000,
          version: "2.7",
          installs: 1281,
          fileSize: 2048000,
          fileCount: 12,
          rating: 4.2,
          thumbnailUrl: null,
        },
      }),
    );
    const chips = wrapper.findAll(".basic-row .chip-value").map((n) => n.text());
    expect(chips).toEqual(["12345", "B:2048000"]);
    const values = metaValues(wrapper);
    expect(values).toContain("1281");
    expect(values[values.length - 1]).toBe("4.2");
  });

  it("刷新失败保留原有作者，并显示错误", async () => {
    mocks.modDetail.mockRejectedValue(new Error("aoe2mm:err:online.sessionExpired"));
    mocks.favoriteMetaOf.mockReturnValue(null);

    const wrapper = mountDetail(makeMod({ author: "AoE Official" }));
    await wrapper.find(".info-refresh-btn").trigger("click");
    await flushPromises();

    expect(mocks.rememberOfficialMeta).not.toHaveBeenCalled();
    expect(metaValues(wrapper)[0]).toBe("AoE Official");
    expect(wrapper.find(".path-error").text()).toContain("aoe2mm:err:online.sessionExpired");
  });

  it("没有 Workshop ID 时不显示刷新按钮", async () => {
    const wrapper = mountDetail(makeMod({ workshopId: null }));
    expect(wrapper.find(".info-refresh-btn").exists()).toBe(false);
  });
});

describe("ModDetail: 更多信息的数据优先级", () => {
  it("官方刷新缓存优先于本地 info.json，本地作者不再顶掉官方值", async () => {
    mocks.favoriteMetaOf.mockReturnValue({
      modId: 12345,
      title: "Official Title",
      creator: "PoisonousSnakes",
      description: "official desc",
      tagIds: [],
      tagNames: [],
      thumbnailUrl: null,
      savedAtMs: 1,
      publishedMs: 1790000000000,
      updatedMs: 1791000000000,
      version: "2.7",
      installs: 1281,
    });

    const wrapper = mountDetail(makeMod({ author: "AoE Official" }));
    const values = metaValues(wrapper);

    expect(values[0]).toBe("PoisonousSnakes");
    expect(values[1]).toBe("DATE:1790000000000");
    expect(values[2]).toBe("DATE:1791000000000");
    expect(values[3]).toBe("2.7");
    expect(values[4]).toBe("1281");
    expect(wrapper.find(".dv-zone-meta .field .v.missing").exists()).toBe(false);
  });

  it("没有任何官方数据时，字段与在线详情同序同标签，缺失值统一为「未提供」", async () => {
    const on: FavoriteOnlineInfo = {
      publishedMs: null,
      updatedMs: null,
      version: null,
      installs: null,
      thumbnailUrl: null,
    };
    const wrapper = mountDetail(makeMod({ author: null, onlineInfo: on, lastUpdateMs: null }));
    const labels = wrapper
      .findAll(".dv-zone-meta .field .k")
      .map((node) => node.text());
    expect(labels).toEqual([
      "online.author",
      "online.created",
      "online.updated",
      "online.version",
      "online.installs",
      "online.rating",
    ]);
    expect(metaValues(wrapper)).toEqual([
      "labels.notProvided",
      "labels.notProvided",
      "labels.notProvided",
      "labels.notProvided",
      "labels.notProvided",
      "labels.notProvided",
    ]);
  });
});
