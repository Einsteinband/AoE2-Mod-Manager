import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OnlineMod } from "../../online/types";
import { ONLINE_SIZE_SORT } from "../online/sortOnlineMods";

const { findMods, installedMods, modDetail } = vi.hoisted(() => ({
  findMods: vi.fn(),
  installedMods: vi.fn(),
  modDetail: vi.fn(),
}));

vi.mock("../../online/service", () => ({
  findMods,
  installedMods,
  modDetail,
}));

function makeMod(modId: number, title: string, fileSize: OnlineMod["fileSize"]): OnlineMod {
  return {
    modId,
    title,
    creator: null,
    thumbnail: null,
    installs: null,
    installsTruncated: false,
    rating: null,
    modStatus: null,
    userInstalled: false,
    userDownloaded: false,
    updateAvailable: false,
    gameTitleId: 2,
    tagIds: [],
    tagNames: [],
    fileSize,
    raw: {},
  };
}

async function loadModule() {
  vi.resetModules();
  return await import("../online/onlineSizeSortSetting");
}

describe("online size sort setting", () => {
  beforeEach(() => {
    window.localStorage.clear();
    findMods.mockClear();
    installedMods.mockClear();
    modDetail.mockClear();
  });

  it("defaults to closed when storage has no saved preference", async () => {
    const mod = await loadModule();
    expect(mod.onlineSizeSortEnabled.value).toBe(false);
    expect(mod.visibleOnlineSortOptions.value.some((opt) => opt.value === ONLINE_SIZE_SORT)).toBe(false);
  });

  it("persists the enabled and disabled preference", async () => {
    const mod = await loadModule();
    mod.setOnlineSizeSortEnabled(true);
    expect(window.localStorage.getItem("aoe2mm.onlineSizeSortEnabled")).toBe("1");

    const reopened = await loadModule();
    expect(reopened.onlineSizeSortEnabled.value).toBe(true);

    reopened.setOnlineSizeSortEnabled(false);
    expect(window.localStorage.getItem("aoe2mm.onlineSizeSortEnabled")).toBe("0");
    const closed = await loadModule();
    expect(closed.onlineSizeSortEnabled.value).toBe(false);
  });

  it("hides the size option when disabled and exposes it when enabled", async () => {
    const mod = await loadModule();
    expect(mod.visibleOnlineSortOptions.value.map((opt) => opt.value)).not.toContain(ONLINE_SIZE_SORT);

    mod.setOnlineSizeSortEnabled(true);
    expect(mod.visibleOnlineSortOptions.value.map((opt) => opt.value)).toContain(ONLINE_SIZE_SORT);
  });

  it("falls back to the default online sort when disabled from size sorting", async () => {
    const mod = await loadModule();
    expect(mod.normalizeOnlineSortForSetting(ONLINE_SIZE_SORT)).toBe(mod.DEFAULT_ONLINE_SORT);
    expect(mod.normalizeOnlineSortForSetting("popular")).toBe("popular");

    mod.setOnlineSizeSortEnabled(true);
    expect(mod.normalizeOnlineSortForSetting(ONLINE_SIZE_SORT)).toBe(ONLINE_SIZE_SORT);
  });

  it("prefers current-list sizes, supplements matching cached sizes, and leaves unknowns unknown", async () => {
    const mod = await loadModule();
    const mods = [
      makeMod(1, "Existing", 1024),
      makeMod(2, "Missing", null),
      makeMod(3, "Invalid", NaN),
      makeMod(4, "Zero", 0),
      makeMod(5, "Unmatched", null),
    ];
    const cached = new Map<number, number>([
      [2, 2048],
      [3, 4096],
      [4, 8192],
      [999, 32],
    ]);

    const before = mods.map((m) => ({ ...m }));
    const result = mod.hydrateOnlineModSizes(mods, cached);

    expect(result.items.map((m) => m.fileSize)).toEqual([1024, 2048, 4096, 0, null]);
    expect(result.stats).toEqual({ total: 5, existing: 2, supplemented: 2, missing: 1 });
    expect(mods).toEqual(before);
    expect(result.items[2]).not.toBe(mods[2]);
    expect(result.items[3]).toBe(mods[3]);
    expect(result.items[4]).toBe(mods[4]);
    expect(result.items[1]).not.toBe(mods[1]);
  });

  it("does not branch the local mod sort through this online preference", () => {
    const localBrowser = readFileSync(join("src", "components", "local", "LocalBrowser.vue"), "utf8");
    const localFilters = readFileSync(join("src", "composables", "local", "useLocalFilters.ts"), "utf8");
    expect(localBrowser).not.toContain("onlineSizeSort");
    expect(localFilters).not.toContain("onlineSizeSort");
  });

  it("does not inject other cached mods into the current list", async () => {
    const mod = await loadModule();
    const mods = [makeMod(1, "Current", null)];
    const cached = new Map<number, number>([
      [1, 12],
      [2, 34],
    ]);

    const result = mod.hydrateOnlineModSizes(mods, cached);
    expect(result.items.map((m) => m.modId)).toEqual([1]);
  });

  it("does not call Find, Installed, or Detail when toggling, reading options, or hydrating sizes", async () => {
    const mod = await loadModule();
    mod.setOnlineSizeSortEnabled(true);
    mod.visibleOnlineSortOptions.value;
    mod.normalizeOnlineSortForSetting(ONLINE_SIZE_SORT);
    mod.hydrateOnlineModSizes([makeMod(1, "A", null)], new Map([[1, 8]]));

    expect(findMods).not.toHaveBeenCalled();
    expect(installedMods).not.toHaveBeenCalled();
    expect(modDetail).not.toHaveBeenCalled();
  });
});
