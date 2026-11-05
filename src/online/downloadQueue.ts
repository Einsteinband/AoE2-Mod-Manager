/**
 * 在线模组下载队列（模块级单例）。
 *
 * 为什么放在模块级而不是组件里：
 *   - 右下角悬浮窗挂在 App.vue，必须在「在线页被卸载 / 切到本地页」时依然能读队列；
 *   - 串行泵与进度监听必须与组件生命周期解耦（下载中切页面不能丢状态）。
 *
 * 为什么要串行（MAX_CONCURRENT = 1）：
 *   - Rust 侧 `online_cancel_install` 用的是一个**全局** `CANCEL_FLAG`，而每次 `online_install`
 *     开头都会 `CANCEL_FLAG.store(false)` —— 两条任务并发会互相清掉对方的取消意图；
 *   - 安装收尾都要写同一份 `mod-status.json` 并共用 `.aoe2mm-staging`，并发写有数据风险。
 *   因此下一个任务必须在「上一个 installMod() 的 Promise 完全落地」之后才启动。
 *   将来底层支持真并发，只要把 MAX_CONCURRENT 改大（并同步修 Rust 的取消语义）即可。
 *
 * 取消的真实语义（与后端实现对齐，不粉饰）：
 *   - status = queued      → 直接出队，零 Rust 调用；
 *   - status = downloading → 置 cancelRequested + cancelInstall()，下载循环（128KB 一次）会捕获；
 *   - status = installing  → 解压 / 补 info.json / 写 mod-status.json 阶段后端**没有取消点**
 *                            （install.rs 全无 cancel 逻辑），只能标「正在停止…」并等真实结果。
 */
import { ref, watch } from "vue";
import { cancelInstall, installMod, loadDownloadQueue, onDownloadProgress, saveDownloadQueue } from "./service";
import { messageOf } from "./errors";
import { sessionPhase } from "../sessionState";
import {
  isApiFailure,
  type DownloadProgress,
  type InstallOutcome,
} from "./types";

/** 同一时刻允许同时执行的安装任务数（受后端全局取消标记限制，当前只能为 1） */
export const MAX_CONCURRENT = 1;

/** 持久化快照结构版本号（结构大改时递增，供将来迁移用） */
const SNAPSHOT_VERSION = 1;
/** 落盘防抖：连续入队 / 连续结束时只写一次 */
const PERSIST_DEBOUNCE_MS = 400;

/** 队列 / 历史最多保留条数（超出后丢弃最旧的已结束任务） */
const HISTORY_LIMIT = 20;

export type TaskStatus =
  | "queued"
  | "downloading"
  | "installing"
  | "done"
  | "failed"
  | "cancelled";

/** 结果消息只存 key + 参数，翻译交给 UI（store 不依赖 vue-i18n 上下文） */
export interface TaskMessage {
  key: string;
  params?: Record<string, unknown>;
}

export interface QueueTaskInput {
  modId: number;
  title: string;
  /** install = 主按钮「下载并安装」；reinstall = 已有本地目录时的重装 */
  kind: "install" | "reinstall";
  tagIds?: number[];
  tagNames?: string[];
  creator?: string | null;
  description?: string | null;
  thumbnail?: string | null;
  /** 目标目录已存在时是否覆盖 */
  force?: boolean;
}

