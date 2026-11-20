import { computed } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ModEntry } from "../../types";
import { setHiddenMod } from "../../hiddenMods";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  displayTitle: vi.fn((_id: number, title: string) => title),
  isFavorite: vi.fn(() => false),
}));
vi.mock("../../modUpdates", () => ({ updateIds: computed(() => new Set<string>()) }));
vi.mock("../../online/types", () => ({ TAG_RANK_BY_NAME: {} }));

import { useLocalFilters } from "../local/useLocalFilters";

function base(id: string, name: string, enabled: boolean | null, tags: string[]): ModEntry {
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
    enabled,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: tags,
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
  };
}

const enabledMod = base("subscribed/aaa", "aaa", true, ["UI"]);
const disabledMod = base("subscribed/bbb", "bbb", false, ["Audio"]);
const unknownMod = base("subscribed/ccc", "ccc", null, ["Map"]);

function createFilters() {
  return useLocalFilters({
    mods: computed(() => [enabledMod, disabledMod, unknownMod]),
    collationLocale: computed(() => "en"),
  });
}

describe("useLocalFilters 隐藏分类", () => {
  it("默认列表排除隐藏项，隐藏分类单独取回该条目", () => {
    setHiddenMod(enabledMod.id, true);
    const filters = createFilters();

    expect(filters.sorted.value.map((m) => m.id)).toEqual([disabledMod.id, unknownMod.id]);
    expect(filters.sourceCounts.value.all).toBe(2);
    expect(filters.statusCounts.value).toEqual({ enabled: 0, disabled: 1, unknown: 1, hidden: 1 });
    expect(filters.inferredTagList.value.map((item) => item.name)).toEqual(["Audio", "Map"]);

    filters.pickStatus("hidden");
    expect(filters.sorted.value.map((m) => m.id)).toEqual([enabledMod.id]);
    expect(filters.contentHint.value).toContain("content.statusHidden");

    setHiddenMod(enabledMod.id, false);
    filters.pickStatus("all");
    expect(filters.sorted.value.map((m) => m.id)).toEqual([enabledMod.id, disabledMod.id, unknownMod.id]);
  });
});
