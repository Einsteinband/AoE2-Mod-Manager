<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import PageShell from "../layout/PageShell.vue";
import ModGrid from "../common/ModGrid.vue";
import ModCard from "../ModCard.vue";
import ModDetail from "../ModDetail.vue";
import LocalSidebar from "./LocalSidebar.vue";
import ImportDialog from "./ImportDialog.vue";
import PresetManager from "../PresetManager.vue";
import FirstRunWizard from "../FirstRunWizard.vue";
import ConfirmDialog from "../ConfirmDialog.vue";
import RenameDialog from "../RenameDialog.vue";
import ContextMenu from "../common/ContextMenu.vue";
import type { ContextMenuItem } from "../common/contextMenuTypes";
import { useLocalScan } from "../../composables/local/useLocalScan";
import { useContextMenu } from "../../composables/useContextMenu";
import { useUninstalledFavorites } from "../../composables/local/useUninstalledFavorites";
import { useLocalFilters } from "../../composables/local/useLocalFilters";
import { useSortMode } from "../../composables/local/useSortMode";
import { useLocalModActions } from "../../composables/local/useLocalModActions";
import { buildLocalMenuItems } from "../../composables/local/useLocalModMenu";
import { useDataModMutex } from "../../composables/local/useDataModMutex";
import { usePresets } from "../../composables/local/usePresets";
import { useLocalUpdate } from "../../composables/local/useLocalUpdate";
import { useLocalBatchUpdate } from "../../composables/local/useLocalBatchUpdate";
import { useToast } from "../../composables/useToast";
import { useScrollRestore } from "../../composables/useScrollRestore";
import { deleteModFiles, openExternalUrl, pickModZip, revealModFolder, toggleModEnabled } from "../../api";
import { itemsById, updateIds, report as modUpdateReport, checkProgress } from "../../modUpdates";
import { buildConflictIndex } from "../../modConflict";
import { enrichFavoriteMetaFromDetail, favoriteMetaOf } from "../../favoriteMeta";
import { enqueueDownload } from "../../online/downloadQueue";
import { sessionPhase } from "../../sessionState";
import {
  canTranslateText,
  currentTargetLanguageName,
  ensureTranslation,
  hydrateTranslations,
  isQueued,
  isShowingOriginal,
  isTranslating,
  toggleOriginal,
  translationErrorKind,
  translationLangEpoch,
  translationOf,
} from "../../online/translation";
import { openModWebpage } from "../../online/service";
import {
  customNameOf,
  ensureUserData,
  isFavorite,
  setCustomName,
  setFavorite,
} from "../../userData";
import { normalizeBackendError, normalizeError, translateBackendMessage } from "../../format";
import type { ModEntry, SortKey } from "../../types";

/**
 * 本地模组浏览器：本地页面唯一入口。
 *
 * 接管原 App.vue 内联的本地页面全部逻辑：
 * 扫描、筛选、排序、批量启停、数据模组互斥、预设、详情面板、状态面板。
 * （第三方 ZIP 导入功能已阶段性搁置：入口与弹窗挂载已关闭，后端实现保留，见
 * docs/ddd/THIRD_PARTY_MOD_IMPORT_HOLD.md）
 *
 * 顶栏工具栏（ModToolbar）和信息栏（rootbar）仍在 App.vue 的 AppShell 插槽中，
 * 通过 v-model props（search/sortModel）和 defineExpose 与本组件通信。
 */
const props = defineProps<{
  /** 游戏根目录（App.vue onMounted 读取 settings 后传入） */
  modRoot?: string | null;
  /** 搜索关键字（v-model，App.vue 顶栏 ModToolbar 持有） */
  search?: string;
  /** 排序字段（v-model，App.vue 顶栏 ModToolbar 持有） */
  sortModel?: string;
  /** 文件大小排序方向（v-model，App.vue 顶栏 ModToolbar 持有） */
  orderModel?: "DESC" | "ASC";
  /** 视图模式（grid/list，App.vue 顶栏 ViewSwitch 持有） */
  viewMode: "grid" | "list";
  /** 卡片大小 */
  cardSize: number;
}>();

const emit = defineEmits<{
  (e: "update:search", v: string): void;
  (e: "update:sortModel", v: string): void;
  (e: "update:orderModel", v: "DESC" | "ASC"): void;
}>();

const { t, locale } = useI18n();
const { toast, showToast } = useToast();

// ---------------- 顶栏 v-model 桥接（search / sortModel 由 App.vue 持有） ----------------
const searchModel = computed({
  get: () => props.search ?? "",
  set: (v: string) => emit("update:search", v),
});
const sortModelModel = computed({
  get: () => props.sortModel ?? "name",
  set: (v: string) => emit("update:sortModel", v),
});
const orderModelModel = computed({
  get: () => props.orderModel ?? "DESC",
  set: (v: "DESC" | "ASC") => emit("update:orderModel", v),
});

// ---------------- 扫描状态 ----------------
const scan = useLocalScan();
const uninstalledFavorites = useUninstalledFavorites({ mods: scan.mods });

const {
  report,
  mods,
  warnings,
  loading,
  error,
  candidates,
  choosingRoot,
  showWizard,
  selectedId,
  selected,
  lastScanText,
  chooseRoot,
} = scan;

// ---------------- 详情选中（含未安装收藏占位条目） ----------------
const detailMod = computed<ModEntry | null>(() => {
  const id = selectedId.value;
  if (!id) return null;
  if (selected.value) return selected.value;
  return uninstalledFavorites.ghosts.value.find((mod) => mod.id === id) ?? null;
});
const selectedEntryId = computed(() => selectedId.value);

watch(detailMod, (mod) => {
  if (!mod?.uninstalled) return;
  void enrichFavoriteMetaFromDetail(mod.workshopId ?? 0);
});

