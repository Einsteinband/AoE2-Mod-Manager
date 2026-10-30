<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ModCard from "./components/ModCard.vue";
import ModDetail from "./components/ModDetail.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import FirstRunWizard from "./components/FirstRunWizard.vue";
import OnlineBrowser from "./components/OnlineBrowser.vue";
import PresetManager from "./components/PresetManager.vue";
import SettingsModal from "./components/SettingsModal.vue";
import StatusBar from "./components/StatusBar.vue";
import { useI18n } from "vue-i18n";
import {
  checkUpdate,
  detectRootCandidates,
  getSettings,
  modStats,
  openExternalUrl,
  pickFolder,
  scanMods,
  setLocale as persistLocale,
  setModRoot,
  updateModPriority,
} from "./api";
import { attachDragSort, type DragEndPayload } from "./dragSort";
import { formatDateTime, translateBackendMessage } from "./format";
import { applyLocale, detectSystemLocale, normalizeLocale } from "./i18n";
import { getTranslateSettings, installMod } from "./online/service";
import { itemsById, markUpdated, updateIds } from "./modUpdates";
import {
  applyTranslateSettings,
  hydrateTranslations,
  syncUiLocale,
  translationLangEpoch,
} from "./online/translation";
import { ensureSession, sessionPhase } from "./sessionState";
import { customNameOf, displayTitle, ensureUserData, isFavorite } from "./userData";
import { TAG_ZH, SORT_OPTIONS, localizedTagName } from "./online/types";
import type { ModEntry, ModStats, ScanReport, SortKey, SourceFilter, StatusFilter } from "./types";

/** 顶部模式：本地扫描 / 在线官方服务 */
const mode = ref<"local" | "online">("local");

/** 在线页的筛选状态提升到顶栏，保证两种模式的搜索/排序控件位置完全一致 */
const onlineQuery = ref("");
const onlineSort = ref(SORT_OPTIONS[0].value);
const onlineOrder = ref<"DESC" | "ASC">("DESC");
const onlineRef = ref<InstanceType<typeof OnlineBrowser> | null>(null);

const { t, locale } = useI18n();
/** 当前界面语言（语言切换本身已迁到 SettingsModal，这里只用于排序区域） */
const currentLocale = computed(() => String(locale.value));
/** 排序/比较用的区域：中文按拼音，其他语言直接用自己的语言代码 */
const collationLocale = computed(() =>
  currentLocale.value === "zh" ? "zh-Hans-CN" : currentLocale.value,
);

const report = ref<ScanReport | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref("");
const source = ref<SourceFilter>("all");
const status = ref<StatusFilter>("all");
/** v0.5：只看收藏（只过滤 isFavorite === true，按 WorkshopID 匹配） */
const favoritesOnly = ref(false);
const sortKey = ref<SortKey>("name");
const selectedId = ref<string | null>(null);
const candidates = ref<string[]>([]);

const stats = ref<ModStats | null>(null);
const statsLoading = ref(false);
const statsError = ref<string | null>(null);

const showWarnings = ref(false);
/** v0.3：预设管理器模态框 */
const showPresets = ref(false);
/** 最近一次成功应用的预设（脏检查靠它判断是否还能显示“当前已应用”） */
const lastAppliedPresetId = ref<string | null>(null);
/** 应用后重扫得到的「启用集合指纹」 */
const appliedFingerprint = ref("");
/** 应用流程正在进行：此期间的扫描结果不应被当成“用户手动改动” */
let presetApplying = false;
const choosingRoot = ref(false);
/** 首次启动引导：没有可用根目录时自动弹出 */
const showWizard = ref(false);
/** v0.4 独立设置弹窗（语言 / 网络 / 关于） */
const showSettings = ref(false);
/** 启动时检查到的版本更新提示（右下角常驻，可点击跳转、可手动关闭） */
const updateNotice = ref<{ version: string; url: string } | null>(null);
/** v0.4：正在覆盖安装的模组（ModEntry.id），用于禁用详情页按钮 */
const updatingEntryId = ref<string | null>(null);

const mods = computed<ModEntry[]>(() => report.value?.mods ?? []);
const warnings = computed<string[]>(() => report.value?.warnings ?? []);

/**
 * 本地列表变化 / 目标语言切换后，把已缓存的译文接回来（**只读缓存，零网络**）。
 * 重启软件后卡片仍显示译文（之前每次重启都退回原文）。
 */
function hydrateLocalTranslations(list: ModEntry[]): void {
  hydrateTranslations(
    list
      .filter((mod) => (mod.workshopId ?? 0) > 0)
      .map((mod) => ({
        modId: mod.workshopId as number,
        title: mod.displayName,
        // 卡片只需要标题：传空描述走 titleHash 匹配，
        // 旧缓存（没有 titleHash）也能按 modId 认下，不会因为升级丢译文
        description: "",
      })),
  );
}

watch(
  [mods, translationLangEpoch],
  ([list]) => {
    hydrateLocalTranslations(list);
  },
  { immediate: true },
);

const sourceCounts = computed(() => ({
  all: mods.value.length,
  local: mods.value.filter((m) => m.kind === "local").length,
  subscribed: mods.value.filter((m) => m.kind === "subscribed").length,
}));

const statusCounts = computed(() => {
  const counts = { enabled: 0, disabled: 0, unknown: 0 };
  for (const m of mods.value) {
    if (m.enabled === true) counts.enabled += 1;
    else if (m.enabled === false) counts.disabled += 1;
    else counts.unknown += 1;
  }
  return counts;
});

