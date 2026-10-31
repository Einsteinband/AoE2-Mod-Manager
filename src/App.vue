<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModCard from "./components/ModCard.vue";
import ModDetail from "./components/ModDetail.vue";
import AppShell from "./components/layout/AppShell.vue";
import PageShell from "./components/layout/PageShell.vue";
import ModToolbar from "./components/common/ModToolbar.vue";
import ViewSwitch from "./components/common/ViewSwitch.vue";
import ModGrid from "./components/common/ModGrid.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import FirstRunWizard from "./components/FirstRunWizard.vue";
import OnlineBrowser from "./components/OnlineBrowser.vue";
import PresetManager from "./components/PresetManager.vue";
import SettingsModal from "./components/SettingsModal.vue";
import LocalSidebar from "./components/local/LocalSidebar.vue";
import {
  FONT_FAMILY_VARS,
  TYPOGRAPHY_DEFAULTS,
  appVersion,
  fetchGithubReleases,
  getSettings,
  normalizeTypography,
  normalizeVersion,
  openExternalUrl,
  renderReleaseMarkdown,
  saveTypographyPrefs,
  setLocale as persistLocale,
  setTheme,
  toggleModEnabled,
  type TypographyPrefs,
  type UiFontFamily,
} from "./api";
import { applyLocale, detectSystemLocale, normalizeLocale } from "./i18n";
import { getTranslateSettings } from "./online/service";
import { kickIndexSync } from "./online/indexSync";
import { itemsById, updateIds } from "./modUpdates";
import {
  applyTranslateSettings,
  hydrateTranslations,
  syncUiLocale,
  translationLangEpoch,
} from "./online/translation";
import {
  ensureStartupSession,
  localSearchEnabled,
  openSettingsNonce,
  sessionEpoch,
} from "./sessionState";
import { ensureUserData } from "./userData";
import { SORT_OPTIONS } from "./online/types";
import type { ModEntry, SortKey } from "./types";
import { useToast } from "./composables/useToast";
import {
  useViewPrefs,
} from "./composables/useViewPrefs";
import { useScrollRestore } from "./composables/useScrollRestore";
import { useLocalScan } from "./composables/local/useLocalScan";
import { useLocalFilters } from "./composables/local/useLocalFilters";
import { useSortMode } from "./composables/local/useSortMode";
import { useLocalModActions } from "./composables/local/useLocalModActions";
import { useBatchToggle } from "./composables/local/useBatchToggle";
import { usePresets } from "./composables/local/usePresets";
import { useLocalUpdate } from "./composables/local/useLocalUpdate";

/**
 * 页面入口只做四件事：**页面级状态（模式 / 在线筛选）/ 组件协调 / 状态连接 / 启动引导**。
 * 具体业务全部在 composable 里，按「数据源 → 筛选 → 排序 → 单条操作 → 批量 → 预设 → 更新」分层，
 * 依赖方向单向向下，不存在循环引用。
 */

// ---------------- 页面级状态：模式切换 + 顶栏在线筛选 ----------------

/** 顶部模式：本地扫描 / 在线官方服务 */
const mode = ref<"local" | "online">("local");

/** 在线页的筛选状态提升到顶栏，保证两种模式的搜索/排序控件位置完全一致 */
/** 官方搜索已提交的词（空 = 显示最新列表）。**只在回车 / 点搜索时写入**，输入过程中不变 */
const onlineQuery = ref("");
/** 官方搜索框的输入缓冲：打字不触发任何请求（v1.1 双搜索框） */
const onlineQueryDraft = ref("");
const onlineSort = ref(SORT_OPTIONS[0].value);
const onlineOrder = ref<"DESC" | "ASC">("DESC");
const onlineRef = ref<InstanceType<typeof OnlineBrowser> | null>(null);

/** 提交官方搜索（回车 / 点搜索按钮）：词没变就当作一次手动刷新 */
function submitOnlineSearch() {
  const next = onlineQueryDraft.value.trim();
  onlineQueryDraft.value = next;
  if (next === onlineQuery.value) {
    if (next) void onlineRef.value?.refresh?.();
    return;
  }
  onlineQuery.value = next;
}

/** 清空官方搜索 → 回到最新 / 官方列表（本地搜索框由在线页自己跟随清除） */
function resetOnlineSearch() {
  onlineQueryDraft.value = "";
  onlineQuery.value = "";
}

/**
 * v1.0：登录成功（`sessionEpoch` 递增）→ 静默补建在线索引（中文混合搜索的底座）。
 *
 * 必须放在 App 顶层而不是在线页：用户一直停在「本地」页时 `OnlineBrowser` 根本没挂载，
 * 索引就永远不会建，中文搜索会一直是空的。
 * `kickIndexSync` 内部按 epoch 去重，与在线页自己的触发共享同一个请求，不会发两次。
 */
watch(sessionEpoch, (epoch) => {
  if (epoch > 0) void kickIndexSync(epoch);
});

const { t, locale } = useI18n();
/** 当前界面语言（语言切换本身已迁到 SettingsModal，这里只用于排序区域） */
const currentLocale = computed(() => String(locale.value));
/** 排序/比较用的区域：中文按拼音，其他语言直接用自己的语言代码 */
const collationLocale = computed(() =>
  currentLocale.value === "zh" ? "zh-Hans-CN" : currentLocale.value,
);

// ---------------- 组合各业务层（顺序即依赖方向） ----------------

const { toast, showToast } = useToast();
const { viewMode, cardSize, applyFromSettings: applyViewPrefs } = useViewPrefs();

// ---------------- v2.2：主题（dark 深色羊皮纸 / light 明亮米白） ----------------
// settings.json 是唯一真源；localStorage 只做首帧防闪缓存：
// script setup 在首次渲染前同步执行，先打上缓存主题，onMounted 再用 settings.json 校正。
type Theme = "dark" | "light";
const THEME_CACHE_KEY = "aoe2mm.theme";

