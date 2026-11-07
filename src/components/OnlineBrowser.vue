<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import OnlineModCard from "./OnlineModCard.vue";
import PageShell from "./layout/PageShell.vue";
import ModGrid from "./common/ModGrid.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import RenameDialog from "./RenameDialog.vue";
import OnlineSidebar from "./online/OnlineSidebar.vue";
import OnlineDetailPanel from "./online/OnlineDetailPanel.vue";
import { onIndexProgress } from "../online/service";
import { onTaskSettled, type DownloadTask } from "../online/downloadQueue";
import { onImagesReady } from "../online/images";
import { hydrateTranslations, translationLangEpoch } from "../online/translation";
import { tagLabel, type OnlineMod } from "../online/types";
import { normalizeBackendError } from "../format";
import {
  ensureSession,
  localSearchEnabled,
  manualRefreshNonce,
  requestOpenSettings,
  sessionEpoch,
  sessionPhase,
  setStatusMessageKey,
} from "../sessionState";
import { ensureUserData, favoriteCount } from "../userData";
import { useToast } from "../composables/useToast";
import { useOnlineThumbs } from "../composables/online/useOnlineThumbs";
import { useOnlineSelection } from "../composables/online/useOnlineSelection";
import { useInstalledIndex } from "../composables/online/useInstalledIndex";
import { PAGE_SIZE, useOnlineList } from "../composables/online/useOnlineList";
import { useOnlineDetail } from "../composables/online/useOnlineDetail";
import { useOnlineFavorite } from "../composables/online/useOnlineFavorite";
import { useOnlineInstall } from "../composables/online/useOnlineInstall";
import { useOnlineSession } from "../composables/online/useOnlineSession";
import { useIndexSync } from "../composables/online/useIndexSync";
import { useLocalSearch } from "../composables/online/useLocalSearch";
import { openExternalUrl } from "../api";

/**
 * 在线页入口：只做**组件协调 + 状态连接 + 生命周期**。
 *
 * 业务分层（依赖单向向下，无循环引用）：
 *   封面缓存 / 本机安装索引 / 当前选中项
 *     → 列表数据（缓存优先 + 翻页）→ 详情（含译文投影）→ 收藏 / 安装
 *       → 登录态 → 本地索引 → 本地搜索
 * 官方接口、数据结构、下载流程、缓存策略全部保持原样，只换了存放位置。
 */

/**
 * 视图偏好由 App.vue 顶层持有（全局唯一真源），本组件只用不写：
 * 在本地页调过的滑块 / 视图，切到在线页后依然生效；
 * 网格 / 列表切换本身已统一放在顶栏右端（设置齿轮左侧），不在本页面里。
 */
withDefaults(defineProps<{ viewMode?: "grid" | "list"; cardSize?: number }>(), {
  viewMode: "grid",
  cardSize: 200,
});

// ---------- 筛选状态由顶栏（App.vue）持有，这里通过 v-model 双向绑定 ----------
const query = defineModel<string>("query", { required: true });
const sort = defineModel<string>("sort", { required: true });
const order = defineModel<"DESC" | "ASC">("order", { required: true });

const { t } = useI18n();

const { toast, showToast } = useToast({ errorMs: 3200 });

// ---------------- 组合各业务层 ----------------

const thumbs = useOnlineThumbs();
const selection = useOnlineSelection();
const installed = useInstalledIndex();

/** 网格的真实滚动容器（列表归零 / 翻页判定 / KeepAlive 还原都要用） */
const scrollEl = ref<HTMLElement | null>(null);

const list = useOnlineList({
  selection,
  query,
  sort,
  order,
  scrollEl,
  hydrateList,
  syncImages: thumbs.syncImages,
  // 401：交给登录层统一处理（清会话 + 尝试静默重登）
  onUnauthorized: (message) => sessionCtl.reportUnauthorized(message),
  // 网络被搓断（代理节点抖动 / TLS 被中断）：弹一条轻提示，别让用户只看到转圈
  onNetworkInterrupted: () => showToast(t("online.networkInterrupted"), "error"),
  // 本地搜索与官方列表互斥：切官方分类 / 来源 / 收藏时清空本地搜索框
  clearLocalSearch: () => localSearch.clearLocalSearch(),
});

const detail = useOnlineDetail({ selection, showToast });
const favorite = useOnlineFavorite({ selection, showToast });
const install = useOnlineInstall({
  selection,
  detail,
  installed,
  patchMod: list.patchMod,
  showToast,
});

const sessionCtl = useOnlineSession({
  reloadAfterLogout: () => list.reload(false),
  resetFavoritePool: list.resetFavoritePool,
  onLoginStart: () => {
    install.clearMessages();
  },
});

const indexSync = useIndexSync({ afterIndexChange: () => rerunLocalSearch() });
const localSearch = useLocalSearch({
  indexStatus: indexSync.indexStatus,
  refreshIndexStatus: indexSync.refreshIndexStatus,
  resetScrollToTop: list.resetScrollToTop,
});