export interface DownloadTask {
  /** 唯一 id：同一 modId 可有多条历史（如失败后重排） */
  id: string;
  modId: number;
  title: string;
  kind: "install" | "reinstall";
  status: TaskStatus;
  progress: DownloadProgress | null;
  error: string | null;
  /** 成功时的后端报告（说明文本由 UI 翻译生成） */
  outcome: InstallOutcome | null;
  localized: boolean | null;
  /** 用户点了取消（安装中取消时只能等真实结果） */
  cancelRequested: boolean;
  /** 需要勾选「覆盖」才能继续 */
  needForce: boolean;
  message: TaskMessage | null;
  /** 入队时快照：执行期不依赖任何组件状态 */
  payload: {
    tagIds: number[];
    tagNames: string[];
    creator: string | null;
    description: string | null;
    thumbnail: string | null;
    force: boolean;
  };
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// ---------------- 状态（全局唯一真源） ----------------

/** 队列 + 最近历史，按 createdAt 升序（渲染时倒序即可） */
export const downloadTasks = ref<DownloadTask[]>([]);

/** 正在执行的任务 id（数组是为了给 MAX_CONCURRENT > 1 留位置） */
export const runningTaskIds = ref<string[]>([]);

/** 右下角面板是否展开 */
export const managerOpen = ref(false);

let seq = 0;

function touch(): void {
  downloadTasks.value = [...downloadTasks.value];
  persistSoon();
}

// ---------------- 持久化（download_queue.json） ----------------

let persistTimer: number | null = null;

/** 把任务机态剥离成可落盘的纯数据（进度不存：重启后不可能续传） */
function snapshotTask(task: DownloadTask): Record<string, unknown> {
  return {
    id: task.id,
    modId: task.modId,
    title: task.title,
    kind: task.kind,
    status: task.status,
    error: task.error,
    localized: task.localized,
    needForce: task.needForce,
    message: task.message,
    payload: task.payload,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

/** 防抖写盘：状态变化（入队 / 出队 / 结束 / 移除）后 400ms 内只写一次 */
function persistSoon(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

async function flushPersist(): Promise<void> {
  try {
    await saveDownloadQueue({
      version: SNAPSHOT_VERSION,
      tasks: downloadTasks.value.map(snapshotTask),
      savedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[downloader] 保存下载队列失败", e);
  }
}

function isActive(task: DownloadTask): boolean {
  return task.status === "queued" || task.status === "downloading" || task.status === "installing";
}

// ---------------- 查询（详情页 / 悬浮窗共用） ----------------

/** 该 mod 尚未结束的任务（排队 / 下载中 / 安装中） */
export function activeTaskOfMod(modId: number): DownloadTask | null {
  for (let i = downloadTasks.value.length - 1; i >= 0; i -= 1) {
    const task = downloadTasks.value[i];
    if (task.modId === modId && isActive(task)) return task;
  }
  return null;
}

/** 该 mod 最近一条任务（含已结束，用于显示结果 / 失败原因） */
export function latestTaskOfMod(modId: number): DownloadTask | null {
  for (let i = downloadTasks.value.length - 1; i >= 0; i -= 1) {
    const task = downloadTasks.value[i];
    if (task.modId === modId) return task;
  }
  return null;
}

/** 详情页用：有活动任务优先，否则给最近一条（可能是失败 / 已完成） */
export function taskOfMod(modId: number): DownloadTask | null {
  return activeTaskOfMod(modId) ?? latestTaskOfMod(modId);
}

/** 队列中的位次（1 起；不在排队返回 null） */
export function queuePositionOf(taskId: string): number | null {
  let pos = 0;
  for (const task of downloadTasks.value) {
    if (task.status !== "queued") continue;
    pos += 1;
    if (task.id === taskId) return pos;
  }
  return null;
}

export function isModActive(modId: number): boolean {
  return activeTaskOfMod(modId) !== null;
}

// ---------------- 入队 / 取消 / 移除 ----------------

export interface EnqueueResult {
  accepted: boolean;
  task: DownloadTask | null;
  reason?: "duplicate";
}

/** 入队：同一 mod 已有未结束任务时拒绝（避免重复下载同一个模组） */
export function enqueueDownload(input: QueueTaskInput): EnqueueResult {
  const running = activeTaskOfMod(input.modId);
  if (running) return { accepted: false, task: running, reason: "duplicate" };

  seq += 1;
  const task: DownloadTask = {
    id: `${input.modId}-${Date.now()}-${seq}`,
    modId: input.modId,
    title: input.title,
    kind: input.kind,
    status: "queued",
    progress: null,
    error: null,
    outcome: null,
    localized: null,
    cancelRequested: false,
    needForce: false,
    message: null,
    payload: {
      tagIds: input.tagIds ?? [],
      tagNames: input.tagNames ?? [],
      creator: input.creator ?? null,
      description: input.description ?? null,
      thumbnail: input.thumbnail ?? null,
      force: input.force === true,
    },
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
  downloadTasks.value = [...downloadTasks.value, task];
  trimHistory();
  persistSoon();
  void pump();
  return { accepted: true, task };
}

/**
 * 请求取消：
 * - 排队中 → 直接出队（零 Rust 调用）；
 * - 下载中 → 置标记 + 调后端取消，泵会在它落地后继续下一个；
 * - 安装中 → 只置标记（后端此阶段无取消点），UI 显示「正在停止…」，结果以后端返回为准。
 */
export function requestCancelTask(taskId: string): void {
  const task = downloadTasks.value.find((item) => item.id === taskId);
  if (!task) return;
  if (task.status === "queued") {
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.message = { key: "downloader.cancelled" };
    touch();
    trimHistory();
    return;
  }
  if (!isActive(task) || task.cancelRequested) return;
  task.cancelRequested = true;
  touch();
  // 只有「正在真正下载」时后端才可能中断；安装阶段调用也无害（标记会被下次 install 重置）
  if (task.status === "downloading") {
    void cancelInstall().catch(() => undefined);
  }
}

/** 移除一条已结束的任务（排队中的请用 requestCancelTask） */
export function removeTask(taskId: string): void {
  const index = downloadTasks.value.findIndex((item) => item.id === taskId);
  if (index < 0) return;
  const task = downloadTasks.value[index];
  if (isActive(task)) return;
  downloadTasks.value = downloadTasks.value.filter((item) => item.id !== taskId);
  persistSoon();
}

/** 清掉所有已结束（完成 / 失败 / 取消）的任务 */
export function clearFinishedTasks(): void {
  downloadTasks.value = downloadTasks.value.filter((task) => isActive(task));
  persistSoon();
}

function trimHistory(): void {
  if (downloadTasks.value.length <= HISTORY_LIMIT) return;
  const finished = downloadTasks.value.filter((task) => !isActive(task));
  const drop = new Set(
    finished
      .slice(0, Math.max(0, downloadTasks.value.length - HISTORY_LIMIT))
      .map((task) => task.id),
  );
  if (!drop.size) return;
  downloadTasks.value = downloadTasks.value.filter((task) => !drop.has(task.id));
}

// ---------------- 任务完成订阅（UI 刷新列表 / 弹提示） ----------------

type SettledHandler = (task: DownloadTask) => void;
const settledHandlers = new Set<SettledHandler>();

/** 订阅「某个任务落地」（成功 / 失败 / 取消都会触发），返回退订函数 */
export function onTaskSettled(handler: SettledHandler): () => void {
  settledHandlers.add(handler);
  return () => {
    settledHandlers.delete(handler);
  };
}

function emitSettled(task: DownloadTask): void {
  for (const handler of [...settledHandlers]) {
    try {
      handler(task);
    } catch (e) {
      console.warn("[downloader] 完成回调异常", e);
    }
  }
}

// ---------------- 串行泵 ----------------

let pumping = false;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (runningTaskIds.value.length < MAX_CONCURRENT) {
      const next = downloadTasks.value.find((task) => task.status === "queued");
      if (!next) break;
      // 同步占位，避免同一轮或下一轮重复取到同一条
      next.status = "downloading";
      next.startedAt = Date.now();
      next.progress = null;
      next.error = null;
      next.outcome = null;
      next.message = null;
      next.needForce = false;
      runningTaskIds.value = [...runningTaskIds.value, next.id];
      touch();
      // 不 await：由 MAX_CONCURRENT 决定是否继续取下一个
      void runTask(next);
    }
  } finally {
    pumping = false;
  }
}

async function runTask(task: DownloadTask): Promise<void> {
  try {
    const outcome = await installMod(
      task.modId,
      task.title,
      task.payload.force,
      task.payload.tagIds,
      task.payload.tagNames,
      task.payload.creator,
      task.payload.description,
      task.payload.thumbnail,
    );
    task.outcome = outcome;
    task.localized = outcome.localized;
    task.status = "done";
    // 安装阶段点的取消：文件已经装上了，按真实结果记为已完成
    task.message = { key: outcome.localized ? "online.installDone" : "online.installKeepSubscribed" };
  } catch (e) {
    const kind = isApiFailure(e) ? e.kind : null;
    if (kind === "cancelled") {
      task.status = "cancelled";
      task.message = { key: "online.downloadCancelled" };
    } else {
      const message = messageOf(e);
      task.status = "failed";
      task.error = message;
      task.needForce = kind === "install" && message.includes("允许覆盖");
      task.message = { key: "online.installFailed" };
    }
  } finally {
    task.progress = null;
    task.finishedAt = Date.now();
    runningTaskIds.value = runningTaskIds.value.filter((id) => id !== task.id);
    touch();
    trimHistory();
    emitSettled(task);
    // ★ 关键：必须在上一条 installMod() 完全落地之后才启动下一条（见文件头注释）
    void pump();
  }
}

// ---------------- 进度事件（全应用只注册一次） ----------------

function handleProgress(payload: DownloadProgress): void {
  // 只认「正在跑且 modId 匹配」的任务；排队中 / 已结束的一律忽略
  const task = downloadTasks.value.find(
    (item) =>
      item.modId === payload.modId &&
      (item.status === "downloading" || item.status === "installing"),
  );
  if (!task) return;
  task.progress = payload;
  // phase = downloaded：Rust 已下完，进入解压 / 补文件 / 写 mod-status.json 阶段
  if (payload.phase === "downloaded" && task.status === "downloading") {
    task.status = "installing";
  }
}

let initialized = false;

/** 把落盘数据还原成任务对象（字段级容错：单个坏任务只跳过它自己） */
function coerceTask(raw: Record<string, unknown>): DownloadTask | null {
  const modId = Number(raw.modId);
  if (!Number.isFinite(modId) || modId <= 0) return null;
  const status = raw.status as TaskStatus;
  if (!["queued", "downloading", "installing", "done", "failed", "cancelled"].includes(status)) {
    return null;
  }
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  const message = raw.message as TaskMessage | null | undefined;
  const id = typeof raw.id === "string" && raw.id ? raw.id : `${modId}-${Date.now()}-r`;
  return {
    id,
    modId,
    title: typeof raw.title === "string" && raw.title ? raw.title : `#${modId}`,
    kind: raw.kind === "reinstall" ? "reinstall" : "install",
    status,
    progress: null, // 进度不持久化：重启后不可能续传，只看得到状态
    error: typeof raw.error === "string" ? raw.error : null,
    outcome: null, // 后端报告不回放（只显示状态与错误）
    localized: typeof raw.localized === "boolean" ? raw.localized : null,
    cancelRequested: false,
    needForce: raw.needForce === true,
    message:
      message && typeof message.key === "string"
        ? { key: message.key, params: message.params }
        : null,
    payload: {
      tagIds: Array.isArray(payload.tagIds)
        ? payload.tagIds.filter((n): n is number => typeof n === "number")
        : [],
      tagNames: Array.isArray(payload.tagNames)
        ? payload.tagNames.filter((n): n is string => typeof n === "string")
        : [],
      creator: typeof payload.creator === "string" ? payload.creator : null,
      description: typeof payload.description === "string" ? payload.description : null,
      thumbnail: typeof payload.thumbnail === "string" ? payload.thumbnail : null,
      force: payload.force === true,
    },
    createdAt: Number(raw.createdAt) || Date.now(),
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : null,
  };
}

/** 启动时恢复上次退出前的队列（同步于任务落地事件之后，不阻塞首屏） */
async function restorePersisted(): Promise<void> {
  try {
    const snapshot = await loadDownloadQueue();
    const raw = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    if (!raw.length) return;
    const restored: DownloadTask[] = [];
    for (const item of raw) {
      const task = coerceTask(item as Record<string, unknown>);
      if (!task) continue;
      if (task.status === "downloading" || task.status === "installing") {
        // 进程被杀时它根本没跑完，磁盘状态未知：不自动重跑，如实标记为「中断」
        task.status = "failed";
        task.error = null;
        task.message = { key: "downloader.interrupted" };
        task.finishedAt = task.finishedAt ?? Date.now();
      }
      restored.push(task);
    }
    if (!restored.length) return;
    const active = restored.filter(isActive);
    const finished = restored.filter((task) => !isActive(task)).slice(-HISTORY_LIMIT);
    downloadTasks.value = [...active, ...finished].sort((a, b) => a.createdAt - b.createdAt);
  } catch (e) {
    console.warn("[downloader] 恢复下载队列失败", e);
  }
}

/** 排队中的任务等登录态恢复后再自动续跑（离线硬跑只会立刻全部失败） */
function resumeIfOnline(): void {
  if (sessionPhase.value !== "online") return;
  if (!downloadTasks.value.some((task) => task.status === "queued")) return;
  void pump();
}

/** 由 App.vue 在 mounted 时调用一次：注册进度事件 + 恢复上次队列（不依赖在线页是否挂载） */
export async function initDownloadQueue(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await onDownloadProgress(handleProgress);
  } catch (e) {
    console.warn("[downloader] 下载进度订阅失败", e);
  }
  await restorePersisted();
  watch(sessionPhase, () => resumeIfOnline(), { immediate: true });
  if (downloadTasks.value.length) persistSoon();
}

/** 强制把当前队列写盘（退出前 / 手动清理后可用） */
export function flushDownloadQueue(): Promise<void> {
  return flushPersist();
}

/** 汇总数字（悬浮窗角标 / 底栏共用） */
export function downloadSummary(): { active: number; queued: number; running: number } {
  let queued = 0;
  let running = 0;
  for (const task of downloadTasks.value) {
    if (task.status === "queued") queued += 1;
    else if (task.status === "downloading" || task.status === "installing") running += 1;
  }
  return { active: queued + running, queued, running };
}