const filtered = computed<ModEntry[]>(() => {
  const q = search.value.trim().toLowerCase();
  /**
   * 收藏视图与「来源 / 状态 / 官方分类」互斥：
   * 两套条件叠加时侧栏计数（3 个收藏）与列表条数（48/1037）必然对不上，
   * 所以收藏视图下只按 isFavorite 过滤（外加搜索关键字）。
   */
  const fav = favoritesOnly.value;
  return mods.value.filter((m) => {
    if (fav && !isFavorite(m.workshopId)) return false;
    if (!fav) {
      if (source.value !== "all" && m.kind !== source.value) return false;
      if (status.value === "enabled" && m.enabled !== true) return false;
      if (status.value === "disabled" && m.enabled !== false) return false;
      if (status.value === "unknown" && m.enabled !== null) return false;
      if (activeTag.value && !m.contentTags.includes(activeTag.value)) return false;
    }
    if (!q) return true;
    const haystack = [
      displayTitle(m.workshopId, m.displayName),
      customNameOf(m.workshopId) ?? "",
      m.displayName,
      m.nameFromFolder,
      m.folderName,
      m.author ?? "",
      m.description ?? "",
      m.workshopId === null ? "" : String(m.workshopId),
    ];
    return haystack.some((v) => v.toLowerCase().includes(q));
  });
});

const sorted = computed<ModEntry[]>(() => {
  const list = [...filtered.value];
  const collator = new Intl.Collator(collationLocale.value, { numeric: true, sensitivity: "base" });
  list.sort((a, b) => {
    switch (sortKey.value) {
      case "updated": {
        const av = a.lastUpdateMs ?? -1;
        const bv = b.lastUpdateMs ?? -1;
        return bv - av;
      }
      case "priority": {
        const av = a.priority ?? Number.MAX_SAFE_INTEGER;
        const bv = b.priority ?? Number.MAX_SAFE_INTEGER;
        return av - bv;
      }
      case "folder":
        return collator.compare(a.folderName, b.folderName);
      case "name":
      default:
        return collator.compare(
          displayTitle(a.workshopId, a.displayName),
          displayTitle(b.workshopId, b.displayName),
        );
    }
  });
  return list;
});

const selected = computed<ModEntry | null>(
  () => mods.value.find((m) => m.id === selectedId.value) ?? null,
);

const lastScanText = computed(() =>
  report.value ? formatDateTime(report.value.scannedAtMs) : t("rootbar.neverScanned"),
);

const heading = computed(() => {
  if (favoritesOnly.value) return t("favorites.heading");
  if (source.value === "local") return t("content.localMods");
  if (source.value === "subscribed") return t("content.subscribedMods");
  return t("content.allMods");
});

/** v0.5：本地列表里的收藏数（侧栏计数） */
const favoriteLocalCount = computed(
  () => mods.value.filter((m) => isFavorite(m.workshopId)).length,
);

/** 内容区副标题右侧的状态文案 */
const statusText = computed(() => {
  if (status.value === "enabled") return t("content.statusEnabled");
  if (status.value === "disabled") return t("content.statusDisabled");
  if (status.value === "unknown") return t("content.statusUnknown");
  return t("content.statusAll");
});

/** 内容区副标题：收藏视图下明确说明「分类已让位」，避免用户以为分类还在生效 */
const contentHint = computed(() =>
  favoritesOnly.value
    ? t("favorites.scopeHint")
    : `${activeTagLabel.value} · ${statusText.value}`,
);

/**
 * 侧栏「⭐ 我的收藏」开关。
 * 进入收藏视图时把来源 / 状态 / 分类全部复位：只按收藏过滤，计数与列表条数才一致。
 */
function toggleFavorites() {
  favoritesOnly.value = !favoritesOnly.value;
  if (!favoritesOnly.value) return;
  source.value = "all";
  status.value = "all";
  activeTag.value = null;
}

/** 点来源 / 状态 / 分类：先退出收藏视图，否则条件叠加又会出现计数错位 */
function pickSource(next: SourceFilter) {
  favoritesOnly.value = false;
  source.value = next;
}

function pickStatus(next: StatusFilter) {
  favoritesOnly.value = false;
  status.value = next;
}

function pickTag(next: string | null) {
  favoritesOnly.value = false;
  activeTag.value = next;
}

function normalizeError(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return t("labels.unknown");
  }
}