/** 索引内容变化（进度事件 / 补建完成 / 暂停继续）后，正在看的本地结果要重算 */
function rerunLocalSearch(): void {
  if (localSearch.localMode.value && localSearch.localTerm.value) {
    void localSearch.runLocalSearch(localSearch.localTerm.value);
  }
}

// ---------------- 模板用的扁平引用 ----------------

const {
  items,
  totalCount,
  loading,
  loadingMore,
  error,
  moreError,
  hasMore,
  onlySubscribed,
  favoritesOnly,
  noCacheOffline,
  activeTag,
  sentinel,
  reload,
  loadMore,
  pickTag,
  pickSubscribed,
  toggleFavorites,
  rememberScroll,
  restoreScrollTop,
} = list;

const {
  detail: detailRaw,
  detailLoading,
  detailError,
  detailUncached,
  detailTags,
  headerTitle,
  titleSub,
  sizeText,
  diskText,
  ratingText,
  versionText,
  createdText,
  updatedText,
  descText,
  canTranslate,
  waitingDetail,
  selectedTranslated,
  showingOriginalText,
  translateBusy,
  translateQueued,
  translateLabel,
  translateProvider,
  onTranslateClick,
} = detail;

const {
  progress,
  installing,
  installError,
  installNote,
  needForce,
  forceOverwrite,
  actionMessage,
  openingWeb,
  confirmDeleteOpen,
  deleteBusy,
  deleteError,
  localEntry,
  primaryAction,
  subscribeLabel,
  subscribeBusy,
  downloadAndInstall,
  doInstall,
  stopInstall,
  askDeleteLocal,
  confirmDeleteLocal,
  cancelDeleteLocal,
  openWebpage,
  revealingFolder,
  openLocalFolder,
  // 队列状态（进度 / 排队 / 安装中只认当前选中模组）
  queued,
  queuePos,
  cancelRequested,
} = install;

const {
  favorited,
  canFavorite,
  favBusy,
  favError,
  renameBusy,
  renameError,
  renameOpen,
  customName,
  toggleFavorite,
  openRename,
  closeRename,
  applyRename,
} = favorite;

const {
  session,
  sessionError,
  waitingLogin,
  probing,
  probeResult,
  netClearing,
  netError,
  netMessage,
  tags,
  tagsError,
  silentAuth,
  silentAuthNote,
  refreshSession,
  runProbe,
  startLogin,
  stopWaiting,
  loadTags,
  dispose: disposeSession,
} = sessionCtl;

/**
 * 帝国时代官网账号中心（v3.3）：微软 / Xbox 账号在这里登录，也是 Steam 版用户
 * 绑定 Steam 账号的唯一入口。域名已加入 Rust `open_external` 白名单。
 */
const ACCOUNT_CENTER_URL = "https://auth.ageofempires.com/";

async function openAccountCenter(): Promise<void> {
  try {
    await openExternalUrl(ACCOUNT_CENTER_URL);
  } catch (e) {
    showToast(normalizeBackendError(e), "error");
  }
}

const {
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
} = indexSync;

const {
  localQuery,
  localTerm,
  localItems,
  localSearching,
  localTotal,
  localIndexed,
  localMode,
  runLocalSearch,
} = localSearch;

const selected = selection.selected;

/** 本机安装索引的读取错误（详情面板「本地状态」行下方显示） */
const localIndexError = installed.localIndexError;

/** 网络状态指示（底栏与在线页同源） */
const phase = sessionPhase;

// ---------------- 派生视图 ----------------

/**
 * 网格实际渲染的列表。
 * 本地搜索态 → 本地索引结果；收藏 → 按 modId 过滤已加载条目（绝不重新请求）；否则官方列表。
 * 单一出口：模板里所有「有没有内容」的判断都读它，避免两套搜索互相串台。
 */
const visibleItems = computed<OnlineMod[]>(() =>
  localMode.value ? localItems.value : list.visibleOfficialItems.value,
);

const heading = computed(() => {
  if (localMode.value) return t("online.localSearchHeading", { q: localTerm.value });
  if (favoritesOnly.value) return t("favorites.heading");
  if (onlySubscribed.value) return t("online.headingSubscribed");
  return query.value.trim() ? t("online.headingSearch") : t("online.headingAll");
});

const activeTagName = computed(() => {
  // 收藏视图：分类已让位，标题栏直接说明作用域
  if (favoritesOnly.value) return t("favorites.scopeHint");
  if (list.effectiveTag.value === null) return t("sidebar.allContent");
  const hit = tags.value.find((item) => item.modTypeId === list.effectiveTag.value);
  return hit ? tagLabel(hit) : t("online.tagFallback", { id: list.effectiveTag.value });
});