/** 主题归一化：只认 light，其余一律 dark（与 Rust 侧 models::normalize_theme 同口径） */
function normalizeTheme(raw: unknown): Theme {
  return String(raw ?? "").toLowerCase() === "light" ? "light" : "dark";
}

/** 读首帧缓存（隐私模式下 localStorage 可能抛错：静默回落 dark） */
function readCachedTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_CACHE_KEY));
  } catch {
    return "dark";
  }
}

/**
 * 应用主题：只改 <html data-theme>，CSS 变量整体换值，
 * 不重载页面、不重建组件树、不动滚动位置。
 */
function applyTheme(next: Theme) {
  document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, next);
  } catch {
    /* 忽略：settings.json 仍是唯一真源 */
  }
}

const theme = ref<Theme>(readCachedTheme());
/** 首屏回填 settings.json 期间禁止回写，避免“读 → 写 → 再读”的无谓往返 */
let themeReady = false;

// 脚本建立阶段就把主题打到 <html> 上（早于首帧渲染，避免开屏闪一下另一个主题）
applyTheme(theme.value);

/** 切换主题：先改 DOM（瞬间生效），再异步落盘；写盘失败只提示，不回滚界面 */
watch(theme, (next) => {
  applyTheme(next);
  if (!themeReady) return;
  // v2.3：invoke 统一收口到 api.ts（setTheme），App.vue 不再直接碰 Tauri 命令
  void setTheme(next).catch((e) => {
    console.warn("[theme] 保存主题失败", e);
  });
});

// ---------------- v2.4：三层排版（界面 / 正文阅读 / 卡片列表） ----------------
// settings.json 是唯一真源，localStorage 只做首帧防闪缓存。
// 变量写在 <html> 的 inline style 上 —— 只有一处真源，且必然盖住 :root / [data-theme] 里的默认值，
// 因此拖动滑块时全站（侧边栏 / 顶栏 / 设置弹窗 / 卡片 / 详情正文）都是逐帧联动的。
const TYPO_CACHE_KEY = "aoe2mm.typography.v2";

/** 读首帧缓存；缺失 / 损坏 / 隐私模式抛错 → 全部回出厂默认值 */
function readCachedTypography(): TypographyPrefs {
  try {
    const raw = window.localStorage.getItem(TYPO_CACHE_KEY);
    if (!raw) return { ...TYPOGRAPHY_DEFAULTS };
    return normalizeTypography(JSON.parse(raw));
  } catch {
    return { ...TYPOGRAPHY_DEFAULTS };
  }
}

/**
 * 把三层排版写到 <html> 的 style 上（所见即所得的核心）：
 *   --app-font-family / --ui-font-weight / --global-scale   → 界面层（侧边栏、顶栏、设置弹窗…）
 *   --reader-font-size / -line-height / -font-weight → 正文阅读层（详情描述…）
 *   --card-font-size                                 → 卡片列表层（卡片标题 / 元信息）
 * 三者互不干扰；只改 CSS 变量，不重建组件树、不丢滚动位置。
 * 字体种类只切「用哪一套字体栈」，真字体名在 style.css 的 --font-* 里。
 */
function applyTypography(next: TypographyPrefs) {
  const root = document.documentElement;
  const prefs = normalizeTypography(next);
  root.style.setProperty("--app-font-family", FONT_FAMILY_VARS[prefs.fontFamily]);
  root.style.setProperty("--ui-font-weight", String(prefs.uiFontWeight));
  root.style.setProperty("--global-scale", String(prefs.globalScale / 100));
  root.style.setProperty("--reader-font-size", `${prefs.readerFontSize}px`);
  root.style.setProperty("--reader-line-height", String(prefs.readerLineHeight));
  root.style.setProperty("--reader-font-weight", String(prefs.readerFontWeight));
  root.style.setProperty("--card-font-size", `${prefs.cardFontSize}px`);
  try {
    window.localStorage.setItem(TYPO_CACHE_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略：settings.json 仍是唯一真源 */
  }
}

const cachedTypography = readCachedTypography();
const uiFontFamily = ref<UiFontFamily>(cachedTypography.fontFamily);
const uiFontWeight = ref<number>(cachedTypography.uiFontWeight);
const globalFontScale = ref<number>(cachedTypography.globalScale);
const readerFontSize = ref<number>(cachedTypography.readerFontSize);
const readerLineHeight = ref<number>(cachedTypography.readerLineHeight);
const readerFontWeight = ref<number>(cachedTypography.readerFontWeight);
const cardFontSize = ref<number>(cachedTypography.cardFontSize);

/** 当前七项快照（归一化后的值，保证和 Rust 侧写盘结果一致） */
function currentTypography(): TypographyPrefs {
  return normalizeTypography({
    fontFamily: uiFontFamily.value,
    uiFontWeight: uiFontWeight.value,
    globalScale: globalFontScale.value,
    readerFontSize: readerFontSize.value,
    readerLineHeight: readerLineHeight.value,
    readerFontWeight: readerFontWeight.value,
    cardFontSize: cardFontSize.value,
  });
}

/** 首屏回填 settings.json 期间禁止回写（与 themeReady 同理） */
let typographyReady = false;
/** 最近一次已经写进 settings.json 的值：避免“启动回填 → 监听器又写一遍”的无谓写盘 */
let persistedTypography: TypographyPrefs = { ...cachedTypography };
/** 连续拖动合并成一次落盘：300ms 内无新值才写 settings.json */
let typographyTimer: ReturnType<typeof setTimeout> | null = null;

function sameTypography(a: TypographyPrefs, b: TypographyPrefs): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.uiFontWeight === b.uiFontWeight &&
    a.globalScale === b.globalScale &&
    a.readerFontSize === b.readerFontSize &&
    a.readerLineHeight === b.readerLineHeight &&
    a.readerFontWeight === b.readerFontWeight &&
    a.cardFontSize === b.cardFontSize
  );
}

