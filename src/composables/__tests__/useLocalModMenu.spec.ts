import { describe, it, expect } from "vitest";
import type { ModEntry, ModKind, ModSource } from "../../types";
import { buildLocalMenuItems } from "../local/useLocalModMenu";

function makeMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "local/test_12345",
    folderName: "test_12345",
    path: "C:/AoE2DE/mods/local/test_12345",
    kind: "local" as ModKind,
    workshopId: 12345,
    nameFromFolder: "test_12345",
    displayName: "Test Mod",
    displayNameSource: "info.json",
    author: "Tester",
    description: "A description long enough to be translatable.",
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: 1700000000000,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: [],
    categorySource: "heuristic",
    officialTags: [],
    source: "tool" as ModSource,
    metadataRecorded: true,
    issues: [],
    infoJsonPresent: true,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    ...overrides,
  };
}

const labels = {
  enable: "Enable",
  disable: "Disable",
  favorite: "Favorite",
  favorited: "Favorited",
  rename: "Rename",
  translateBusy: "Translating…",
  translateQueued: "Queued",
  translateTrigger: "Translate",
  translateShowTranslated: "Show translated",
  translateShowOriginal: "Show original",
  openFolder: "Open folder",
  browseSite: "Open webpage",
  deleteMod: "Uninstall",
  notRegisteredHint: "Not registered",
};

const baseState = {
  favorited: false,
  hasTranslation: false,
  canText: true,
  translating: false,
  queued: false,
  showingOriginal: false,
};

describe("buildLocalMenuItems", () => {
  it("real installed mod: toggle/favorite/rename/translate/folder/website/delete, no download", () => {
    const items = buildLocalMenuItems(makeMod(), baseState, labels);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      "toggle",
      "favorite",
      "translate",
      "rename",
      "folder",
      "website",
      "delete",
    ]);
    const toggle = items.find((i) => i.id === "toggle")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.label).toBe("Disable");
    const del = items.find((i) => i.id === "delete")!;
    expect(del.danger).toBe(true);
    expect(del.dividerBefore).toBe(true);
    expect(ids).not.toContain("install");
  });

  it("unknown state (enabled=null) disables toggle with hint", () => {
    const items = buildLocalMenuItems(makeMod({ enabled: null }), baseState, labels);
    const toggle = items.find((i) => i.id === "toggle")!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.hint).toBe("Not registered");
  });

  it("旧收藏幽灵条目的下载入口已移除：即使带 uninstalled 标记也按本地条目出菜单", () => {
    const stale = makeMod({
      uninstalled: true,
      enabled: null,
      path: "",
      folderName: "",
    });
    const items = buildLocalMenuItems(stale, baseState, labels);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(["toggle", "favorite", "translate", "rename", "folder", "website", "delete"]);
    expect(ids).not.toContain("install");
    // 无 mod-status 记录时启用项禁用并给出提示，而不是走下载安装
    expect(items.find((i) => i.id === "toggle")!.disabled).toBe(true);
  });

  it("mod without workshop id disables favorite/rename/website", () => {
    const items = buildLocalMenuItems(makeMod({ workshopId: null }), baseState, labels);
    for (const id of ["favorite", "rename", "website"]) {
      expect(items.find((i) => i.id === id)!.disabled).toBe(true);
    }
  });

  it("translate disabled when no cached translation and text is not translatable", () => {
    const items = buildLocalMenuItems(
      makeMod(),
      { ...baseState, hasTranslation: false, canText: false },
      labels,
    );
    expect(items.find((i) => i.id === "translate")!.disabled).toBe(true);
  });
});