async function refresh(root?: string | null) {
  // 重扫会重排整个列表，排序模式必须退出（否则拖拽索引会对不上）
  // 有未保存的排序改动时不允许静默丢弃
  if (sortMode.value && sortDirty.value) {
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  exitSortMode();
  loading.value = true;
  error.value = null;
  try {
    const next = await scanMods(root);
    report.value = next;
    if (!next.mods.some((m) => m.id === selectedId.value)) {
      selectedId.value = next.mods[0]?.id ?? null;
    }
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    loading.value = false;
  }
}

async function chooseRoot() {
  if (choosingRoot.value) return;
  choosingRoot.value = true;
  try {
    const picked = await pickFolder(report.value?.root ?? candidates.value[0] ?? null);
    if (!picked) return;
    loading.value = true;
    error.value = null;
    const next = await setModRoot(picked);
    report.value = next;
    selectedId.value = next.mods[0]?.id ?? null;
    if (!candidates.value.includes(picked)) candidates.value.unshift(picked);
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    choosingRoot.value = false;
    loading.value = false;
  }
}

function selectMod(mod: ModEntry) {
  // 拖拽松手时浏览器仍会补一个 click：这段时间内忽略，避免排序时误切换选中项
  if (Date.now() < suppressClickUntil) return;
  selectedId.value = mod.id;
}

/**
 * 启用/禁用后的局部刷新：只 patch 这一条记录的字段，不重扫、不重置筛选、不重算体积。
 * 后端已把真实写入结果回传，这里不做任何推测。
 */
function handleToggle(payload: { enabled: boolean }) {
  const id = selectedId.value;
  const list = report.value?.mods;
  if (!id || !list) return;
  const mod = list.find((m) => m.id === id);
  if (!mod) return;
  mod.enabled = payload.enabled;
  mod.issues = mod.issues.filter((issue) => !issue.startsWith("mod-status.json 中没有该模组的记录"));
}

/**
 * 删除后的局部移除：只把这一条从数组里摘掉，不重扫、不重置筛选。
 * 删的可能刚好是当前选中项，所以顺手把选中项回退到同位置上的一条。
 */
function handleRemoved(payload: { id: string }) {
  const list = report.value?.mods;
  if (!list) return;
  const index = list.findIndex((m) => m.id === payload.id);
  if (index < 0) return;
  const wasSelected = selectedId.value === payload.id;
  list.splice(index, 1);
  if (!wasSelected) return;
  const next = list[index] ?? list[index - 1] ?? null;
  selectedId.value = next?.id ?? null;
}

// ---------------- v0.2：手动拖拽排序（Priority） ----------------

/** 排序模式：只有开启时卡片才可拖拽，关闭时保持正常的点击选中 */
const sortMode = ref(false);
const sortSaving = ref(false);
/** 可拖拽的列表：与 report.mods 是同一批对象引用，改 Priority 无需重扫 */
const dragList = ref<ModEntry[]>([]);
/** 游戏尚未登记（priority 为 null）的模组，无法参与排序，单独列在下方 */
const unsortable = ref<ModEntry[]>([]);
/** 最近一次成功写入磁盘的顺序（判断“有没有未保存改动”，失败时也按它回滚） */
const savedOrder = ref<string[]>([]);
/** 有未保存改动时退出排序模式的二次确认 */
const showDiscardConfirm = ref(false);
/** 进入排序模式前的筛选快照，退出时还原 */
let sortSnapshot: {
  search: string;
  source: SourceFilter;
  status: StatusFilter;
  activeTag: string | null;
  sortKey: SortKey;
  favoritesOnly: boolean;
} | null = null;
/** 本次排序是否真的改过顺序（决定退出后是否停在“按加载优先级”） */
let orderChanged = false;
/** 拖拽结束后短时间内屏蔽 click，避免松手时把卡片误选中 */
let suppressClickUntil = 0;

const dragEl = ref<HTMLElement | null>(null);
let disposeDrag: (() => void) | null = null;

/** 右下角 Toast（排序已保存等轻量提示） */
const toast = ref<{ text: string; kind: "ok" | "error" } | null>(null);
let toastTimer: number | null = null;
function showToast(text: string, kind: "ok" | "error" = "ok") {
  toast.value = { text, kind };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
    toastTimer = null;
  }, kind === "error" ? 7000 : 3200);
}

/** 作者 GitHub 主页：交给 Rust 用系统浏览器打开，绝不在 WebView 里导航 */
const AUTHOR_URL = "https://github.com/Einsteinband";

async function openAuthorPage() {
  try {
    await openExternalUrl(AUTHOR_URL);
  } catch (e) {
    showToast(normalizeError(e), "error");
  }
}

/**
 * v0.4：把本地模组覆盖安装到服务端最新版。
 * 直接复用现有的 online_install 管线（下载 → 解压 → 原子更换 → 写 mod-status.json）；
 * force=true 表示目标目录已存在时也允许覆盖（旧目录会先备份，不直接删）。
 * 分类 Tag 不回传，由 Rust 从 mod_metadata.json 里沿用上次安装记录。
 */
