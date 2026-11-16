/**
 * 「收藏」工作区的数据模型：**在线信息 + 本地状态**。
 *
 * 收藏的是「这个模组」，不是「这个模组的本地版本」。因此：
 *   - 标题 / 作者 / 描述 / 发布时间 / 更新时间 / 版本 / 订阅数 / 官方封面
 *     一律来自官方在线来源（在线缓存 → 官方详情缓存 → 离线快照，逐级只补缺）；
 *   - 本地扫描结果只提供 isInstalled / path / kind / enabled / priority / issues
 *     等安装状态与操作能力；
 *   - 安装 / 卸载只改变状态与按钮，绝不把元数据换成磁盘 info.json 里的内容。
 *
 * 本文件是纯函数层：没有网络、没有 invoke、没有响应式，方便直接单测。
 */
import type { FavoriteMeta } from "../favoriteMeta";
import type { ModEntry } from "../types";
import type { OnlineMod } from "../online/types";

/** 官方在线元数据 + 展示字段（收藏卡片与详情的信息来源） */
export interface FavoriteOnlineSnapshot {
  modId: number;
  title: string;
  creator: string | null;
  description: string | null;
  tagIds: number[];
  tagNames: string[];
  thumbnailUrl: string | null;
  publishedMs: number | null;
  updatedMs: number | null;
  version: string | null;
  installs: number | null;
  /** 官方压缩包体积（字节） */
  fileSize: number | null;
  /** 官方文件数量 */
  fileCount: number | null;
  /** 官方评分 */
  rating: number | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isFinite(item)) : [];
}

/**
 * 官方日期 → ms epoch。
 * 官方接口同时存在三种形态：ISO 字符串、秒级时间戳、毫秒时间戳。
 * 无法识别时返回 null（显示「未提供」，绝不猜日期）。
 */
