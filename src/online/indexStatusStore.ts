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
 * - 一轮跑完 → 短暂显示成功与新增数量，随后回到正常状态。
 */
import { reactive } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  indexPause,
  indexStatus as fetchIndexStatus,
  onIndexProgress,
} from "./service";
import { runIndexSync } from "./indexSync";
import type { IndexStatus } from "./types";

/** 成功提示停留时长（之后回到「🟢 本地索引 N 条」常态） */
export const INDEX_FLASH_MS = 8000;
/** 同步期间的状态轮询间隔（事件推送为主，轮询只在事件丢失时兜底） */
const POLL_MS = 4000;

export interface IndexBarState {
  status: IndexStatus | null;
  /** 上一轮失败原因（原始文本 / aoe2mm:err 码）；空串 = 无失败 */
  failure: string;
  /** 未登录导致的失败：不提供「手动重试」（重试必然再失败），引导去账号入口 */
  needLogin: boolean;
  /** 底栏手动重试进行中 */
  retrying: boolean;
  /** 成功提示里的新增条数；null = 不在成功提示期 */
  flashAdded: number | null;
}

export const indexBar = reactive<IndexBarState>({
  status: null,
  failure: "",
  needLogin: false,
  retrying: false,
  flashAdded: null,
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
  /** 成功提示里的新增条数（kind === "success" 时有效） */
  added: number;
  /** 是否显示「手动重试」按钮（失败且可重试时唯一入口） */
  showRetry: boolean;
}

/**
 * 纯推导：把运行时状态压成底栏要展示的一种形态。
 * 单独抽出来是为了能脱离 Tauri / Vue 直接写单测。
 */
export function deriveIndexBar(state: IndexBarState): IndexBarView {
  const hidden: IndexBarView = { kind: "hidden", added: 0, showRetry: false };
  // 手动重试在飞：无论 Rust 状态有没有跟上，都先显示进度并隐藏按钮
  if (state.retrying) return { kind: "syncing", added: 0, showRetry: false };
  const st = state.status;
  if (!st) return hidden;
  // 自动更新关闭：底栏不出现任何索引内容（也不出现手动入口）
  if (!st.indexingEnabled) return hidden;
  if (state.failure) {
    return { kind: "failed", added: 0, showRetry: true };
  }
  if (state.needLogin) return { kind: "needLogin", added: 0, showRetry: false };
  if (st.syncing) return { kind: "syncing", added: 0, showRetry: false };
  if (state.flashAdded !== null) {
    return { kind: "success", added: state.flashAdded, showRetry: false };
  }
  if (st.done) return { kind: "ready", added: 0, showRetry: false };
  return { kind: "idle", added: 0, showRetry: false };
}

/** 一轮同步的起点基线：成功提示里的「新增」= 结束时 indexed - 起点 indexed */
let baseline = 0;
/** 是否观察到过一轮进行中的同步（用来识别「跑完」的那一帧） */
let sawSyncing = false;

let started = false;
let unlisten: UnlistenFn | null = null;
let pollTimer: number | null = null;
let flashTimer: number | null = null;

function clearFlash(): void {
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  indexBar.flashAdded = null;
}

function flashSuccess(added: number): void {
  clearFlash();
  indexBar.flashAdded = Math.max(0, Math.round(added));
  flashTimer = window.setTimeout(() => {
    indexBar.flashAdded = null;
    flashTimer = null;
  }, INDEX_FLASH_MS);
}

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
  const prev = indexBar.status;
  indexBar.status = next;
  if (!next) {
    indexBar.failure = "";
    indexBar.needLogin = false;
    sawSyncing = false;
    clearFlash();
    stopPoll();
    return;
  }
  // 开关关闭：清掉上一轮残留的失败 / 成功提示，底栏保持静默
  if (!next.indexingEnabled) {
    indexBar.failure = "";
    indexBar.needLogin = false;
    sawSyncing = false;
    clearFlash();
    stopPoll();
    return;
  }
  if (next.syncing) {
    if (!sawSyncing || !prev?.syncing) {
      sawSyncing = true;
      baseline = next.indexed;
      clearFlash();
    }
    // 新一轮开始 → 上一次的失败提示与重试入口必须消失（进度优先）
    indexBar.failure = "";
    indexBar.needLogin = false;
    schedulePoll();
    return;
  }
  if (sawSyncing && prev?.syncing) {
    sawSyncing = false;
    if (!next.lastError && next.phase !== "error") {
      // 新增 = 结束条数 - 起点条数（更新已有条目不会改变总数）
      flashSuccess(Math.max(0, next.indexed - baseline));
    }
  }
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
 * - 成功 → 短暂成功提示（新增条数取本轮真实 `fetched`）；
 * - 失败 → 保留 / 刷新失败原因，重试入口继续存在。
 */
export async function retryIndexSync(): Promise<boolean> {
  if (indexBar.retrying) return false;
  indexBar.retrying = true;
  indexBar.failure = "";
  indexBar.needLogin = false;
  clearFlash();
  try {
    const report = await runIndexSync();
    // 先刷新状态（可能顺带触发一次「结束帧」推导），再用本轮真实 fetched 覆盖成功提示，
    // 否则「只更新了已有条目（fetched>0、indexed 不变）」会被算成「已是最新」。
    await refreshIndexStatus();
    flashSuccess(report?.fetched ?? 0);
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    await refreshIndexStatus();
    // 状态里没带出失败原因（后端还没落盘）时，用命令返回的错误兜底
    if (!indexBar.failure && !indexBar.needLogin) {
      indexBar.failure = raw || "sync failed";
      indexBar.needLogin = /unauthenticated|needLogin|未登录/i.test(raw);
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
  clearFlash();
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