async function handleUpdateMod(mod: ModEntry) {
  const modId = mod.workshopId ?? 0;
  if (modId <= 0 || updatingEntryId.value) return;
  // v0.6：离线状态下必须拦截下载（本地收藏/备注仍然可用）
  if (sessionPhase.value !== "online") {
    showToast(t("online.offlineBlocked"), "error");
    return;
  }
  if (sortMode.value && sortDirty.value) {
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  updatingEntryId.value = mod.id;
  try {
    await installMod(modId, mod.displayName, true);
    markUpdated(mod.id);
    showToast(t("update.modDoneToast"));
    await refresh();
  } catch (e) {
    showToast(normalizeError(e), "error");
  } finally {
    updatingEntryId.value = null;
  }
}

/**
 * 启动时只跑一次版本检查（不轮询、不重试）。
 * 失败静默：没网 / GitHub 限流不应该在界面上刷错误，用户仍可到设置里手动点“检查更新”。
 */
async function runStartupUpdateCheck() {
  try {
    const info = await checkUpdate();
    if (!info.hasUpdate) return;
    updateNotice.value = { version: info.latestVersion, url: info.releaseUrl };
  } catch {
    /* 静默失败 */
  }
}

/** 点击右下角提示：拉系统浏览器到 Release 页面（不在 WebView 里跳转） */
async function openUpdatePage() {
  const url = updateNotice.value?.url;
  if (!url) return;
  try {
    await openExternalUrl(url);
    updateNotice.value = null;
  } catch (e) {
    showToast(normalizeError(e), "error");
  }
}

function compareByPriority(a: ModEntry, b: ModEntry): number {
  const collator = new Intl.Collator(collationLocale.value, { numeric: true, sensitivity: "base" });
  const av = a.priority ?? Number.MAX_SAFE_INTEGER;
  const bv = b.priority ?? Number.MAX_SAFE_INTEGER;
  return av === bv
    ? collator.compare(
        displayTitle(a.workshopId, a.displayName),
        displayTitle(b.workshopId, b.displayName),
      )
    : av - bv;
}

/**
 * 进入排序模式。
 * 关键决策：手动排序只对**全量列表**有意义——过滤后的子集一旦拖拽，
 * 拖出来的相对顺序会和全局顺序冲突（且无法推断插到哪个槽位），
 * 所以进入时清空搜索/筛选并把左侧栏置灰锁定，列表固定按 Priority 升序。
 */
async function enterSortMode() {
  if (loading.value || sortSaving.value || !report.value || !mods.value.length) return;
  sortSnapshot = {
    search: search.value,
    source: source.value,
    status: status.value,
    activeTag: activeTag.value,
    sortKey: sortKey.value,
    favoritesOnly: favoritesOnly.value,
  };
  search.value = "";
  source.value = "all";
  status.value = "all";
  activeTag.value = null;
  favoritesOnly.value = false;
  sortKey.value = "priority";

  const byPriority = [...mods.value].sort(compareByPriority);
  dragList.value = byPriority.filter((m) => m.priority !== null);
  unsortable.value = byPriority.filter((m) => m.priority === null);
  savedOrder.value = dragList.value.map((m) => m.id);
  orderChanged = false;
  sortMode.value = true;
  // 必须等 DOM 真正渲染出 .sort-grid 再挂载（否则 dragEl 还是 null）
  await mountDragSortable();
}

function exitSortMode() {
  if (!sortMode.value) return;
  sortMode.value = false;
  showDiscardConfirm.value = false;
  unmountDragSortable();
  const snapshot = sortSnapshot;
  sortSnapshot = null;
  if (!snapshot) return;
  // 筛选还原；但本次真的排过序就停在“按加载优先级”，否则拖完看不到结果
  search.value = snapshot.search;
  source.value = snapshot.source;
  status.value = snapshot.status;
  activeTag.value = snapshot.activeTag;
  favoritesOnly.value = snapshot.favoritesOnly;
  sortKey.value = orderChanged ? "priority" : snapshot.sortKey;
}

function handleDragEnd({ oldIndex, newIndex }: DragEndPayload) {
  const list = dragList.value;
  if (oldIndex < 0 || oldIndex >= list.length) return;
  const [moved] = list.splice(oldIndex, 1);
  if (!moved) return;
  list.splice(Math.min(newIndex, list.length), 0, moved);
  suppressClickUntil = Date.now() + 150;
  // 只改内存顺序，不写盘：等用户点“保存排序”才调 update_mod_priority
}

/** 有未保存的改动？只比顺序，不比内容 */
const sortDirty = computed(() => {
  const ids = dragList.value.map((m) => m.id);
  return (
    ids.length !== savedOrder.value.length || ids.some((id, i) => id !== savedOrder.value[i])
  );
});

/**
 * 手动保存：只有点“保存排序”（或排序模式下按 Ctrl+S）才写盘。
 * 成功后**只**改内存里的 Priority（同一批对象引用），绝不重扫：不闪、滚动条不复位。
 */
async function saveSortOrder() {
  if (sortSaving.value || !sortMode.value || !sortDirty.value) return;
  const list = [...dragList.value];
  const ids = list.map((m) => m.id);

  sortSaving.value = true;
  try {
    const outcome = await updateModPriority(ids);
    list.forEach((mod, index) => {
      mod.priority = index + 1;
    });
    savedOrder.value = ids;
    orderChanged = true;
    showToast(t("sort.savedToast", { n: outcome.updated }));
  } catch (e) {
    // 磁盘没写成功 → 界面顺序回到上一次成功保存的样子
    const byId = new Map(dragList.value.map((m) => [m.id, m]));
    dragList.value = savedOrder.value
      .map((id) => byId.get(id))
      .filter((m): m is ModEntry => Boolean(m));
    showToast(normalizeError(e), "error");
  } finally {
    sortSaving.value = false;
  }
}

/** 退出排序模式：有未保存改动时先二次确认 */
function requestExitSortMode() {
  if (!sortMode.value || sortSaving.value) return;
  if (sortDirty.value) {
    showDiscardConfirm.value = true;
    return;
  }
  exitSortMode();
}

/** 放弃更改：内存里的 Priority 本来就没动，直接退出，列表自然回到磁盘顺序 */
function discardSortChanges() {
  showDiscardConfirm.value = false;
  exitSortMode();
}

/** 启用集合指纹：只取 id，排序后拼串。任何开关 / 增删都会改变它 */
function enabledFingerprint(list: ModEntry[]): string {
  return list
    .filter((m) => m.enabled === true)
    .map((m) => m.id)
    .sort()
    .join("|");
}

/** 应用预设后：重扫 → 用重扫结果记下指纹 → 标记“当前已应用” */
async function handlePresetApplied(presetId: string) {
  presetApplying = true;
  try {
    await refresh();
    appliedFingerprint.value = enabledFingerprint(mods.value);
    lastAppliedPresetId.value = presetId;
  } finally {
    presetApplying = false;
  }
}

/**
 * 脏检查：指纹一变就解除所有预设按钮的置灰。
 * 覆盖三条来源：软件内开关（handleToggle 局部 patch，无需重扫）、
 * 游戏里改完再点“重新扫描”、以及安装/删除模组。
 */
watch(
  () => enabledFingerprint(mods.value),
  (next) => {
    if (presetApplying || !lastAppliedPresetId.value) return;
    if (next === appliedFingerprint.value) return;
    lastAppliedPresetId.value = null;
    appliedFingerprint.value = "";
  },
);

watch(selectedId, async (id) => {
  stats.value = null;
  statsError.value = null;
  if (!id) return;
  const mod = mods.value.find((m) => m.id === id);
  if (!mod) return;
  statsLoading.value = true;
  try {
    stats.value = await modStats(mod.path);
  } catch (e) {
    statsError.value = normalizeError(e);
  } finally {
    statsLoading.value = false;
  }
});

/** 本地列表的滚动位置：mode 切换时 .grid-scroll 被 v-if 销毁重建，故靠 ref 变化钩子静默还原 */
const localScrollEl = ref<HTMLElement | null>(null);
let localScrollTop = 0;
let localScrollBound: HTMLElement | null = null;

function rememberLocalScroll() {
  const el = localScrollEl.value;
  if (!el) return;
  // 只有真有滚动高度时才记录，避免元素脱离文档后被归零的值覆盖掉
  if (el.scrollHeight > el.clientHeight) localScrollTop = el.scrollTop;
}

watch(
  localScrollEl,
  (el) => {
    if (localScrollBound) {
      localScrollBound.removeEventListener("scroll", rememberLocalScroll);
      localScrollBound = null;
    }
    if (!el) return;
    el.addEventListener("scroll", rememberLocalScroll, { passive: true });
    localScrollBound = el;

    const target = localScrollTop;
    if (target <= 0) return;
    void nextTick(() => {
      el.scrollTop = target;
      // 缩略图 / 字体回流会让高度暂时不足导致 scrollTop 被截断，下一帧再补一次
      if (el.scrollTop < target) {
        requestAnimationFrame(() => {
          if (el.scrollTop < target) el.scrollTop = target;
        });
      }
    });
  },
  { flush: "post" },
);

onMounted(async () => {
  // v0.6：启动即静默校验登录态——不 await、不阻塞首屏，
  // 底栏自己从 🟡 变成 🟢/⚪；在线页通过 watch(sessionEpoch) 收到刷新信号
  void ensureSession();
  // v0.5：收藏/备注只读一次磁盘，失败不阻塞本地页
  void ensureUserData().catch(() => undefined);
  // 启动即检查一次新版本（只此一次，失败静默）
  void runStartupUpdateCheck();
  try {
    candidates.value = (await detectRootCandidates()).map((c) => c.path);
    const settings = await getSettings();
    // 语言：已保存的优先，否则按系统语言决定（并把结果回写，以后不再依赖 navigator）
    const savedLocale = normalizeLocale(settings.locale);
    applyLocale(savedLocale ?? detectSystemLocale());
    if (!savedLocale) {
      void persistLocale(locale.value).catch(() => undefined);
    }
    // 翻译目标语言：空串 = 跟随界面语言（此时取刚应用完的 UI 语言）
    try {
      const translateView = await getTranslateSettings();
      applyTranslateSettings(translateView, String(locale.value));
    } catch (e) {
      console.warn("[translation] 读取翻译设置失败", e);
    }
    if (settings.modRoot) {
      await refresh(settings.modRoot);
      // 记录的路径被移动 / 磁盘未连接时，直接回到引导而不是只留一个错误面板
      if (!report.value || !report.value.rootExists) showWizard.value = true;
    } else {
      showWizard.value = true;
    }
  } catch (e) {
    error.value = normalizeError(e);
    showWizard.value = true;
  }
});

/**
 * UI 语言变化 → 「跟随界面语言」模式下，翻译目标语言立即联动，
 * 列表与详情会因 langEpoch 自增而重新只读预热（无需重启、不发网络）。
 */
watch(locale, (next) => {
  syncUiLocale(String(next));
});

/** 引导完成：后端已写入 settings.json 并吐回完整扫描结果 */
function handleWizardDone(next: ScanReport) {
  report.value = next;
  selectedId.value = next.mods[0]?.id ?? null;
  error.value = null;
  showWizard.value = false;
  if (next.root && !candidates.value.includes(next.root)) candidates.value.unshift(next.root);
}
/** 官方 17 项分类的固定顺序（直接复用在线页的 TAG_ZH，保证两侧排列一致） */
const TAG_ORDER: Record<string, number> = Object.fromEntries(
  Object.values(TAG_ZH).map((name, index) => [name, index]),
);

interface TagOption {
  name: string;
  count: number;
}

/** 左侧选中的官方/推断标签；null = 全部内容 */
const activeTag = ref<string | null>(null);

/**
 * 标签索引：官方与推断同名标签合并计数，
 * 保证“侧栏显示的数量”与“点击后的结果数量”一致。
 */
const tagIndex = computed(() => {
  const map = new Map<string, { count: number; official: boolean }>();
  for (const mod of mods.value) {
    const isOfficial = mod.categorySource === "official";
    for (const tag of mod.contentTags) {
      const current = map.get(tag) ?? { count: 0, official: false };
      current.count += 1;
      if (isOfficial) current.official = true;
      map.set(tag, current);
    }
  }
  return map;
});

/** 官方分类：只来自 mod_metadata.json 记录过的模组，按官方字典顺序排 */
const officialTagList = computed<TagOption[]>(() =>
  [...tagIndex.value.entries()]
    .filter(([, value]) => value.official)
    .map(([name, value]) => ({ name, count: value.count }))
    .sort((a, b) => {
      const ai = TAG_ORDER[a.name] ?? Number.MAX_SAFE_INTEGER;
      const bi = TAG_ORDER[b.name] ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.name.localeCompare(b.name, collationLocale.value) : ai - bi;
    }),
);

/** 特征推断：本地扫描兜底得出的标签，按命中数降序 */
const inferredTagList = computed<TagOption[]>(() =>
  [...tagIndex.value.entries()]
    .filter(([, value]) => !value.official)
    .map(([name, value]) => ({ name, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, collationLocale.value)),
);

const activeTagLabel = computed(() => activeTag.value ?? t("sidebar.allContent"));

// 重新扫描/卸装后选中的标签可能消失：自动退回“全部内容”，避免莫名空列表
watch([officialTagList, inferredTagList], () => {
  if (!activeTag.value) return;
  const stillExists =
    officialTagList.value.some((t) => t.name === activeTag.value) ||
    inferredTagList.value.some((t) => t.name === activeTag.value);
  if (!stillExists) activeTag.value = null;
});

/** 有多少模组的分类来自软件记录的官方 Tag */
const officialTagged = computed(
  () => mods.value.filter((m) => m.categorySource === "official").length,
);

// ---------------- v0.2：拖拽实例的生命周期 ----------------

/**
 * 挂载 Sortable。
 * 必须等 sortMode 变 true 且 DOM 真正渲染出 .sort-grid 之后（nextTick）再做：
 * 旧实现靠 watch([dragEl, sortMode]) 兑，一旦 el 与 sortMode 在同一次 patch 里变化，
 * 回调可能在 dragEl 还是 null 时就跑完（之后不会再补一次），
 * 结果就是“能进排序模式、但卡片完全拖不动且无任何报错”。
 */
async function mountDragSortable() {
  await nextTick();
  const el = dragEl.value;
  if (!el) {
    console.warn("[sort] 排序网格未渲染出来，拖拽未挂载");
    return;
  }
  disposeDrag?.();
  disposeDrag = attachDragSort(el, handleDragEnd);
}

function unmountDragSortable() {
  disposeDrag?.();
  disposeDrag = null;
}

/** 切到在线页时强制退出排序模式（本地网格会被销毁） */
watch(mode, (next) => {
  if (next === "local") return;
  // 有未保存改动就不让切页：切走会销毁本地网格，等于静默丢弃
  if (sortMode.value && sortDirty.value) {
    mode.value = "local";
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  exitSortMode();
});

/** 排序模式下 Ctrl+S 手动保存 */
function onSortHotkey(event: KeyboardEvent) {
  if (!sortMode.value) return;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  void saveSortOrder();
}
window.addEventListener("keydown", onSortHotkey);

onBeforeUnmount(() => {
  unmountDragSortable();
  window.removeEventListener("keydown", onSortHotkey);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="crest">⚔</span>
        <div>
          <h1>{{ t("app.name") }}</h1>
          <p class="tagline">
            {{ t("app.taglinePrefix") }}<a
              class="author-link"
              :href="AUTHOR_URL"
              :title="t('app.authorTitle')"
              @click.prevent="openAuthorPage"
              >{{ t("app.author") }}</a
            >
          </p>
        </div>
      </div>

      <nav class="mode-tabs">
        <button type="button" :class="{ active: mode === 'local' }" @click="mode = 'local'">
          {{ t("nav.local") }}
        </button>
        <button type="button" :class="{ active: mode === 'online' }" @click="mode = 'online'">
          {{ t("nav.online") }}
        </button>
      </nav>

      <div v-if="mode === 'local'" class="search-box">
        <span class="glyph">⌕</span>
        <input
          v-model="search"
          type="search"
          :placeholder="sortMode ? t('sort.searchDisabled') : t('search.placeholder')"
          :disabled="sortMode"
          spellcheck="false"
        />
        <button
          v-if="search"
          class="clear"
          type="button"
          :title="t('search.clear')"
          :aria-label="t('search.clear')"
          @click="search = ''"
        >
          ✕
        </button>
      </div>

      <!-- 在线模式：同一个搜索框位置，绑定在线 query（输入 300ms 防抖自动查） -->
      <div v-else class="search-box">
        <span class="glyph">⌕</span>
        <input
          v-model="onlineQuery"
          type="search"
          :placeholder="t('online.searchPlaceholder')"
          spellcheck="false"
        />
        <button
          v-if="onlineQuery"
          class="clear"
          type="button"
          :title="t('search.clear')"
          :aria-label="t('search.clear')"
          @click="onlineQuery = ''"
        >
          ✕
        </button>
      </div>

      <div v-if="mode === 'local'" class="toolbar">
        <select
          v-model="sortKey"
          :title="sortMode ? t('sort.sortDisabled') : t('toolbar.sortLabel')"
          :disabled="sortMode"
        >
          <option value="name">{{ t("toolbar.sortName") }}</option>
          <option value="updated">{{ t("toolbar.sortUpdated") }}</option>
          <option value="priority">{{ t("toolbar.sortPriority") }}</option>
          <option value="folder">{{ t("toolbar.sortFolder") }}</option>
        </select>
        <button type="button" :disabled="loading || !report" @click="refresh()">
          {{ t("toolbar.rescan") }}
        </button>
        <button type="button" :disabled="loading || choosingRoot" @click="chooseRoot">
          {{ t("toolbar.changeRoot") }}
        </button>
        <button type="button" class="preset-entry" @click="showPresets = true">
          {{ t("toolbar.presets") }}
        </button>
        <button
          type="button"
          class="sort-toggle"
          :class="{ active: sortMode }"
          :disabled="loading || !report || !mods.length"
          :title="sortMode ? t('sort.exitTitle') : t('sort.enterTitle')"
          @click="sortMode ? requestExitSortMode() : enterSortMode()"
        >
          {{ sortMode ? t("sort.exit") : t("sort.enter") }}
        </button>
      </div>

      <!-- 在线模式：同一行右侧换成排序 / 升降序 / 刷新 -->
      <div v-else class="toolbar">
        <select v-model="onlineSort" :title="t('toolbar.sortLabel')">
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ t(opt.labelKey) }}
          </option>
        </select>
        <select v-model="onlineOrder" :title="t('online.orderLabel')">
          <option value="DESC">{{ t("online.sortDesc") }}</option>
          <option value="ASC">{{ t("online.sortAsc") }}</option>
        </select>
        <button type="button" :title="t('online.refreshTitle')" @click="onlineRef?.refresh()">
          {{ t("online.refresh") }}
        </button>
      </div>

      <!-- v0.4：语言切换已迁入设置弹窗，顶栏只保留齿轮入口（占原语言下拉那一列） -->
      <button
        type="button"
        class="settings-entry"
        :title="t('settings.open')"
        :aria-label="t('settings.open')"
        @click="showSettings = true"
      >
        ⚙
      </button>
    </header>

    <div class="rootbar">
      <span>{{ t("rootbar.root") }}</span>
      <span class="path" :title="report?.root ?? ''">{{ report?.root ?? t("rootbar.notSet") }}</span>
      <span class="sep">|</span>
      <span class="pill">{{ t("rootbar.local", { n: sourceCounts.local }) }}</span>
      <span class="pill">{{ t("rootbar.subscribed", { n: sourceCounts.subscribed }) }}</span>
      <span class="pill">
        {{ t("rootbar.showing", { shown: sorted.length, total: mods.length }) }}
      </span>
      <span class="sep">|</span>
      <span>{{ t("rootbar.scannedAt", { time: lastScanText }) }}</span>
      <span class="spacer"></span>
      <button
        v-if="warnings.length"
        type="button"
        class="warn-pill"
        @click="showWarnings = !showWarnings"
      >
        ⚠ {{ t("rootbar.warnings", { n: warnings.length }) }}
      </button>
    </div>

    <div class="body-grid" :class="{ 'online-mode': mode === 'online' }">
      <aside v-if="mode === 'local'" class="sidebar" :class="{ 'sort-locked': sortMode }">
        <div v-if="sortMode" class="sort-lock-note">{{ t("sort.sidebarLocked") }}</div>
        <div class="side-group">
          <div class="side-title">{{ t("sidebar.source") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'all' && !favoritesOnly }"
            @click="pickSource('all')"
          >
            <span class="label">{{ t("sidebar.allMods") }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'local' && !favoritesOnly }"
            @click="pickSource('local')"
          >
            <span class="label">{{ t("sidebar.local") }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'subscribed' && !favoritesOnly }"
            @click="pickSource('subscribed')"
          >
            <span class="label">{{ t("sidebar.subscribed") }}</span>
          </button>
        </div>

        <!-- v0.5：我的收藏（只过滤 isFavorite，按 WorkshopID 匹配 user_data.json） -->
        <div class="side-group">
          <div class="side-title">{{ t("favorites.groupTitle") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: favoritesOnly }"
            :disabled="sortMode"
            :title="t('favorites.note')"
            @click="toggleFavorites"
          >
            <span class="label">⭐ {{ t("favorites.label") }}</span>
            <span class="count">{{ favoriteLocalCount }}</span>
          </button>
          <div class="side-note note" style="padding: 4px 10px">{{ t("favorites.note") }}</div>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.officialTags") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: activeTag === null && !favoritesOnly }"
            @click="pickTag(null)"
          >
            <span class="label">{{ t("sidebar.allContent") }}</span>
          </button>
          <button
            v-for="item in officialTagList"
            :key="item.name"
            type="button"
            class="side-item"
            :class="{ active: activeTag === item.name && !favoritesOnly }"
            :title="t('sidebar.tagCount', { name: localizedTagName(item.name), n: item.count })"
            @click="pickTag(item.name)"
          >
            <span class="label">{{ localizedTagName(item.name) }}</span>
          </button>
          <div v-if="!officialTagList.length" class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.officialEmpty") }}
          </div>
        </div>

        <div v-if="inferredTagList.length" class="side-group">
          <div class="side-title">{{ t("sidebar.inferredTags") }}</div>
          <button
            v-for="item in inferredTagList"
            :key="item.name"
            type="button"
            class="side-item"
            :class="{ active: activeTag === item.name && !favoritesOnly }"
            :title="t('sidebar.inferredCount', { name: localizedTagName(item.name), n: item.count })"
            @click="pickTag(item.name)"
          >
            <span class="label">{{ localizedTagName(item.name) }}</span>
          </button>
          <div class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.officialVsInferred", { official: officialTagged, inferred: mods.length - officialTagged }) }}
          </div>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.status") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'all' && !favoritesOnly }"
            @click="pickStatus('all')"
          >
            <span class="label">{{ t("sidebar.all") }}</span><span class="count">{{ sourceCounts.all }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'enabled' && !favoritesOnly }"
            @click="pickStatus('enabled')"
          >
            <span class="label">{{ t("sidebar.enabled") }}</span><span class="count">{{ statusCounts.enabled }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'disabled' && !favoritesOnly }"
            @click="pickStatus('disabled')"
          >
            <span class="label">{{ t("sidebar.disabled") }}</span><span class="count">{{ statusCounts.disabled }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'unknown' && !favoritesOnly }"
            @click="pickStatus('unknown')"
          >
            <span class="label">{{ t("sidebar.unknown") }}</span><span class="count">{{ statusCounts.unknown }}</span>
          </button>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.basis") }}</div>
          <div class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.basisNote", { official: officialTagged, inferred: mods.length - officialTagged }) }}
          </div>
        </div>
      </aside>

      <section v-if="mode === 'local'" class="content">
        <div v-if="showWarnings" class="warn-panel">
          <strong>{{ t("state.warningsTitle") }}</strong>
          <ul class="warn-list">
            <li v-for="w in warnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <div class="content-head">
          <h2>{{ heading }}</h2>
          <span class="hint">{{ contentHint }}</span>
        </div>

        <div ref="localScrollEl" class="grid-scroll">
          <div v-if="loading" class="state-panel">
            <h2><span class="spinner"></span>{{ t("state.scanningTitle") }}</h2>
            <p>{{ t("state.scanningBody") }}</p>
          </div>

          <div v-else-if="error" class="state-panel">
            <h2>{{ t("state.scanFailedTitle") }}</h2>
            <p>{{ error }}</p>
            <div class="actions">
              <button type="button" @click="chooseRoot">{{ t("state.chooseOther") }}</button>
              <button type="button" :disabled="!report" @click="refresh()">{{ t("state.retry") }}</button>
            </div>
          </div>

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

          <div v-else-if="!report.rootExists" class="state-panel">
            <h2>{{ t("state.rootMissingTitle") }}</h2>
            <p>{{ t("state.rootMissingBody", { path: report.root }) }}</p>
            <div class="actions">
              <button type="button" @click="chooseRoot">{{ t("state.chooseAgain") }}</button>
            </div>
          </div>

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

          <div v-else-if="sortMode" class="sort-wrap">
            <div class="sort-banner">
              <span class="glyph">⇅</span>
              <span>{{ t("sort.banner", { n: dragList.length }) }}</span>
              <span v-if="sortDirty" class="sort-state dirty">{{ t("sort.dirty") }}</span>
              <span v-else class="sort-state">{{ t("sort.clean") }}</span>
              <button
                type="button"
                class="sort-save"
                :disabled="!sortDirty || sortSaving"
                :title="t('sort.saveTitle')"
                @click="saveSortOrder()"
              >
                {{ sortSaving ? t("sort.saving") : t("sort.save") }}
              </button>
            </div>

            <div ref="dragEl" class="card-grid sort-grid">
              <ModCard
                v-for="(mod, index) in dragList"
                :key="mod.id"
                :mod="mod"
                :active="mod.id === selectedId"
                :order="index + 1"
                :has-update="updateIds.has(mod.id)"
                sortable
                @select="selectMod"
              />
            </div>

            <div v-if="unsortable.length" class="sort-locked-group">
              <div class="side-title">{{ t("sort.lockedTitle", { n: unsortable.length }) }}</div>
              <div class="card-grid">
                <ModCard
                  v-for="mod in unsortable"
                  :key="mod.id"
                  :mod="mod"
                  :active="mod.id === selectedId"
                  :has-update="updateIds.has(mod.id)"
                  @select="selectMod"
                />
              </div>
            </div>
          </div>

          <!-- 收藏视图专用空态：计数 > 0 却看不到，说明是搜索没命中，必须说清楚 -->
          <div v-else-if="!sorted.length && favoritesOnly" class="state-panel">
            <h2>⭐ {{ t("favorites.empty") }}</h2>
            <p>{{ favoriteLocalCount ? t("favorites.emptyLocalHint", { n: favoriteLocalCount }) : t("favorites.emptyNone") }}</p>
            <div class="actions">
              <button v-if="search" type="button" @click="search = ''">
                {{ t("search.clear") }}
              </button>
              <button type="button" @click="toggleFavorites">{{ t("favorites.exit") }}</button>
            </div>
          </div>

          <div v-else-if="!sorted.length" class="state-panel">
            <h2>{{ t("state.filteredTitle") }}</h2>
            <p>{{ t("state.filteredBody", { total: mods.length }) }}</p>
            <div class="actions">
              <button
                type="button"
                @click="
                  search = '';
                  source = 'all';
                  status = 'all';
                  activeTag = null;
                  favoritesOnly = false;
                "
              >
                {{ t("state.clearFilters") }}
              </button>
            </div>
          </div>

          <div v-else class="card-grid">
            <ModCard
              v-for="mod in sorted"
              :key="mod.id"
              :mod="mod"
              :active="mod.id === selectedId"
              :has-update="updateIds.has(mod.id)"
              @select="selectMod"
            />
          </div>
        </div>
      </section>

      <aside v-if="mode === 'local'" class="detail">
        <ModDetail
          v-if="selected"
          :mod="selected"
          :stats="stats"
          :stats-loading="statsLoading"
          :stats-error="statsError"
          :update-info="itemsById.get(selected.id) ?? null"
          :updating="updatingEntryId === selected.id"
          @toggled="handleToggle"
          @removed="handleRemoved"
          @update="handleUpdateMod(selected)"
        />
        <div v-else class="detail-empty">
          {{ t("state.detailEmpty") }}<br />
          <span class="note">{{ t("state.detailEmptyNote") }}</span>
        </div>
      </aside>

      <!-- KeepAlive 缓存 OnlineBrowser 实例：切到本地再切回在线不会重新挂载、
           不会重新检查登录状态、也不会重新请求第一页。
           筛选状态由顶栏通过 v-model 传入，组件内部无需自带工具栏。 -->
      <KeepAlive>
        <OnlineBrowser
          v-if="mode === 'online'"
          ref="onlineRef"
          v-model:query="onlineQuery"
          v-model:sort="onlineSort"
          v-model:order="onlineOrder"
        />
      </KeepAlive>

      <!-- 首次启动：探测失败/未设置时引导用户手动选择根目录 -->
      <FirstRunWizard
        v-if="showWizard"
        @done="handleWizardDone"
        @close="showWizard = false"
      />

      <!-- v0.3：预设管理器（position: fixed 浮层，不影响三栏布局） -->
      <PresetManager
        v-if="showPresets"
        :mods="mods"
        :applied-id="lastAppliedPresetId"
        @close="showPresets = false"
        @applied="handlePresetApplied"
      />
    </div>

    <!-- v0.6：全局底部状态栏（账号灯 / 动态提示 / 代理与本地计数），始终显示 -->
    <StatusBar :local-count="mods.length" :mode="mode" />

    <!-- 放弃未保存排序的二次确认 -->
    <ConfirmDialog
      v-if="showDiscardConfirm"
      :title="t('sort.discardTitle')"
      :message="t('sort.discardMessage')"
      :confirm-label="t('sort.discardConfirm')"
      @confirm="discardSortChanges"
      @cancel="showDiscardConfirm = false"
    />

    <!-- v0.4：独立设置弹窗（通用 / 网络 / 关于） -->
    <SettingsModal v-if="showSettings" @close="showSettings = false" />

    <!-- 轻量提示（排序已保存等）：固定右下角，不挤压布局 -->
    <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>

    <!-- 启动时发现新版本：右下角常驻提示，点击跳 GitHub Release -->
    <div v-if="updateNotice" class="app-toast update-toast" :class="{ stacked: !!toast }">
      <button type="button" class="update-toast-body" @click="openUpdatePage">
        🎉 {{ t("update.available", { version: updateNotice.version }) }}
      </button>
      <button
        type="button"
        class="update-toast-x"
        :title="t('update.dismiss')"
        :aria-label="t('update.dismiss')"
        @click="updateNotice = null"
      >
        ✕
      </button>
    </div>
  </div>
</template>
