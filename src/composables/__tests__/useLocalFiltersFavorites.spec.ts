import { computed } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ModEntry } from "../../types";

/**
 * 回归：本地页不再承载任何「收藏视图」。
 *
 * 收藏已经是独立工作区（App 的第三个 mode + 侧栏 FavoritesNav），
 * 本地筛选只负责扫描结果本身——不得再出现 favoritesOnly 开关、
 * 也不得把收藏占位条目混进本地列表。
 */

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  displayTitle: vi.fn((_id: number, title: string) => title),
  isFavorite: vi.fn(() => false),
}));
vi.mock("../../modUpdates", () => ({ updateIds: computed(() => new Set<string>()) }));
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

function createFilters(mods: ModEntry[]) {
  return useLocalFilters({
    mods: computed(() => mods),
    collationLocale: computed(() => "en"),
  });
}

const installed = base("subscribed/abewwwe", "abewwwe", { workshopId: 45782 });
const second = base("subscribed/zzz", "zzz", { workshopId: 1001 });

describe("useLocalFilters 不再提供收藏视图", () => {
  it("返回值里没有 favoritesOnly / toggleFavorites 等旧收藏 API", () => {
    const filters = createFilters([installed]);
    expect("favoritesOnly" in filters).toBe(false);
    expect("toggleFavorites" in filters).toBe(false);
    expect("favoriteLocalCount" in filters).toBe(false);
    expect("ghostMods" in filters).toBe(false);
  });

  it("列表只来自传入的扫描结果，排序不掺入任何收藏占位条目", () => {
    const filters = createFilters([installed, second]);
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["subscribed/abewwwe", "subscribed/zzz"]);
    expect(filters.sorted.value.every((m) => m.uninstalled !== true)).toBe(true);

    filters.sortKey.value = "name";
    filters.order.value = "ASC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["subscribed/abewwwe", "subscribed/zzz"]);
  });

  it("筛选快照只保存本地筛选维度，恢复后不产生收藏状态", () => {
    const filters = createFilters([installed, second]);
    filters.source.value = "local";
    const snap = filters.snapshot();
    expect(Object.keys(snap)).not.toContain("favoritesOnly");

    filters.source.value = "all";
    filters.restore(snap);
    expect(filters.source.value).toBe("local");
  });
});
