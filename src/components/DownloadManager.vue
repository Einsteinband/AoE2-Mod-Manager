<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { translateBackendMessage } from "../format";
import {
  clearFinishedTasks,
  downloadSummary,
  downloadTasks,
  isTaskStalled,
  managerOpen,
  queuePositionOf,
  removeTask,
  requestCancelTask,
  retryTask,
  stalledTick,
  type DownloadTask,
} from "../online/downloadQueue";

/**
 * 右下角全局下载管理器（仿 Steam 下载管理）。
 *
 * 状态全部来自模块级单例 `downloadQueue.ts`：与在线页是否挂载、用户停在哪一页无关。
 * 这里只做展示与按钮分发，不改任何业务状态机。
 */
const { t } = useI18n();

const tasks = downloadTasks;
const summary = computed(() => downloadSummary());

/** 最新入队的在最上面 */
const ordered = computed(() => [...tasks.value].reverse());

const finishedCount = computed(
  () => tasks.value.filter((task) => task.status === "done" || task.status === "failed" || task.status === "cancelled").length,
);

/** FAB 上的百分比：只有「正在下载且有真实总字节数」时才显示 */
const fabPercent = computed<number | null>(() => {
  const task = tasks.value.find((item) => item.status === "downloading" || item.status === "installing");
  if (!task) return null;
  const progress = task.progress;
  if (!progress) return null;
  if (task.status === "installing") return 100;
  if (progress.total > 0) return Math.max(0, Math.min(100, Math.round(progress.percent)));
  return null;
});

function toggle(): void {
  managerOpen.value = !managerOpen.value;
}

function isStopping(task: DownloadTask): boolean {
  return task.cancelRequested && (task.status === "downloading" || task.status === "installing");
}

/**
 * F2：读取 stalledTick 建立响应式依赖。stalledTick 每 5s 自增一次，
 * 触发本组件重算，进而让 isTaskStalled(task) 的结果随时间刷新。
 * 不读这个 tick，「90s 无进度」不会自动变成可见状态。
 */
function touchStalledTick(): void {
  void stalledTick.value;
}

function statusText(task: DownloadTask): string {
  touchStalledTick();
  if (isStopping(task)) return t("downloader.stopping");
  if (task.status === "downloading" && isTaskStalled(task)) return t("downloader.stalled");
  switch (task.status) {
    case "queued": {
      const pos = queuePositionOf(task.id);
      return pos ? t("downloader.queuedPos", { n: pos }) : t("downloader.queued");
    }
    case "downloading":
      return t("downloader.downloading");
    case "installing":
      return t("downloader.installing");
    case "done":
      return t("downloader.done");
    case "failed":
      return t("downloader.failed");
    case "cancelled":
      return t("downloader.cancelled");
    default:
      return "";
  }
}

function percentOf(task: DownloadTask): number {
  const progress = task.progress;
  if (!progress) return 0;
  if (progress.total > 0) return Math.max(0, Math.min(100, progress.percent));
  return 0;
}

function showBar(task: DownloadTask): boolean {
  return task.status === "downloading" || task.status === "installing";
}

