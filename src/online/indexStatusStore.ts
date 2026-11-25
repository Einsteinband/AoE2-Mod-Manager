/**
 * 官方 Mod 本地索引的**全局状态单例**（底部状态栏唯一数据源）。
 *
 * 为什么单独建一个模块：
 * - 索引是应用级后台任务（Rust `online_index::spawn_background` 启动 8s 后自己跑），
 *   不能挂在某个页面组件上——用户停在本地页时底栏也要能看到进度；
 * - 页面组件各自 `useIndexSync()` 会造出多份轮询 / 事件监听，底栏与页面会互相打架；
 * - 手动重试必须和自动任务共用同一个同步核心（`runIndexSync()` 单飞），
 *   不新写第二条同步链路。
 *
 * 状态判定以 Rust 的 `IndexStatus` 为准，前端只做「展示层推导」：
 * - `indexingEnabled === false`（自动更新关闭）→ 底栏完全静默，不显示任何索引字样；
 * - `syncing` → 实时进度（真实已处理条数 / 可靠总量），不显示手动按钮；
 * - `lastError` 非空且已停 → 失败原因 + 唯一「手动重试」入口；
 * - 一轮**完整成功**跑完 → 常驻显示 Rust 记录的真实 `added`，不用 index 差值推算。
 */
import { reactive } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  indexPause,
  indexStatus as fetchIndexStatus,
  onIndexProgress,
} from "./service";
import { runIndexSync } from "./indexSync";
import { classifyAuthError } from "./sessionVerdict";
import { handleAuthFailure } from "../sessionState";
import type { IndexStatus } from "./types";

/** 同步期间的状态轮询间隔（事件推送为主，轮询只在事件丢失时兜底） */
const POLL_MS = 4000;
/** 自动同步结果缓存：只保存“今日完整成功”，重启后仍可显示；失败 / 部分完成绝不缓存 */
const SYNC_CACHE_KEY = "aoe2mm.indexSyncResult.v1";

/** Rust `SyncReport` 落到前端后的真实同步结果 */
export interface IndexSyncResult {
  /** 本轮 items.insert 真正新增的条目数 */
  added: number;
  updated: number;
  failed: number;
  atMs: number;
  reason: string;
  /** reason !== "manual"：自动同步（startup/settings/resume/login） */
  auto: boolean;
  /** 本轮是否完整结束；部分分页 / 暂停 / 预算用尽为 false */
  complete: boolean;
  /** 只有 complete 且同步成功才为 true */
  ok: boolean;
  /** 本地自然日（YYYY-MM-DD），用于“今日已同步” */
  day: string;
}

export interface IndexBarState {
  status: IndexStatus | null;
  /** 上一轮失败原因（原始文本 / aoe2mm:err 码）；空串 = 无失败 */
  failure: string;
  /** 未登录导致的失败：不提供「手动重试」（重试必然再失败），引导去账号入口 */
  needLogin: boolean;
  /** 底栏手动重试进行中 */
  retrying: boolean;
  /** 最近一轮真实同步结果；null = 还没结果 / 新一轮已开始 */
  lastSync: IndexSyncResult | null;
}

function localDayKey(ms = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function readCachedSync(): IndexSyncResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SYNC_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IndexSyncResult> | null;
    if (!parsed || parsed.complete !== true || parsed.ok !== true || parsed.auto !== true) return null;
    const atMs = count(parsed.atMs);
    if (atMs <= 0 || localDayKey(atMs) !== localDayKey()) return null;
    return {
      added: count(parsed.added),
      updated: count(parsed.updated),
      failed: count(parsed.failed),
      atMs,
      reason: typeof parsed.reason === "string" ? parsed.reason : "auto",
      auto: true,
      complete: true,
      ok: true,
      day: localDayKey(atMs),
    };
  } catch {
    return null;
  }
}

function writeCachedSync(result: IndexSyncResult): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_CACHE_KEY, JSON.stringify(result));
  } catch {
    /* 缓存失败不影响底栏：本次会话内仍能显示 */
  }
}

function clearCachedSync(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SYNC_CACHE_KEY);
  } catch {
    /* 忽略：缓存只是重启后的兜底 */
  }
}

export const indexBar = reactive<IndexBarState>({
  status: null,
  failure: "",
  needLogin: false,
  retrying: false,
  lastSync: readCachedSync(),
});

export type IndexBarKind =
  | "hidden"
  | "idle"
  | "syncing"
  | "ready"
  | "success"
  | "failed"
  | "needLogin";

export interface IndexBarView {
  kind: IndexBarKind;
  /** 成功结果里的真实新增条数（kind === "success" 时有效） */
  added: number;
  /** 失败是否来自自动同步（决定“今日同步失败”与“同步失败”） */
  auto: boolean;
  /** 是否显示「手动重试」按钮（失败且可重试时唯一入口） */
  showRetry: boolean;
}

