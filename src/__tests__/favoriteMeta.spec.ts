import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../online/cache", () => ({
  allCachedItems: vi.fn(() => []),
  readDetailCache: vi.fn(() => null),
}));

vi.mock("../userData", () => ({
  isFavorite: vi.fn(() => true),
}));

import { favoriteMetaOf, rememberOfficialMeta, hydrateFavoriteMeta } from "../favoriteMeta";

const KEY = "aoe2.favoriteMeta.v1";

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("rememberOfficialMeta: 刷新结果覆盖旧值并持久化", () => {
  it("官方值覆盖 info.json 派生的旧作者 / 版本 / 订阅数", async () => {
    await hydrateFavoriteMeta(); // 初始化 store
    // 先写入一条「本地扫描」派生的旧元数据
    rememberOfficialMeta({
      modId: 45782,
      title: "Old Title",
      creator: "AoE Official",
      description: "old desc",
      publishedMs: null,
      updatedMs: 1650000000000,
      version: "1.0",
      installs: 0,
    });
    // 再写入「刚刷新到的官方值」：同字段必须被覆盖
    rememberOfficialMeta({
      modId: 45782,
      title: "Official Title",
      creator: "PoisonousSnakes",
      description: "official desc",
      publishedMs: 1790000000000,
      updatedMs: 1791000000000,
      version: "2.7",
      installs: 1281,
    });

    const meta = favoriteMetaOf(45782);
    expect(meta).not.toBeNull();
    expect(meta!.creator).toBe("PoisonousSnakes");
    expect(meta!.description).toBe("official desc");
    expect(meta!.publishedMs).toBe(1790000000000);
    expect(meta!.updatedMs).toBe(1791000000000);
    expect(meta!.version).toBe("2.7");
    expect(meta!.installs).toBe(1281);
  });

  it("官方没给的字段为空时不覆盖已有值（避免刷新把信息清空）", async () => {
    await hydrateFavoriteMeta();
    rememberOfficialMeta({ modId: 9, title: "T", creator: "Keep", version: "3.1", installs: 10 });
    rememberOfficialMeta({ modId: 9, title: "T2", creator: null, version: null, installs: null });

    const meta = favoriteMetaOf(9);
    expect(meta!.creator).toBe("Keep");
    expect(meta!.version).toBe("3.1");
    expect(meta!.installs).toBe(10);
    expect(meta!.title).toBe("T2");
  });

  it("写入会落 localStorage（重启后仍在，不会退回「作者未知」）", async () => {
    await hydrateFavoriteMeta();
    rememberOfficialMeta({ modId: 777, title: "T", creator: "PoisonousSnakes", version: "2.7" });
    await new Promise((resolve) => setTimeout(resolve, 350)); // 写入有 300ms 合并

    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    expect(raw!).toContain("PoisonousSnakes");
  });
});
