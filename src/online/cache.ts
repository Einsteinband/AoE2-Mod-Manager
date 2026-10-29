/**
 * 在线数据离线缓存的前端入口（Rust 侧 cache.rs 的薄封装）。
 *
 * 约定：
 * - **key 不由前端拼**：只把原始查询参数交给 Rust，由 `cache::find_key` 统一算 key，
 *   这样「写缓存」和「读缓存」永远是同一个 key，不会出现读不到自己写的数据。
 * - 读到 `expired === true`（超过 24 小时）一律当没缓存，直接走网络。
 */
import { invoke } from "@tauri-apps/api/core";
import type { CacheHit, CacheStat, ClearCacheReport, FindResult, OnlineMod } from "./types";

export interface FindCacheParams {
  query: string;
  start: number;
  count: number;
  sort: string;
  order: string;
  tags?: number[];
}

/** 搜索 / 分页的缓存 */
export function readFindCache(params: FindCacheParams): Promise<CacheHit<FindResult> | null> {
  return invoke<CacheHit<FindResult> | null>("online_cache_find", {
    query: params.query,
    start: params.start,
    count: params.count,
    sort: params.sort,
    order: params.order,
    tags: params.tags ?? [],
  });
}

/** 已订阅列表的缓存（该接口不支持 tags 过滤） */
export function readInstalledCache(
  start: number,
  count: number,
): Promise<CacheHit<FindResult> | null> {
  return invoke<CacheHit<FindResult> | null>("online_cache_installed", { start, count });
}

/** 单个模组详情的缓存 */
export function readDetailCache(
  modId: number,
): Promise<CacheHit<Record<string, unknown>> | null> {
  return invoke<CacheHit<Record<string, unknown>> | null>("online_cache_detail", { modId });
}

/** 清理 online_cache.json（设置 → 网络 → 清理在线缓存） */
export function clearOnlineCache(): Promise<ClearCacheReport> {
  return invoke<ClearCacheReport>("online_cache_clear");
}

/** 缓存概览：条目数 / 体积 / 时间范围 */
export function onlineCacheStat(): Promise<CacheStat> {
  return invoke<CacheStat>("online_cache_stat");
}

/** 列表缓存：命中、未过期、且 items 是数组才算可用 */
export function usableListCache(
  hit: CacheHit<FindResult> | null | undefined,
): hit is CacheHit<FindResult> {
  return !!hit && !hit.expired && Array.isArray(hit.value?.items);
}

/** 详情缓存：命中、未过期、且不是空对象才算可用 */
export function usableDetailCache(
  hit: CacheHit<Record<string, unknown>> | null | undefined,
): hit is CacheHit<Record<string, unknown>> {
  return !!hit && !hit.expired && !!hit.value && Object.keys(hit.value).length > 0;
}

/** 取缓存里的列表项（过滤掉缺 modId 的脏数据） */
export function cacheItems(hit: CacheHit<FindResult>): OnlineMod[] {
  return (hit.value?.items ?? []).filter((m) => typeof m?.modId === "number");
}