/** 详情面板：翻译按钮的可用态 / 提示（组合自 useOnlineDetail 的投影） */
const translateDisabled = computed(
  () => translateBusy.value || translateQueued.value || (!selectedTranslated.value && !canTranslate.value),
);
const translateActive = computed(() => selectedTranslated.value && !showingOriginalText.value);
const translateNote = computed(() => (waitingDetail.value && !selectedTranslated.value
  ? t("translate.waitingContent")
  : null));

/** 详情面板：封面 */
const selectedThumb = computed(() => thumbs.thumbOf(selected.value));

// ---------------- 交互 ----------------

/** 列表一变就把已缓存的译文接回来（**只读缓存，零网络**） */
function hydrateList(list: OnlineMod[]): void {
  hydrateTranslations(
    list
      .filter((mod) => mod.modId > 0)
      .map((mod) => ({ modId: mod.modId, title: mod.title ?? "", description: "" })),
  );
}

/** ModGrid 就绪：拿回真实滚动容器（IntersectionObserver / keepFilling 继续读这个 ref） */
function onGridReady(payload: { scrollEl: HTMLElement | null }) {
  scrollEl.value = payload.scrollEl;
}

/** 选中卡片 → 加载详情（缓存优先 + 单飞 + 冷却都在 useOnlineDetail 里） */
function selectMod(mod: OnlineMod): void {
  const same = selected.value?.modId === mod.modId;
  // 重复点同一张卡：什么都不做（不重复请求，也不清空已看到的内容）
  if (same && (detailRaw.value !== null || detailLoading.value || detail.isPending(mod.modId))) return;
  selection.select(mod);
  if (!same) {
    detail.resetForSwitch();
    install.resetForSwitch();
    favorite.resetForSwitch();
  }
  void detail.loadDetail(mod);
}

/** 收藏视图的空态 / 搜索清空等：切回官方列表的通用动作 */
function clearLocalQuery(): void {
  localSearch.localQuery.value = "";
}

/** 顶栏“刷新”按钮只能走组件内部逻辑：仅暴露这一个方法 */
async function manualRefresh(): Promise<void> {
  await refreshSession();
  // 用户点了刷新：明确意图，走手工通道（仍受单飞 + 2s 闸门保护）
  await reload(true);
}
defineExpose({ refresh: manualRefresh });

// ---------------- 滚动：无限加载 + KeepAlive 位置还原 ----------------

let unlisten: (() => void) | null = null;
let unlistenImages: (() => void) | null = null;
let unlistenIndex: (() => void) | null = null;
let observer: IntersectionObserver | null = null;
let scrollHandler: (() => void) | null = null;
/** 滚动停止检测：滚动过程中不请求，停稳 200ms 后才判断是否到底 */
let scrollIdleTimer: number | null = null;
/** 滚动停下多久才判定「真的到底了」 */
const SCROLL_IDLE_MS = 200;
/** 被 KeepAlive 切走时是否还有没还原的滚动位置 */
let restorePending = false;

function detachObserver(): void {
  if (scrollIdleTimer !== null) {
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scrollHandler && scrollEl.value) {
    scrollEl.value.removeEventListener("scroll", scrollHandler);
  }
  scrollHandler = null;
}

function attachObserver(): void {
  detachObserver();
  const el = scrollEl.value;
  const marker = sentinel.value;
  if (!el || !marker) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    },
    { root: el, rootMargin: "600px 0px", threshold: 0 },
  );
  observer.observe(marker);
  scrollHandler = () => {
    rememberScroll();
    // 连续滚轮期间不发请求：等停稳后再判断，避免一次长滚动触发多次 loadMore
    if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = null;
      const node = scrollEl.value;
      if (!node) return;
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 600) void loadMore();
    }, SCROLL_IDLE_MS);
  };
  el.addEventListener("scroll", scrollHandler, { passive: true });
}

watch([scrollEl, sentinel], attachObserver, { flush: "post" });

/**
 * 先把 scrollTop 还原、再挂观察器：顺序反过来会让哨兵先被判相交，误触发一次 loadMore，
 * 新批量一追加页面就会跳。
 */
function restoreScroll(): void {
  if (!scrollEl.value || !restorePending) {
    attachObserver();
    return;
  }
  restorePending = false;
  restoreScrollTop();
  attachObserver();
}

// ---------------- 登录态 / 启动 ----------------

/** 首次挂载只跑一次；被 KeepAlive 缓存后不会再触发 */
let booted = false;

/**
 * 登录态确认有效的统一刷新入口。
 * boot 与 watch(sessionEpoch) 都走它，用 epoch 去重，保证同一个信号只刷一次。
 */
let handledEpoch = 0;
async function handleSessionEpoch(): Promise<void> {
  const current = sessionEpoch.value;
  if (current === handledEpoch) return;
  handledEpoch = current;
  if (sessionPhase.value !== "online") return;
  await loadTags();
  // v1.0：登录成功 → 自动补建索引（之前未登录时索引只能是空的）。
  // v1.2：每次新登录都重置闸门 —— 上一轮可能就是因为 Cookie 失效（401）中止的。
  resetSyncGuard();
  void triggerIndexSync();
  // 自动触发：缓存命中时不会再打网络
  await reload(false);
}

