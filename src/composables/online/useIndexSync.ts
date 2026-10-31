/**
 * 在线页的「本地索引（中文搜索底座）」状态机。
 *
 * 三种驱动方式，各管一件事，互不重叠：
 * 1. **事件推送**（`online://index-progress`）：Rust 每入库一批就 emit 一次，指示灯实时刷新；
 * 2. **短轮询**（6 秒）：只在「确实还在建」时才挂，建完 / 暂停后立即停；
 * 3. **用户操作**：补建 / 暂停 / 继续按钮。
 *
 * 判定以 `done` 为准：服务端深翻页截断 + 3 万条硬上限都会让
 * 「indexed < totalCount」永远成立，拿它当条件会永远转圈。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  indexPause,
  indexStatus as fetchIndexStatus,
  indexSync,
} from "../../online/service";
import { kickIndexSync } from "../../online/indexSync";
import type { IndexStatus } from "../../online/types";
import { sessionEpoch, setStatusMessage } from "../../sessionState";

/** 索引进度轮询间隔（纯内存读，开销可忽略） */
const POLL_INTERVAL_MS = 6000;
/** 边爬边搜：进度事件触发的本地结果重算最小间隔 */
const PROGRESS_RERUN_GAP_MS = 1500;

export function useIndexSync(deps: {
  /** 索引内容发生变化：正在看的本地搜索结果需要重算 */
  afterIndexChange: () => void;
}) {
  const { t } = useI18n();

  /** 本地索引状态（已收录条数 / 服务端总量 / 是否在建立） */
  const indexStatus = ref<IndexStatus | null>(null);
  /** 手动补建索引正在进行（按钮防连点） */
  const indexSyncBusy = ref(false);
  /** 「暂停 / 继续」正在进行（按钮防连点） */
  const indexPauseBusy = ref(false);
  /** 本会话是否已经自动补建过索引（登录成功只补一次） */
  let indexSyncRequested = false;

  let pollTimer: number | null = null;
  let lastProgressRerunMs = 0;

  /** 索引里有数据 = 中文搜索可用 */
  const indexReady = computed(() => (indexStatus.value?.indexed ?? 0) > 0);

  /**
   * 索引指示灯：failed（🔴 需登录）/ paused（⏸ 已暂停）/ syncing（🟡）/ ready（🟢）/ idle（⚪）
   */
  const indexPhaseKind = computed<
    "failed" | "paused" | "syncing" | "ready" | "disabled" | "idle"
  >(() => {
    const st = indexStatus.value;
    if (!st) return "idle";
    // 开关关闭 → 无论如何都显示 ⚪（绝不能说「同步中」）
    if (!st.indexingEnabled) return "disabled";
    if (st.phase === "needLogin" || st.phase === "error") return "failed";
    if (st.syncing) return "syncing";
    // 用户主动暂停：优先于 done，否则会被误显示成 🟢 已就绪
    if (st.paused) return "paused";
    if (st.done) return "ready";
    // 已撞硬上限：不会再增长，当「就绪」展示
    if (st.maxItems > 0 && st.indexed >= st.maxItems) return "ready";
    // 有断点（中断过）但没在同步：等用户点「继续索引」，不再转圈
    if (st.resumable) return "paused";
    return "syncing";
  });

  /** 索引还没建完：与指示灯同一套判定（空态提示 / 轮询都用它） */
  const indexBuilding = computed(() => indexPhaseKind.value === "syncing");

  /** 一行进度文案：同步中带「已收集 N / M 条」 */
  const indexStatusText = computed(() => {
    const st = indexStatus.value;
    if (!st) return t("online.indexStatusIdle");
    if (indexPhaseKind.value === "disabled") return t("online.indexStatusDisabled");
    if (indexPhaseKind.value === "failed") {
      return st.phase === "needLogin"
        ? t("online.indexStatusNeedLogin")
        : t("online.indexStatusError");
    }
    if (indexPhaseKind.value === "ready") {
      return t("online.indexStatusReady", { n: st.indexed });
    }
    if (indexPhaseKind.value === "paused") {
      return t("online.indexStatusPaused", { n: st.indexed });
    }
    return st.totalCount > 0
      ? t("online.indexStatusSyncing", { n: st.indexed, total: st.totalCount })
      : t("online.indexStatusSyncingUnknown", { n: st.indexed });
  });

  function indexNeedsPolling(): boolean {
    if (indexSyncBusy.value || indexPauseBusy.value) return true;
    const st = indexStatus.value;
    if (!st || !st.indexingEnabled) return false;
    if (st.syncing) return true;
    // 用户主动暂停 / 有断点等点「继续」：不再轮询（否则每 6 秒白刷一次）
    if (st.paused || st.resumable) return false;
    // 从未完成且还没撞到硬上限：说明后台正在或在排队建，保持刷新直到 done
    return !st.done && st.scanned < st.maxItems && st.updatedAtMs > 0;
  }

  function stopIndexPoll(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleIndexPoll(): void {
    if (pollTimer !== null || !indexNeedsPolling()) return;
    pollTimer = window.setInterval(() => {
      const wasBuilding = indexBuilding.value;
      void (async () => {
        try {
          indexStatus.value = await fetchIndexStatus();
        } catch {
          return;
        }
        // 刚建完：正在看的本地搜索结果必须重算，否则用户看到的还是「0 条」
        if (wasBuilding && !indexBuilding.value) deps.afterIndexChange();
        if (!indexNeedsPolling()) stopIndexPoll();
      })();
    }, POLL_INTERVAL_MS);
  }

  /** 读一次索引状态（已收录条数 / 服务端总量 / 是否在建立） */
  async function refreshIndexStatus(): Promise<void> {
    try {
      indexStatus.value = await fetchIndexStatus();
    } catch {
      /* 读不到状态就按「未建立」处理，空态会自己兜底 */
    }
    scheduleIndexPoll();
  }

  /**
   * 补建索引（登录成功后自动跑一次，空态里也提供手动按钮）。
   * 自动路径走 `kickIndexSync`：与 App.vue 顶层的登录触发器**共享同一个 Promise**，
   * 同一 epoch 不会发两次请求。失败一律静默：未登录（unauthenticated）、
   * 已在同步（busy）、限流冷却都不该打扰用户。
   */
  async function triggerIndexSync(force = false): Promise<void> {
    if (indexSyncBusy.value) return;
    // v1.2：开关关闭时一个请求都不发（手动按钮也不会出现在 🟡 状态里）
    // indexStatus 还没读到时不拦：Rust 侧 sync_blocking 自己会按设置拒掉
    if (indexStatus.value && !indexStatus.value.indexingEnabled) return;
    if (!force && indexSyncRequested) return;
    indexSyncRequested = true;
    indexSyncBusy.value = true;
    try {
      const report = force ? await indexSync() : await kickIndexSync(sessionEpoch.value);
      if (report && (report.fetched > 0 || report.done)) {
        setStatusMessage(t("online.localSearchReady", { n: report.indexed }));
      }
    } catch {
      // 手动路径才可能抛（自动路径已被 kickIndexSync 吃掉）：允许下次登录再自动试一次
      indexSyncRequested = false;
    } finally {
      indexSyncBusy.value = false;
      await refreshIndexStatus();
      // 索引变了：本地结果必须重算，否则用户看到的还是旧的命中集
      deps.afterIndexChange();
    }
  }

  /**
   * 暂停 / 继续本地索引。
   *
   * 暂停：Rust 侧只置一个标记，线程做完「当前这一页」就收手并保留断点（不会置 done）；
   * 继续：从已落盘的游标接着爬，跳过 24 小时新鲜度闸门。
   * 两者都立即返回最新状态，真正的爬取在后台线程，进度靠 index-progress 事件推送。
   */
  async function toggleIndexPause(): Promise<void> {
    if (indexPauseBusy.value) return;
    const shouldPause = indexPhaseKind.value === "syncing";
    indexPauseBusy.value = true;
    try {
      indexStatus.value = await indexPause(shouldPause);
    } catch {
      /* 失败静默：轮询会自己纠偏 */
      await refreshIndexStatus();
    } finally {
      indexPauseBusy.value = false;
      // 继续是异步线程启的：1.5s 后再读一次，等 Rust 把 syncing 置起来
      window.setTimeout(() => {
        void refreshIndexStatus();
        deps.afterIndexChange();
      }, 1500);
    }
  }

  /** `online://index-progress` 事件：实时刷进度行，并节流触发本地结果重算 */
  function applyProgress(status: IndexStatus): void {
    indexStatus.value = status;
    const now = Date.now();
    if (now - lastProgressRerunMs < PROGRESS_RERUN_GAP_MS) return;
    lastProgressRerunMs = now;
    deps.afterIndexChange();
  }

  /** 重新登录：允许再自动补建一次（上一轮可能就是因为 Cookie 失效而中止的） */
  function resetSyncGuard(): void {
    indexSyncRequested = false;
  }

  return {
    indexStatus,
    indexSyncBusy,
    indexPauseBusy,
    indexReady,
    indexPhaseKind,
    indexBuilding,
    indexStatusText,
    refreshIndexStatus,
    triggerIndexSync,
    toggleIndexPause,
    applyProgress,
    resetSyncGuard,
    stopIndexPoll,
  };
}

export type IndexSync = ReturnType<typeof useIndexSync>;
