/**
 * 官网在线模组总数的「每日一次」检测。
 *
 * 为什么单独做一个模块：
 * - 底栏的本地索引状态只在开启索引时出现，且 Rust 增量同步有 24h 新鲜度闸门，
 *   不能保证「在线总数」每天都被真实刷新；
 * - 数量本身来自官方 `/Find` 的总量字段，一次只取 1 条，网络开销固定且很小；
 * - 结果按本地自然日缓存，跨天最多检测一次，离线 / 未登录时沿用上次结果。
 */
import { ref, watch, type WatchStopHandle } from "vue";
import { findMods } from "./service";
import { sessionPhase } from "../sessionState";

const STORAGE_KEY = "aoe2mm.onlineModCount.v1";
/** 应用长期开着时，用低频心跳跨过本地零点 */
const DAY_CHECK_MS = 30 * 60 * 1000;

interface CachedCount {
  count: number;
  /** 本地自然日 YYYY-MM-DD */
  day: string;
}

/** 底栏展示的在线模组总数；null = 还没有可靠数据 */
export const onlineModCount = ref<number | null>(null);
/** 最近一次成功检测的本地日期（用于 tooltip） */
export const onlineModCountDay = ref("");

let started = false;
let timer: number | null = null;
let stopSessionWatch: WatchStopHandle | null = null;
let inFlight = false;
/** 本进程内已经尝试过检测的日期：失败也不在同一天反复请求 */
let attemptedDay = "";

export function localDayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readCache(): CachedCount | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedCount>;
    if (
      typeof parsed.count === "number" &&
      Number.isFinite(parsed.count) &&
      parsed.count > 0 &&
      typeof parsed.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.day)
    ) {
      return { count: Math.round(parsed.count), day: parsed.day };
    }
  } catch {
    /* 隐私模式 / 坏数据：当作没有缓存 */
  }
  return null;
}

function writeCache(value: CachedCount): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 写不进去不影响本次会话展示 */
  }
}

/**
 * 到点才检测：同一天已有成功结果 → 直接复用；否则向官方 `/Find` 取一次总量。
 * 未登录 / 校验中不发请求，也不消耗当天的那一次检测机会。
 */
export async function refreshOnlineModCountIfDue(now = new Date()): Promise<number | null> {
  const day = localDayKey(now);
  const cached = readCache();
  if (cached) {
    onlineModCount.value = cached.count;
    onlineModCountDay.value = cached.day;
    if (cached.day === day) return cached.count;
  }
  if (sessionPhase.value !== "online") return onlineModCount.value;
  if (inFlight || attemptedDay === day) return onlineModCount.value;

  attemptedDay = day;
  inFlight = true;
  try {
    const result = await findMods({
      query: "",
      start: 1,
      count: 1,
      sort: "recentpopular",
      order: "DESC",
      tags: [],
    });
    const total = result.totalCount;
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      const value: CachedCount = { count: Math.round(total), day };
      onlineModCount.value = value.count;
      onlineModCountDay.value = day;
      writeCache(value);
      return value.count;
    }
    return onlineModCount.value;
  } catch {
    // 失败不清旧值：底栏继续显示上一次成功检测的数量
    return onlineModCount.value;
  } finally {
    inFlight = false;
  }
}

/** App 顶层启动一次：登录后立即补检测，之后每 30 分钟检查一次是否跨天 */
export function startOnlineModCountWatch(): void {
  if (started) return;
  started = true;
  void refreshOnlineModCountIfDue();
  stopSessionWatch = watch(sessionPhase, (phase) => {
    if (phase === "online") void refreshOnlineModCountIfDue();
  });
  timer = window.setInterval(() => {
    void refreshOnlineModCountIfDue();
  }, DAY_CHECK_MS);
}

/** 仅卸载 / 单测清理 */
export function stopOnlineModCountWatch(): void {
  started = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  stopSessionWatch?.();
  stopSessionWatch = null;
}