// ---------------- 区域设置（collation） ----------------
const currentLocale = computed(() => String(locale.value));
const collationLocale = computed(() =>
  currentLocale.value === "zh" ? "zh-Hans-CN" : currentLocale.value,
);

// ---------------- 筛选 ----------------
const filters = useLocalFilters({
  mods: scan.mods,
  ghostMods: uninstalledFavorites.ghosts,
  collationLocale,
});

const {
  search: filtersSearch,
  source,
  status,
  favoritesOnly,
  updatesOnly,
  updatesAvailableCount,
  activeTag,
  sourceCounts,
  statusCounts,
  sorted,
  officialTagList,
  inferredTagList,
  heading,
  favoriteLocalCount,
  pickSource,
  pickStatus,
  pickTag,
  pickUpdatesOnly,
  toggleFavorites,
  clearFilters,
} = filters;

// 桥接：外部 v-model ↔ filters 内部 ref
watch(searchModel, (v) => { if (filtersSearch.value !== v) filtersSearch.value = v; });
watch(filtersSearch, (v) => { if (searchModel.value !== v) emit("update:search", v); });
watch(sortModelModel, (v) => {
  if (filters.sortKey.value !== (v as SortKey)) filters.sortKey.value = v as SortKey;
});
watch(filters.sortKey, (v) => {
  if (sortModelModel.value !== v) emit("update:sortModel", v);
});
watch(orderModelModel, (v) => {
  if (filters.order.value !== v) filters.order.value = v;
});
watch(filters.order, (v) => {
  if (orderModelModel.value !== v) emit("update:orderModel", v);
});

// ---------------- 排序模式 ----------------
const sort = useSortMode({
  mods: scan.mods,
  loading: scan.loading,
  collationLocale,
  filters,
  hasReport: () => !!scan.report.value,
  showToast,
});

const {
  sortMode,
  sortSaving,
  dragList,
  showDiscardConfirm,
  sortDirty,
  excludedSortCount,
  blocksRescan,
  enterSortMode,
  exitSortMode,
  discardSortChanges,
  saveSortOrder,
  onSortHotkey,
} = sort;

/** 保存排序并自动退出排序模式 */
async function saveAndExitSortMode(): Promise<void> {
  if (sortSaving.value || !sortMode.value) return;
  await saveSortOrder();
  if (!sortDirty.value) exitSortMode();
}

// ---------------- 单条目操作 ----------------
const actions = useLocalModActions({
  report: scan.report,
  selectedId: scan.selectedId,
  patchModEnabled: scan.patchModEnabled,
  sort,
  normalizeError,
  showToast,
});

const {
  stats,
  statsLoading,
  statsError,
  selectMod,
  handleToggle,
  handleCardToggled,
  handleCardToggleError,
  handleRemoved,
} = actions;

// ---------------- 卡片右键上下文菜单（目标快照，不改选中态） ----------------
const cardMenu = useContextMenu<ModEntry>();
const menuOpen = cardMenu.open;
const menuX = cardMenu.x;
const menuY = cardMenu.y;

/** 页面层托管的备注弹窗（作用于快照；ModDetail 内原弹窗保留不动） */
const renameTarget = ref<ModEntry | null>(null);
const renameBusy = ref(false);
const renameError = ref<string | null>(null);

/** 页面层托管的卸载确认弹窗（作用于快照；复用现有 ConfirmDialog 二次确认） */
const deleteTarget = ref<ModEntry | null>(null);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

/** 目录 / 官网瞬时忙碌标记（按条目 id，避免重复触发） */
const revealingId = ref<string | null>(null);
const webOpeningId = ref<string | null>(null);

function onCardContextMenu(mod: ModEntry, event: MouseEvent | KeyboardEvent): void {
  cardMenu.openAt(event, mod);
}

/** 卸载确认文案：与 ModDetail 三态口径一致（tool / official / unknown + 本地补句） */
const deleteConfirmMessage = computed(() => {
  const mod = deleteTarget.value;
  if (!mod) return "";
  const body =
    mod.source === "tool"
      ? t("detail.confirmTool")
      : mod.source === "official"
        ? t("detail.confirmOfficial")
        : t("detail.confirmUnknown");
  return `${body}\n\n${t("detail.confirmLocalOnly")}`;
});

const localMenuItems = computed<ContextMenuItem[]>(() => {
  const mod = cardMenu.target.value;
  if (!mod) return [];
  const id = mod.workshopId ?? 0;
  const favorited = id > 0 && isFavorite(id);
  const hasTranslation = id > 0 && translationOf(id) !== null;
  const canText = canTranslateText(mod.description ?? "");
  const translating = id > 0 && isTranslating(id);
  const queued = id > 0 && isQueued(id);
  const showingOriginal = id > 0 && isShowingOriginal(id);

  return buildLocalMenuItems(
    mod,
    {
      favorited,
      hasTranslation,
      canText,
      translating,
      queued,
      showingOriginal,
      offline: sessionPhase.value !== "online",
    },
    {
      enable: t("menu.enable"),
      disable: t("menu.disable"),
      favorite: t("favorites.favorite"),
      favorited: t("favorites.favorited"),
      rename: t("favorites.rename"),
      translateBusy: t("translate.busy"),
      translateQueued: t("translate.queued"),
      translateTrigger: t("translate.trigger", { lang: currentTargetLanguageName() }),
      translateShowTranslated: t("translate.showTranslated", { lang: currentTargetLanguageName() }),
      translateShowOriginal: t("translate.showOriginal"),
      openFolder: t("detail.openFolder"),
      browseSite: t("detail.browseSite"),
      deleteMod: t("detail.deleteMod"),
      downloadInstall: t("detail.downloadInstall"),
      offlineHint: t("online.offlineBlocked"),
      notRegisteredHint: t("card.notRegisteredHint"),
    },
  );
});