export function parseOnlineDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  const text = str(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return parseOnlineDate(Number(text));
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** 官方详情 / 列表里的描述是 HTML：落进 ModEntry 前纯文本化 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRaw(raw: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!raw) return null;
  for (const key of keys) {
    const value = raw[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return null;
}

function emptySnapshot(modId: number): FavoriteOnlineSnapshot {
  return {
    modId,
    title: "",
    creator: null,
    description: null,
    tagIds: [],
    tagNames: [],
    thumbnailUrl: null,
    publishedMs: null,
    updatedMs: null,
    version: null,
    installs: null,
    fileSize: null,
    fileCount: null,
    rating: null,
  };
}

/** 在线缓存 / 索引列表条目 → 快照（列表没有描述与发布时间，保持 null） */
export function snapshotFromList(mod: OnlineMod): FavoriteOnlineSnapshot {
  const raw = mod.raw ?? {};
  return {
    modId: mod.modId,
    title: str(mod.title),
    creator: mod.creator?.trim() || null,
    description: null,
    tagIds: [...numList(mod.tagIds)],
    tagNames: [...strList(mod.tagNames)],
    thumbnailUrl: str(mod.thumbnail) || null,
    publishedMs: parseOnlineDate(pickRaw(raw, ["createDate", "created", "dateCreated"])),
    updatedMs: parseOnlineDate(pickRaw(raw, ["lastUpdate", "updated", "lastModified"])),
    version: str(pickRaw(raw, ["modVersion", "version"])) || null,
    installs: num(pickRaw(raw, ["installs", "downloadCount", "subscriptions"])) ?? mod.installs,
    // 与在线详情同一口径：详情 modFileSize → 列表 fileSize；列表没有就保持 null
    fileSize: num(pickRaw(raw, ["modFileSize", "fileSize"])) ?? mod.fileSize ?? null,
    fileCount: num(pickRaw(raw, ["fileCount", "numFiles", "file_count", "modFileCount"])) ?? null,
    rating: mod.rating ?? num(pickRaw(raw, ["currentRating", "rating", "averageRating"])) ?? null,
  };
}

/** 官方详情缓存 → 快照（详情是描述 / 版本 / 发布时间的权威来源） */
export function snapshotFromDetail(
  modId: number,
  raw: Record<string, unknown> | null | undefined,
): FavoriteOnlineSnapshot {
  const out = emptySnapshot(modId);
  if (!raw) return out;
  const description = plainText(str(pickRaw(raw, ["description", "modDescription"])));
  out.title = str(pickRaw(raw, ["modName", "title", "name"]));
  out.creator = str(pickRaw(raw, ["creatorName", "creator", "author"])) || null;
  out.description = description || null;
  out.tagIds = numList(pickRaw(raw, ["modTagIds", "tagIds"]));
  out.tagNames = strList(pickRaw(raw, ["modTagNames", "tagNames", "tags"]));
  out.thumbnailUrl = str(pickRaw(raw, ["imageThumbnail", "thumbnail", "thumbnailUrl"])) || null;
  out.publishedMs = parseOnlineDate(pickRaw(raw, ["createDate", "created", "dateCreated"]));
  out.updatedMs = parseOnlineDate(pickRaw(raw, ["lastUpdate", "updated", "lastModified"]));
  out.version = str(pickRaw(raw, ["modVersion", "version"])) || null;
  out.installs = num(pickRaw(raw, ["installs", "downloadCount", "subscriptions"]));
  out.fileSize = num(pickRaw(raw, ["modFileSize", "fileSize"]));
  out.fileCount = num(pickRaw(raw, ["fileCount", "numFiles", "file_count", "modFileCount"]));
  out.rating = num(pickRaw(raw, ["currentRating", "rating", "averageRating"]));
  return out;
}

/** 离线快照（favoriteMeta）→ 快照：只保证卸载后仍能显示标题 / 作者 / 分类 / 封面 */
export function snapshotFromMeta(meta: FavoriteMeta | null): FavoriteOnlineSnapshot | null {
  if (!meta || !Number.isFinite(meta.modId) || meta.modId <= 0) return null;
  return {
    modId: meta.modId,
    title: meta.title,
    creator: meta.creator,
    description: meta.description,
    tagIds: [...meta.tagIds],
    tagNames: [...meta.tagNames],
    thumbnailUrl: meta.thumbnailUrl,
    publishedMs: meta.publishedMs ?? null,
    updatedMs: meta.updatedMs ?? null,
    version: meta.version ?? null,
    installs: meta.installs ?? null,
    // 离线快照目前不存体积 / 文件数 / 评分：保持 null，由列表或详情缓存补
    fileSize: null,
    fileCount: null,
    rating: null,
  };
}

/**
 * 合并三级来源：后一级只补前一级的**空字段**，不覆盖已拿到的官方值。
 * 顺序：在线列表（最实时） → 官方详情缓存（描述/版本权威） → favoriteMeta 离线快照。
 */
export function mergeSnapshots(
  modId: number,
  layers: (FavoriteOnlineSnapshot | null | undefined)[],
): FavoriteOnlineSnapshot {
  let out = emptySnapshot(modId);
  for (const layer of layers) {
    if (!layer) continue;
    out = {
      modId,
      title: out.title || layer.title,
      creator: out.creator ?? layer.creator,
      description: out.description ?? layer.description,
      tagIds: out.tagIds.length ? out.tagIds : layer.tagIds,
      tagNames: out.tagNames.length ? out.tagNames : layer.tagNames,
      thumbnailUrl: out.thumbnailUrl ?? layer.thumbnailUrl,
      publishedMs: out.publishedMs ?? layer.publishedMs,
      updatedMs: out.updatedMs ?? layer.updatedMs,
      version: out.version ?? layer.version,
      installs: out.installs ?? layer.installs,
      fileSize: out.fileSize ?? layer.fileSize,
      fileCount: out.fileCount ?? layer.fileCount,
      rating: out.rating ?? layer.rating,
    };
  }
  return out;
}

/** 在线前缀：未安装条目的 entryId（与真实条目 id 天然不冲突） */
const FAV_PREFIX = "fav:";

export function favoriteEntryId(modId: number): string {
  return FAV_PREFIX + modId;
}

export function isFavoriteEntryId(id: string): boolean {
  return id.startsWith(FAV_PREFIX);
}

/**
 * 组装一条收藏条目：**官方在线信息 + 本地安装状态**。
 *
 * `local` 存在（= 本机扫描到了这个 WorkshopID）时，只借用它的安装状态字段
 * （id / path / kind / enabled / priority / issues / sizeBytes …），
 * 所有元数据字段一律用在线快照覆盖；`local` 为 null 时生成「未安装」条目，
 * 操作区只有「下载安装」。
 */
export function buildFavoriteEntry(input: {
  modId: number;
  online: FavoriteOnlineSnapshot;
  local: ModEntry | null;
  /** 未安装条目的封面（应用图片缓存 asset URL） */
  coverUrl?: string | null;
}): ModEntry {
  const { modId, online, local } = input;
  const title = online.title || local?.displayName || `#${modId}`;
  const onlineInfo = {
    publishedMs: online.publishedMs,
    updatedMs: online.updatedMs,
    version: online.version,
    installs: online.installs,
    fileSize: online.fileSize,
    fileCount: online.fileCount,
    rating: online.rating,
    thumbnailUrl: online.thumbnailUrl,
  };
  const tags = online.tagNames.length ? [...online.tagNames] : local?.officialTags ?? [];

  if (!local) {
    return {
      id: favoriteEntryId(modId),
      folderName: "",
      path: "",
      // 官方订阅位的模组：将来重新下载时装到 subscribed/，只影响展示文案
      kind: "subscribed",
      workshopId: modId,
      nameFromFolder: `#${modId}`,
      displayName: title,
      displayNameSource: "folder",
      author: online.creator,
      description: online.description,
      thumbnail: null,
      coverUrl: input.coverUrl ?? null,
      enabled: null,
      priority: null,
      lastUpdateMs: online.updatedMs,
      installedAtMs: null,
      checksum: null,
      contentTags: tags,
      categories: [],
      categorySource: tags.length ? "official" : "heuristic",
      officialTags: tags,
      source: "unknown",
      metadataRecorded: false,
      issues: [],
      infoJsonPresent: false,
      isDataMod: false,
      sizeBytes: null,
      sizeComplete: false,
      uninstalled: true,
      origin: "online",
      onlineInfo,
    };
  }

  return {
    ...local,
    // 元数据：官方在线来源优先；本地字段只在官方缺该字段时兜底
    displayName: title,
    author: online.creator ?? local.author,
    description: online.description ?? local.description,
    lastUpdateMs: online.updatedMs ?? local.lastUpdateMs,
    contentTags: tags.length ? tags : local.contentTags,
    officialTags: tags.length ? tags : local.officialTags,
    categorySource: tags.length ? "official" : local.categorySource,
    uninstalled: false,
    // 已安装时来源就是磁盘条目，封面 / 开关按本地处理
    origin: "local",
    onlineInfo,
  };
}

/** true = 本条收藏在本机有安装目录（本地状态，不影响信息区） */
export function favoriteIsInstalled(entry: ModEntry | null | undefined): boolean {
  return !!entry && entry.uninstalled !== true;
}