watch(sessionEpoch, () => {
  void handleSessionEpoch();
});

// 底栏「立即重新校验」成功后推一次手工刷新信号（这属于用户明确意图）
watch(manualRefreshNonce, (value) => {
  if (!value) return;
  void reload(true);
});

// 排序 / 升降序：立即重新查询（顶栏下拉已直接写入 model）
watch([sort, order], () => {
  void reload();
});

/**
 * 官方搜索：App.vue 只在「回车 / 点搜索」时才写 query（输入过程中不写），
 * 所以这里直接重载，无需防抖。官方搜索一旦生效就清空本地搜索框（两套搜索互斥）。
 */
watch(query, () => {
  if (query.value.trim()) localSearch.clearLocalSearch();
  void reload();
});

/** 目标语言一变（设置页切换 / 跟随界面语言联动）→ 重新预热，卡片立刻换成新语言 */
watch(translationLangEpoch, () => {
  hydrateList(visibleItems.value);
  // 本地索引的标题占位是按旧语言灌进来的（切语言时已清空）：重新检索一次，别退化成英文
  if (localMode.value && localTerm.value) void localSearch.runLocalSearch(localTerm.value);
});

/**
 * 队列任务落地（成功 / 失败 / 取消）：同步在线列表的本机状态 + 刷新本地索引 + 轻提示。
 * 下载本身在 `online/downloadQueue.ts` 里执行，本组件只负责展示层的后续刷新。
 */
function handleTaskSettled(task: DownloadTask): void {
  if (task.status === "done") {
    // 本地模组：服务器订阅状态不参与判断
    list.patchMod(task.modId, { userInstalled: false, updateAvailable: false });
  }
  void installed.refreshLocalIndex();
  if (task.message) {
    showToast(t(task.message.key, task.message.params ?? {}), task.status === "failed" ? "error" : "ok");
  }
}

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  // 下载任务由 App 层的队列单例执行；这里只订阅「任务落地」事件刷列表 / 本地索引 + 轻提示
  unlisten = onTaskSettled(handleTaskSettled);
  // v0.5：收藏 / 备注只读一次磁盘（失败不阻塞在线页）
  void ensureUserData().catch(() => undefined);

  // v1.0：先读索引状态（中文搜索的空态 / 提示依赖它）
  void refreshIndexStatus();

  // v1.2：索引进度事件（每入库一批推一次）：实时刷进度行，并在本地搜索态下重算命中
  unlistenIndex = await onIndexProgress(applyProgress);

  // ① 先渲染缓存（内部就是一次 invoke，命中就立刻出卡片，绝不转圈；缓存命中不联网）
  await reload(false);

  // ①b 订阅「封面已落地」事件：后台下完一批就把本地 asset URL 补进映射
  unlistenImages = await onImagesReady(thumbs.applyImages);

  // ② 静默校验登录态：App.vue 启动时已发起，这里复用同一个 Promise（并发去重）
  const online = await ensureSession();
  if (online) {
    await handleSessionEpoch();
    return;
  }

  // ④ 离线：分类字典用内置兜底，并后台静默尝试一次 SSO（隐藏窗口，不阻塞）
  await loadTags();
  setStatusMessageKey("statusbar.offlineHint");
  void sessionCtl.silentReauth(t("online.reasonNoSession"));
}

onMounted(() => {
  void installed.refreshLocalIndex();
  void boot();
});

/** 被 KeepAlive 再次显示：只恢复滚动位置与观察器，不发任何网络请求 */
onActivated(() => {
  // 本地页可能删过模组，重新读一次索引（只读目录名，不发网络请求）
  void installed.refreshLocalIndex();
  void nextTick(restoreScroll);
});

/** 切走时先记位置再销毁观察器（deactivated 在移出文档之后触发，不能在这里读 scrollTop） */
onDeactivated(() => {
  rememberScroll();
  restorePending = true;
  detachObserver();
});

onUnmounted(() => {
  detachObserver();
  disposeSession();
  stopIndexPoll();
  if (unlisten) unlisten();
  if (unlistenImages) unlistenImages();
  if (unlistenIndex) unlistenIndex();
});
</script>

