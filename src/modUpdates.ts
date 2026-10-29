/**
 * v0.4「本地模组批量更新检测」的共享状态。
 *
 * 为什么放在模块作用域而不是组件里：
 * - 结果要同时被 SettingsModal（按钮 / 状态）和 App.vue（卡片角标 / 详情页按钮）使用；
 * - 60 秒冷却必须跨「关掉设置弹窗再打开」依然生效，组件内的 ref 会被销毁重来。
 *
 * 触发方式是唯一的：用户点设置里的按钮 → runModUpdateCheck()。
 * 绝不在后台轮询。
 */
import { computed, ref } from "vue";
import { checkModUpdates } from "./api";
import { translateBackendMessage } from "./format";
import type { ModUpdateItem, ModUpdateReport } from "./types";

/** 冷却时长：60 秒内禁止再次请求 /Installed */
const COOLDOWN_MS = 60_000;
let lastCheckMs = 0;
let timer: number | null = null;

export const report = ref<ModUpdateReport | null>(null);
export const checking = ref(false);
export const error = ref<string | null>(null);
export const cooldownLeft = ref(0);

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

export function describeError(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return String(e);
  }
}

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

/** 用户点击「检查本地模组更新」：成功或失败都会进入 60 秒冷却 */
export async function runModUpdateCheck(): Promise<ModUpdateReport | null> {
  if (!canCheck.value) return null;
  checking.value = true;
  error.value = null;
  try {
    const next = await checkModUpdates();
    report.value = next;
    return next;
  } catch (e) {
    error.value = describeError(e);
    return null;
  } finally {
    checking.value = false;
    lastCheckMs = Date.now();
    startTimer();
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
