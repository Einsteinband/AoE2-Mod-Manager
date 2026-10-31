/**
 * 在线页的「本地搜索」（v1.1 双搜索框架的左半边）。
 *
 * 与顶栏的官方搜索**彻底解耦**：
 * - 只调 `search_local_mods`（纯内存索引 + 本地译文标题），**零网络**；
 * - 输入过程 300ms 防抖，换词丢弃过期响应（请求序号）；
 * - 命中项的中文标题先灌进共享译文表，卡片和详情立刻显示中文。
 *
 * 索引不可用（未登录 / 还在建立 / IPC 异常）属于预期：直接给空态，绝不发网络兜底。
 */
import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import { searchLocalMods } from "../../online/service";
import { applyExternalTitles } from "../../online/translation";
import type { IndexSearchItem, IndexStatus, OnlineMod } from "../../online/types";
import { localSearchEnabled } from "../../sessionState";

/** 本地索引一次取多少条：一次拿全，不为本地结果单独翻页 */
const LOCAL_SEARCH_LIMIT = 60;
/** 输入防抖 */
const DEBOUNCE_MS = 300;

/** 本地索引搜索命中的一条 → 前端卡片用的 OnlineMod（字段与 OnlineModSummary 同形） */
function toOnlineMod(item: IndexSearchItem): OnlineMod {
  return {
    modId: item.modId,
    title: item.title,
    creator: item.creator ?? null,
    thumbnail: item.thumbnail ?? null,
    installs: item.installs ?? null,
    installsTruncated: item.installsTruncated ?? false,
    rating: item.rating ?? null,
    modStatus: item.modStatus ?? null,
    userInstalled: item.userInstalled ?? false,
    userDownloaded: item.userDownloaded ?? false,
    updateAvailable: item.updateAvailable ?? false,
    gameTitleId: item.gameTitleId ?? null,
    tagIds: item.tagIds ?? [],
    tagNames: item.tagNames ?? [],
    fileSize: item.fileSize ?? null,
    raw: item.raw ?? {},
  };
}

export function useLocalSearch(deps: {
  indexStatus: Ref<IndexStatus | null>;
  refreshIndexStatus: () => Promise<void>;
  /** 切到本地视图前先归零滚动（顺序反了会先顶到最底再回弹） */
  resetScrollToTop: () => void;
}) {
  /** 本地搜索框输入（列表上方那个框，独立于顶栏官方搜索） */
  const localQuery = ref("");
  /** 已生效的本地关键词：空串 = 不在本地搜索态 */
  const localTerm = ref("");
  /** 本地检索结果：直接渲染进原来的卡片网格 */
  const localItems = ref<OnlineMod[]>([]);
  const localSearching = ref(false);
  /** 命中总数 / 索引规模（标题条展示用） */
  const localTotal = ref(0);
  const localIndexed = ref(0);

  let timer: number | null = null;
  /** 本地检索请求序号：换词时丢弃过期响应 */
  let seq = 0;

  /** 当前是否处于「本地搜索」视图：是则网格只渲染本地结果，且绝不发网络请求 */
  const localMode = computed(() => localTerm.value !== "");

  function stopTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 退出本地搜索态并清空输入框（点官方分类 / 切来源 / 提交官方搜索时调用）。
   * 返回调用前是否处于本地视图 —— 调用方用它决定要不要重新请求官方列表。
   */
  function clearLocalSearch(): boolean {
    const wasLocal = localMode.value;
    stopTimer();
    seq += 1;
    localQuery.value = "";
    localTerm.value = "";
    localItems.value = [];
    localTotal.value = 0;
    localSearching.value = false;
    return wasLocal;
  }

  /**
   * 执行本地检索：只读内存索引 + 本地译文，**零网络**。
   * 命中项的中文标题先灌进共享译文表，卡片和详情页立刻显示中文。
   */
  async function runLocalSearch(term: string): Promise<void> {
    // v1.2：搜索框被关掉时不跑（进度事件也会反过来触发这里）
    if (!localSearchEnabled.value) return;
    const mySeq = ++seq;
    localSearching.value = true;
    try {
      const result = await searchLocalMods({ query: term, offset: 0, limit: LOCAL_SEARCH_LIMIT });
      if (mySeq !== seq) return;
      const titled = result.items.filter((item) => !!item.zhTitle);
      if (titled.length) {
        applyExternalTitles(
          titled.map((item) => ({ modId: item.modId, title: item.zhTitle as string })),
        );
      }
      localItems.value = result.items.map(toOnlineMod);
      localTotal.value = result.total;
      localIndexed.value = result.indexed;
      // 索引规模随搜索同步回来：顺手刷新状态面板的数字，省一次 invoke
      if (deps.indexStatus.value) {
        deps.indexStatus.value = { ...deps.indexStatus.value, indexed: result.indexed };
      }
      // 切到本地视图前先归零滚动（顺序反了会先顶到最底再回弹）
      if (!localMode.value) deps.resetScrollToTop();
      localTerm.value = term;
      if (!deps.indexStatus.value) void deps.refreshIndexStatus();
    } catch {
      // 索引不可用属于预期（未登录 / 还在建立 / IPC 异常）：给空态，不发网络兜底
      if (mySeq !== seq) return;
      localItems.value = [];
      localTotal.value = 0;
      localTerm.value = term;
    } finally {
      if (mySeq === seq) localSearching.value = false;
    }
  }

  /**
   * 本地搜索框：300ms 防抖后查本地索引，**输入过程中一个网络请求都不会发**。
   * 清空输入立即回到官方列表，不等防抖。
   */
  watch(localQuery, (value) => {
    stopTimer();
    const term = value.trim();
    if (!term) {
      if (localTerm.value || localItems.value.length) {
        seq += 1;
        localTerm.value = "";
        localItems.value = [];
        localTotal.value = 0;
        localSearching.value = false;
        deps.resetScrollToTop();
      }
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      void runLocalSearch(term);
    }, DEBOUNCE_MS);
  });

  /** 首次进入本地搜索时读一次索引状态（之后只在补建完成后刷新） */
  watch(localMode, (on) => {
    if (on) void deps.refreshIndexStatus();
  });

  /** 设置里关掉本地搜索框：立即退出本地视图，回到官方列表 */
  watch(localSearchEnabled, (on) => {
    if (on) return;
    if (localMode.value || localQuery.value) {
      clearLocalSearch();
      deps.resetScrollToTop();
    }
  });

  onUnmounted(stopTimer);

  return {
    localQuery,
    localTerm,
    localItems,
    localSearching,
    localTotal,
    localIndexed,
    localMode,
    clearLocalSearch,
    runLocalSearch,
  };
}

export type LocalSearch = ReturnType<typeof useLocalSearch>;