function noteText(task: DownloadTask): string {
  if (task.status === "failed") {
    if (task.error) return translateBackendMessage(task.error);
    // 启动时从磁盘恢复的「上次退出时中断」没有 error 文本，用消息 key 兜底
    if (task.message) return t(task.message.key, task.message.params ?? {});
    return "";
  }
  if (task.status === "downloading" || task.status === "installing") {
    // F2：下载无响应时优先给「点取消放弃」的提示，而不是干巴巴的 MB 数。
    if (task.status === "downloading" && isTaskStalled(task)) {
      return t("downloader.stalledHint");
    }
    const progress = task.progress;
    if (!progress) return t("downloader.waiting");
    const received = (progress.received / 1024 / 1024).toFixed(1);
    if (progress.total > 0) {
      return `${received} MB / ${(progress.total / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${received} MB`;
  }
  if (task.status === "queued") return t("downloader.queuedHint");
  if (task.status === "done") return task.localized === false
    ? t("downloader.doneKeepSubscribed")
    : t("downloader.doneHint");
  return "";
}

function actionLabel(task: DownloadTask): string {
  if (task.status === "queued") return t("downloader.leaveQueue");
  if (task.status === "downloading" || task.status === "installing") return t("downloader.cancel");
  return t("downloader.remove");
}

function runAction(task: DownloadTask): void {
  if (task.status === "queued" || task.status === "downloading" || task.status === "installing") {
    requestCancelTask(task.id);
    return;
  }
  removeTask(task.id);
}

/** Esc 收起面板（不影响其它弹窗：只有展开时才监听） */
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" && managerOpen.value) managerOpen.value = false;
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <!-- 常驻悬浮按钮：无任务时也显示（灰色小图标），有任务时显示进度 / 排队角标 -->
  <div class="dlmgr">
    <div v-if="managerOpen" class="dlmgr-panel" role="dialog" aria-label="downloads">
      <header class="dlmgr-head">
        <h4>{{ t("downloader.title") }}</h4>
        <span class="dlmgr-sub">{{ t("downloader.footer", { total: tasks.length, active: summary.active }) }}</span>
        <button type="button" class="dlmgr-x" :title="t('downloader.close')" @click="managerOpen = false">
          ✕
        </button>
      </header>

      <div class="dlmgr-list">
        <div v-if="!tasks.length" class="dlmgr-empty">{{ t("downloader.empty") }}</div>
        <div v-for="task in ordered" :key="task.id" class="dlmgr-row" :class="task.status">
          <div class="dlmgr-row-top">
            <span class="dlmgr-title" :title="task.title">{{ task.title }}</span>
            <span class="dlmgr-badge" :class="task.status">{{ statusText(task) }}</span>
          </div>

          <div v-if="showBar(task)" class="dlmgr-bar">
            <div class="dlmgr-fill" :style="{ width: percentOf(task) + '%' }"></div>
          </div>

          <div class="dlmgr-row-bottom">
            <span class="dlmgr-note">{{ noteText(task) }}</span>
            <template v-if="task.status === 'failed' || task.status === 'cancelled'">
              <button
                type="button"
                class="dlmgr-act"
                @click="retryTask(task.id)"
              >
                {{ t("downloader.retry") }}
              </button>
              <button
                type="button"
                class="dlmgr-act"
                @click="removeTask(task.id)"
              >
                {{ t("downloader.remove") }}
              </button>
            </template>
            <button
              v-else
              type="button"
              class="dlmgr-act"
              :class="{ danger: task.status === 'downloading' || task.status === 'installing' }"
              :disabled="isStopping(task)"
              @click="runAction(task)"
            >
              {{ isStopping(task) ? t("downloader.stopping") : actionLabel(task) }}
            </button>
          </div>
        </div>
      </div>

      <footer v-if="finishedCount > 0" class="dlmgr-foot">
        <button type="button" @click="clearFinishedTasks()">{{ t("downloader.clearFinished") }}</button>
      </footer>
    </div>

    <button
      type="button"
      class="dlmgr-fab"
      :class="{ running: summary.running > 0, idle: summary.active === 0 }"
      :title="t('downloader.open')"
      :aria-label="t('downloader.open')"
      @click="toggle"
    >
      <span class="dlmgr-fab-icon">⇩</span>
      <span v-if="summary.running > 0 && fabPercent !== null" class="dlmgr-fab-text">{{ fabPercent }}%</span>
      <span v-else-if="summary.running > 0" class="dlmgr-fab-spin"></span>
      <span v-if="summary.queued > 0" class="dlmgr-fab-badge">{{ summary.queued }}</span>
    </button>
  </div>
</template>

<style scoped>
.dlmgr {
  position: fixed;
  right: 18px;
  bottom: 30px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}
.dlmgr-fab {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  gap: 0;
  padding: 0;
  border: 1px solid rgba(var(--accent-rgb), 0.6);
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom));
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.dlmgr-fab:hover {
  border-color: var(--gold);
  transform: translateY(-1px);
}
.dlmgr-fab.running {
  border-color: var(--gold);
  box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.25), var(--shadow);
}
.dlmgr-fab-icon {
  font-size: 16px;
  line-height: 1;
  color: var(--gold);
}
.dlmgr-fab-text {
  position: absolute;
  bottom: 6px;
  font-size: 9.5px;
  letter-spacing: calc(0.2px * var(--ui-tracking));
  color: var(--gold-bright);
  font-variant-numeric: tabular-nums;
}
.dlmgr-fab-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--gold);
  color: var(--text-on-accent);
  font-size: 10px;
  font-weight: var(--ui-font-weight-strong);
}
.dlmgr-fab-spin {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid rgba(var(--accent-rgb), 0.25);
  border-top-color: var(--gold);
  animation: dlmgr-spin 0.9s linear infinite;
}
@keyframes dlmgr-spin {
  to { transform: rotate(360deg); }
}
.dlmgr-panel {
  width: 320px;
  max-height: min(360px, 60vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  border-radius: 5px;
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom));
  box-shadow: var(--shadow);
  animation: app-toast-in 0.18s ease-out;
}
.dlmgr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(var(--accent-rgb), 0.06);
}
.dlmgr-head h4 {
  margin: 0;
  font-size: calc(12px * var(--global-scale));
  letter-spacing: calc(0.6px * var(--ui-tracking));
  color: var(--gold);
}
.dlmgr-sub {
  margin-left: auto;
  font-size: calc(10.5px * var(--global-scale));
  color: var(--muted);
}
.dlmgr-x {
  padding: 2px 4px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.dlmgr-x:hover { color: var(--gold); }
.dlmgr-list {
  overflow-y: auto;
  padding: 2px 0;
}
.dlmgr-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
}
.dlmgr-row:last-child { border-bottom: none; }
.dlmgr-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dlmgr-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--parch);
}
.dlmgr-badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: calc(10px * var(--global-scale));
  color: var(--parch-dim);
  white-space: nowrap;
}
.dlmgr-badge.downloading,
.dlmgr-badge.installing {
  color: var(--gold);
  border-color: rgba(var(--accent-rgb), 0.55);
}
.dlmgr-badge.done {
  color: var(--gold-bright);
  border-color: rgba(var(--accent-rgb), 0.7);
}
.dlmgr-badge.failed {
  color: var(--danger-text);
  border-color: rgba(var(--danger-rgb), 0.6);
}
.dlmgr-badge.cancelled { color: var(--muted); }
.dlmgr-bar {
  margin-top: 5px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-track);
  overflow: hidden;
}
.dlmgr-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  transition: width 0.2s ease;
}
.dlmgr-row-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
}
.dlmgr-note {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(10px * var(--global-scale));
  color: var(--muted);
}
.dlmgr-act {
  flex: none;
  padding: 2px 8px;
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  border-radius: 3px;
  background: transparent;
  color: var(--gold);
  font-size: calc(10px * var(--global-scale));
  cursor: pointer;
}
.dlmgr-act:hover:not(:disabled) {
  border-color: var(--gold);
  background: rgba(var(--accent-rgb), 0.12);
}
.dlmgr-act.danger {
  color: var(--danger-text);
  border-color: rgba(var(--danger-rgb), 0.55);
}
.dlmgr-act:disabled {
  opacity: 0.55;
  cursor: default;
}
.dlmgr-foot {
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  text-align: right;
}
.dlmgr-foot button {
  padding: 3px 10px;
  font-size: calc(10.5px * var(--global-scale));
}
.dlmgr-fab.idle { border-color: var(--line); }
.dlmgr-fab.idle .dlmgr-fab-icon { color: var(--muted); }
.dlmgr-fab.idle:hover { border-color: var(--gold-dim); }
.dlmgr-fab.idle:hover .dlmgr-fab-icon { color: var(--gold); }
.dlmgr-empty {
  padding: 16px 10px;
  text-align: center;
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
}
</style>
