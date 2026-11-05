/**
 * 收藏模组的「离线元数据」轻量缓存（localStorage）。
 *
 * 存在的唯一理由：模组卸载 / 从未下载后，磁盘上已经没有 info.json，
 * 但「我的收藏」仍然必须显示它的标题、作者、分类与封面。
 *
 * 约束：
 * 1. **只存展示与重新下载必需的最小字段**，不存路径、不存目录名（卸载后都没有意义）；
 * 2. 与 `user_data.json` 的分工：那边只记 WorkshopID → (收藏, 备注名)，是**唯一收藏真源**；
 *    这里只是元数据的补充缓存，删掉它不会导致收藏丢失（标题会退化成 #ID）；
 * 3. 纯前端 localStorage，不新增 Rust 命令、不引入后台任务；
 * 4. 写入会做条目裁剪（只保留「已安装 ∪ 已收藏」），文件不会无限增长。
 */
import { ref } from "vue";
import { allCachedItems, readDetailCache } from "./online/cache";
import { isFavorite } from "./userData";
import type { ModEntry } from "./types";

const STORAGE_KEY = "aoe2.favoriteMeta.v1";
/** 条目上限：超过就按 savedAtMs 丢最旧的（正常情况下远到不了） */
const MAX_ENTRIES = 800;

/** 单个模组的离线元数据 */
export interface FavoriteMeta {
  modId: number;
  title: string;
  creator: string | null;
  description: string | null;
  tagIds: number[];
  tagNames: string[];
  /** 官网封面地址：本地图片缓存缺失时用它后台补图 */
  thumbnailUrl: string | null;
  savedAtMs: number;
}

/** 在线缓存 / 在线列表里能提供元数据的最小形状 */
export interface MetaSource {
  modId: number;
  title?: string | null;
  creator?: string | null;
  description?: string | null;
  thumbnail?: string | null;
  tagIds?: number[];
  tagNames?: string[];
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

function toStrList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

function coerceEntry(raw: unknown): FavoriteMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const modId = Number(item.modId);
  if (!Number.isFinite(modId) || modId <= 0) return null;
  return {
    modId,
    title: toStr(item.title),
    creator: toStr(item.creator) || null,
    description: toStr(item.description) || null,
    tagIds: toNumList(item.tagIds),
    tagNames: toStrList(item.tagNames),
    thumbnailUrl: toStr(item.thumbnailUrl) || null,
    savedAtMs: Number(item.savedAtMs) || 0,
  };
}

function readStore(): Record<string, FavoriteMeta> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, FavoriteMeta> = {};
    for (const value of Object.values(parsed ?? {})) {
      const entry = coerceEntry(value);
      if (entry) out[String(entry.modId)] = entry;
    }
    return out;
  } catch {
    // 损坏就当作没有：收藏真源在 user_data.json，这里丢了只是标题退化
    return {};
  }
}

/** 全局单例（响应式：界面上的占位卡会随元数据补齐而刷新） */
const store = ref<Record<string, FavoriteMeta>>(readStore());

let persistTimer: number | null = null;

function persistNow(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value));
  } catch (e) {
    console.warn("[favoriteMeta] failed to save the metadata cache", e);
  }
}

/** 合并连续写入：一次扫描可能补几十条，不该写几十次 */
function persistSoon(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 300);
}

/** 只读视图（调用方不要直接改） */
export const favoriteMetaMap = store;