async function onMenuSelect(itemId: string): Promise<void> {
  const mod = cardMenu.target.value;
  if (!mod) return;
  const id = mod.workshopId ?? 0;

  switch (itemId) {
    case "toggle": {
      cardMenu.close();
      if (mod.enabled === null) {
        showToast(t("card.notRegisteredHint"), "error");
        return;
      }
      const target = mod.enabled !== true;
      // 数据模组启用：互斥裁决交给父组件（与卡片开关 / 详情面板同一入口）
      if (target && mod.isDataMod) {
        requestEnableDataMod({ id: mod.id });
        return;
      }
      try {
        const result = await toggleModEnabled(id, mod.kind, mod.folderName, target);
        scan.patchModEnabled(mod.id, result.enabled);
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "install": {
      cardMenu.close();
      downloadUninstalledFavorite(mod);
      return;
    }
    case "favorite": {
      if (id <= 0) return;
      cardMenu.close();
      await ensureUserData();
      try {
        const next = await setFavorite(id, !isFavorite(id));
        showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "rename": {
      if (id <= 0) return;
      cardMenu.close();
      renameError.value = null;
      renameTarget.value = mod;
      return;
    }
    case "translate": {
      await translateFromMenu(mod);
      cardMenu.close();
      return;
    }
    case "folder": {
      cardMenu.close();
      await revealFromMenu(mod);
      return;
    }
    case "website": {
      cardMenu.close();
      await openWebsiteFromMenu(mod);
      return;
    }
    case "delete": {
      cardMenu.close();
      deleteError.value = null;
      deleteTarget.value = mod;
      return;
    }
  }
}

function rawBackendMessage(error: unknown): string {
  if (typeof error === "string") return translateBackendMessage(error);
  const message = (error as Error)?.message;
  return translateBackendMessage(message ?? String(error ?? ""));
}

function translationErrorMessage(error: unknown): string {
  switch (translationErrorKind(error)) {
    case "network":
      return t("translate.failNetwork");
    case "busy":
      return t("translate.failBusy");
    case "quota":
      return t("translate.failQuota");
    case "not_ready":
      return t("translate.notReady");
    default:
      return t("translate.failGeneric", { msg: rawBackendMessage(error) });
  }
}

async function translateFromMenu(mod: ModEntry): Promise<void> {
  const id = mod.workshopId ?? 0;
  if (id <= 0) return;
  // 已有译文：只切原文 / 译文，不发请求
  if (translationOf(id)) {
    toggleOriginal(id);
    return;
  }
  if (isTranslating(id) || isQueued(id)) return;
  if (!canTranslateText(mod.description ?? "")) {
    showToast(t("translate.notReady"), "error");
    return;
  }
  try {
    const tr = await ensureTranslation({ modId: id, title: mod.displayName }, mod.description ?? "");
    if (tr.truncated) {
      showToast(t("translate.truncated", { chars: tr.charCount }));
    } else {
      showToast(tr.cached ? t("translate.fromCacheToast") : t("translate.okToast"));
    }
  } catch (e) {
    showToast(translationErrorMessage(e), "error");
  }
}

async function revealFromMenu(mod: ModEntry): Promise<void> {
  if (!mod.path || revealingId.value) return;
  revealingId.value = mod.id;
  try {
    await revealModFolder(mod.path);
  } catch (e) {
    showToast(normalizeBackendError(e), "error");
  } finally {
    revealingId.value = null;
  }
}

async function openWebsiteFromMenu(mod: ModEntry): Promise<void> {
  const id = mod.workshopId ?? 0;
  if (id <= 0 || webOpeningId.value) return;
  webOpeningId.value = mod.id;
  try {
    await openModWebpage(id);
  } catch (e) {
    showToast(normalizeBackendError(e), "error");
  } finally {
    webOpeningId.value = null;
  }
}

async function applyMenuRename(name: string): Promise<void> {
  const mod = renameTarget.value;
  if (!mod || renameBusy.value) return;
  const id = mod.workshopId ?? 0;
  if (id <= 0) {
    renameTarget.value = null;
    return;
  }
  renameBusy.value = true;
  renameError.value = null;
  try {
    await setCustomName(id, name);
    renameTarget.value = null;
    showToast(t("favorites.savedToast"));
  } catch (e) {
    renameError.value = scan.normalizeError(e);
  } finally {
    renameBusy.value = false;
  }
}

function closeMenuRename(): void {
  renameTarget.value = null;
}

async function confirmMenuDelete(): Promise<void> {
  const mod = deleteTarget.value;
  if (!mod || deleting.value) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    await deleteModFiles(mod.kind, mod.folderName, mod.workshopId);
    deleteTarget.value = null;
    handleRemoved({ id: mod.id });
  } catch (e) {
    deleteError.value = scan.normalizeError(e);
  } finally {
    deleting.value = false;
  }
}

function cancelMenuDelete(): void {
  deleteTarget.value = null;
}


// ---------------- 未安装收藏的下载入口 ----------------
function downloadUninstalledFavorite(mod: ModEntry): void {
  const modId = Number(mod.workshopId ?? 0);
  if (!Number.isFinite(modId) || modId <= 0) {
    showToast(t("favorites.downloadNoId"), "error");
    return;
  }
  if (sessionPhase.value !== "online") {
    showToast(t("online.offlineBlocked"), "error");
    return;
  }
  const meta = favoriteMetaOf(modId);
  const result = enqueueDownload({
    modId,
    title: meta?.title || mod.displayName,
    kind: "install",
    tagIds: meta?.tagIds ?? [],
    tagNames: meta?.tagNames ?? [],
    creator: meta?.creator ?? null,
    description: meta?.description ?? null,
    thumbnail: meta?.thumbnailUrl ?? null,
  });
  if (!result.accepted) {
    showToast(t("favorites.downloadBusy"), "error");
    return;
  }
  showToast(t("favorites.downloadQueued"));
}

function downloadSelected(): void {
  const mod = detailMod.value;
  if (!mod) return;
  downloadUninstalledFavorite(mod);
}

function handleCoverUpdated(payload: { id: string; path: string }): void {
  scan.patchModCover(payload.id, payload.path);
}

// ---------------- 数据模组互斥 + 批量操作 ----------------
const dataModMutex = useDataModMutex({
  scan,
  sorted,
  t,
  showToast,
});

const {
  dataModConflict,
  dataModBusy,
  dataModError,
  requestEnableDataMod,
  confirmDataModSwitch,
  cancelDataModSwitch,
  batchAsk,
  batchBusy,
  batchError,
  askBatchEnable,
  askBatchDisable,
  runBatchToggleGuarded,
  cancelBatchGuarded,
  batchConfirmMessage,
} = dataModMutex;

// ---------------- 本地/订阅冲突索引 ----------------
const conflicts = computed(() => buildConflictIndex(scan.mods.value));

function conflictHintOf(entryId: string): string | null {
  if (conflicts.value.bySubscribedId.has(entryId)) return t("subscription.conflictBadge");
  if (conflicts.value.byLocalId.has(entryId)) return t("subscription.localNoted");
  return null;
}

// ---------------- 预设 ----------------
const presets = usePresets({
  mods: scan.mods,
  rescan: () => refresh(),
});
const { showPresets, lastAppliedPresetId, handlePresetApplied } = presets;

// ---------------- 本地模组更新（覆盖安装 + 版本检查） ----------------
const update = useLocalUpdate({
  blocksRescan: sort.blocksRescan,
  rescan: () => refresh(),
  normalizeError,
  showToast,
});
const { updateNotice, updatingEntryId, handleUpdateMod, runStartupUpdateCheck, openUpdatePage, dismissUpdateNotice } = update;

// ---------------- 可更新视图：批量选择 + 批量更新 ----------------
const batchUpdate = useLocalBatchUpdate({
  showToast,
  onComplete: () => refresh(),
});
const { isBatching, total: batchTotal, completed: batchCompleted, currentTitle, progressPercent, startBatchUpdate } = batchUpdate;

/** 可更新视图中用户勾选的 entryId 集合 */
const selectedForUpdate = ref<Set<string>>(new Set());

/** 当前可更新视图中实际显示的模组列表（用于全选） */
const updatableMods = computed(() => sorted.value.filter((m) => updateIds.value.has(m.id)));

const allSelected = computed(() => {
  const list = updatableMods.value;
  return list.length > 0 && list.every((m) => selectedForUpdate.value.has(m.id));
});

function toggleSelect(id: string): void {
  if (isBatching.value) return;
  const next = new Set(selectedForUpdate.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedForUpdate.value = next;
}

function toggleSelectAll(): void {
  if (isBatching.value) return;
  if (allSelected.value) {
    selectedForUpdate.value = new Set();
  } else {
    selectedForUpdate.value = new Set(updatableMods.value.map((m) => m.id));
  }
}

function runBatchUpdate(): void {
  const modsToUpdate = updatableMods.value.filter((m) => selectedForUpdate.value.has(m.id));
  if (modsToUpdate.length === 0) return;
  startBatchUpdate(modsToUpdate);
}

// 离开可更新视图时清空选中
watch(updatesOnly, (v) => {
  if (!v) selectedForUpdate.value = new Set();
});

// ---------------- 检测完成提示：有更新时显示跳转条 ----------------
const showUpdateBanner = ref(false);
watch(modUpdateReport, (r) => {
  if (r && r.updateCount > 0) {
    showUpdateBanner.value = true;
  }
});

function goToUpdates(): void {
  showUpdateBanner.value = false;
  if (!updatesOnly.value) pickUpdatesOnly();
}

/** 蓝奏云高速下载（与设置页·关于同链接） */
const LANZOU_URL = "https://wwblm.lanzouv.com/b01i5yfj5e";
async function openLanzouPage() {
  try {
    await openExternalUrl(LANZOU_URL);
  } catch (e) {
    showToast(normalizeBackendError(e), "error");
  }
}

// ---------------- 滚动位置记忆 ----------------
const { el: localScrollEl } = useScrollRestore();

function onLocalGridReady(payload: { scrollEl: HTMLElement | null; gridEl: HTMLElement | null }) {
  localScrollEl.value = payload.scrollEl;
  sort.gridEl.value = payload.gridEl;
}

// ---------------- 警告面板开关 ----------------
const showWarnings = ref(false);
function toggleWarnings() { showWarnings.value = !showWarnings.value; }

// ---------------- 重扫包装（排序模式保护） ----------------
async function refresh(root?: string | null): Promise<void> {
  if (sort.blocksRescan.value) {
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  sort.exitSortMode();
  await scan.refresh(root);
}

// ---------------- 第三方 ZIP 导入（实验性，仅 ZIP） ----------------
const importDialogOpen = ref(false);
const importZipPath = ref<string | null>(null);
const dragActive = ref(false);
let unlistenDragDrop: (() => void) | null = null;

async function handleImportClick() {
  const path = await pickModZip();
  if (!path) return;
  importZipPath.value = path;
  importDialogOpen.value = true;
}

function handleZipPath(p: string) {
  if (!p.toLowerCase().endsWith(".zip")) {
    showToast(t("import.dragNotZip"), "error");
    return;
  }
  importZipPath.value = p;
  importDialogOpen.value = true;
}

async function onImported() {
  const root = scan.report.value?.root;
  if (root) await refresh(root);
}

// ---------------- 本地译文预热（只读缓存，零网络） ----------------
function hydrateLocalTranslations(list: ModEntry[]): void {
  hydrateTranslations(
    list
      .filter((mod) => (mod.workshopId ?? 0) > 0)
      .map((mod) => ({
        modId: mod.workshopId as number,
        title: mod.displayName,
        description: "",
      })),
  );
}

watch(
  [mods, translationLangEpoch],
  ([list]) => { hydrateLocalTranslations(list as ModEntry[]); },
  { immediate: true },
);

// ---------------- 初始化：modRoot 到达后开始扫描 ----------------
let rootChecked = false;
watch(
  () => props.modRoot,
  async (root) => {
    // App.vue onMounted getSettings 前 modRoot 是 undefined，等它确定后再开始
    if (root === undefined) return;
    if (rootChecked) return;
    rootChecked = true;
    await scan.loadCandidates();
    if (root) {
      await refresh(root);
      if (!scan.report.value || !scan.report.value.rootExists) scan.showWizard.value = true;
    } else {
      scan.showWizard.value = true;
    }
  },
  { immediate: true },
);

// ---------------- Ctrl+S 快捷键 ----------------
onMounted(async () => {
  // Tauri 2 原生拖拽通道（非 Tauri 环境静默降级）
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const { payload } = event;
      if (payload.type === "enter" || payload.type === "over") {
        dragActive.value = !sortMode.value;
      } else if (payload.type === "leave") {
        dragActive.value = false;
      } else if (payload.type === "drop") {
        dragActive.value = false;
        if (sortMode.value) return;
        if (!payload.paths.length) return;
        if (payload.paths.length > 1) {
          showToast(t("import.dragMultiple"), "error");
          return;
        }
        handleZipPath(payload.paths[0]);
      }
    });
  } catch {
    /* 非 Tauri 环境静默降级 */
  }
  // 排序模式 Ctrl+S 保存
  window.addEventListener("keydown", onSortHotkey);
  // 启动时检查新版本（只此一次）
  void runStartupUpdateCheck();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSortHotkey);
  unlistenDragDrop?.();
});

// ---------------- 弹窗辅助 ----------------
function closeWizard() { scan.showWizard.value = false; }
function closePresets() { presets.showPresets.value = false; }
function cancelDiscardSort() { sort.showDiscardConfirm.value = false; }

// ---------------- Expose 给 App.vue（rootbar / ModToolbar 绑定） ----------------
defineExpose({
  sortMode,
  sortBlocksRescan: blocksRescan,
  exitSortMode,
  refresh: () => refresh(),
  rescan: () => refresh(),
  reportRoot: computed(() => report.value?.root ?? ""),
  sourceCounts,
  statusCounts,
  sortedCount: computed(() => sorted.value.length),
  modsCount: computed(() => mods.value.length),
  lastScanText,
  warnings,
  loading,
  hasReport: computed(() => !!report.value),
  toggleWarnings,
  /** 外部（设置 → 通用「更换根目录」）换根后，把后端返回的完整扫描结果直接接管 */
  applyReport: scan.handleWizardDone,
});
</script>

<template>
  <PageShell :sidebar-class="sortMode ? 'sort-locked' : ''">
    <!-- 左：来源 / 收藏 / 分类 / 状态筛选 -->
    <template #sidebar>
      <LocalSidebar
        :sort-mode="sortMode"
        :source="source"
        :status="status"
        :favorites-only="favoritesOnly"
        :updates-only="updatesOnly"
        :updates-available-count="updatesAvailableCount"
        :active-tag="activeTag"
        :official-tag-list="officialTagList"
        :inferred-tag-list="inferredTagList"
        :source-counts="sourceCounts"
        :status-counts="statusCounts"
        :favorite-local-count="favoriteLocalCount"
        @pick-source="pickSource"
        @pick-status="pickStatus"
        @pick-tag="pickTag"
        @toggle-favorites="toggleFavorites"
        @pick-updates-only="pickUpdatesOnly"
      />
    </template>

    <!-- 中：内容区 -->
    <template #content>
      <!-- 拖拽 ZIP 覆盖层 -->
      <div v-if="dragActive" class="drag-overlay">
        <p>{{ t("import.dragPrompt") }}</p>
      </div>

      <!-- 警告面板 -->
      <div v-if="showWarnings && warnings.length" class="warn-panel">
        <strong>{{ t("state.warningsTitle") }}</strong>
        <ul class="warn-list">
          <li v-for="w in warnings" :key="w">{{ w }}</li>
        </ul>
      </div>

      <!-- 检测完成：有更新时显示跳转条 -->
      <div v-if="showUpdateBanner && modUpdateReport && modUpdateReport.updateCount > 0" class="update-banner">
        <button type="button" class="update-banner-btn" @click="goToUpdates">
          {{ t("updates.foundBanner", { n: modUpdateReport.updateCount }) }}
        </button>
        <button type="button" class="update-banner-x" @click="showUpdateBanner = false">✕</button>
      </div>

      <!-- 本地页顶部操作区 -->
      <div class="batch-bar">
        <div class="batch-bar-row">
          <h2>{{ heading }}</h2>
          <div class="batch-actions">
            <button type="button" class="batch-btn preset-entry" @click="showPresets = true">
              {{ t("toolbar.presets") }}
            </button>
            <button
              type="button"
              class="batch-btn batch-enable"
              :disabled="loading || !report || !sorted.length || batchBusy"
              :title="t('toolbar.enableAllTitle')"
              @click="askBatchEnable"
            >
              {{ batchBusy ? t("batch.working") : t("toolbar.enableAll") }}
            </button>
            <button
              type="button"
              class="batch-btn batch-disable"
              :disabled="loading || !report || !sorted.length || batchBusy"
              :title="t('toolbar.disableAllTitle')"
              @click="askBatchDisable"
            >
              {{ batchBusy ? t("batch.working") : t("toolbar.disableAll") }}
            </button>
            <button
              type="button"
              class="batch-btn sort-toggle"
              :class="{ active: sortMode }"
              :disabled="loading || !report || !mods.length || sortSaving"
              :title="sortMode ? t('sort.saveTitle') : t('sort.enterTitle')"
              @click="sortMode ? saveAndExitSortMode() : enterSortMode()"
            >
              {{ sortMode ? (sortSaving ? t("sort.saving") : t("sort.save")) : t("sort.enter") }}
            </button>
            <button
              v-if="source === 'imported'"
              type="button"
              class="batch-btn import-entry"
              :disabled="loading"
              :title="t('import.buttonTitle')"
              @click="handleImportClick"
            >
              <span>{{ t("import.button") }}</span>
              <span class="import-experimental">{{ t("import.experimentalBadge") }}</span>
            </button>
          </div>
        </div>
        <span
          v-if="source === 'local'"
          class="local-dir-note"
          :title="t('content.localDirNote')"
        >{{ t("content.localDirNote") }}</span>
      </div>

      <!-- 待更新视图：批量更新操作栏（仅在有确认可更新模组时显示） -->
      <div v-if="updatesOnly && !loading && updatableMods.length > 0" class="batch-update-bar">
        <label class="batch-update-select-all">
          <input
            type="checkbox"
            :checked="allSelected"
            :disabled="isBatching"
            @change="toggleSelectAll"
          />
          {{ t("updates.selectAll") }}
        </label>
        <span class="batch-update-count">
          {{ t("updates.selectedCount", { n: selectedForUpdate.size, total: updatableMods.length }) }}
        </span>
        <button
          type="button"
          class="batch-btn batch-update-btn"
          :disabled="selectedForUpdate.size === 0 || isBatching"
          @click="runBatchUpdate"
        >
          {{ isBatching ? t("updates.inProgress", { done: batchCompleted, total: batchTotal }) : t("updates.updateSelected") }}
        </button>
        <span v-if="isBatching && currentTitle" class="batch-update-current">
          {{ currentTitle }}
        </span>
        <div v-if="isBatching" class="batch-update-progress">
          <div class="batch-update-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>

      <!-- 待更新视图空态 -->
      <div v-if="updatesOnly && !loading && updatableMods.length === 0 && !checkProgress" class="state-panel">
        <h2>{{ t("updates.emptyTitle") }}</h2>
        <p>{{ t("updates.emptyBody") }}</p>
        <div class="actions">
          <button type="button" @click="pickUpdatesOnly">{{ t("updates.exit") }}</button>
        </div>
      </div>

      <!-- 排序模式说明栏 -->
      <div v-if="sortMode && !loading && report && report.rootExists && mods.length" class="sort-wrap">
        <div class="sort-banner">
          <span class="glyph">⇅</span>
          <span>{{ t("sort.banner", { n: dragList.length }) }}</span>
          <span v-if="sortDirty" class="sort-state dirty">{{ t("sort.dirty") }}</span>
          <span v-else class="sort-state">{{ t("sort.clean") }}</span>
        </div>
        <p class="sort-hint">
          <span>{{ t("sort.enabledOnly") }}</span>
          <span v-if="excludedSortCount" class="sort-hint-count">
            {{ t("sort.hiddenCount", { n: excludedSortCount }) }}
          </span>
        </p>
      </div>

      <!-- 卡片网格 -->
      <ModGrid
        :view-mode="viewMode"
        :card-size="cardSize"
        :grid-class="sortMode ? 'sort-grid' : ''"
        @ready="onLocalGridReady"
      >
        <!-- 扫描中 -->
        <div v-if="loading" class="state-panel">
          <h2><span class="spinner"></span>{{ t("state.scanningTitle") }}</h2>
          <p>{{ t("state.scanningBody") }}</p>
        </div>

        <!-- 扫描失败 -->
        <div v-else-if="error" class="state-panel">
          <h2>{{ t("state.scanFailedTitle") }}</h2>
          <p>{{ error }}</p>
          <div class="actions">
            <button type="button" @click="chooseRoot">{{ t("state.chooseOther") }}</button>
            <button type="button" :disabled="!report" @click="refresh()">{{ t("state.retry") }}</button>
          </div>
        </div>

        <!-- 未选择根目录 -->
        <div v-else-if="!report" class="state-panel">
          <h2>{{ t("state.pickRootTitle") }}</h2>
          <p>{{ t("state.pickRootBody") }}</p>
          <button
            v-for="candidate in candidates"
            :key="candidate"
            type="button"
            class="candidate"
            @click="refresh(candidate)"
          >
            {{ t("state.useDetected", { path: candidate }) }}
          </button>
          <p v-if="!candidates.length" class="note">{{ t("state.noneDetected") }}</p>
          <div class="actions">
            <button type="button" :disabled="choosingRoot" @click="chooseRoot">
              {{ t("state.chooseManually") }}
            </button>
          </div>
        </div>

        <!-- 根目录不存在 -->
        <div v-else-if="!report.rootExists" class="state-panel">
          <h2>{{ t("state.rootMissingTitle") }}</h2>
          <p>{{ t("state.rootMissingBody", { path: report.root }) }}</p>
          <div class="actions">
            <button type="button" @click="chooseRoot">{{ t("state.chooseAgain") }}</button>
          </div>
        </div>

        <!-- 无模组 -->
        <div v-else-if="!mods.length" class="state-panel">
          <h2>{{ t("state.noModsTitle") }}</h2>
          <p>{{ t("state.noModsBody", { local: report.localDir, subscribed: report.subscribedDir }) }}</p>
          <ul class="warn-list">
            <li v-for="w in warnings" :key="w">{{ w }}</li>
          </ul>
          <div class="actions">
            <button type="button" @click="refresh()">{{ t("state.rescan") }}</button>
            <button type="button" @click="chooseRoot">{{ t("state.switchRoot") }}</button>
          </div>
        </div>

        <!-- 收藏视图空态 -->
        <div v-else-if="!sorted.length && favoritesOnly" class="state-panel">
          <h2>⭐ {{ t("favorites.empty") }}</h2>
          <p>
            {{
              favoriteLocalCount && filtersSearch
                ? t("favorites.emptyLocalHint", { n: favoriteLocalCount })
                : t("favorites.emptyNone")
            }}
          </p>
          <div class="actions">
            <button v-if="filtersSearch" type="button" @click="filtersSearch = ''">
              {{ t("search.clear") }}
            </button>
            <button type="button" @click="toggleFavorites">{{ t("favorites.exit") }}</button>
          </div>
        </div>

        <!-- 筛选后空态 -->
        <div v-else-if="!sorted.length" class="state-panel">
          <h2>{{ t("state.filteredTitle") }}</h2>
          <p>{{ t("state.filteredBody", { total: mods.length }) }}</p>
          <div class="actions">
            <button type="button" @click="clearFilters">
              {{ t("state.clearFilters") }}
            </button>
          </div>
        </div>

        <!-- 卡片 -->
        <template #cards>
          <ModCard
            v-for="(mod, index) in sortMode ? dragList : sorted"
            :key="mod.id"
            :mod="mod"
            :active="mod.id === selectedEntryId"
            :order="sortMode ? index + 1 : undefined"
            :has-update="updateIds.has(mod.id)"
            :conflict="conflicts.bySubscribedId.has(mod.id)"
            :sortable="sortMode"
            :selectable="updatesOnly"
            :selected="selectedForUpdate.has(mod.id)"
            :updating="updatingEntryId === mod.id"
            @select="selectMod"
            @toggled="handleCardToggled"
            @toggle-error="handleCardToggleError"
            @request-enable="requestEnableDataMod"
            @check="(payload) => toggleSelect(payload.id)"
            @update="handleUpdateMod"
            @context-menu="onCardContextMenu"
          />
        </template>
      </ModGrid>
    </template>

    <!-- 右：详情面板 -->
    <template #detail>
      <ModDetail
        v-if="detailMod"
        :mod="detailMod"
        :stats="stats"
        :stats-loading="statsLoading"
        :stats-error="statsError"
        :update-info="itemsById.get(detailMod.id) ?? null"
        :updating="updatingEntryId === detailMod.id"
        :conflict-hint="conflictHintOf(detailMod.id)"
        @toggled="handleToggle"
        @removed="handleRemoved"
        @download="downloadSelected"
        @update="handleUpdateMod(detailMod)"
        @request-enable="requestEnableDataMod"
        @cover-updated="handleCoverUpdated"
      />
      <div v-else class="detail-empty">
        {{ t("state.detailEmpty") }}<br />
        <span class="note">{{ t("state.detailEmptyNote") }}</span>
      </div>
    </template>
  </PageShell>

  <!-- ========== 本地相关浮层（fixed 定位，不参与三栏布局） ========== -->

  <!-- 首次启动向导 -->
  <FirstRunWizard
    v-if="showWizard"
    @done="scan.handleWizardDone"
    @close="closeWizard"
  />

  <!-- 预设管理器 -->
  <PresetManager
    v-if="showPresets"
    :mods="mods"
    :applied-id="lastAppliedPresetId"
    @close="closePresets"
    @applied="handlePresetApplied"
  />

  <!-- 第三方 ZIP 导入弹窗（实验性） -->
  <ImportDialog
    v-model="importDialogOpen"
    :zip-path="importZipPath"
    @installed="onImported"
  />

  <!-- 批量启用/禁用确认 -->
  <ConfirmDialog
    v-if="batchAsk !== null"
    :title="batchAsk ? t('batch.confirmTitleEnable') : t('batch.confirmTitleDisable')"
    :message="batchConfirmMessage"
    :confirm-label="batchAsk ? t('batch.confirmEnable') : t('batch.confirmDisable')"
    :danger="!batchAsk"
    :busy="batchBusy"
    :error="batchError"
    @confirm="runBatchToggleGuarded"
    @cancel="cancelBatchGuarded"
  />

  <!-- 数据模组互斥确认 -->
  <ConfirmDialog
    v-if="dataModConflict"
    :title="t('dataMod.conflictTitle')"
    :message="
      t('dataMod.conflictMessage', {
        old: dataModConflict.oldMod.displayName,
        new: dataModConflict.newMod.displayName,
      })
    "
    :confirm-label="t('dataMod.conflictConfirm')"
    :danger="false"
    :busy="dataModBusy"
    :error="dataModError"
    @confirm="confirmDataModSwitch"
    @cancel="cancelDataModSwitch"
  />

  <!-- 放弃未保存排序确认 -->
  <ConfirmDialog
    v-if="showDiscardConfirm"
    :title="t('sort.discardTitle')"
    :message="t('sort.discardMessage')"
    :confirm-label="t('sort.discardConfirm')"
    @confirm="discardSortChanges"
    @cancel="cancelDiscardSort"
  />

  <!-- 卡片右键：备注名弹窗（作用于快照 Mod，与详情面板弹窗互不影响） -->
  <RenameDialog
    v-if="renameTarget"
    :original="renameTarget.displayName"
    :initial="customNameOf(renameTarget.workshopId)"
    :busy="renameBusy"
    :error="renameError ? translateBackendMessage(renameError) : null"
    @save="applyMenuRename"
    @cancel="closeMenuRename"
  />

  <!-- 卡片右键：卸载二次确认（危险操作，确认后才删目录） -->
  <ConfirmDialog
    v-if="deleteTarget"
    :title="t('detail.confirmTitle')"
    :message="deleteConfirmMessage"
    :detail="deleteTarget.path"
    :confirm-label="t('detail.deleteConfirmLabel')"
    :busy="deleting"
    :error="deleteError ? translateBackendMessage(deleteError) : null"
    @confirm="confirmMenuDelete"
    @cancel="cancelMenuDelete"
  />

  <!-- 轻量提示 -->
  <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>

  <!-- 卡片右键上下文菜单（fixed 浮层；关闭逻辑由共享组件统一处理） -->
  <ContextMenu
    v-if="menuOpen"
    :x="menuX"
    :y="menuY"
    :items="localMenuItems"
    @select="onMenuSelect"
    @close="cardMenu.close"
  />

  <!-- 版本更新提示（右下角常驻） -->
  <div v-if="updateNotice" class="app-toast update-toast">
    <div class="update-toast-main">
      <button type="button" class="update-toast-body" @click="openUpdatePage">
        🎉 {{ t("update.available", { version: updateNotice.version }) }}
      </button>
      <div class="update-toast-actions">
        <button type="button" class="update-toast-lanzou" @click="openLanzouPage">
          {{ t("update.lanzou") }}
        </button>
        <span class="update-toast-hint">{{ t("update.lanzouHint") }}</span>
      </div>
    </div>
    <button
      type="button"
      class="update-toast-x"
      :title="t('update.dismiss')"
      :aria-label="t('update.dismiss')"
      @click="dismissUpdateNotice()"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
/* 批量操作按钮（覆盖全局 .batch-actions 的视觉变体） */
.batch-actions .batch-btn {
  padding: 4px 9px;
  font-size: calc(11px * var(--global-scale));
  line-height: 1.45;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}
.batch-actions .batch-btn.preset-entry {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-hover));
  letter-spacing: calc(1px * var(--ui-tracking));
}
.batch-actions .batch-btn.batch-enable {
  color: var(--ok-text-strong);
  border-color: rgba(var(--ok-rgb), 0.5);
  background: linear-gradient(180deg, var(--ok-surface-top), var(--ok-surface-bottom));
  letter-spacing: calc(1px * var(--ui-tracking));
}
.batch-actions .batch-btn.batch-enable:hover:not(:disabled) {
  color: var(--ok-text-strong);
  border-color: rgba(var(--ok-rgb), 0.85);
  background: linear-gradient(180deg, var(--ok-surface-top), var(--ok-surface-bottom));
}
.batch-actions .batch-btn.batch-disable {
  color: var(--danger-text);
  border-color: rgba(var(--danger-rgb), 0.5);
  background: linear-gradient(180deg, var(--danger-surface-top), var(--danger-surface-bottom));
  letter-spacing: calc(1px * var(--ui-tracking));
}
.batch-actions .batch-btn.batch-disable:hover:not(:disabled) {
  color: var(--danger-text-strong);
  border-color: rgba(var(--danger-rgb), 0.85);
  background: linear-gradient(180deg, var(--danger-surface-top), var(--danger-surface-bottom));
}
.batch-actions .batch-btn.sort-toggle.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
}

