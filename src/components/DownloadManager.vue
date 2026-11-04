<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  clearFinishedTasks,
  downloadSummary,
  downloadTasks,
  managerOpen,
  queuePositionOf,
  removeTask,
  requestCancelTask,
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
const hasTasks = computed(() => tasks.value.length > 0);

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

function statusText(task: DownloadTask): string {
  if (isStopping(task)) return t("downloader.stopping");
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
  if (task.status === "failed" && task.error) return task.error;
  if (task.status === "downloading" || task.status === "installing") {
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
  <!-- 无任何任务 / 历史时整块不渲染（不打扰） -->
  <div v-if="hasTasks" class="dlmgr">
    <div v-if="managerOpen" class="dlmgr-panel" role="dialog" aria-label="downloads">
      <header class="dlmgr-head">
        <h4>{{ t("downloader.title") }}</h4>
        <span class="dlmgr-sub">{{ t("downloader.footer", { total: tasks.length, active: summary.active }) }}</span>
        <button type="button" class="dlmgr-x" :title="t('downloader.close')" @click="managerOpen = false">
          ✕
        </button>
      </header>

      <div class="dlmgr-list">
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
            <button
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
      :class="{ running: summary.running > 0 }"
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