/** 取某个 WorkshopID 的离线元数据；没有则 null */
export function favoriteMetaOf(modId: number | null | undefined): FavoriteMeta | null {
  const id = Number(modId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return store.value[String(id)] ?? null;
}

/**
 * 合并一条元数据：**只补空字段，不覆盖已有内容**。
 * （新拿到的 title 为空时不会把旧标题抹掉，这是崩溃 / 半截数据下的保命行为）
 */
function mergeEntry(next: FavoriteMeta): boolean {
  const key = String(next.modId);
  const current = store.value[key];
  if (!current) {
    store.value[key] = next;
    return true;
  }
  let changed = false;
  const merged: FavoriteMeta = { ...current };
  if (!merged.title && next.title) {
    merged.title = next.title;
    changed = true;
  }
  if (!merged.creator && next.creator) {
    merged.creator = next.creator;
    changed = true;
  }
  if (!merged.description && next.description) {
    merged.description = next.description;
    changed = true;
  }
  if (!merged.tagIds.length && next.tagIds.length) {
    merged.tagIds = next.tagIds;
    changed = true;
  }
  if (!merged.tagNames.length && next.tagNames.length) {
    merged.tagNames = next.tagNames;
    changed = true;
  }
  if (!merged.thumbnailUrl && next.thumbnailUrl) {
    merged.thumbnailUrl = next.thumbnailUrl;
    changed = true;
  }
  if (changed) {
    merged.savedAtMs = Math.max(merged.savedAtMs, next.savedAtMs);
    store.value[key] = merged;
  }
  return changed;
}

/** 记忆一条在线来源（在线页点收藏时调用，保证以后卸载 / 清理缓存后仍可展示） */
export function rememberOnlineMeta(source: MetaSource): void {
  const modId = Number(source.modId);
  if (!Number.isFinite(modId) || modId <= 0) return;
  const changed = mergeEntry({
    modId,
    title: toStr(source.title),
    creator: toStr(source.creator) || null,
    description: toStr(source.description) || null,
    tagIds: toNumList(source.tagIds),
    tagNames: toStrList(source.tagNames),
    thumbnailUrl: toStr(source.thumbnail) || null,
    savedAtMs: Date.now(),
  });
  if (changed) persistSoon();
}

/** 记忆一条本地扫描条目（卸载 / 移出列表前必须调用） */
export function rememberModMeta(entry: ModEntry | null | undefined): void {
  if (!entry) return;
  const modId = Number(entry.workshopId ?? 0);
  if (!Number.isFinite(modId) || modId <= 0) return;
  const changed = mergeEntry({
    modId,
    title: entry.displayName,
    creator: entry.author,
    description: entry.description,
    tagIds: [],
    tagNames: entry.officialTags.length ? entry.officialTags : entry.contentTags,
    thumbnailUrl: null,
    savedAtMs: Date.now(),
  });
  if (changed) persistSoon();
}

/**
 * 扫描结果变化后调用：把这批已安装模组记进缓存，并裁掉「既不安装、也没收藏」的条目。
 * 只有收藏数据已加载（userDataLoaded）时才裁剪，否则启动早期会把收藏条目误删。
 */
export function rememberInstalledMods(
  mods: ModEntry[],
  options: { userDataReady: boolean },
): void {
  let changed = false;
  const installed = new Set<number>();
  for (const mod of mods) {
    const modId = Number(mod.workshopId ?? 0);
    if (!Number.isFinite(modId) || modId <= 0) continue;
    installed.add(modId);
    if (
      mergeEntry({
        modId,
        title: mod.displayName,
        creator: mod.author,
        description: mod.description,
        tagIds: [],
        tagNames: mod.officialTags.length ? mod.officialTags : mod.contentTags,
        thumbnailUrl: null,
        savedAtMs: Date.now(),
      })
    ) {
      changed = true;
    }
  }
  if (options.userDataReady) {
    for (const key of Object.keys(store.value)) {
      const id = Number(key);
      if (installed.has(id)) continue;
      if (isFavorite(id)) continue;
      delete store.value[key];
      changed = true;
    }
  }
  // 兜底：条目过多时丢最旧的（正常账号不会触发）
  const keys = Object.keys(store.value);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => store.value[a].savedAtMs - store.value[b].savedAtMs)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((key) => {
        delete store.value[key];
        changed = true;
      });
  }
  if (changed) persistSoon();
}