/* v0.7：检测完成后有更新的跳转提示条 */
.update-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(var(--danger-rgb), 0.5);
  background: linear-gradient(180deg, var(--danger-surface-top), var(--danger-surface-bottom));
}
.update-banner-btn {
  flex: 1;
  text-align: left;
  background: none;
  border: none;
  color: var(--danger-text-strong);
  font-size: calc(12px * var(--global-scale));
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.update-banner-btn:hover {
  text-decoration: underline;
}
.update-banner-x {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

/* v0.7：可更新视图批量操作栏 */
.batch-update-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--gold-dim);
  background: rgba(var(--accent-rgb), 0.08);
  flex-wrap: wrap;
}
.update-check-area {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.update-check-btn {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-hover));
  white-space: nowrap;
}
.update-check-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
}
.update-check-progress span {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
}
.batch-update-select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch);
  cursor: pointer;
}
.batch-update-select-all input {
  accent-color: var(--gold-bright);
}
.batch-update-count {
  font-size: calc(11.5px * var(--global-scale));
  color: var(--muted);
}
.batch-update-btn {
  padding: 4px 12px;
  font-size: calc(11.5px * var(--global-scale));
  border-radius: 4px;
  color: var(--danger-text-strong);
  border-color: rgba(var(--danger-rgb), 0.5);
  background: linear-gradient(180deg, var(--danger-surface-top), var(--danger-surface-bottom));
  cursor: pointer;
  white-space: nowrap;
}
.batch-update-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}
.batch-update-current {
  font-size: calc(11px * var(--global-scale));
  color: var(--gold-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.batch-update-progress {
  flex-basis: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--shadow-rgb), 0.3);
  overflow: hidden;
}
.batch-update-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold), var(--gold-bright));
  transition: width 0.3s ease;
}

/* 第三方 ZIP 导入按钮（实验性，信息蓝变体） */
.batch-actions .batch-btn.import-entry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--info-text);
  border-color: rgba(var(--info-rgb), 0.4);
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-hover));
  letter-spacing: calc(1px * var(--ui-tracking));
}
.batch-actions .batch-btn.import-entry:hover:not(:disabled) {
  border-color: rgba(var(--info-rgb), 0.8);
  background: rgba(var(--info-rgb), 0.1);
}
.import-experimental {
  font-size: calc(10px * var(--global-scale));
  opacity: 0.8;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 4px;
  line-height: 1.4;
}

/* Tauri 拖拽覆盖层：fixed 盖满窗口 */
.drag-overlay {
  position: fixed;
  inset: 0;
  background: rgba(var(--accent-rgb), 0.15);
  border: 2px dashed var(--accent-gold);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  pointer-events: none;
}
.drag-overlay p {
  font-size: 18px;
  color: var(--accent-gold);
  font-weight: 600;
}
</style>