/**
 * 纯推导：把运行时状态压成底栏要展示的一种形态。
 * 单独抽出来是为了能脱离 Tauri / Vue 直接写单测。
 */
export function deriveIndexBar(state: IndexBarState): IndexBarView {
  const hidden: IndexBarView = { kind: "hidden", added: 0, auto: false, showRetry: false };
  // 手动重试在飞：无论 Rust 状态有没有跟上，都先显示进度并隐藏按钮
  if (state.retrying) return { kind: "syncing", added: 0, auto: false, showRetry: false };
  const st = state.status;
  if (!st) return hidden;
  // 自动更新关闭：底栏不出现任何索引内容（也不出现手动入口）
  if (!st.indexingEnabled) return hidden;
  if (state.needLogin) return { kind: "needLogin", added: 0, auto: false, showRetry: false };
  if (st.syncing) return { kind: "syncing", added: 0, auto: false, showRetry: false };

  const sync = state.lastSync;
  if (sync?.complete && !sync.ok) {
    // 自动失败只认“今天”；昨天的失败不能在第二天继续冒充今日状态。
    if (!sync.auto || sync.day === localDayKey()) {
      return { kind: "failed", added: 0, auto: sync.auto, showRetry: true };
    }
    return { kind: st.done ? "ready" : "idle", added: 0, auto: false, showRetry: false };
  }
  if (sync?.complete && sync.ok) {
    // 自动成功只认“今天”；手动成功在当前会话内保留到下一次结果覆盖。
    if (!sync.auto || sync.day === localDayKey()) {
      return { kind: "success", added: sync.added, auto: sync.auto, showRetry: false };
    }
    return { kind: st.done ? "ready" : "idle", added: 0, auto: false, showRetry: false };
  }
  if (state.failure) {
    return { kind: "failed", added: 0, auto: sync?.auto ?? false, showRetry: true };
  }
  if (st.done) return { kind: "ready", added: 0, auto: false, showRetry: false };
  return { kind: "idle", added: 0, auto: false, showRetry: false };
}

/** 把 Rust `IndexStatus` 里的最近同步结果转成前端结果；没有结果时为 null */
function resultFromStatus(next: IndexStatus): IndexSyncResult | null {
  if (!next.lastSyncAtMs) return null;
  const atMs = count(next.lastSyncAtMs);
  const reason = next.lastSyncReason || "auto";
  return {
    added: count(next.lastSyncAdded),
    updated: count(next.lastSyncUpdated),
    failed: count(next.lastSyncFailed),
    atMs,
    reason,
    auto: reason !== "manual",
    complete: next.lastSyncComplete === true,
    ok: next.lastSyncComplete === true && next.lastSyncOk === true,
    day: localDayKey(atMs),
  };
}

function saveSyncResult(result: IndexSyncResult | null): void {
  indexBar.lastSync = result;
  if (result?.complete && result.ok && result.auto) {
    writeCachedSync(result);
  } else {
    clearCachedSync();
  }
}

let started = false;
let unlisten: UnlistenFn | null = null;
let pollTimer: number | null = null;

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function wantsPoll(): boolean {
  if (indexBar.retrying) return true;
  const st = indexBar.status;
  // 开关开启时保持低频心跳：自动任务可能在前端毫不知情时开跑（Rust 启动 8s 后自己触发），
  // 只靠事件会有漏帧风险；这条 4s 的一次内存读开销可忽略。
  if (!st || !st.indexingEnabled) return false;
  return true;
}

function schedulePoll(): void {
  if (pollTimer !== null) return;
  if (!wantsPoll()) return;
  pollTimer = window.setInterval(() => {
    void refreshIndexStatus();
  }, POLL_MS);
}

/**
 * 把一份最新状态喂进全局状态机（事件推送与轮询都走这里）。
 * 自动任务的开始 / 结束都只能从这里被观察到，因此成功与失败的判定集中在此。
 */
export function applyIndexStatus(next: IndexStatus | null): void {
  indexBar.status = next;
  if (!next) {
    indexBar.failure = "";
    indexBar.needLogin = false;
    saveSyncResult(null);
    stopPoll();
    return;
  }
  // 开关关闭：清掉上一轮残留的失败 / 成功提示，底栏保持静默
  if (!next.indexingEnabled) {
    indexBar.failure = "";
    indexBar.needLogin = false;
    saveSyncResult(null);
    stopPoll();
    return;
  }
  if (next.syncing) {
    // 新一轮开始 → 旧成功结果立刻消失，绝不在同步途中提前显示“今日已同步”
    saveSyncResult(null);
    indexBar.failure = "";
    indexBar.needLogin = false;
    schedulePoll();
    return;
  }

  const result = resultFromStatus(next);
  if (result) saveSyncResult(result);

  indexBar.failure = "";
  indexBar.needLogin = false;
  if (next.phase === "needLogin") {
    indexBar.needLogin = true;
  } else if (next.lastError) {
    indexBar.failure = next.lastError;
  }
  // 跑完 / 失败后保留心跳：下一轮自动任务开始时（Rust 侧不会通知前端）也能被看到
  schedulePoll();
}