// 脚本建立阶段先打上缓存值，避免开屏时字号 / 字体跳一下
applyTypography(cachedTypography);

watch(
  [uiFontFamily, uiFontWeight, globalFontScale, readerFontSize, readerLineHeight, readerFontWeight, cardFontSize],
  () => {
    const next = currentTypography();
    // 1）先改 DOM：即时预览（不重建组件树、不丢滚动位置）
    applyTypography(next);
    if (!typographyReady) return;
    // 2）值没变就不写盘
    if (sameTypography(next, persistedTypography)) return;
    // 3）合并连续拖动，300ms 后只写最后一次
    if (typographyTimer) clearTimeout(typographyTimer);
    typographyTimer = setTimeout(() => {
      if (sameTypography(next, persistedTypography)) return;
      persistedTypography = next;
      void saveTypographyPrefs(next).catch((e) => {
        console.warn("[typography] 保存排版失败", e);
      });
    }, 300);
  },
);

onBeforeUnmount(() => {
  if (typographyTimer) clearTimeout(typographyTimer);
});
const scan = useLocalScan();
const {
  report,
  mods,
  warnings,
  loading,
  error,
  candidates,
  choosingRoot,
  showWizard,
  selected,
  lastScanText,
  chooseRoot,
} = scan;

const filters = useLocalFilters({ mods: scan.mods, collationLocale });
const {
  search,
  source,
  status,
  favoritesOnly,
  activeTag,
  sourceCounts,
  statusCounts,
  sorted,
  officialTagList,
  inferredTagList,
  heading,
  contentHint,
  favoriteLocalCount,
  pickSource,
  pickStatus,
  pickTag,
  toggleFavorites,
  clearFilters,
} = filters;

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
  enterSortMode,
  requestExitSortMode,
  discardSortChanges,
  saveSortOrder,
  onSortHotkey,
} = sort;

const actions = useLocalModActions({
  report: scan.report,
  selectedId: scan.selectedId,
  patchModEnabled: scan.patchModEnabled,
  sort,
  normalizeError: scan.normalizeError,
  showToast,
});
const { stats, statsLoading, statsError, selectMod, handleToggle, handleCardToggled, handleCardToggleError, handleRemoved } =
  actions;

// ---------------- 数据模组互斥（游戏同一时间只能加载一个 .dat） ----------------

/** 待用户确认的冲突：旧数据模组（已启用）→ 新数据模组（将要启用） */
const dataModConflict = ref<{ oldMod: ModEntry; newMod: ModEntry } | null>(null);
const dataModBusy = ref(false);
const dataModError = ref<string | null>(null);

/** 当前已启用的其他数据模组（排除 excludeId 自己） */
function enabledDataMods(excludeId?: string): ModEntry[] {
  return (scan.report.value?.mods ?? []).filter(
    (m) => m.isDataMod && m.enabled === true && m.id !== excludeId,
  );
}

/** 写一条启用状态（只 patch 这一条，不重扫） */
async function writeModEnabled(mod: ModEntry, enabled: boolean): Promise<void> {
  const result = await toggleModEnabled(mod.workshopId, mod.kind, mod.folderName, enabled);
  scan.patchModEnabled(mod.id, result.enabled);
}

/** 没有冲突时直接启用数据模组 */
async function enableDataMod(mod: ModEntry): Promise<void> {
  dataModBusy.value = true;
  dataModError.value = null;
  try {
    await writeModEnabled(mod, true);
    showToast(t("dataMod.enabledToast", { name: mod.displayName }));
  } catch (e) {
    showToast(scan.normalizeError(e), "error");
  } finally {
    dataModBusy.value = false;
  }
}

/**
 * 卡片 / 详情页的「启用数据模组」请求：先查已有的数据模组，
 * 已启用另一个则弹冲突确认，否则直接启用。
 */
function requestEnableDataMod(payload: { id: string }): void {
  if (dataModBusy.value || dataModConflict.value) return;
  const mod = scan.report.value?.mods.find((m) => m.id === payload.id);
  if (!mod) return;
  const conflict = enabledDataMods(mod.id)[0] ?? null;
  if (!conflict) {
    void enableDataMod(mod);
    return;
  }
  dataModError.value = null;
  dataModConflict.value = { oldMod: conflict, newMod: mod };
}

/** 用户确认：先禁用旧的数据模组，再启用新的 */
async function confirmDataModSwitch(): Promise<void> {
  const conflict = dataModConflict.value;
  if (!conflict || dataModBusy.value) return;
  dataModBusy.value = true;
  dataModError.value = null;
  try {
    await writeModEnabled(conflict.oldMod, false);
    await writeModEnabled(conflict.newMod, true);
    dataModConflict.value = null;
    showToast(
      t("dataMod.switchedToast", {
        old: conflict.oldMod.displayName,
        new: conflict.newMod.displayName,
      }),
    );
  } catch (e) {
    dataModError.value = scan.normalizeError(e);
  } finally {
    dataModBusy.value = false;
  }
}

/** 用户取消：中止启用，不动磁盘 */
function cancelDataModSwitch(): void {
  if (dataModBusy.value) return;
  dataModConflict.value = null;
  dataModError.value = null;
}

// ---------------- 批量启用时的数据模组互斥 ----------------

/** 本次批量启用被跳过的数据模组数量（0 = 无跳过） */
const dataModSkipCount = ref(0);
/** 本次批量启用需要顺带禁用的旧数据模组 */
const dataModBatchDisable = ref<ModEntry[]>([]);
/** 批量目标覆盖：null = 直接用当前筛选结果（不改变 collation / 筛选） */
const batchOverride = ref<ModEntry[] | null>(null);
const batchSource = computed(() => batchOverride.value ?? sorted.value);