<template>
  <!-- 三栏骨架与本地页完全一致：统一走 <PageShell>（同一个组件、同一套列宽与滚动规则） -->
  <PageShell>
    <!-- 左侧：分类筛选（复用本地 .side-group / .side-item） -->
    <template #sidebar>
      <OnlineSidebar
        :only-subscribed="onlySubscribed"
        :favorites-only="favoritesOnly"
        :active-tag="activeTag"
        :tags="tags"
        :tags-error="tagsError"
        :session="session"
        :net-clearing="netClearing"
        :net-error="netError"
        :net-message="netMessage"
        :favorite-count="favoriteCount"
        @pick-subscribed="pickSubscribed"
        @toggle-favorites="toggleFavorites"
        @pick-tag="pickTag"
        @refresh-session="refreshSession"
      />
    </template>

    <!-- 中间：与本地一致的 .content + .grid-scroll + .card-grid（由 ModGrid 提供） -->
    <template #content>
      <div class="content-head">
        <h2>{{ heading }}</h2>
        <span class="hint">
          <!-- 收藏视图：不展示官方「共 N 条」总数（那是查询总数，与收藏无关），只报本地命中数 -->
          <template v-if="favoritesOnly">
            {{ t("favorites.localHint", { n: visibleItems.length }) }}
          </template>
          <template v-else-if="localMode">
            {{ t("online.localSearchFound", { n: localTotal }) }}
            <template v-if="localIndexed > 0">
              · {{ t("online.localSearchIndexed", { n: localIndexed }) }}
            </template>
            <template v-if="localSearching">{{ t("online.loadingSuffix") }}</template>
          </template>
          <template v-else>
            {{ activeTagName }} ·
            {{ items.length
            }}<template v-if="totalCount !== null">{{ t("online.totalSuffix", { n: totalCount }) }}</template>
            <template v-if="loading">{{ t("online.loadingSuffix") }}</template>
          </template>
        </span>
      </div>

      <!-- v1.1：本地搜索框（与顶栏官方搜索彻底解耦：只查本地索引，输入过程零网络）
           v1.2：设置 → 通用里可关闭此入口（默认关闭） -->
      <div v-if="localSearchEnabled" class="local-search">
        <span class="glyph">⌕</span>
        <input
          v-model="localQuery"
          type="search"
          :placeholder="t('online.localSearchPlaceholder')"
          spellcheck="false"
        />
        <span v-if="localSearching" class="spinner"></span>
        <button
          v-if="localQuery"
          class="clear"
          type="button"
          :title="t('search.clear')"
          :aria-label="t('search.clear')"
          @click="clearLocalQuery"
        >
          ✕
        </button>
      </div>

      <!-- v1.2：索引进度指示（Rust 事件推送，实时刷新；不靠轮询）
           搜索框关掉但索引仍在跑时也保留这行，让用户能看到进度。
           v1.6：设置里关掉「本地索引」后整行不再渲染（连同「前往设置」按钮），
           用户已经主动关闭，不该再被一行 ⚪ 提示反复提醒。 -->
      <div
        v-if="
          indexStatus?.indexingEnabled !== false &&
          (localSearchEnabled || (indexStatus?.indexingEnabled ?? false))
        "
        class="index-status"
        :class="indexPhaseKind"
      >
        <span class="text">{{ indexStatusText }}</span>
        <button
          v-if="indexPhaseKind === 'failed' && indexStatus?.phase === 'needLogin'"
          type="button"
          class="mini"
          @click="startLogin()"
        >
          {{ t("online.openLogin") }}
        </button>
        <button
          v-else-if="indexPhaseKind === 'syncing'"
          type="button"
          class="mini"
          :disabled="indexPauseBusy"
          @click="toggleIndexPause"
        >
          {{ t("online.indexPause") }}
        </button>
        <!-- ⏸ 暂停中 / 中断过：从断点接着爬（不受 24h 新鲜度闸门约束） -->
        <button
          v-else-if="indexPhaseKind === 'paused'"
          type="button"
          class="mini"
          :disabled="indexPauseBusy"
          @click="toggleIndexPause"
        >
          {{ indexPauseBusy ? t("online.indexContinueBusy") : t("online.indexContinue") }}
        </button>
        <!-- 🟢 已就绪：还能继续把剩余窗口爬完 -->
        <button
          v-else-if="indexPhaseKind === 'ready'"
          type="button"
          class="mini"
          :disabled="indexPauseBusy"
          @click="toggleIndexPause"
        >
          {{ indexPauseBusy ? t("online.indexContinueBusy") : t("online.indexContinue") }}
        </button>
        <!-- 开关关闭：指示灯变 ⚪，直接给一个跳设置页的入口 -->
        <button
          v-else-if="indexPhaseKind === 'disabled'"
          type="button"
          class="mini"
          @click="requestOpenSettings()"
        >
          {{ t("online.indexStatusGoSettings") }}
        </button>
        <button
          v-else-if="indexPhaseKind === 'idle'"
          type="button"
          class="mini"
          :disabled="indexSyncBusy"
          @click="triggerIndexSync(true)"
        >
          {{ indexSyncBusy ? t("online.localSearchBuildingShort") : t("online.localSearchBuildNow") }}
        </button>
      </div>

      <!-- 搜索 / 排序 / 刷新已统一到 App.vue 的顶栏，这里只保留标题条与列表 -->
      <!-- 列表：与本地页共用 ModGrid（滚动容器 + 网格骨架 + 视图模式 + 卡片大小）
           内部只留状态面板与页脚，卡片本体进 #cards 插槽 -->
      <ModGrid :view-mode="viewMode" :card-size="cardSize" @ready="onGridReady">
        <!-- v0.6：已删除全屏「正在检查登录状态」蒙层。有缓存就直接出列表；
             既没缓存又没登录才显示登录面板，校验进行中只在面板里加一行 🟡 提示。 -->
        <!-- v1.1：本地搜索态下不管登录/官方列表，直接走下面的本地分支 -->
        <div v-if="!localMode && !items.length && !session?.loggedIn" class="state-panel">
          <h2>{{ t("online.sessionConnectTitle") }}</h2>
          <p>{{ t("online.sessionConnectBody") }}</p>
          <p v-if="phase === 'checking'" class="online-silent">
            <span class="spinner"></span>{{ t("statusbar.checking") }}
          </p>
          <p v-else-if="silentAuth" class="online-silent">
            <span class="spinner"></span>{{ silentAuthNote }}
          </p>
          <p v-else-if="silentAuthNote" class="online-silent note">{{ silentAuthNote }}</p>
          <!-- v3.3：登录途径只剩微软 / Xbox 一条（Steam 与 PSN 入口已移除）。 -->
          <div class="login-target-single">
            <span class="lt-label">{{ t("online.loginMicrosoftLabel") }}</span>
            <span class="lt-hint">{{ t("online.loginMicrosoftHint") }}</span>
          </div>
          <p class="login-bind-note">
            {{ t("online.loginSteamBindNote") }}
            <button type="button" class="lt-link" @click="openAccountCenter">{{ t("online.loginAccountCenter") }}</button>
          </p>
          <div class="login-actions">
            <button type="button" :disabled="waitingLogin" @click="startLogin()">
              {{ waitingLogin ? t("online.waitingLogin") : t("online.openLogin") }}
            </button>
            <button v-if="waitingLogin" type="button" @click="stopWaiting">{{ t("online.cancel") }}</button>
            <button type="button" :disabled="probing" @click="runProbe">
              {{ probing ? t("online.probing") : t("online.probe") }}
            </button>
            <button type="button" @click="refreshSession">{{ t("online.recheck") }}</button>
          </div>
          <p v-if="sessionError" class="online-error">{{ sessionError }}</p>
          <pre v-if="probeResult" class="online-note-box">{{ probeResult }}</pre>
        </div>

        <template v-else>
          <!-- 收藏视图的空态必须排在前面：它是纯本地结果，
               不能报“官方接口没返回”这种误导文案 -->
          <div v-if="favoritesOnly && !localMode && !visibleItems.length" class="state-panel">
            <h2>⭐ {{ t("favorites.empty") }}</h2>
            <p>{{ t("favorites.localEmpty") }}</p>
          </div>

          <!-- 本地搜索空态：与官方接口完全无关，只说本地索引的情况。 -->
          <div v-else-if="localMode && !visibleItems.length && !localSearching" class="state-panel">
            <h2>{{ t("online.localSearchEmptyTitle") }}</h2>
            <!-- 边爬边搜：索引还没建完时不能说「没有结果」，要说清后台还在继续 -->
            <p v-if="indexBuilding" class="note">{{ t("online.localSearchPartial") }}</p>
            <p v-else-if="indexStatus && !indexStatus.indexingEnabled" class="note">
              {{ t("online.localSearchDisabledHint") }}
            </p>
            <p v-else>{{ t("online.localSearchEmptyBody") }}</p>
            <p v-if="!session?.loggedIn" class="note">{{ t("online.localSearchNeedLogin") }}</p>
            <p v-else-if="indexSyncBusy" class="note">{{ t("online.localSearchBuildingShort") }}</p>
            <p v-else-if="!indexReady" class="note">{{ t("online.localSearchNotReady") }}</p>
            <p v-else-if="indexBuilding" class="note">
              {{ t("online.localSearchBuilding", { n: indexStatus?.indexed ?? 0, total: indexStatus?.totalCount ?? 0 }) }}
            </p>
            <div class="login-actions">
              <button v-if="!session?.loggedIn" type="button" @click="startLogin()">
                {{ t("online.openLogin") }}
              </button>
              <button
                v-else-if="indexStatus && !indexStatus.indexingEnabled"
                type="button"
                @click="requestOpenSettings()"
              >
                {{ t("online.indexStatusGoSettings") }}
              </button>
              <button
                v-else-if="!indexReady || indexBuilding"
                type="button"
                :disabled="indexSyncBusy"
                @click="triggerIndexSync(true)"
              >
                {{ indexSyncBusy ? t("online.localSearchBuildingShort") : t("online.localSearchBuildNow") }}
              </button>
              <button v-else type="button" @click="runLocalSearch(localTerm)">
                {{ t("online.reload") }}
              </button>
            </div>
          </div>

          <div v-else-if="noCacheOffline && !localMode" class="state-panel">
            <h2>{{ onlySubscribed ? t("online.headingSubscribed") : t("online.offlineNoCacheTitle") }}</h2>
            <p>{{ t("online.offlineNoCacheBody") }}</p>
            <div class="login-actions">
              <button type="button" @click="reload(true)">{{ t("online.retry") }}</button>
            </div>
          </div>

          <div v-else-if="error && !localMode" class="state-panel">
            <h2>{{ t("online.requestFailedTitle") }}</h2>
            <p>{{ error }}</p>
            <div class="login-actions">
              <button type="button" @click="reload(true)">{{ t("online.retry") }}</button>
              <button type="button" @click="startLogin()">{{ t("online.signInAgain") }}</button>
            </div>
          </div>

          <div v-else-if="!visibleItems.length && (localMode ? localSearching : loading)" class="state-panel">
            <h2><span class="spinner"></span>{{ t("online.listLoadingTitle") }}</h2>
            <p class="note">{{ t("online.listLoadingBody", { n: PAGE_SIZE }) }}</p>
          </div>

          <div v-else-if="!visibleItems.length" class="state-panel">
            <h2>{{ t("online.listEmptyTitle") }}</h2>
            <p>{{ t("online.listEmptyBody") }}</p>
            <div class="login-actions">
              <button type="button" @click="reload(true)">{{ t("online.reload") }}</button>
            </div>
          </div>

          <!-- 离线 + 有缓存：列表照常展示，只在上方加一条不可下载的提示（本地搜索视图不插这条） -->
          <div v-else-if="!session?.loggedIn && !localMode" class="offline-strip">
            ⚪ {{ t("online.offlineCacheNotice") }}
          </div>
        </template>

        <!-- 卡片本体：本地与在线共用同一套网格骨架（.card-grid + --card-size + list-mode） -->
        <template #cards>
          <OnlineModCard
            v-for="mod in visibleItems"
            :key="mod.modId"
            :mod="mod"
            :thumb="thumbs.thumbOf(mod)"
            :active="selected?.modId === mod.modId"
            @select="selectMod"
          />
        </template>

        <!-- 页脚：本地搜索 / 收藏视图不挂哨兵，官方列表挂哨兵继续翻页 -->
        <template #foot>
          <template v-if="visibleItems.length">
            <!-- 本地搜索：哨兵不挂（v-if 移除后 watch([scrollEl, sentinel]) 自动解绑），一次给完 60 条不翻页 -->
            <div v-if="localMode" class="scroll-foot">
              {{ t("online.localSearchFooter", { n: visibleItems.length }) }}
            </div>
            <!-- 收藏视图不挂哨兵：sentinel 为 null 后 watch([scrollEl, sentinel]) 会自动解绑
                 IntersectionObserver 与滚动监听，从根上停掉自动翻页（双保险：loadMore 内还有一道 guard） -->
            <div v-else-if="favoritesOnly" class="scroll-foot">
              {{ t("favorites.footerLoaded", { fav: visibleItems.length, loaded: items.length }) }}
            </div>
            <div v-else ref="sentinel" class="scroll-foot">
              <template v-if="moreError">
                <span class="err">{{ moreError }}</span>
                <button type="button" @click="loadMore()">{{ t("online.retry") }}</button>
              </template>
              <template v-else-if="loadingMore">
                <span class="spinner"></span>{{ t("online.loadingMore") }}
              </template>
              <template v-else-if="hasMore">{{ t("online.scrollMore") }}</template>
              <template v-else>{{ t("online.endOfList", { n: items.length }) }}</template>
            </div>
          </template>
        </template>
      </ModGrid>
    </template>

    <!-- 右侧：与本地相同的详情栏宽度与滚动规则 -->
    <template #detail>
      <OnlineDetailPanel
        :mod="selected"
        :thumb="selectedThumb"
        :title="headerTitle"
        :subtitle="titleSub"
        :tags="detailTags"
        :translate-label="translateLabel"
        :translate-provider="translateProvider"
        :translate-note="translateNote"
        :translate-disabled="translateDisabled"
        :translate-active="translateActive"
        :favorited="favorited"
        :can-favorite="canFavorite"
        :fav-busy="favBusy"
        :fav-error="favError"
        :rename-busy="renameBusy"
        :rating-text="ratingText"
        :size-text="sizeText"
        :disk-text="diskText"
        :version-text="versionText"
        :created-text="createdText"
        :updated-text="updatedText"
        :local-entry="localEntry"
        :local-index-error="localIndexError"
        :queued="queued"
        :queue-pos="queuePos"
        :cancel-requested="cancelRequested"
        :primary-action="primaryAction"
        :subscribe-label="subscribeLabel"
        :subscribe-busy="subscribeBusy"
        :installing="installing"
        :progress="progress"
        :action-message="actionMessage"
        :install-error="installError"
        :install-note="installNote"
        :opening-web="openingWeb"
        :revealing-folder="revealingFolder"
        :desc-text="descText"
        :detail-loading="detailLoading"
        :detail-error="detailError"
        :detail-uncached="detailUncached"
        v-model:need-force="needForce"
        v-model:force-overwrite="forceOverwrite"
        @translate="onTranslateClick"
        @toggle-favorite="toggleFavorite"
        @rename="openRename"
        @install="downloadAndInstall"
        @leave-queue="stopInstall"
        @uninstall="askDeleteLocal"
        @reinstall="doInstall"
        @stop-install="stopInstall"
        @open-webpage="openWebpage"
        @reveal-folder="openLocalFolder"
      />
    </template>

    <!-- 浮层：Toast / 备注名弹窗 / 删除确认，全部 position: fixed，不参与三栏排版 -->
    <template #overlay>
    <!-- 右下角轻提示：局部状态变更的即时反馈，不触发列表重载 -->
    <div v-if="toast" class="online-toast" :class="toast.kind">{{ toast.text }}</div>

    <!-- v0.5：备注名弹窗 -->
    <RenameDialog
      v-if="renameOpen && selected"
      :original="selected.title"
      :initial="customName"
      :busy="renameBusy"
      :error="renameError"
      @save="applyRename"
      @cancel="closeRename"
    />

    <!-- 删除本地文件前的二次确认 -->
    <ConfirmDialog
      v-if="confirmDeleteOpen"
      :title="t('online.uninstallTitle')"
      :message="t('online.uninstallMessage')"
      :detail="localEntry ? localEntry.kind + '/' + localEntry.folderName : null"
      :confirm-label="t('confirm.defaultConfirm')"
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDeleteLocal"
      @cancel="cancelDeleteLocal"
    />

    </template>
  </PageShell>