/** 读一次索引状态（命令纯内存读，开销可忽略） */
export async function refreshIndexStatus(): Promise<IndexStatus | null> {
  try {
    const st = await fetchIndexStatus();
    applyIndexStatus(st);
    return st;
  } catch {
    // 读不到状态（未登录 / 后端未就绪 / 纯浏览器预览）→ 保持现状，不弹任何东西
    return null;
  }
}

/**
 * 手动重试：**复用同一个同步核心**（`runIndexSync()` → Rust `online_index_sync`）。
 *
 * - 与自动补建共享单飞 Promise，Rust 侧还有 `begin_run` 的 busy 闸门，
 *   自动任务在跑时点重试不会起第二条链路；
 * - 成功 → 用本轮真实 `added` 常驻显示，不写“今日已同步”；
 * - 失败 → 保留 / 刷新失败原因，重试入口继续存在。
 */
export async function retryIndexSync(): Promise<boolean> {
  if (indexBar.retrying) return false;
  indexBar.retrying = true;
  indexBar.failure = "";
  indexBar.needLogin = false;
  try {
    const report = await runIndexSync("manual");
    // 先刷新状态（Rust 已把本轮真实结果写进内存），再用手动报告兜底。
    await refreshIndexStatus();
    if (report && !report.skipped && report.done) {
      const atMs = Date.now();
      indexBar.lastSync = {
        added: count(report.added),
        updated: count(report.updated),
        failed: count(report.failed),
        atMs,
        reason: "manual",
        auto: false,
        complete: true,
        ok: true,
        day: localDayKey(atMs),
      };
      clearCachedSync();
    } else if (report && !report.skipped) {
      // 部分完成 / 暂停：不得显示成功结果
      saveSyncResult(null);
    }
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    await refreshIndexStatus();
    // 自动任务正在跑时点重试会拿到 busy：保持进度态，不要把“重复点击”误报成失败。
    if (!indexBar.failure && !indexBar.needLogin && !indexBar.status?.syncing) {
      const atMs = Date.now();
      indexBar.failure = raw || "sync failed";
      indexBar.needLogin = classifyAuthError(error) === "unauthenticated";
      if (indexBar.needLogin) handleAuthFailure(error);
      indexBar.lastSync = {
        added: 0,
        updated: 0,
        failed: 1,
        atMs,
        reason: "manual",
        auto: false,
        complete: true,
        ok: false,
        day: localDayKey(atMs),
      };
      clearCachedSync();
    }
    return false;
  } finally {
    indexBar.retrying = false;
  }
}

/**
 * 启动全局索引观察（App 顶层只调用一次）：
 * 1. 先读一次当前状态（自动任务可能在 8s 后才开跑，先拿到「已就绪 / 未开始」）；
 * 2. 订阅 `online://index-progress`，自动任务的每一页进度都能实时进底栏；
 * 3. 挂一条 4s 的轻量轮询兜底（命令是纯内存读）：自动任务由 Rust 自己启动，
 *    事件一旦漏帧，靠轮询也能把「开始 / 结束」收敛回正确状态。
 */
export async function startIndexStatusWatch(): Promise<void> {
  if (started) return;
  started = true;
  const first = await refreshIndexStatus();
  // 兼容旧数据：上一版有「暂停索引」按钮，暂停标记会落盘；本版手动入口已收进底栏，
  // 若不清掉这个标记，Rust 启动时的后台任务会永久跳过、用户也没有任何地方能「继续」。
  // 开关本身是开启状态时，这里清一次暂停标记（等价于恢复每日自动索引）。
  if (first && first.indexingEnabled && first.paused) {
    try {
      await indexPause(false);
    } catch {
      /* 清标记失败不阻断观察器：下一轮心跳会继续读到真实状态 */
    }
    await refreshIndexStatus();
  }
  try {
    unlisten = await onIndexProgress((status) => applyIndexStatus(status));
  } catch {
    unlisten = null;
  }
  schedulePoll();
}

/** 仅供单测 / 卸载时清理（生产环境不调用，观察器与 App 同生命周期） */
export function stopIndexStatusWatch(): void {
  started = false;
  stopPoll();
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
