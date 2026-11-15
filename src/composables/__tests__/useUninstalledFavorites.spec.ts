import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModEntry } from "../../types";

/**
 * 本地页「我的收藏」里的在线条目（已卸载 / 未安装占位）。
 *
 * 这里锁定三件事：
 * 1. 占位条目必须带 `origin: "online"`，来源不靠调用方另猜；
 * 2. 同一 Workshop ID 若本次扫描已有磁盘条目，就**不再**生成占位（不出现双份、来源不混淆）；
 * 3. 在线条目的封面只来自应用图片缓存 + 官方缩略图地址，永远不会去拼本地目录路径。
 */

const mocks = vi.hoisted(() => ({
  favorites: new Set<number>([45782, 99991]),
  localImages: vi.fn(async (ids: number[]) => {
    const map: Record<number, string> = {};
    for (const id of ids) if (id === 45782) map[id] = "asset://localhost/cache/45782.jpg";
    return map;
  }),
  fetchImages: vi.fn(async (_tasks: { modId: number; url: string }[] = []) => 1),
}));

vi.mock("../../online/images", () => ({
  assetUrl: (path: string) => `asset://localhost/${path}`,
  fetchImages: mocks.fetchImages,
  localImages: mocks.localImages,
  onImagesReady: vi.fn(async () => () => undefined),
}));

vi.mock("../../favoriteMeta", () => ({
  favoriteMetaOf: (modId: number) =>
    modId === 99991
      ? {
          modId,
          title: "Online Only",
          creator: "Remote Author",
          description: "from official API",
          tagIds: [1],
          tagNames: ["UI"],
          thumbnailUrl: "https://api.ageofempires.com/thumb/99991.jpg",
          savedAtMs: 1,
        }
      : null,
  rememberInstalledMods: vi.fn(),
}));

vi.mock("../../online/networkError", () => ({ isNetworkError: ref(false) }));
vi.mock("../../userData", () => ({
  favoriteIdSet: computed(() => mocks.favorites),
  userDataLoaded: ref(true),
}));

import { useUninstalledFavorites } from "../local/useUninstalledFavorites";

function makeInstalled(workshopId: number | null, folderName = "abewwwe"): ModEntry {
  return {
    id: `subscribed/${folderName}`,
    folderName,
    path: `F:/Games/AoE2DE/subscribed/${folderName}`,
    kind: "subscribed",
    workshopId,
    nameFromFolder: folderName,
    displayName: "abewwwe",
    displayNameSource: "folder",
    author: null,
    description: null,
    thumbnail: `F:/Games/AoE2DE/subscribed/${folderName}/thumbnail.jpg`,
    enabled: true,
    priority: 1,
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
  };
}

function mount(mods: ModEntry[]) {
  const modsRef = computed(() => mods);
  return useUninstalledFavorites({ mods: modsRef });
}

beforeEach(() => {
  mocks.favorites = new Set<number>([45782, 99991]);
  mocks.localImages.mockClear();
  mocks.fetchImages.mockClear();
});

describe("useUninstalledFavorites source identity", () => {
  it("扫描里没有的收藏 → 占位条目，来源标记为 online 且没有本地路径", () => {
    const fav = mount([]);
    expect(fav.ghosts.value.map((g) => g.workshopId)).toEqual([45782, 99991]);
    for (const ghost of fav.ghosts.value) {
      expect(ghost.uninstalled).toBe(true);
      expect(ghost.origin).toBe("online");
      expect(ghost.path).toBe("");
      expect(ghost.folderName).toBe("");
    }
  });

  it("同一 Workshop ID 已安装在磁盘 → 不生成占位（不会出现本地+在线两条）", () => {
    const fav = mount([makeInstalled(45782)]);
    expect(fav.ghosts.value.map((g) => g.workshopId)).toEqual([99991]);
  });

  it("在线条目封面只取应用图片缓存，缓存命中后写进 coverUrl", async () => {
    const fav = mount([]);
    await nextTick();
    await nextTick();
    expect(mocks.localImages).toHaveBeenCalled();
    const ghost = fav.ghosts.value.find((g) => g.workshopId === 45782);
    expect(ghost?.coverUrl).toBe("asset://localhost/cache/45782.jpg");
  });

  it("缺图时只按官方缩略图地址补图（不拼本地目录路径）", async () => {
    mount([]);
    await nextTick();
    await nextTick();
    await nextTick();
    const tasks = mocks.fetchImages.mock.calls.at(-1)?.[0];
    expect(tasks?.some((task) => task.modId === 99991 && task.url.startsWith("https://"))).toBe(true);
    expect(tasks?.every((task) => !task.url.includes("\\") && !task.url.includes("F:"))).toBe(true);
  });
});
