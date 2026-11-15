import { describe, expect, it } from "vitest";
import type { ModEntry } from "../../types";
import {
  buildFavoriteEntry,
  mergeSnapshots,
  parseOnlineDate,
  snapshotFromDetail,
  snapshotFromList,
  snapshotFromMeta,
  type FavoriteOnlineSnapshot,
} from "../model";

function localMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "local:123",
    folderName: "123_SomeMod",
    path: "D:\\mods\\local\\123_SomeMod",
    kind: "local",
    workshopId: 123,
    nameFromFolder: "SomeMod",
    displayName: "本地 info.json 的标题",
    displayNameSource: "info.json",
    author: "AoE Official",
    description: "本地 info.json 的旧描述",
    thumbnail: "D:\\mods\\local\\123_SomeMod\\thumbnail.jpg",
    enabled: true,
    priority: 3,
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
    sizeBytes: 10,
    sizeComplete: true,
    ...overrides,
  };
}

const onlineSnapshot: FavoriteOnlineSnapshot = {
  modId: 123,
  title: "官方标题",
  creator: "PoisonousSnakes",
  description: "官方描述",
  tagIds: [7],
  tagNames: ["UI"],
  thumbnailUrl: "https://cdn.example/thumb.jpg",
  publishedMs: 1790000000000,
  updatedMs: 1791000000000,
  version: "2.7",
  installs: 1281,
};

describe("parseOnlineDate", () => {
  it("接受秒级 / 毫秒级时间戳与 ISO 字符串", () => {
    expect(parseOnlineDate(1790000000)).toBe(1790000000000);
    expect(parseOnlineDate(1790000000000)).toBe(1790000000000);
    expect(parseOnlineDate("2026-08-22T13:43:00")).toBe(Date.parse("2026-08-22T13:43:00"));
  });

  it("无法识别时返回 null，不猜日期", () => {
    expect(parseOnlineDate(null)).toBeNull();
    expect(parseOnlineDate("")).toBeNull();
    expect(parseOnlineDate("Unpublished")).toBeNull();
  });
});

describe("snapshotFromDetail", () => {
  it("读取官方详情字段（描述去 HTML）", () => {
    const snapshot = snapshotFromDetail(123, {
      modName: "官方标题",
      creatorName: "PoisonousSnakes",
      modDescription: "<p>第一行</p><p>第二行</p>",
      modVersion: "2.7",
      createDate: "2026-08-22T13:43:00",
      lastUpdate: 1791000000,
      installs: 1281,
      imageThumbnail: "https://cdn.example/thumb.jpg",
    });
    expect(snapshot.title).toBe("官方标题");
    expect(snapshot.creator).toBe("PoisonousSnakes");
    expect(snapshot.description).toBe("第一行\n第二行");
    expect(snapshot.version).toBe("2.7");
    expect(snapshot.installs).toBe(1281);
    expect(snapshot.publishedMs).toBe(Date.parse("2026-08-22T13:43:00"));
    expect(snapshot.updatedMs).toBe(1791000000000);
  });
});

describe("mergeSnapshots", () => {
  it("后层只补缺，不覆盖已有官方值", () => {
    const merged = mergeSnapshots(123, [
      snapshotFromList({ modId: 123, title: "列表标题", creator: "列表作者" } as never),
      { ...onlineSnapshot, title: "", creator: null, description: null, version: null },
      snapshotFromMeta({
        modId: 123,
        title: "离线标题",
        creator: "离线作者",
        description: "离线描述",
        tagIds: [],
        tagNames: [],
        thumbnailUrl: null,
        savedAtMs: 1,
        version: "1.0",
      }),
    ]);
    expect(merged.title).toBe("列表标题");
    expect(merged.creator).toBe("列表作者");
    expect(merged.description).toBe("离线描述");
    expect(merged.version).toBe("1.0");
  });
});

describe("buildFavoriteEntry", () => {
  it("已安装：安装状态来自本地，元数据全部来自官方", () => {
    const entry = buildFavoriteEntry({ modId: 123, online: onlineSnapshot, local: localMod() });
    expect(entry.id).toBe("local:123");
    expect(entry.uninstalled).toBe(false);
    expect(entry.enabled).toBe(true);
    expect(entry.path).toBe("D:\\mods\\local\\123_SomeMod");
    // 关键：不再出现 AoE Official / 2022 这种本地 info.json 元数据
    expect(entry.displayName).toBe("官方标题");
    expect(entry.author).toBe("PoisonousSnakes");
    expect(entry.description).toBe("官方描述");
    expect(entry.lastUpdateMs).toBe(1791000000000);
    expect(entry.onlineInfo?.publishedMs).toBe(1790000000000);
    expect(entry.onlineInfo?.version).toBe("2.7");
    expect(entry.onlineInfo?.installs).toBe(1281);
    expect(entry.contentTags).toEqual(["UI"]);
    expect(entry.categorySource).toBe("official");
  });

  it("未安装：官方信息 + 下载安装占位条目", () => {
    const entry = buildFavoriteEntry({
      modId: 123,
      online: onlineSnapshot,
      local: null,
      coverUrl: "asset://cache/123.jpg",
    });
    expect(entry.id).toBe("fav:123");
    expect(entry.uninstalled).toBe(true);
    expect(entry.origin).toBe("online");
    expect(entry.enabled).toBeNull();
    expect(entry.displayName).toBe("官方标题");
    expect(entry.author).toBe("PoisonousSnakes");
    expect(entry.onlineInfo?.installs).toBe(1281);
    expect(entry.coverUrl).toBe("asset://cache/123.jpg");
  });

  it("安装 / 卸载来回切换时官方信息完全一致", () => {
    const installed = buildFavoriteEntry({ modId: 123, online: onlineSnapshot, local: localMod() });
    const uninstalled = buildFavoriteEntry({ modId: 123, online: onlineSnapshot, local: null });
    const reinstalled = buildFavoriteEntry({ modId: 123, online: onlineSnapshot, local: localMod() });
    const infoOf = (entry: ModEntry) => ({
      displayName: entry.displayName,
      author: entry.author,
      description: entry.description,
      lastUpdateMs: entry.lastUpdateMs,
      onlineInfo: entry.onlineInfo,
    });
    expect(infoOf(installed)).toEqual(infoOf(uninstalled));
    expect(infoOf(reinstalled)).toEqual(infoOf(uninstalled));
    // 变化的只有本地状态与操作能力
    expect(installed.uninstalled).not.toBe(uninstalled.uninstalled);
    expect(installed.enabled).not.toBe(uninstalled.enabled);
  });
});
