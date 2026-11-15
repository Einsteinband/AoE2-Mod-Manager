import { describe, expect, it } from "vitest";
import {
  LOCAL_COVER_FILE_NAMES,
  buildCoverPlan,
  favoriteOrigin,
  isRemoteThumbnail,
  localCoverPaths,
} from "../modSource";

/**
 * 收藏聚合视图的来源识别与封面候选（纯函数）。
 *
 * 这些断言直接对应本次故障：同一个 Workshop ID 既可能是本机已安装副本、
 * 也可能是纯在线条目，来源只能由磁盘事实决定；一旦判为本地来源，
 * 封面候选里不允许出现任何官网 URL（否则就又回去请求服务器了）。
 */
describe("favoriteOrigin", () => {
  it("本机有安装目录 → local", () => {
    expect(favoriteOrigin(true)).toBe("local");
  });

  it("本机没有安装目录 → online", () => {
    expect(favoriteOrigin(false)).toBe("online");
  });
});

describe("localCoverPaths", () => {
  it("候选文件名与 Rust THUMB_NAMES 一致（含遗留 _preview-icon 命名）", () => {
    expect([...LOCAL_COVER_FILE_NAMES]).toEqual([
      "thumbnail.jpg",
      "thumbnail.jpeg",
      "thumbnail.png",
      "thumbnail.webp",
      "_preview-icon.jpg",
      "_preview-icon.jpeg",
      "_preview-icon.png",
      "_preview-icon.webp",
    ]);
  });

  it("Windows 根目录按反斜杠拼接，顺序与候选文件名一致", () => {
    const paths = localCoverPaths("F:\\Games\\AoE2DE", "local", "abewwwe");
    expect(paths).toHaveLength(8);
    expect(paths[0]).toBe("F:\\Games\\AoE2DE\\local\\abewwwe\\thumbnail.jpg");
    expect(paths[4]).toBe("F:\\Games\\AoE2DE\\local\\abewwwe\\_preview-icon.jpg");
  });

  it("根目录结尾带分隔符不会拼出双分隔符", () => {
    const paths = localCoverPaths("F:\\Games\\AoE2DE\\", "subscribed", "x");
    expect(paths[0]).toBe("F:\\Games\\AoE2DE\\subscribed\\x\\thumbnail.jpg");
  });

  it("根目录 / kind / 目录名任一缺失 → 没有候选（不猜路径）", () => {
    expect(localCoverPaths("", "local", "x")).toEqual([]);
    expect(localCoverPaths("F:\\R", "", "x")).toEqual([]);
    expect(localCoverPaths("F:\\R", "local", "  ")).toEqual([]);
    expect(localCoverPaths(null, null, null)).toEqual([]);
  });
});

describe("isRemoteThumbnail", () => {
  it("只把 http(s) 认作网络地址", () => {
    expect(isRemoteThumbnail("https://cdn.example/x.jpg")).toBe(true);
    expect(isRemoteThumbnail("http://cdn.example/x.jpg")).toBe(true);
    expect(isRemoteThumbnail("asset://localhost/F%3A/x.jpg")).toBe(false);
    expect(isRemoteThumbnail("data:image/png;base64,AAA")).toBe(false);
    expect(isRemoteThumbnail(null)).toBe(false);
  });
});

describe("buildCoverPlan", () => {
  const toAsset = (path: string) => `asset://local/${path}`;

  it("本地来源：缓存 + 本地文件，绝不带官网 URL（即使服务端有缩略图）", () => {
    const plan = buildCoverPlan({
      origin: "local",
      localPaths: ["F:\\R\\local\\abewwwe\\thumbnail.jpg", "F:\\R\\local\\abewwwe\\_preview-icon.jpg"],
      cachedUrl: "asset://local/F%3A/cache/45782.jpg",
      remoteUrl: "https://api.ageofempires.com/thumb/45782.jpg",
      toAssetUrl: toAsset,
    });
    expect(plan.urls).toEqual([
      "asset://local/F%3A/cache/45782.jpg",
      "asset://local/F:\\R\\local\\abewwwe\\thumbnail.jpg",
      "asset://local/F:\\R\\local\\abewwwe\\_preview-icon.jpg",
    ]);
    expect(plan.urls.some((url) => isRemoteThumbnail(url))).toBe(false);
    expect(plan.allowRemote).toBe(false);
  });

  it("本地来源、缓存也没命中：只剩本地文件候选", () => {
    const plan = buildCoverPlan({
      origin: "local",
      localPaths: ["F:\\R\\local\\abewwwe\\thumbnail.png"],
      cachedUrl: null,
      remoteUrl: null,
    });
    expect(plan.urls).toEqual(["F:\\R\\local\\abewwwe\\thumbnail.png"]);
    expect(plan.allowRemote).toBe(false);
  });

  it("在线来源：缓存优先，缺失才用官网缩略图，不掺本地目录路径", () => {
    const plan = buildCoverPlan({
      origin: "online",
      localPaths: ["F:\\R\\local\\abewwwe\\thumbnail.jpg"],
      cachedUrl: null,
      remoteUrl: "https://api.ageofempires.com/thumb/45782.jpg",
    });
    expect(plan.urls).toEqual(["https://api.ageofempires.com/thumb/45782.jpg"]);
    expect(plan.allowRemote).toBe(false);
  });

  it("同一个 Workshop ID：来源不同 → 封面候选完全不同（不靠 ID 猜来源）", () => {
    const remoteUrl = "https://api.ageofempires.com/thumb/45782.jpg";
    const localPaths = ["F:\\R\\local\\abewwwe\\thumbnail.jpg"];
    const local = buildCoverPlan({ origin: favoriteOrigin(true), localPaths, cachedUrl: null, remoteUrl });
    const online = buildCoverPlan({ origin: favoriteOrigin(false), localPaths, cachedUrl: null, remoteUrl });
    expect(local.urls).toEqual(localPaths);
    expect(online.urls).toEqual([remoteUrl]);
  });
});
