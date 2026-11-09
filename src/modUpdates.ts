/**
 * v0.4「本地模组批量更新检测」的共享状态。
 *
 * 为什么放在模块作用域而不是组件里：
 * - 结果要同时被 SettingsModal（按钮 / 状态）和 App.vue（卡片角标 / 详情页按钮）使用；
 * - 15 秒冷却必须跨「关掉设置弹窗再打开」依然生效，组件内的 ref 会被销毁重来。
 *
 * 触发方式是唯一的：用户点设置里的按钮 → runModUpdateCheck()。
 * 绝不在后台轮询。
 *
 * v0.7：支持 Tauri 事件实时进度和增量结果。
 */
import { computed, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { checkModUpdates } from "./api";
import { normalizeBackendError } from "./format";
import type { ModUpdateItem, ModUpdateReport } from "./types";

/** 冷却时长：15 秒内禁止再次请求 /Installed */
const COOLDOWN_MS = 15_000;
let lastCheckMs = 0;
let timer: number | null = null;

export const report = ref<ModUpdateReport | null>(null);
export const checking = ref(false);
export const error = ref<string | null>(null);
export const cooldownLeft = ref(0);

/** v0.7：实时检测进度 */
export const checkProgress = ref<{ completed: number; total: number; phase: string } | null>(null);

export const canCheck = computed(() => !checking.value && cooldownLeft.value === 0);

/** 有更新的 ModEntry.id 集合（卡片角标直接查这个） */
export const updateIds = computed<Set<string>>(() => {
  const set = new Set<string>();
  for (const item of report.value?.items ?? []) {
    if (item.hasUpdate) set.add(item.entryId);
  }
  return set;
});

/** entryId → 单条结果（详情页展示服务端 / 本地时间） */
export const itemsById = computed<Map<string, ModUpdateItem>>(() => {
  const map = new Map<string, ModUpdateItem>();
  for (const item of report.value?.items ?? []) map.set(item.entryId, item);
  return map;
});

function stopTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** 250ms 一跳的倒计时；归零自动清定时器 */
function startTimer() {
  const tick = () => {
    const left = COOLDOWN_MS - (Date.now() - lastCheckMs);
    if (left <= 0) {
      cooldownLeft.value = 0;
      stopTimer();
      return;
    }
    cooldownLeft.value = Math.ceil(left / 1000);
  };
  stopTimer();
  tick();
  if (cooldownLeft.value > 0) timer = window.setInterval(tick, 250);
}

/** 弹窗重新挂载时调用：若仍在冷却期就接着倒计时 */
export function resumeCooldown() {
  if (lastCheckMs > 0 && Date.now() - lastCheckMs < COOLDOWN_MS) startTimer();
}

// ---------------- v0.7：Tauri 事件监听（实时进度 + 增量结果） ----------------

let unlistenStarted: UnlistenFn | null = null;
let unlistenItem: UnlistenFn | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenFinished: UnlistenFn | null = null;

async function setupEventListeners() {
  await cleanupEventListeners();

  unlistenStarted = await listen<{ total: number }>("mod-update://started", (e) => {
    // 初始化空 report，开始累积增量结果
    report.value = {
      checkedAtMs: Date.now(),
      totalLocal: e.payload.total,
      updateCount: 0,
      unknownCount: 0,
      serverTotal: null,
      pages: 0,
      items: [],
    };
    checkProgress.value = { completed: 0, total: e.payload.total, phase: "installed" };
  });

  unlistenItem = await listen<ModUpdateItem>("mod-update://item", (e) => {
    if (!report.value) return;
    const idx = report.value.items.findIndex((i) => i.entryId === e.payload.entryId);
    if (idx >= 0) {
      // 更新已有项
      report.value.items[idx] = e.payload;
    } else {
      // 新增项
      report.value.items.push(e.payload);
    }
    // 重新统计 updateCount
    report.value.updateCount = report.value.items.filter((i) => i.hasUpdate).length;
  });

  unlistenProgress = await listen<{ completed: number; total: number; phase: string }>(
    "mod-update://progress",
    (e) => {
      checkProgress.value = {
        completed: e.payload.completed,
        total: e.payload.total,
        phase: e.payload.phase,
      };
    },
  );

  unlistenFinished = await listen<{
    total: number;
    updateCount: number;
    detailRequested: number;
    detailSucceeded: number;
    detailFailed: number;
  }>("mod-update://finished", (e) => {
    if (report.value) {
      report.value.updateCount = e.payload.updateCount;
      report.value.detailRequested = e.payload.detailRequested;
      report.value.detailSucceeded = e.payload.detailSucceeded;
      report.value.detailFailed = e.payload.detailFailed;
    }
    checkProgress.value = null;
  });
}

async function cleanupEventListeners() {
  await unlistenStarted?.();
  await unlistenItem?.();
  await unlistenProgress?.();
  await unlistenFinished?.();
  unlistenStarted = null;
  unlistenItem = null;
  unlistenProgress = null;
  unlistenFinished = null;
}

/** 用户点击「检查本地模组更新」：成功或失败都会进入 15 秒冷却 */
export async function runModUpdateCheck(): Promise<ModUpdateReport | null> {
  if (!canCheck.value) return null;
  checking.value = true;
  error.value = null;
  checkProgress.value = null;

  // 设置事件监听（started 事件会初始化 report）
  await setupEventListeners();

  try {
    const next = await checkModUpdates();
    // 最终结果覆盖事件累积的结果
    report.value = next;
    return next;
  } catch (e) {
    error.value = normalizeBackendError(e);
    return null;
  } finally {
    checking.value = false;
    checkProgress.value = null;
    lastCheckMs = Date.now();
    startTimer();
    // 延迟清理监听，让 finished 事件有机会被处理
    window.setTimeout(() => void cleanupEventListeners(), 500);
  }
}

/** 更新安装成功后清掉该模组的「可更新」标记，避免角标一直挂着 */
export function markUpdated(entryId: string) {
  const current = report.value;
  if (!current) return;
  const hit = current.items.find((item) => item.entryId === entryId);
  if (!hit || !hit.hasUpdate) return;
  hit.hasUpdate = false;
  hit.serverLastUpdateMs = hit.localLastUpdateMs;
  current.updateCount = current.items.filter((item) => item.hasUpdate).length;
}