</template>

<style scoped>
/* 只补充本地界面没有的元素；布局全部复用 style.css 的本地类 */
/* 搜索/排序控件已统一到 App.vue 顶栏（.search-box / .toolbar），此处不再保留 */
.offline-strip {
  margin: 10px 0 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--gold-dim);
  border-radius: 3px;
  background: rgba(var(--accent-rgb), 0.06);
  color: var(--gold);
  font-size: 11.5px;
  line-height: 1.6;
}
.scroll-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 0 8px;
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: calc(0.4px * var(--ui-tracking));
}
.scroll-foot .err {
  color: var(--danger-text);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scroll-foot button {
  padding: 3px 10px;
  font-size: 11px;
}
.login-target-single {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  margin: 12px 0 4px;
  padding: 9px 11px;
  line-height: 1.5;
  border: 1px solid rgba(var(--accent-rgb), 0.35);
  border-radius: 4px;
  background: linear-gradient(180deg, var(--item-active-top), var(--bg-hover));
}
.lt-label {
  font-size: 12.5px;
  color: var(--gold-bright);
}
.lt-hint {
  font-size: 10.5px;
  color: var(--muted);
}
/* v3.3：Steam 版用户绑定微软账号的提示（金色描边、可点击跳官网账号中心） */
.login-bind-note {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}
.lt-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--gold-bright);
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
.lt-link:hover {
  color: var(--gold);
}
.login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.online-silent {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--gold-dim);
  border-radius: 3px;
  background: rgba(var(--accent-rgb), 0.06);
  color: var(--gold);
  font-size: 11.5px;
  line-height: 1.7;
}
/* 与详情子组件同名同值（scoped 样式不穿透子组件），保证两处观感一致 */
.online-error {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(var(--danger-rgb), 0.45);
  border-radius: 3px;
  background: rgba(var(--danger-rgb), 0.08);
  color: var(--danger-text);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.online-note-box {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel-deep);
  color: var(--parch-dim);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  font-family: var(--font-mono);
}

/* 右下角轻提示（固定定位，不参与三栏布局） */
.online-toast {
  position: fixed;
  right: 24px;
  /* v0.4.2：抬到右下角下载悬浮按钮之上，避免互相遮挡 */
  bottom: 88px;
  z-index: 60;
  max-width: 420px;
  padding: 9px 14px;
  border-radius: 4px;
  border: 1px solid var(--gold-dim);
  background: linear-gradient(180deg, var(--toast-top), var(--toast-bottom));
  color: var(--parch);
  font-size: 12px;
  letter-spacing: calc(0.6px * var(--ui-tracking));
  line-height: 1.6;
  box-shadow: 0 10px 24px rgba(var(--shadow-rgb), 0.55);
  animation: toast-in 0.18s ease-out;
  pointer-events: none;
}
.online-toast.error {
  border-color: var(--danger);
  color: var(--danger-text-strong);
  background: linear-gradient(180deg, var(--toast-error-top), var(--toast-error-bottom));
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