/**
 * 单条懒补齐：详情缓存里有描述就写回元数据缓存（零网络，无缓存 / 失败都静默）。
 * 占位卡片被选中时调用一次，保证右栏详情能拿到完整描述。
 */
export async function enrichFavoriteMetaFromDetail(modId: number): Promise<void> {
  const id = Number(modId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (enriched.has(id)) return;
  enriched.add(id);
  if (store.value[String(id)]?.description) return;
  try {
    const hit = await readDetailCache(id);
    const description = pickDetailDescription(hit?.value as Record<string, unknown> | null);
    if (!description) return;
    if (
      mergeEntry({
        modId: id,
        title: "",
        creator: null,
        description,
        tagIds: [],
        tagNames: [],
        thumbnailUrl: null,
        savedAtMs: Date.now(),
      })
    ) {
      persistSoon();
    }
  } catch {
    /* 静默：没有详情缓存不影响占位卡展示 */
  }
}

let hydrated: Promise<void> | null = null;

/** 已在本次会话尝试过补描述的模组（同一个 ID 不重复 invoke） */
const enriched = new Set<number>();

/** 详情缓存里的描述是 HTML，落进 localStorage 前必须纯文本化 */
function stripHtml(html: string): string {
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

/** 详情缓存里描述字段的候选键（列表接口不返回描述，只能从详情缓存补） */
function pickDetailDescription(raw: Record<string, unknown> | null | undefined): string {
  if (!raw) return "";
  for (const key of ["description", "modDescription"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return stripHtml(value).slice(0, 4000);
  }
  for (const value of Object.values(raw)) {
    if (typeof value !== "string") continue;
    if (!/<(p|br|div|li)\b/i.test(value)) continue;
    const text = stripHtml(value);
    if (text.length > 20) return text.slice(0, 4000);
  }
  return "";
}

/** 详情缓存补充上限：几十条收藏已经足够覆盖真实场景，避免启动时发太多 invoke */
const DETAIL_HYDRATE_LIMIT = 40;

/**
 * 用在线缓存（online_cache.json）补一次元数据：只补缺失字段，零网络。
 * 同一会话只跑一次；断网 / 从没缓存过都会静默返回。
 */
export function hydrateFavoriteMeta(): Promise<void> {
  if (hydrated) return hydrated;
  hydrated = (async () => {
    try {
      const items = await allCachedItems();
      let changed = false;
      for (const item of items) {
        const modId = Number(item?.modId);
        if (!Number.isFinite(modId) || modId <= 0) continue;
        // 只补「收藏过的」与「已经在缓存里的」：不能把整份在线缓存都搬进 localStorage
        if (!isFavorite(modId) && !store.value[String(modId)]) continue;
        if (
          mergeEntry({
            modId,
            title: toStr(item.title),
            creator: toStr(item.creator) || null,
            description: null,
            tagIds: toNumList(item.tagIds),
            tagNames: toStrList(item.tagNames),
            thumbnailUrl: toStr(item.thumbnail) || null,
            savedAtMs: Date.now(),
          })
        ) {
          changed = true;
        }
      }
      // 列表接口没有描述：收藏条目缺描述时，用本地详情缓存（零网络）补一次
      let quota = DETAIL_HYDRATE_LIMIT;
      for (const entry of Object.values(store.value)) {
        if (quota <= 0) break;
        if (entry.description) continue;
        if (!isFavorite(entry.modId)) continue;
        quota -= 1;
        try {
          const hit = await readDetailCache(entry.modId);
          const description = pickDetailDescription(hit?.value as Record<string, unknown> | null);
          if (!description) continue;
          entry.description = description;
          entry.savedAtMs = Date.now();
          changed = true;
        } catch {
          /* 单条读不到不影响其他条目 */
        }
      }
      if (changed) persistSoon();
    } catch {
      /* 没有在线缓存可用：保持现状 */
    }
  })();
  return hydrated;
}
