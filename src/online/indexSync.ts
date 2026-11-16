/**
 * 登录成功 → 静默补建在线索引（中文混合搜索的底座）。
 *
 * 为什么要单独抽一个模块：
 * - 触发点有两个：`App.vue` 顶层（用户停在本地页也能建）与 `OnlineBrowser`
 *   的 `handleSessionEpoch`（在线页自己也要知道进度）；
 * - 两处会在**同一个 sessionEpoch** 上先后触发，必须共享同一个 Promise，
 *   否则官方接口会挨两次 `/Find`，第二次还会拿到 `busy`。
 *
 * 设计约束（与 Rust 侧 `online_index::sync_blocking` 对齐）：
 * - 每个 epoch 只发一次；Rust 那边还有单飞 + 24h 新鲜度闸门 + 429 冷却三道保险；
 * - **失败一律静默**：未登录（unauthenticated）、已在同步（busy）、限流冷却都是预期，
 *   绝不弹窗、绝不重试刷屏。
 */
import { indexSync } from "./service";
import type { IndexSyncReport } from "./types";

/** 已经消费掉的 epoch（同一次登录只触发一次） */
let consumedEpoch = -1;
/** 全局单飞：自动补建 / 底部状态栏「手动重试」/ 在线页补建共享同一个 Promise */
let inFlight: Promise<IndexSyncReport> | null = null;

/**
 * 触发一次索引同步（**唯一同步核心**）。
 *
 * 自动补建、底栏手动重试都必须走这里：前端单飞 + Rust 侧 `begin_run` 的 busy 闸门
 * 两道保险，任何时刻最多只有一轮同步在飞，不会出现两个任务各爬一遍。
 * 与 `kickIndexSync` 的区别：这里不吞错误，调用方需要知道成功 / 失败。
 */
export function runIndexSync(reason: "manual" | "login" = "manual"): Promise<IndexSyncReport> {
  if (inFlight) return inFlight;
  const run = indexSync(reason).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/**
 * 按登录事件（`sessionEpoch`）触发一次索引补建。
 * 返回 `null` = 本次不需要/没有真正执行（epoch 已消费过，或请求被静默失败）。
 */
export function kickIndexSync(epoch: number): Promise<IndexSyncReport | null> {
  if (epoch <= 0) return Promise.resolve(null);
  if (inFlight) return inFlight.catch(() => null).then((report) => report ?? null);
  if (epoch <= consumedEpoch) return Promise.resolve(null);
  consumedEpoch = epoch;
  return runIndexSync("login").catch((error) => {
    console.info("[index] background index build skipped (expected: not signed in / already syncing / rate-limit cooldown)", error);
    return null;
  });
}

/** 仅用于诊断：当前是否已有索引补建在飞 */
export function indexSyncInFlight(): boolean {
  return inFlight !== null;
}
