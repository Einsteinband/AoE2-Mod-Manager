/**
 * 收藏 / 列表项的真实来源识别 + 封面候选来源（纯函数，零副作用）。
 *
 * 背景：在线页的「我的收藏」是聚合视图，里面既有在线模组，也有本机已安装的副本。
 * 但收藏项过去只有 `modId`，合并 / 筛选 / 排序 / 打开详情之后没人记得它在磁盘上存在，
 * 于是本地副本被当成纯在线模组处理：封面走官网缩略图、刷新走在线下载命令。
 *
 * 规则（不可违反）：
 * 1. 来源由**磁盘事实**（本机安装索引 installed.localIndex）判定，不由当前页面模式判定；
 * 2. 本地来源的封面只允许来自本地文件（模组目录内的封面文件 / 应用图片缓存），
 *    **禁止**回落到官网 URL，也禁止为此排队任何网络请求；
 * 3. 在线来源保持原行为：应用图片缓存优先，缺失才用官网 URL。
 *
 * 封面文件名与 Rust `scan.rs` 的 `THUMB_NAMES` 保持一致，顺序也一致（先官方固定名，后遗留命名）。
 */

/** 与 Rust scan::THUMB_NAMES 对齐（仅模组根目录文件） */
export const LOCAL_COVER_FILE_NAMES = [
  "thumbnail.jpg",
  "thumbnail.jpeg",
  "thumbnail.png",
  "thumbnail.webp",
  "_preview-icon.jpg",
  "_preview-icon.jpeg",
  "_preview-icon.png",
  "_preview-icon.webp",
] as const;

export type ModOrigin = "local" | "online";

/** 是不是可以发网络请求的封面地址（asset: / asset.localhost / data: 都不算） */
export function isRemoteThumbnail(url: string | null | undefined): boolean {
  const text = (url ?? "").trim().toLowerCase();
  return text.startsWith("http://") || text.startsWith("https://");
}

/**
 * 收藏项来源：只要磁盘上有这个模组的安装目录，它就是「本地来源」。
 * 只凭 modId 大小 / 是否命中在线缓存都不能判断，必须传本机安装索引的结果。
 */
export function favoriteOrigin(hasLocalEntry: boolean): ModOrigin {
  return hasLocalEntry ? "local" : "online";
}

function joinPath(root: string, kind: string, folder: string, file: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${kind}${sep}${folder}${sep}${file}`;
}

/** 模组目录下所有可能的封面文件绝对路径（按优先级） */
export function localCoverPaths(
  root: string | null | undefined,
  kind: string | null | undefined,
  folderName: string | null | undefined,
): string[] {
  const base = (root ?? "").trim();
  const kindName = (kind ?? "").trim();
  const folder = (folderName ?? "").trim();
  if (!base || !kindName || !folder) return [];
  return LOCAL_COVER_FILE_NAMES.map((name) => joinPath(base, kindName, folder, name));
}

export interface CoverPlanInput {
  origin: ModOrigin;
  /** 模组目录内候选封面（绝对路径，按优先级） */
  localPaths: string[];
  /** 应用图片缓存命中（已是 asset URL） */
  cachedUrl: string | null;
  /** 官网缩略图 URL */
  remoteUrl: string | null;
  /** 绝对路径 → asset URL（由调用方注入 convertFileSrc，保持本模块可纯测） */
  toAssetUrl?: (path: string) => string;
}

export interface CoverPlan {
  /** 依次尝试的封面地址；空数组 = 没有可用封面，界面显示占位 */
  urls: string[];
  /** 是否允许在候选全部失败后回落到官网地址 */
  allowRemote: boolean;
}

/**
 * 通用的来源判定（两个页面共用同一口径，禁止各处再写一套）：
 * - 显式 `origin` 优先（在线页收藏聚合层写入）；
 * - 没有标记时，`uninstalled === true`（本地页的「已卸载收藏占位」）视为在线来源，
 *   其余磁盘条目视为本地来源。
 */
export function modEntryOrigin(mod: {
  origin?: "local" | "online";
  uninstalled?: boolean;
}): ModOrigin {
  if (mod.origin === "local" || mod.origin === "online") return mod.origin;
  return mod.uninstalled === true ? "online" : "local";
}

/** 在线收藏项的封面候选：只有「应用图片缓存 → 官方缩略图」，永远不掺本地目录路径 */
export function onlineFavoriteCoverUrls(input: {
  cachedUrl: string | null;
  remoteUrl: string | null;
}): string[] {
  return buildCoverPlan({
    origin: "online",
    localPaths: [],
    cachedUrl: input.cachedUrl,
    remoteUrl: input.remoteUrl,
  }).urls;
}

export function buildCoverPlan(input: CoverPlanInput): CoverPlan {
  const toUrl = input.toAssetUrl ?? ((path: string) => path);
  const localUrls = input.localPaths.map((path) => toUrl(path));
  const cached = (input.cachedUrl ?? "").trim();
  if (input.origin === "local") {
    // 本地来源：图片缓存（也在本机磁盘）优先，其次是模组目录里的封面文件；
    // 永远不排官网 URL —— 本地封面缺失时只能走本地封面恢复，不能擅自从服务器取。
    return {
      urls: [...(cached ? [cached] : []), ...localUrls],
      allowRemote: false,
    };
  }
  const remote = (input.remoteUrl ?? "").trim();
  return {
    urls: [...(cached ? [cached] : []), ...(remote ? [remote] : [])],
    allowRemote: false,
  };
}
