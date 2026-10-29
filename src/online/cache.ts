/**
 * 在线数据离线缓存的前端入口（Rust 侧 cache.rs 的薄封装）。
 *
 * v0.7 的关键变化：
 * - **一次 invoke 读多页**（`readCachedPages`）：切分类 / 搜索 / 翻页只发一个命令，
 *   且整份数据在 Rust 内存里，微秒级返回 —— 这就是“秒开”的基础。
 * - **永不过期**：Rust 侧已取消 TTL，这里也不再判断时间戳。
 * - key 依然只由 Rust 拼（前端只传原始参数），避免读写的 key 不一致。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  CacheHit,
  CacheOverview,
  CachedPage,
  ClearCacheReport,
  FindResult,
  OnlineMod,
} from "./types";

export interface CacheQuery {
  query: string;
  start: number;
  count: number;
  sort: string;
  order: string;
  tags?: number[];
  /** true = 走 /Installed（已订阅列表） */
  installed?: boolean;
  /** 最多连续读几页（默认 8） */
  maxPages?: number;
}

/**
 * 一次读回多页缓存。
 * 返回空数组 = 没有缓存（调用方才该去发网络请求）。
 */
export function readCachedPages(params: CacheQuery): Promise<CachedPage[]> {
  return invoke<CachedPage[]>("online_cache_pages", {
    query: params.query,
    start: params.start,
    count: params.count,
    sort: params.sort,
    order: params.order,
    tags: params.tags ?? [],
    installed: params.installed ?? false,
    maxPages: params.maxPages ?? 8,
  });
}

/** 缓存里出现过的所有列表项（“我的收藏”纯本地浏览用，绝不发网络请求） */
export function allCachedItems(): Promise<OnlineMod[]> {
  return invoke<OnlineMod[]>("online_cache_items");
}

/** 单个模组详情的缓存（详情页秒开） */
export function readDetailCache(
  modId: number,
): Promise<CacheHit<Record<string, unknown>> | null> {
  return invoke<CacheHit<Record<string, unknown>> | null>("online_cache_detail", { modId });
}

/** 清理 online_cache.json + image_cache 目录（设置 → 网络） */
export function clearOnlineCache(): Promise<ClearCacheReport> {
  return invoke<ClearCacheReport>("online_cache_clear");
}

/** 缓存总览：JSON 条目 + 图片张数 / 体积 */
export function onlineCacheStat(): Promise<CacheOverview> {
  return invoke<CacheOverview>("online_cache_stat");
}

/** 详情缓存是否可用（无 TTL，只有“空对象 / 缺字段”才算无效） */
export function usableDetailCache(
  hit: CacheHit<Record<string, unknown>> | null | undefined,
): hit is CacheHit<Record<string, unknown>> {
  return !!hit && !!hit.value && Object.keys(hit.value).length > 0;
}

/** 兼容旧调用：把 CachedPage[] 摊平成 FindResult 形状（目前仅个别地方用） */
export function pagesToResult(pages: CachedPage[]): FindResult {
  const items: OnlineMod[] = [];
  let totalCount: number | null = null;
  for (const page of pages) {
    if (totalCount === null && page.totalCount !== null) totalCount = page.totalCount;
    for (const item of page.items) items.push(item);
  }
  return { totalCount, isLoggedOn: true, items, serverMessage: null };
}
