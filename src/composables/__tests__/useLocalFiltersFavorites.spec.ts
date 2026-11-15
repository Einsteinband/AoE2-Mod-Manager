import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ModEntry } from "../../types";

/**
 * 本地页收藏视图的来源身份必须穿过「合并 / 筛选 / 排序」：
 * 已安装条目（本地来源）与在线占位条目（origin: "online"）同处一列，
 * 排序后各自的来源标记不能被抹掉，也不能因为同 ID 出现两份。
 */

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const favIds = new Set<number>([45782, 99991]);
vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  displayTitle: vi.fn((_id: number, title: string) => title),
  isFavorite: vi.fn((id: number) => favIds.has(id)),
}));
vi.mock("../../modUpdates", () => ({ updateIds: ref(new Set<string>()) }));
vi.mock("../../online/types", () => ({ TAG_RANK_BY_NAME: {} }));

import { useLocalFilters } from "../local/useLocalFilters";

function base(id: string, name: string, extra: Partial<ModEntry> = {}): ModEntry {
  return {
    id,
    folderName: name,
    path: `/mods/${name}`,
    kind: "subscribed",
    workshopId: null,
    nameFromFolder: name,
    displayName: name,
    displayNameSource: "folder",
    author: null,
    description: null,
    thumbnail: null,
    enabled: true,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: [],
    categorySource: "heuristic",
    officialTags: [],
    source: "official",
    metadataRecorded: true,
    issues: [],
    infoJsonPresent: true,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    ...extra,
  };
}

function createFilters(mods: ModEntry[], ghosts: ModEntry[]) {
  return useLocalFilters({
    mods: computed(() => mods),
    ghostMods: computed(() => ghosts),
    collationLocale: computed(() => "en"),
  });
}

const installed = base("subscribed/abewwwe", "abewwwe", { workshopId: 45782, thumbnail: "F:/m/abewwwe/thumbnail.jpg" });
const ghost = base("fav:99991", "#99991", { workshopId: 99991, uninstalled: true, origin: "online", path: "", folderName: "" });

describe("useLocalFilters 收藏视图的跨来源合并", () => {
  it("收藏视图同时包含本地与在线条目，在线条目的 origin 在排序后仍保留", () => {
    const filters = createFilters([installed], [ghost]);
    filters.toggleFavorites();
    const ids = filters.sorted.value.map((m) => m.id);
    // 默认按名称排序：占位标题是 "#99991"，排在 "abewwwe" 之前
    expect(ids).toEqual(["fav:99991", "subscribed/abewwwe"]);
    const online = filters.sorted.value.find((m) => m.id === "fav:99991");
    expect(online?.origin).toBe("online");
    expect(online?.uninstalled).toBe(true);
  });

  it("按名称重排不会丢来源标记", () => {
    const filters = createFilters([installed], [ghost]);
    filters.toggleFavorites();
    filters.sortKey.value = "name";
    filters.order.value = "ASC";
    expect(filters.sorted.value.map((m) => m.workshopId)).toEqual([99991, 45782]);
    expect(filters.sorted.value[0].origin).toBe("online");
  });

  it("退出收藏视图后在线占位不参与列表（不污染本地扫描口径）", () => {
    const filters = createFilters([installed], [ghost]);
    filters.toggleFavorites();
    filters.toggleFavorites();
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["subscribed/abewwwe"]);
  });

  it("同一 Workshop ID 只出现一次：已安装时该 ID 不进占位集合（由 ghosts 来源保证）", () => {
    const filters = createFilters([installed], [ghost]);
    filters.toggleFavorites();
    const byId = filters.sorted.value.filter((m) => m.workshopId === 45782);
    expect(byId).toHaveLength(1);
    expect(byId[0].origin).toBeUndefined();
  });
});
