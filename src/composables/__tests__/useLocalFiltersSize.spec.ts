import { computed } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ModEntry } from "../../types";
import { useLocalFilters } from "../local/useLocalFilters";

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;

function makeMod(
  id: string,
  title: string,
  sizeBytes: number | null,
  sizeComplete = true,
): ModEntry {
  return {
    id,
    folderName: title,
    path: `/mods/${id}`,
    kind: "local",
    workshopId: null,
    nameFromFolder: title,
    displayName: title,
    displayNameSource: "folder",
    author: null,
    description: null,
    thumbnail: null,
    enabled: null,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: ["ui"],
    categorySource: "heuristic",
    officialTags: [],
    source: "unknown",
    metadataRecorded: false,
    issues: [],
    infoJsonPresent: false,
    isDataMod: false,
    sizeBytes,
    sizeComplete,
  };
}

function createFilters(mods: ModEntry[]) {
  return useLocalFilters({
    mods: computed(() => mods),
    collationLocale: computed(() => "en"),
  });
}

describe("useLocalFilters file size sorting", () => {
  it("handles empty and single-item lists", () => {
    expect(createFilters([]).sorted.value).toEqual([]);
    const one = [makeMod("one", "Only", 123)];
    expect(createFilters(one).sorted.value).toEqual(one);
  });

  it("compares raw bytes across KB, MB and GB", () => {
    const filters = createFilters([
      makeMod("gb", "GB mod", GB),
      makeMod("kb", "KB mod", KB),
      makeMod("mb", "MB mod", MB),
    ]);
    filters.sortKey.value = "size";

    filters.order.value = "ASC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["kb", "mb", "gb"]);

    filters.order.value = "DESC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["gb", "mb", "kb"]);
  });

  it("places unknown or incomplete sizes after valid sizes in both directions", () => {
    const filters = createFilters([
      makeMod("null", "Null", null),
      makeMod("kb", "One KB", KB),
      makeMod("incomplete", "Incomplete", 123, false),
      makeMod("two-kb", "Two KB", 2 * KB),
      makeMod("zero", "Zero bytes", 0),
    ]);
    filters.sortKey.value = "size";

    filters.order.value = "ASC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["zero", "kb", "two-kb", "incomplete", "null"]);

    filters.order.value = "DESC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["two-kb", "kb", "zero", "incomplete", "null"]);
  });

  it("uses title, folder name and id as a stable fallback for equal sizes", () => {
    const filters = createFilters([
      makeMod("b", "B mod", KB),
      makeMod("a-1", "A mod", KB),
      makeMod("a-2", "A mod", KB),
    ]);
    filters.sortKey.value = "size";

    expect(filters.sorted.value.map((m) => m.id)).toEqual(["a-1", "a-2", "b"]);
  });

  it("does not mutate the source list", () => {
    const mods = [makeMod("mb", "B mod", MB), makeMod("kb", "A mod", KB)];
    const filters = createFilters(mods);
    filters.sortKey.value = "size";

    filters.sorted.value;
    expect(mods.map((m) => m.id)).toEqual(["mb", "kb"]);
  });

  it("keeps size order after active search filtering", () => {
    const filters = createFilters([
      makeMod("alpha-large", "Alpha Large", MB),
      makeMod("alpha-small", "Alpha Small", KB),
      makeMod("beta", "Beta Large", GB),
    ]);
    filters.sortKey.value = "size";
    filters.search.value = "alpha";

    filters.order.value = "ASC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["alpha-small", "alpha-large"]);

    filters.order.value = "DESC";
    expect(filters.sorted.value.map((m) => m.id)).toEqual(["alpha-large", "alpha-small"]);
  });

  it("persists size order through sort-mode snapshot and restore", () => {
    const filters = createFilters([makeMod("a", "A", 1), makeMod("b", "B", 2)]);
    filters.sortKey.value = "size";
    filters.order.value = "ASC";

    const snapshot = filters.snapshot();
    filters.order.value = "DESC";
    filters.restore(snapshot);

    expect(filters.order.value).toBe("ASC");
  });
});