/** batch 自己的 Toast：把「跳过 X 个数据模组」并入结果提示，避免两条提示互相覆盖 */
function showBatchToast(text: string, kind: "ok" | "error" = "ok"): void {
  if (dataModSkipCount.value > 0) {
    showToast(`${text}${t("batch.dataModSkipped", { n: dataModSkipCount.value })}`, kind);
    return;
  }
  showToast(text, kind);
}

const batch = useBatchToggle({
  sorted: batchSource,
  report: scan.report,
  patchModEnabled: scan.patchModEnabled,
  normalizeError: scan.normalizeError,
  showToast: showBatchToast,
});
const { batchAsk, batchBusy, batchError, batchTargets, askBatch, runBatchToggle, cancelBatch } = batch;

function resetBatchDataMod(): void {
  batchOverride.value = null;
  dataModBatchDisable.value = [];
  dataModSkipCount.value = 0;
}

/**
 * 全部启用：数据模组只能留一个。
 * 取当前列表里排在最前面（优先级最高）的那个，其余从本次目标里摘掉（静默跳过）；
 * 已启用但不是它的数据模组会在确认后被禁用，否则游戏里会互相覆盖。
 */
function askBatchEnable(): void {
  if (batchBusy.value) return;
  const list = sorted.value;
  const dataMods = list.filter((m) => m.isDataMod);
  const winner = dataMods[0] ?? null;
  const skipped = winner ? dataMods.length - 1 : 0;
  dataModSkipCount.value = skipped;
  // 列表里没有数据模组时，不做任何额外禁用（别误伤用户已有的数据模组）
  dataModBatchDisable.value = winner ? enabledDataMods(winner.id) : [];
  batchOverride.value =
    skipped > 0 ? list.filter((m) => !m.isDataMod || m.id === winner?.id) : null;
  askBatch(true);
}

/** 全部禁用：与数据模组无关，清掉残留状态后照常走 */
function askBatchDisable(): void {
  resetBatchDataMod();
  askBatch(false);
}

/** 确认执行：批量启用时先禁用冲突的旧数据模组，再整批启用（批次仍只写一次盘） */
async function runBatchToggleGuarded(): Promise<void> {
  if (batchAsk.value === null || batchBusy.value) return;
  if (batchAsk.value === false) {
    await runBatchToggle();
    resetBatchDataMod();
    return;
  }
  for (const stale of dataModBatchDisable.value) {
    try {
      await writeModEnabled(stale, false);
    } catch (e) {
      // 弹窗不关：用户可以重试或取消，绝不带着两个数据模组继续下去
      showToast(scan.normalizeError(e), "error");
      return;
    }
  }
  await runBatchToggle();
  resetBatchDataMod();
}

function cancelBatchGuarded(): void {
  cancelBatch();
  resetBatchDataMod();
}

/** 批量确认文案：把「跳过几个数据模组 / 会先禁用哪个」如实写进弹窗 */
const batchConfirmMessage = computed(() => {
  if (batchAsk.value !== true) {
    return t("batch.confirmDisableMessage", { n: batchTargets.value.length });
  }
  let text = t("batch.confirmEnableMessage", { n: batchTargets.value.length });
  if (dataModSkipCount.value > 0) {
    text += t("batch.dataModSkipNote", { n: dataModSkipCount.value });
  }
  const stale = dataModBatchDisable.value;
  if (stale.length) {
    text += t("batch.dataModDisableNote", {
      names: stale.map((m) => m.displayName).join(" / "),
    });
  }
  return text;
});

/**
 * 重扫的唯一入口：先看排序模式有没有未保存改动（不许静默丢弃），
 * 再退出排序模式（重扫会重排整个列表，拖拽索引会对不上），最后才真正扫描。
 */
