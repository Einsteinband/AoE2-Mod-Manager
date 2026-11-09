/**
 * 本地模组批量更新管理。
 *
 * 为什么单独做一个 composable 而不是直接在组件里写循环：
 * - 批量更新是跨组件状态（触发按钮在 LocalTab，进度要显示在队列面板）；
 * - 需要统计成功/失败数、当前进度、防重复启动；
 * - 复用统一队列的 onTaskSettled 事件，不自己实现下载逻辑。
 *
 * 执行模型：
 * - 一次性把所有可更新模组逐个 enqueueLocalUpdate 入队；
 * - 队列 pump() 自动串行执行（MAX_CONCURRENT=1）；
 * - onTaskSettled 监听每个任务落地，统计成功/失败；
 * - 全部完成后 emit 汇总。
 */
import { ref, computed, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  enqueueLocalUpdate,
  onTaskSettled,
  downloadTasks,
  type DownloadTask,
} from "../../online/downloadQueue";
import type { ModEntry } from "../../types";

/** 批量更新完成回调参数 */
export interface BatchUpdateResult {
  total: number;
  success: number;
  failed: number;
  failedTitles: string[];
}

export function useLocalBatchUpdate(deps: {
  showToast: (text: string, kind?: "ok" | "error") => void;
  /** 全部完成后调用（用于 rescan） */
  onComplete?: () => void | Promise<void>;
}) {
  const { t } = useI18n();

  /** 是否正在批量更新中 */
  const isBatching = ref(false);
  /** 总任务数 */
  const total = ref(0);
  /** 已完成数（成功+失败） */
  const completed = ref(0);
  /** 成功数 */
  const successCount = ref(0);
  /** 失败数 */
  const failCount = ref(0);
  /** 失败的模组标题列表 */
  const failedTitles = ref<string[]>([]);

  /** 本次批量更新涉及的 entryId 集合（用于区分批量任务 vs 单个手动更新） */
  const batchEntryIds = new Set<string>();

  /** 当前正在更新的模组标题（从队列状态派生） */
  const currentTitle = computed<string | null>(() => {
    for (const task of downloadTasks.value) {
      if (
        task.kind === "local_update" &&
        task.entryId &&
        batchEntryIds.has(task.entryId) &&
        (task.status === "downloading" || task.status === "installing")
      ) {
        return task.title;
      }
    }
    return null;
  });

  /** 进度百分比 0-100 */
  const progressPercent = computed(() => {
    if (total.value === 0) return 0;
    return Math.round((completed.value / total.value) * 100);
  });

  /** 检查是否全部完成 */
  function checkComplete(): void {
    if (!isBatching.value) return;
    if (completed.value < total.value) return;
    isBatching.value = false;

    const result: BatchUpdateResult = {
      total: total.value,
      success: successCount.value,
      failed: failCount.value,
      failedTitles: [...failedTitles.value],
    };

    // 通知用户结果
    if (result.failed === 0) {
      deps.showToast(t("batchUpdate.allDone", { n: result.success }), "ok");
    } else {
      deps.showToast(
        t("batchUpdate.partialDone", { success: result.success, failed: result.failed }),
        "error",
      );
    }

    // 触发完成回调（rescan）
    if (deps.onComplete) {
      void Promise.resolve(deps.onComplete()).catch(() => undefined);
    }
  }

  /** 监听任务完成，统计批量进度 */
  const offSettled = onTaskSettled((task: DownloadTask) => {
    if (task.kind !== "local_update" || !task.entryId) return;
    // 只统计本次批量更新涉及的任务
    if (!batchEntryIds.has(task.entryId)) return;

    completed.value += 1;
    if (task.status === "done") {
      successCount.value += 1;
    } else {
      failCount.value += 1;
      failedTitles.value.push(task.title);
    }

    checkComplete();
  });

  onUnmounted(() => {
    offSettled();
  });

  /**
   * 启动批量更新。
   * @param mods 可更新的模组列表（按顺序）
   */
  function startBatchUpdate(mods: ModEntry[]): void {
    if (isBatching.value) return;
    if (mods.length === 0) return;

    // 重置统计
    batchEntryIds.clear();
    completed.value = 0;
    successCount.value = 0;
    failCount.value = 0;
    failedTitles.value = [];

    let enqueued = 0;
    for (const mod of mods) {
      const modId = mod.workshopId ?? 0;
      if (modId <= 0) continue;

      const result = enqueueLocalUpdate(modId, mod.displayName, mod.id);
      if (result.accepted) {
        batchEntryIds.add(mod.id);
        enqueued += 1;
      }
    }

    if (enqueued === 0) return;

    total.value = enqueued;
    isBatching.value = true;
  }

  return {
    isBatching,
    total,
    completed,
    successCount,
    failCount,
    failedTitles,
    currentTitle,
    progressPercent,
    startBatchUpdate,
  };
}

export type LocalBatchUpdate = ReturnType<typeof useLocalBatchUpdate>;
