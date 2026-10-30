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
/** 在途请求：两处调用方共享 */
let inFlight: Promise<IndexSyncReport | null> | null = null;

/**
 * 按登录事件（`sessionEpoch`）触发一次索引补建。
 * 返回 `null` = 本次不需要/没有真正执行（epoch 已消费过，或请求被静默失败）。
 */
export function kickIndexSync(epoch: number): Promise<IndexSyncReport | null> {
  if (epoch <= 0) return Promise.resolve(null);
  if (inFlight) return inFlight;
  if (epoch <= consumedEpoch) return Promise.resolve(null);
  consumedEpoch = epoch;
  inFlight = indexSync()
    .catch((error) => {
      console.info("[index] 索引补建未执行（预期内：未登录 / 已在同步 / 限流冷却）", error);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** 仅用于诊断：当前是否已有索引补建在飞 */
export function indexSyncInFlight(): boolean {
  return inFlight !== null;
}