async function refresh(root?: string | null): Promise<void> {
  if (sort.blocksRescan.value) {
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  sort.exitSortMode();
  await scan.refresh(root);
}

const presets = usePresets({ mods: scan.mods, rescan: () => refresh() });
const { showPresets, lastAppliedPresetId, handlePresetApplied } = presets;

const update = useLocalUpdate({
  blocksRescan: sort.blocksRescan,
  rescan: () => refresh(),
  normalizeError: scan.normalizeError,
  showToast,
});
const { updateNotice, updatingEntryId, handleUpdateMod, runStartupUpdateCheck, openUpdatePage } = update;

/** 本地列表的滚动位置记忆（模式切换时滚动容器会被销毁重建） */
const { el: localScrollEl } = useScrollRestore();

/**
 * ModGrid 就绪回调：把内部真实的滚动容器 / 网格节点交给上层。
 * - scrollEl → 本地列表的滚动位置还原（切页再切回不回到顶部）
 * - gridEl   → 排序模式的 Sortable 挂载点（不再靠模板 ref，网格永远是同一个 DOM）
 */
function onLocalGridReady(payload: {
  scrollEl: HTMLElement | null;
  gridEl: HTMLElement | null;
}) {
  localScrollEl.value = payload.scrollEl;
  sort.gridEl.value = payload.gridEl;
}

// ---------------- 页面级 UI 状态（弹窗 / 提示） ----------------

const showWarnings = ref(false);
/** v0.4 独立设置弹窗（语言 / 网络 / 关于） */
const showSettings = ref(false);

/** v1.2：在线页「本地索引未开启 → 前往设置」的快捷入口 */
watch(openSettingsNonce, () => {
  showSettings.value = true;
});

function closeSettings() {
  showSettings.value = false;
}

function closeWizard() {
  scan.showWizard.value = false;
}

function closePresets() {
  presets.showPresets.value = false;
}

function cancelDiscardSort() {
  sort.showDiscardConfirm.value = false;
}

function toggleWarnings() {
  showWarnings.value = !showWarnings.value;
}

/** 作者 GitHub 主页：交给 Rust 用系统浏览器打开，绝不在 WebView 里导航 */
const AUTHOR_URL = "https://github.com/Einsteinband";

async function openAuthorPage() {
  try {
    await openExternalUrl(AUTHOR_URL);
  } catch (e) {
    showToast(scan.normalizeError(e), "error");
  }
}

/**
 * v3.2：右下角「发现新版本」里的蓝奏云高速下载。
 * 与设置页「关于」用的是同一个网盘分享链接，同样交给 Rust 用系统浏览器打开。
 * 打开后不关掉提示：用户可能还想走 GitHub 版本，让提示自己保留即可。
 */
const LANZOU_URL = "https://wwblm.lanzouv.com/b01i5yfj5e";

async function openLanzouPage() {
  try {
    await openExternalUrl(LANZOU_URL);
  } catch (e) {
    showToast(scan.normalizeError(e), "error");
  }
}

// ---------------- 顶栏模型（本地 / 在线共用一套控件） ----------------

/**
 * ModToolbar 的排序下拉绑定的是 string，而本地 sortKey 是收窄的 SortKey 联合类型，
 * 用一个 computed 代理做窄化写入，避免在子组件里放宽类型。
 */
const sortModel = computed<string>({
  get: () => filters.sortKey.value,
  set: (value) => {
    filters.sortKey.value = value as SortKey;
  },
});

/** 本地排序项：中文文案由 i18n 提供，顺序与历史上完全一致 */
const localSortOptions = computed(() => [
  { value: "name", label: t("toolbar.sortName") },
  { value: "updated", label: t("toolbar.sortUpdated") },
  { value: "priority", label: t("toolbar.sortPriority") },
  { value: "folder", label: t("toolbar.sortFolder") },
]);

/** 在线排序项：直接复用官方 SORT_OPTIONS，标签由 i18n 翻译 */
const onlineSortOptions = computed(() =>
  SORT_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
);

/** 在线升降序下拉的文案 */
const onlineOrderLabels = computed(() => ({
  desc: t("online.sortDesc"),
  asc: t("online.sortAsc"),
}));

// ---------------- 本地译文（只读缓存，零网络） ----------------

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

// ---------------- v3.1：新版本首启弹窗（每个版本只弹一次） ----------------

/** localStorage 记录「上次启动时已经展示过更新说明的版本」（settings.json 不新增字段） */
const LAST_SEEN_VERSION_KEY = "aoe2.lastSeenVersion";

interface VersionNotes {
  /** 当前运行的版本号 */
  version: string;
  /** Release 标题（无标题时回落 v{version}） */
  title: string;
  /** 已渲染好的安全 HTML（空串 = 拉不到 / 正文为空，走兜底文案） */
  html: string;
}

const versionNotes = ref<VersionNotes | null>(null);
/** 首次启动向导优先：向导没关就先攒着，关掉再弹，避免两个浮层叠在一起 */
let versionNotesPending = false;
/** 本次启动是否已经判定过（多重入口重复调用也只弹一次，杜绝同版本弹两遍） */
let versionNotesChecked = false;
/** 拉取更新说明的最长等待：卡住也要走兜底文案，绝不出现「更新了却没弹」 */
const VERSION_NOTES_FETCH_TIMEOUT_MS = 10000;

function readLastSeenVersion(): string {
  try {
    return window.localStorage.getItem(LAST_SEEN_VERSION_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastSeenVersion(version: string) {
  try {
    window.localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch (e) {
    // 隐私模式 / 存储被禁用：下次启动会再弹一次，不影响主流程
    console.warn("[version-notes] 写入 lastSeenVersion 失败", e);
  }
}

/** 版本号归一化后比较：v 前缀 / 大小写 / 空白都不算差异 */
function sameVersion(a: string, b: string): boolean {
  return normalizeVersion(a) === normalizeVersion(b);
}

/** 给网络调用加超时上限：Promise 一直挂着也不能让弹窗无限缺席 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("version-notes timeout")), ms);
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function showVersionNotesIfNeeded() {
  // 本次启动只判定一次：向导监听等入口重复触发也不会弹第二次
  if (versionNotesChecked) return;
  versionNotesChecked = true;

  let current = "";
  try {
    current = await appVersion();
  } catch (e) {
    // 读不到版本就不写 lastSeenVersion，下次启动重试，不会漏掉更新说明
    console.warn("[version-notes] 读取当前版本失败", e);
    return;
  }
  if (!current) {
    versionNotesChecked = false;
    return;
  }
  // 这个版本已经确认过（lastSeenVersion 相同）就安静启动
  if (sameVersion(readLastSeenVersion(), current)) return;

  let title = `v${current}`;
  let html = "";
  try {
    const releases = await withTimeout(fetchGithubReleases(), VERSION_NOTES_FETCH_TIMEOUT_MS);
    // 只取与「当前运行版本」对应的那一条：跨版本升级不会把中间版本的说明再弹一遍
    const hit = releases.find((release) => sameVersion(release.version || release.tagName, current));
    if (hit?.name?.trim()) title = hit.name.trim();
    html = hit ? renderReleaseMarkdown(hit.body ?? "") : "";
  } catch (e) {
    // 网络不通 / 未发版 / 超时：不拦启动，只显示一句兜底文案，确认后照样记版本号
    console.warn("[version-notes] 拉取更新说明失败，使用兜底文案", e);
  }
  versionNotes.value = { version: current, title, html };
}

function scheduleVersionNotes() {
  if (scan.showWizard.value) {
    versionNotesPending = true;
    return;
  }
  void showVersionNotesIfNeeded();
}

/**
 * 「我知道了」：唯一写入 lastSeenVersion 的入口。
 * 只在按钮点击时调用；点遮罩、Esc、直接关进程都不算已读，下次启动继续弹。
 * 先写再关：即使写入抛异常也已捕获，弹窗不会卡在界面上。
 */
function dismissVersionNotes() {
  const version = versionNotes.value?.version;
  if (version) writeLastSeenVersion(version);
  versionNotes.value = null;
}

watch(
  () => scan.showWizard.value,
  (open) => {
    if (open || !versionNotesPending) return;
    versionNotesPending = false;
    void showVersionNotesIfNeeded();
  },
);

// ---------------- 启动引导 ----------------

onMounted(async () => {
  // v1.3：启动即静默校验登录态——持久登录关闭时 Rust 侧会自己跑一次隐藏窗口静默重登，
  // 同样不 await、不阻塞首屏，底栏先显示「正在恢复登录…」再变 🟢/⚪
  void ensureStartupSession();
  // v0.5：收藏/备注只读一次磁盘，失败不阻塞本地页
  void ensureUserData().catch(() => undefined);
  // 启动即检查一次新版本（只此一次，失败静默）
  void runStartupUpdateCheck();
  try {
    await scan.loadCandidates();
    const settings = await getSettings();
    // v1.2：在线页本地搜索框开关（默认关闭，设置页可改）
    localSearchEnabled.value = settings.enableLocalSearch === true;
    // v1.6：视图模式与卡片大小（老 settings.json 缺字段 → 后端给 grid / 200）
    applyViewPrefs(settings);
    // v2.2：主题（老 settings.json 缺字段 → 后端给 dark）；缓存与设置不一致时以设置为准
    theme.value = normalizeTheme(settings.theme);
    applyTheme(theme.value);
    themeReady = true;
    // v2.4：三层排版（老 settings.json 缺字段 → 后端已给默认值；
    // v2.3 的扁平字段由 Rust 侧 migrate_legacy_typography 一次性搬进 reader_*）
    const typoPrefs = normalizeTypography({
      fontFamily: settings.uiFontFamily,
      uiFontWeight: settings.uiFontWeight,
      globalScale: settings.globalFontScale,
      readerFontSize: settings.readerFontSize,
      readerLineHeight: settings.readerLineHeight,
      readerFontWeight: settings.readerFontWeight,
      cardFontSize: settings.cardFontSize,
    });
    uiFontFamily.value = typoPrefs.fontFamily;
    uiFontWeight.value = typoPrefs.uiFontWeight;
    globalFontScale.value = typoPrefs.globalScale;
    readerFontSize.value = typoPrefs.readerFontSize;
    readerLineHeight.value = typoPrefs.readerLineHeight;
    readerFontWeight.value = typoPrefs.readerFontWeight;
    cardFontSize.value = typoPrefs.cardFontSize;
    applyTypography(typoPrefs);
    // 回填后同步“已落盘值”，避免监听器把刚读到的值又写回去
    persistedTypography = { ...typoPrefs };
    typographyReady = true;
    // v3.0：旧字体名（sans-serif / serif / system-ui）静默重写成 hei / system，
    // 顺手把 settings.json 里的旧值覆盖掉（否则每次启动都要重新归一化一遍）。
    if (String(settings.uiFontFamily ?? "").trim().toLowerCase() !== typoPrefs.fontFamily) {
      void saveTypographyPrefs(typoPrefs).catch((e) => {
        console.warn("[typography] 旧字体配置重写失败", e);
      });
    }
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
      if (!scan.report.value || !scan.report.value.rootExists) scan.showWizard.value = true;
    } else {
      scan.showWizard.value = true;
    }
  } catch (e) {
    scan.error.value = scan.normalizeError(e);
    scan.showWizard.value = true;
  }
  // v3.1：版本变了才弹「新版本特性」（首次启动同样算一次，走兜底文案）
  scheduleVersionNotes();
});

/**
 * UI 语言变化 → 「跟随界面语言」模式下，翻译目标语言立即联动，
 * 列表与详情会因 langEpoch 自增而重新只读预热（无需重启、不发网络）。
 */
watch(locale, (next) => {
  syncUiLocale(String(next));
});

/** 切到在线页时强制退出排序模式（本地网格会被销毁） */
watch(mode, (next) => {
  if (next === "local") return;
  // 有未保存改动就不让切页：切走会销毁本地网格，等于静默丢弃
  if (sort.blocksRescan.value) {
    mode.value = "local";
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  sort.exitSortMode();
});

/** 排序模式下 Ctrl+S 手动保存 */
window.addEventListener("keydown", onSortHotkey);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSortHotkey);
});
</script>

<template>
  <!-- 应用外壳：顶栏 / 信息栏 / 主体 / 状态栏四层统一由 AppShell 持有；
       本地与在线共用同一个顶栏、同一个底栏，不再各自拼一套外层容器。 -->
  <AppShell
    v-model:mode="mode"
    :author-url="AUTHOR_URL"
    :local-count="mods.length"
    @open-author="openAuthorPage"
    @open-settings="showSettings = true"
  >
    <!-- 顶栏中间：纹章 / 模式切换 / 齿轮由 TopBar 负责，这里只填工具栏。
         本地与在线用的是同一个组件、同一串 props，按钮排列与防挤压行为完全一致。 -->
    <template #toolbar>
      <!-- 本地模式：搜索 + 排序 +【重新扫描】+ 视图切换（网格 / 列表）
           v2.0 顶栏做减法：更换根目录 → 设置·外观；卡片大小滑块 → 设置·外观；
           预设管理器 / 全部启用 / 全部禁用 / 排序模式 → 列表抬头右侧的 .batch-actions -->
      <ModToolbar
        v-if="mode === 'local'"
        v-model:search="search"
        v-model:sort="sortModel"
        v-model:view-mode="viewMode"
        :search-placeholder="sortMode ? t('sort.searchDisabled') : t('search.placeholder')"
        :search-disabled="sortMode"
        :sort-options="localSortOptions"
        :sort-disabled="sortMode"
        :sort-title="sortMode ? t('sort.sortDisabled') : t('toolbar.sortLabel')"
        :show-view-switch="false"
      >
        <template #extra>
          <button type="button" :disabled="loading || !report" @click="refresh()">
            {{ t("toolbar.rescan") }}
          </button>
        </template>
      </ModToolbar>

      <!-- 在线模式：搜索框变成官方搜索（回车 / 点「搜索」才发请求），排序换成官方排序 + 升降序 -->
      <ModToolbar
        v-else
        v-model:search="onlineQueryDraft"
        v-model:sort="onlineSort"
        v-model:order="onlineOrder"
        v-model:view-mode="viewMode"
        submit-mode
        :submit-label="t('online.officialSearchGo')"
        :search-placeholder="t('online.officialSearchPlaceholder')"
        :search-title="t('online.officialSearchHint')"
        :clear-visible="Boolean(onlineQueryDraft || onlineQuery)"
        :sort-options="onlineSortOptions"
        :sort-title="t('toolbar.sortLabel')"
        :order-labels="onlineOrderLabels"
        :order-title="t('online.orderLabel')"
        :show-view-switch="false"
        @submit="submitOnlineSearch"
        @clear="resetOnlineSearch"
      >
        <template #extra>
          <button type="button" :title="t('online.refreshTitle')" @click="onlineRef?.refresh()">
            {{ t("online.refresh") }}
          </button>
        </template>
      </ModToolbar>

      <!-- 顶栏右端（设置齿轮左侧）：网格 / 列表切换。
           两种模式共用同一个位置，切页时按钮不会跳动；
           排序模式仍留在本地页列表抬头的 .batch-actions 里。 -->
      <div class="topbar-actions">
        <ViewSwitch v-model:view-mode="viewMode" />
      </div>
    </template>

    <!-- 信息栏（本地 / 在线共用同一条，内容由页面决定） -->
    <template #info>
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
        @click="toggleWarnings"
      >
        ⚠ {{ t("rootbar.warnings", { n: warnings.length }) }}
      </button>
      </div>
    </template>

    <!-- 主体：本地页与在线页共用同一个 <PageShell> 三栏骨架 -->
    <PageShell v-if="mode === 'local'" :sidebar-class="sortMode ? 'sort-locked' : ''">
      <!-- 左：来源 / 收藏 / 官方分类 / 推断分类 / 状态筛选（LocalSidebar 只负责展示与上抛事件） -->
      <template #sidebar>
        <LocalSidebar
          :sort-mode="sortMode"
          :source="source"
          :status="status"
          :favorites-only="favoritesOnly"
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
        />
      </template>

      <!-- 中：抬头 + 卡片网格（滚动区由 ModGrid 提供） -->
      <template #content>
        <div v-if="showWarnings" class="warn-panel">
          <strong>{{ t("state.warningsTitle") }}</strong>
          <ul class="warn-list">
            <li v-for="w in warnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <div class="content-head">
          <h2>{{ heading }}</h2>
          <span class="hint">{{ contentHint }}</span>

          <!-- v2.6 批量操作组：预设 / 全部启用 / 全部禁用 / 排序模式 / 视图切换（网格·列表），
               贴在列表标题（说明文字）右侧、整组右靠。视图切换与在线页列表抬头的位置一致。 -->
          <div v-if="mode === 'local'" class="batch-actions">
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
              :disabled="loading || !report || !mods.length"
              :title="sortMode ? t('sort.exitTitle') : t('sort.enterTitle')"
              @click="sortMode ? requestExitSortMode() : enterSortMode()"
            >
              {{ sortMode ? t("sort.exit") : t("sort.enter") }}
            </button>
          </div>
        </div>

        <!-- 本地列表：与在线页共用 ModGrid（滚动容器 + 网格骨架 + 视图模式 + 卡片大小） -->
        <ModGrid
          :view-mode="viewMode"
          :card-size="cardSize"
          :grid-class="sortMode ? 'sort-grid' : ''"
          @ready="onLocalGridReady"
        >
          <!-- 状态面板 / 排序提示条：不参与网格排版，直接落在滚动区里 -->
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

            <!-- v1.2：排序模式只对已启用模组生效，顶部常驻说明，不给底层原理 -->
            <p class="sort-hint">
              <span>{{ t("sort.enabledOnly") }}</span>
              <span v-if="excludedSortCount" class="sort-hint-count">
                {{ t("sort.hiddenCount", { n: excludedSortCount }) }}
              </span>
            </p>
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
              <button type="button" @click="clearFilters">
                {{ t("state.clearFilters") }}
              </button>
            </div>
          </div>

          <!-- 卡片本体：排序模式下拖拽列表，否则筛选后的列表；网格/列表视图由 ModGrid 统一控制 -->
          <template #cards>
            <ModCard
              v-for="(mod, index) in sortMode ? dragList : sorted"
              :key="mod.id"
              :mod="mod"
              :active="mod.id === selected?.id"
              :order="sortMode ? index + 1 : undefined"
              :has-update="updateIds.has(mod.id)"
              :sortable="sortMode"
              @select="selectMod"
              @toggled="handleCardToggled"
              @toggle-error="handleCardToggleError"
              @request-enable="requestEnableDataMod"
            />
          </template>
        </ModGrid>
      </template>

      <!-- 右：详情面板 -->
      <template #detail>
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
          @request-enable="requestEnableDataMod"
        />
        <div v-else class="detail-empty">
          {{ t("state.detailEmpty") }}<br />
          <span class="note">{{ t("state.detailEmptyNote") }}</span>
        </div>
      </template>
    </PageShell>

      <!-- 在线页：内部同样用 <PageShell>，这里不再套一层三栏容器 -->
      <!-- KeepAlive 缓存 OnlineBrowser 实例：切到本地再切回在线不会重新挂载、
           不会重新检查登录状态、也不会重新请求第一页。
           筛选状态由顶栏通过 v-model 传入；视图模式与卡片大小同样由顶层传入，
           保证两个页面的网格/列表切换与缩放完全同步。 -->
      <KeepAlive>
        <OnlineBrowser
          v-if="mode === 'online'"
          ref="onlineRef"
          v-model:query="onlineQuery"
          v-model:sort="onlineSort"
          v-model:order="onlineOrder"
          :view-mode="viewMode"
          :card-size="cardSize"
        />
      </KeepAlive>

    <!-- ---------------------------------------------------------------
         全局浮层：全部 position: fixed，不参与四层布局与三栏尺寸计算
         --------------------------------------------------------------- -->
    <template #overlay>
      <!-- 首次启动：探测失败/未设置时引导用户手动选择根目录 -->
      <FirstRunWizard
        v-if="showWizard"
        @done="scan.handleWizardDone"
        @close="closeWizard"
      />

      <!-- v0.3：预设管理器（position: fixed 浮层，不影响三栏布局） -->
      <PresetManager
        v-if="showPresets"
        :mods="mods"
        :applied-id="lastAppliedPresetId"
        @close="closePresets"
        @applied="handlePresetApplied"
      />

    <!-- v0.9：批量启用 / 禁用的二次确认（整批只写一次盘） -->
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

    <!-- 数据模组互斥：同一时间只能启用一个（游戏只加载一份 .dat） -->
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

    <!-- 放弃未保存排序的二次确认 -->
    <ConfirmDialog
      v-if="showDiscardConfirm"
      :title="t('sort.discardTitle')"
      :message="t('sort.discardMessage')"
      :confirm-label="t('sort.discardConfirm')"
      @confirm="discardSortChanges"
      @cancel="cancelDiscardSort"
    />

    <!-- v0.4：独立设置弹窗（通用 / 外观 / 网络 / 本地 / 在线 / 关于） -->
    <SettingsModal
      v-if="showSettings"
      v-model:card-size="cardSize"
      v-model:theme="theme"
      v-model:ui-font-family="uiFontFamily"
      v-model:ui-font-weight="uiFontWeight"
      v-model:global-font-scale="globalFontScale"
      v-model:reader-font-size="readerFontSize"
      v-model:reader-line-height="readerLineHeight"
      v-model:reader-font-weight="readerFontWeight"
      v-model:card-font-size="cardFontSize"
      :root-path="report?.root ?? ''"
      @close="closeSettings"
      @change-root="chooseRoot"
    />

    <!-- v3.1：新版本首启弹窗（lastSeenVersion ≠ 当前版本时只弹一次） -->
    <!-- 点遮罩不关闭：未点「我知道了」就不算已读，避免误触后下次又弹 -->
    <div v-if="versionNotes" class="version-notes-backdrop">
      <div class="version-notes" role="dialog" aria-modal="true">
        <header class="version-notes-head">
          <h2>{{ t("versionNotes.title", { version: versionNotes.version }) }}</h2>
          <span v-if="versionNotes.title !== `v${versionNotes.version}`" class="version-notes-sub">
            {{ versionNotes.title }}
          </span>
        </header>
        <div class="version-notes-body">
          <div v-if="versionNotes.html" class="release-notes" v-html="versionNotes.html"></div>
          <p v-else class="version-notes-fallback">
            {{ t("versionNotes.fallback", { version: versionNotes.version }) }}
          </p>
        </div>
        <footer class="version-notes-foot">
          <button type="button" class="primary" @click="dismissVersionNotes">
            {{ t("versionNotes.confirm") }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 轻量提示（排序已保存等）：固定右下角，不挤压布局 -->
    <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>

    <!-- 启动时发现新版本：右下角常驻提示，点击正文跳 GitHub Release，旁边给蓝奏云备用下载 -->
    <div v-if="updateNotice" class="app-toast update-toast" :class="{ stacked: !!toast }">
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
        @click="update.dismissUpdateNotice()"
      >
        ✕
      </button>
    </div>
    </template>
  </AppShell>
</template>

<style scoped>
/* ================= v2.0：列表抬头右侧的批量操作组 =================
   全局 .content-head 是「定高 + nowrap + overflow: hidden」的一行（防止分类名长短
   让卡片区上下跳），因此这里把四个按钮统一压一档字号与内边距：
   无论窗口多窄，它们都只占右侧一小块，绝不会把抬头撑高或把提示文字顶出可视区。 */
.content-head .batch-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  align-self: center;
  gap: 6px;
  margin-left: auto;
  min-width: 0;
}

.batch-actions .batch-btn {
  padding: 4px 9px;
  /* v2.4：批量操作按钮属于界面层，跟随全局缩放 */
  font-size: calc(11px * var(--global-scale));
  line-height: 1.45;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}

/* 窗口较窄（三栏被挤）时允许抬头换成两行：标题 + 提示一行，操作组整体落到右下角。
   .content-head 默认是 nowrap 的一行（定高防跳），这里只在窄屏放开。 */
@media (max-width: 1180px) {
  .content-head {
    flex-wrap: wrap;
    row-gap: 6px;
  }
}

/* 预设管理器：金色描边（原顶栏 .preset-entry 的视觉，按新容器重写一遍） */
.batch-actions .batch-btn.preset-entry {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-hover));
  letter-spacing: 1px;
}

/* 批量启用 / 禁用：绿色 / 红色描边（沿用 v0.9 的一套配色） */
.batch-actions .batch-btn.batch-enable,
.batch-actions .batch-btn.batch-disable {
  letter-spacing: 1px;
}
.batch-actions .batch-btn.batch-enable {
  color: var(--ok-text-strong);
  border-color: rgba(var(--ok-rgb), 0.5);
  background: linear-gradient(180deg, var(--ok-surface-top), var(--ok-surface-bottom));
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
}
.batch-actions .batch-btn.batch-disable:hover:not(:disabled) {
  color: var(--danger-text-strong);
  border-color: rgba(var(--danger-rgb), 0.85);
  background: linear-gradient(180deg, var(--danger-surface-top), var(--danger-surface-bottom));
}

/* 排序模式：同色系切换态 */
.batch-actions .batch-btn.sort-toggle.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
}


</style>
