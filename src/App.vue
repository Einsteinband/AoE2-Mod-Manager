<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AppShell from "./components/layout/AppShell.vue";
import ModToolbar from "./components/common/ModToolbar.vue";
import ViewSwitch from "./components/common/ViewSwitch.vue";
import OnlineBrowser from "./components/OnlineBrowser.vue";
import SettingsModal from "./components/SettingsModal.vue";
import DownloadManager from "./components/DownloadManager.vue";
import LocalBrowser from "./components/local/LocalBrowser.vue";
import {
  FONT_FAMILY_VARS,
  INSTALLED_CARD_DECOR_DEFAULTS,
  TYPOGRAPHY_DEFAULTS,
  appVersion,
  fetchGithubReleases,
  getSettings,
  normalizeInstalledCardDecor,
  normalizeTypography,
  normalizeVersion,
  openExternalUrl,
  renderReleaseMarkdown,
  saveInstalledCardDecorPrefs,
  saveTypographyPrefs,
  setAccent,
  setLocale as persistLocale,
  setTheme,
  type InstalledCardDecorPrefs,
  type TypographyPrefs,
  type UiAccent,
  type UiFontFamily,
} from "./api";
import type { ScanReport } from "./types";
import {
  ACCENT_CSS_VARS,
  DEFAULT_ACCENT,
  getAccentPalette,
  isAccentId,
  normalizeAccentTheme,
} from "./config/accentThemes";
import { applyLocale, detectSystemLocale, normalizeLocale } from "./i18n";
import { getTranslateSettings } from "./online/service";
import { kickIndexSync } from "./online/indexSync";
import { initDownloadQueue, onTaskSettled } from "./online/downloadQueue";
import { hydrateFavoriteMeta } from "./favoriteMeta";
import { normalizeBackendError } from "./format";
import { SORT_OPTIONS } from "./online/types";
import { useToast } from "./composables/useToast";
import { useViewPrefs } from "./composables/useViewPrefs";
import {
  normalizeOnlineSortForSetting,
  onlineSizeSortEnabled,
  visibleOnlineSortOptions,
} from "./composables/online/onlineSizeSortSetting";
import {
  applyTranslateSettings,
  syncUiLocale,
} from "./online/translation";
import {
  ensureStartupSession,
  localSearchEnabled,
  openSettingsNonce,
  sessionEpoch,
} from "./sessionState";
import { ensureUserData } from "./userData";
import { useGameLaunch } from "./composables/useGameLaunch";

/**
 * 应用外壳：只负责应用级职责。
 *
 * - 页面模式切换（本地/在线）
 * - 全局布局（AppShell 四层）
 * - 主题、排版、语言
 * - 全局弹窗（SettingsModal、版本更新说明）
 * - 全局下载管理器
 * - 应用初始化（登录态、设置读取、数据预热）
 *
 * 本地页面的全部业务逻辑在 LocalBrowser.vue 中。
 */

// ---------------- 页面模式 ----------------
const mode = ref<"local" | "online">("local");

// ---------------- 在线页搜索/排序（顶栏持有） ----------------
const onlineQuery = ref("");
const onlineQueryDraft = ref("");
const onlineSort = ref(SORT_OPTIONS[0].value);
const onlineOrder = ref<"DESC" | "ASC">("DESC");
const onlineRef = ref<InstanceType<typeof OnlineBrowser> | null>(null);

/** 官方搜索防抖：输入停顿后才把词写入已提交 query，避免连续输入刷请求 */
const ONLINE_SEARCH_DEBOUNCE_MS = 350;
let onlineSearchTimer: number | null = null;

function applyOnlineSearch(): void {
  const next = onlineQueryDraft.value.trim();
  // 与当前已提交词一致就不重复触发；清空也会走到这里，恢复默认官方列表
  if (next !== onlineQuery.value) onlineQuery.value = next;
}

watch(onlineQueryDraft, () => {
  if (onlineSearchTimer !== null) window.clearTimeout(onlineSearchTimer);
  onlineSearchTimer = window.setTimeout(applyOnlineSearch, ONLINE_SEARCH_DEBOUNCE_MS);
});

function resetOnlineSearch() {
  onlineQueryDraft.value = "";
  onlineQuery.value = "";
}

onBeforeUnmount(() => {
  if (onlineSearchTimer !== null) window.clearTimeout(onlineSearchTimer);
});

watch(sessionEpoch, (epoch) => {
  if (epoch > 0) void kickIndexSync(epoch);
});

// ---------------- i18n ----------------
const { t, locale } = useI18n();
const currentLocale = computed(() => String(locale.value));

// ---------------- Toast + 视图偏好 ----------------
const { toast, showToast } = useToast();
const { viewMode, cardSize, applyFromSettings: applyViewPrefs } = useViewPrefs();

// ---------------- 本地页引用（LocalBrowser template ref） ----------------
const localRef = ref<InstanceType<typeof LocalBrowser> | null>(null);
const modRoot = ref<string | null | undefined>(undefined);
const localSearch = ref("");
const localSortModel = ref("name");
const localOrder = ref<"DESC" | "ASC">("DESC");

/** 本地排序项（i18n 文案） */
const localSortOptions = computed(() => [
  { value: "name", label: t("toolbar.sortName") },
  { value: "updated", label: t("toolbar.sortUpdated") },
  { value: "size", label: t("toolbar.sortFileSize") },
  { value: "download", label: t("toolbar.sortDownload") },
  { value: "priority", label: t("toolbar.sortPriority") },
  { value: "folder", label: t("toolbar.sortFolder") },
]);
const localOrderLabels = computed(() => ({
  desc: t("online.sortDesc"),
  asc: t("online.sortAsc"),
}));

const onlineSortOptions = computed(() =>
  visibleOnlineSortOptions.value.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
);
const onlineOrderLabels = computed(() => ({
  desc: t("online.sortDesc"),
  asc: t("online.sortAsc"),
}));

watch(onlineSizeSortEnabled, () => {
  onlineSort.value = normalizeOnlineSortForSetting(onlineSort.value);
});

// ---------------- 主题 ----------------
type Theme = "dark" | "light";
const THEME_CACHE_KEY = "aoe2mm.theme";

function normalizeTheme(raw: unknown): Theme {
  return String(raw ?? "").toLowerCase() === "light" ? "light" : "dark";
}
function readCachedTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_CACHE_KEY));
  } catch {
    return "dark";
  }
}
function applyTheme(next: Theme) {
  document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, next);
  } catch { /* 忽略 */ }
}
const theme = ref<Theme>(readCachedTheme());
let themeReady = false;
applyTheme(theme.value);

watch(theme, (next) => {
  applyTheme(next);
  applyAccentPalette(accent.value, next);
  if (!themeReady) return;
  void setTheme(next).catch((e) => console.warn("[theme] failed to save", e));
});

// ---------------- 强调色（与明暗模式正交，驱动选中 / 主按钮 / 反馈 / Focus 等强调层） ----------------
const ACCENT_CACHE_KEY = "aoe2mm.accent";

function readCachedAccent(): UiAccent {
  try {
    return normalizeAccentTheme(window.localStorage.getItem(ACCENT_CACHE_KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** 把当前强调色对应明暗档位的调色板写进根节点 CSS 变量（注册表为唯一色值来源） */
function applyAccentPalette(accentId: UiAccent, mode: Theme) {
  const palette = getAccentPalette(accentId, mode);
  const root = document.documentElement;
  for (const { field, cssVar } of ACCENT_CSS_VARS) {
    root.style.setProperty(cssVar, palette[field]);
  }
}

function applyAccent(next: UiAccent) {
  document.documentElement.setAttribute("data-accent", next);
  applyAccentPalette(next, theme.value);
  try {
    window.localStorage.setItem(ACCENT_CACHE_KEY, next);
  } catch { /* 忽略 */ }
}
const accent = ref<UiAccent>(readCachedAccent());
let accentReady = false;
applyAccent(accent.value);

watch(accent, (next) => {
  applyAccent(next);
  if (!accentReady) return;
  // 写入侧防护：注册表外的 ID 不落盘（防御外部字符串 / 坏值被当成有效主题色保存）
  if (!isAccentId(next)) return;
  void setAccent(next).catch((e) => console.warn("[accent] failed to save", e));
});

// ---------------- 详情页辅助按钮样式：图标（默认）/ 原始文字 ----------------
type DetailButtonMode = "icon" | "text";
const DETAIL_BTN_MODE_CACHE_KEY = "aoe2mm.detailButtonMode";

function normalizeDetailBtnMode(raw: unknown): DetailButtonMode {
  return String(raw ?? "").toLowerCase() === "text" ? "text" : "icon";
}
function readCachedDetailBtnMode(): DetailButtonMode {
  try {
    return normalizeDetailBtnMode(window.localStorage.getItem(DETAIL_BTN_MODE_CACHE_KEY));
  } catch {
    return "icon";
  }
}
function applyDetailBtnMode(next: DetailButtonMode) {
  document.documentElement.dataset.detailButtonMode = next;
  try {
    window.localStorage.setItem(DETAIL_BTN_MODE_CACHE_KEY, next);
  } catch { /* 忽略 */ }
}
const detailButtonMode = ref<DetailButtonMode>(readCachedDetailBtnMode());
applyDetailBtnMode(detailButtonMode.value);

watch(detailButtonMode, (next) => {
  applyDetailBtnMode(next);
});

// ---------------- 排版（三层 CSS 变量） ----------------
const TYPO_CACHE_KEY = "aoe2mm.typography.v2";

function readCachedTypography(): TypographyPrefs {
  try {
    const raw = window.localStorage.getItem(TYPO_CACHE_KEY);
    if (!raw) return { ...TYPOGRAPHY_DEFAULTS };
    return normalizeTypography(JSON.parse(raw));
  } catch {
    return { ...TYPOGRAPHY_DEFAULTS };
  }
}

function applyTypography(next: TypographyPrefs) {
  const root = document.documentElement;
  const prefs = normalizeTypography(next);
  const baseFamily = FONT_FAMILY_VARS[prefs.fontFamily];
  const useLatinStack = prefs.latinFont && currentLocale.value !== "zh";
  root.style.setProperty(
    "--app-font-family",
    useLatinStack ? `var(--font-latin), ${baseFamily}` : baseFamily,
  );
  root.style.setProperty("--ui-font-weight", String(prefs.uiFontWeight));
  root.style.setProperty("--ui-font-weight-strong", prefs.uiFontWeight >= 600 ? "700" : "600");
  root.style.setProperty("--global-scale", String(prefs.globalScale / 100));
  root.style.setProperty("--reader-font-size", `${prefs.readerFontSize}px`);
  root.style.setProperty("--reader-line-height", String(prefs.readerLineHeight));
  root.style.setProperty("--reader-font-weight", String(prefs.readerFontWeight));
  root.style.setProperty("--card-font-size", `${prefs.cardFontSize}px`);
  root.style.setProperty("--card-font-weight", String(prefs.cardFontWeight));
  try {
    window.localStorage.setItem(TYPO_CACHE_KEY, JSON.stringify(prefs));
  } catch { /* 忽略 */ }
}

const cachedTypography = readCachedTypography();
const uiFontFamily = ref<UiFontFamily>(cachedTypography.fontFamily);
const uiFontWeight = ref<number>(cachedTypography.uiFontWeight);
const globalFontScale = ref<number>(cachedTypography.globalScale);
const readerFontSize = ref<number>(cachedTypography.readerFontSize);
const readerLineHeight = ref<number>(cachedTypography.readerLineHeight);
const readerFontWeight = ref<number>(cachedTypography.readerFontWeight);
const cardFontSize = ref<number>(cachedTypography.cardFontSize);
const cardFontWeight = ref<number>(cachedTypography.cardFontWeight);
const latinFont = ref<boolean>(cachedTypography.latinFont);

function currentTypography(): TypographyPrefs {
  return normalizeTypography({
    fontFamily: uiFontFamily.value,
    uiFontWeight: uiFontWeight.value,
    globalScale: globalFontScale.value,
    readerFontSize: readerFontSize.value,
    readerLineHeight: readerLineHeight.value,
    readerFontWeight: readerFontWeight.value,
    cardFontSize: cardFontSize.value,
    cardFontWeight: cardFontWeight.value,
    latinFont: latinFont.value,
  });
}

let typographyReady = false;
let persistedTypography: TypographyPrefs = { ...cachedTypography };
let typographyTimer: ReturnType<typeof setTimeout> | null = null;

function sameTypography(a: TypographyPrefs, b: TypographyPrefs): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.uiFontWeight === b.uiFontWeight &&
    a.globalScale === b.globalScale &&
    a.readerFontSize === b.readerFontSize &&
    a.readerLineHeight === b.readerLineHeight &&
    a.readerFontWeight === b.readerFontWeight &&
    a.cardFontSize === b.cardFontSize &&
    a.cardFontWeight === b.cardFontWeight &&
    a.latinFont === b.latinFont
  );
}

applyTypography(cachedTypography);

watch(currentLocale, () => applyTypography(currentTypography()));

watch(
  [uiFontFamily, uiFontWeight, globalFontScale, readerFontSize, readerLineHeight, readerFontWeight, cardFontSize, cardFontWeight, latinFont],
  () => {
    const next = currentTypography();
    applyTypography(next);
    if (!typographyReady) return;
    if (sameTypography(next, persistedTypography)) return;
    if (typographyTimer) clearTimeout(typographyTimer);
    typographyTimer = setTimeout(() => {
      if (sameTypography(next, persistedTypography)) return;
      persistedTypography = next;
      void saveTypographyPrefs(next).catch((e) => console.warn("[typography] failed", e));
    }, 300);
  },
);

onBeforeUnmount(() => {
  if (typographyTimer) clearTimeout(typographyTimer);
});

// ---------------- 已安装卡片装饰开关（背景 / 左侧条 / 右下角斜纹） ----------------
const DECOR_CACHE_KEY = "aoe2mm.installedCardDecor.v1";

function readCachedDecor(): InstalledCardDecorPrefs {
  try {
    const raw = window.localStorage.getItem(DECOR_CACHE_KEY);
    if (!raw) return { ...INSTALLED_CARD_DECOR_DEFAULTS };
    return normalizeInstalledCardDecor(JSON.parse(raw));
  } catch {
    return { ...INSTALLED_CARD_DECOR_DEFAULTS };
  }
}

function applyDecor(next: InstalledCardDecorPrefs) {
  const root = document.documentElement;
  const prefs = normalizeInstalledCardDecor(next);
  root.dataset.installedCardBg = prefs.cardBg ? "on" : "off";
  root.dataset.installedCardBar = prefs.sideBar ? "on" : "off";
  root.dataset.installedCardStripes = prefs.cornerStripes ? "on" : "off";
  try {
    window.localStorage.setItem(DECOR_CACHE_KEY, JSON.stringify(prefs));
  } catch { /* 忽略 */ }
}

const cachedDecor = readCachedDecor();
const installedCardBg = ref<boolean>(cachedDecor.cardBg);
const installedCardBar = ref<boolean>(cachedDecor.sideBar);
const installedCardStripes = ref<boolean>(cachedDecor.cornerStripes);

function currentDecor(): InstalledCardDecorPrefs {
  return normalizeInstalledCardDecor({
    cardBg: installedCardBg.value,
    sideBar: installedCardBar.value,
    cornerStripes: installedCardStripes.value,
  });
}

let decorReady = false;
let persistedDecor: InstalledCardDecorPrefs = { ...cachedDecor };
let decorTimer: ReturnType<typeof setTimeout> | null = null;

function sameDecor(a: InstalledCardDecorPrefs, b: InstalledCardDecorPrefs): boolean {
  return a.cardBg === b.cardBg && a.sideBar === b.sideBar && a.cornerStripes === b.cornerStripes;
}

applyDecor(cachedDecor);

watch(
  [installedCardBg, installedCardBar, installedCardStripes],
  () => {
    const next = currentDecor();
    applyDecor(next);
    if (!decorReady) return;
    if (sameDecor(next, persistedDecor)) return;
    if (decorTimer) clearTimeout(decorTimer);
    decorTimer = setTimeout(() => {
      if (sameDecor(next, persistedDecor)) return;
      persistedDecor = next;
      void saveInstalledCardDecorPrefs(next).catch((e) => console.warn("[installed-card-decor] failed", e));
    }, 300);
  },
);

onBeforeUnmount(() => {
  if (decorTimer) clearTimeout(decorTimer);
});

// ---------------- 顶栏「启动游戏」 ----------------
const { launching: gameLaunching, launch: launchGameNow } = useGameLaunch({
  notify: showToast,
  normalizeError: normalizeBackendError,
  openGameRootSettings,
  texts: () => ({
    started: t("toolbar.launchGameStarted"),
    needRoot: t("toolbar.launchGameNoRoot"),
  }),
});

// ---------------- 设置弹窗 ----------------
const showSettings = ref(false);
const settingsInitialTab = ref<"general" | "appearance" | "network" | "local" | "online" | "storage" | "about">("general");
const settingsFocusGameRoot = ref(false);

watch(openSettingsNonce, () => { showSettings.value = true; });

function closeSettings() {
  showSettings.value = false;
  settingsFocusGameRoot.value = false;
  settingsInitialTab.value = "general";
}

function openGameRootSettings() {
  settingsInitialTab.value = "general";
  settingsFocusGameRoot.value = true;
  showSettings.value = true;
}

/**
 * 设置 → 通用「更换根目录」：后端已经按新根目录重扫完，这里只把结果交给本地页接管。
 * 旧实现把这个事件接到 openGameRootSettings（= 打开设置 + 闪烁游戏根目录），
 * 而按钮本身就在设置页里，所以点下去毫无反应。
 */
function onModRootChanged(report: ScanReport): void {
  localRef.value?.applyReport(report);
}

// ---------------- 作者主页 ----------------
const AUTHOR_URL = "https://github.com/Einsteinband";
async function openAuthorPage() {
  try { await openExternalUrl(AUTHOR_URL); } catch (e) { showToast(normalizeBackendError(e), "error"); }
}

// ---------------- 版本更新说明（每版本只弹一次） ----------------
const LAST_SEEN_VERSION_KEY = "aoe2.lastSeenVersion";
interface VersionNotes { version: string; title: string; html: string; }
const versionNotes = ref<VersionNotes | null>(null);
let versionNotesChecked = false;
const VERSION_NOTES_FETCH_TIMEOUT_MS = 10000;

function readLastSeenVersion(): string {
  try { return window.localStorage.getItem(LAST_SEEN_VERSION_KEY) ?? ""; } catch { return ""; }
}
function writeLastSeenVersion(version: string) {
  try { window.localStorage.setItem(LAST_SEEN_VERSION_KEY, version); } catch { /* 忽略 */ }
}
function sameVersion(a: string, b: string): boolean {
  return normalizeVersion(a) === normalizeVersion(b);
}
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), ms);
    task.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e) => { window.clearTimeout(timer); reject(e); },
    );
  });
}

async function showVersionNotesIfNeeded() {
  if (versionNotesChecked) return;
  versionNotesChecked = true;
  let current = "";
  try { current = await appVersion(); } catch { return; }
  if (!current) { versionNotesChecked = false; return; }
  if (sameVersion(readLastSeenVersion(), current)) return;
  let title = `v${current}`;
  let html = "";
  try {
    const releases = await withTimeout(fetchGithubReleases(), VERSION_NOTES_FETCH_TIMEOUT_MS);
    const hit = releases.find((r) => sameVersion(r.version || r.tagName, current));
    if (hit?.name?.trim()) title = hit.name.trim();
    html = hit ? renderReleaseMarkdown(hit.body ?? "") : "";
  } catch { /* 静默 */ }
  versionNotes.value = { version: current, title, html };
}

function dismissVersionNotes() {
  const v = versionNotes.value?.version;
  if (v) writeLastSeenVersion(v);
  versionNotes.value = null;
}

// ---------------- 下载队列完成 → 通知本地页重扫 ----------------
let offDownloadSettled: (() => void) | null = null;

// ---------------- 切页保护：排序模式有未保存改动时不允许切到在线 ----------------
watch(mode, (next) => {
  if (next === "local") return;
  if (localRef.value?.sortBlocksRescan) {
    mode.value = "local";
    showToast(t("sort.unsavedBlock"), "error");
    return;
  }
  localRef.value?.exitSortMode();
});

// ---------------- 语言切换联动 ----------------
watch(locale, (next) => { syncUiLocale(String(next)); });

// ---------------- 启动初始化 ----------------
onMounted(async () => {
  void ensureStartupSession();
  void initDownloadQueue();
  void ensureUserData().then(() => hydrateFavoriteMeta()).catch(() => undefined);

  // 下载完成 → 通知 LocalBrowser 重扫
  offDownloadSettled = onTaskSettled((task) => {
    if (task.status !== "done") return;
    localRef.value?.refresh();
  });

  try {
    const settings = await getSettings();
    localSearchEnabled.value = settings.enableLocalSearch === true;
    applyViewPrefs(settings);
    theme.value = normalizeTheme(settings.theme);
    applyTheme(theme.value);
    themeReady = true;
    accent.value = normalizeAccentTheme(settings.accent);
    applyAccent(accent.value);
    accentReady = true;

    const typoPrefs = normalizeTypography({
      fontFamily: settings.uiFontFamily,
      uiFontWeight: settings.uiFontWeight,
      globalScale: settings.globalFontScale,
      readerFontSize: settings.readerFontSize,
      readerLineHeight: settings.readerLineHeight,
      readerFontWeight: settings.readerFontWeight,
      cardFontSize: settings.cardFontSize,
      cardFontWeight: settings.cardFontWeight,
    });
    uiFontFamily.value = typoPrefs.fontFamily;
    uiFontWeight.value = typoPrefs.uiFontWeight;
    globalFontScale.value = typoPrefs.globalScale;
    readerFontSize.value = typoPrefs.readerFontSize;
    readerLineHeight.value = typoPrefs.readerLineHeight;
    readerFontWeight.value = typoPrefs.readerFontWeight;
    cardFontSize.value = typoPrefs.cardFontSize;
    cardFontWeight.value = typoPrefs.cardFontWeight;
    applyTypography(typoPrefs);
    persistedTypography = { ...typoPrefs };
    typographyReady = true;

    const decorPrefs = normalizeInstalledCardDecor({
      cardBg: settings.installedCardBgEnabled,
      sideBar: settings.installedCardBarEnabled,
      cornerStripes: settings.installedCardStripesEnabled,
    });
    installedCardBg.value = decorPrefs.cardBg;
    installedCardBar.value = decorPrefs.sideBar;
    installedCardStripes.value = decorPrefs.cornerStripes;
    applyDecor(decorPrefs);
    persistedDecor = { ...decorPrefs };
    decorReady = true;

    const savedLocale = normalizeLocale(settings.locale);
    applyLocale(savedLocale ?? detectSystemLocale());
    if (!savedLocale) void persistLocale(locale.value).catch(() => undefined);

    try {
      const translateView = await getTranslateSettings();
      applyTranslateSettings(translateView, String(locale.value));
    } catch { /* 忽略 */ }

    // 把 modRoot 传给 LocalBrowser，触发它的初始化扫描
    modRoot.value = settings.modRoot ?? null;
  } catch {
    modRoot.value = null;
  }

  // 版本更新说明（等 FirstRunWizard 关闭后再弹）
  const checkVersionNotes = () => { void showVersionNotesIfNeeded(); };
  // LocalBrowser 的 showWizard 状态由它自己管理，这里简单延迟弹出版本说明
  setTimeout(checkVersionNotes, 500);
});

onBeforeUnmount(() => {
  offDownloadSettled?.();
});
</script>

<template>
  <AppShell
    v-model:mode="mode"
    :author-url="AUTHOR_URL"
    :local-count="localRef?.sourceCounts?.local ?? 0"
    :root-path="localRef?.reportRoot ?? ''"
    :subscribed-count="localRef?.sourceCounts?.subscribed ?? 0"
    :showing-count="localRef?.sortedCount ?? 0"
    :total-count="localRef?.modsCount ?? 0"
    :scanned-at="localRef?.lastScanText ?? ''"
    :warning-count="localRef?.warnings?.length ?? 0"
    @open-author="openAuthorPage"
    @open-settings="showSettings = true"
    @toggle-warnings="localRef?.toggleWarnings?.()"
  >
    <!-- 顶栏工具栏 -->
    <template #toolbar>
      <!-- 本地模式 -->
      <ModToolbar
        v-if="mode === 'local'"
        v-model:search="localSearch"
        v-model:sort="localSortModel"
        v-model:order="localOrder"
        v-model:view-mode="viewMode"
        :search-placeholder="localRef?.sortMode ? t('sort.searchDisabled') : t('search.placeholder')"
        :search-disabled="localRef?.sortMode ?? false"
        :sort-options="localSortOptions"
        :sort-disabled="localRef?.sortMode ?? false"
        :sort-title="localRef?.sortMode ? t('sort.sortDisabled') : t('toolbar.sortLabel')"
        :order-labels="localSortModel === 'size' ? localOrderLabels : null"
        :order-title="t('online.orderLabel')"
        :show-view-switch="false"
      >
        <template #extra>
          <button
            type="button"
            class="icon-btn refresh-btn"
            :disabled="(localRef?.loading ?? true) || !localRef?.hasReport"
            :title="t('toolbar.rescan')"
            :aria-label="t('toolbar.rescan')"
            @click="localRef?.rescan()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <path
                d="M20 3v4h-4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </template>
      </ModToolbar>

      <!-- 在线模式：输入即防抖自动触发（无独立搜索按钮） -->
      <ModToolbar
        v-else
        v-model:search="onlineQueryDraft"
        v-model:sort="onlineSort"
        v-model:order="onlineOrder"
        v-model:view-mode="viewMode"
        :search-placeholder="t('online.officialSearchPlaceholder')"
        :search-title="t('online.officialSearchHint')"
        :clear-visible="Boolean(onlineQueryDraft || onlineQuery)"
        :sort-options="onlineSortOptions"
        :sort-title="t('toolbar.sortLabel')"
        :order-labels="onlineOrderLabels"
        :order-title="t('online.orderLabel')"
        :show-view-switch="false"
        @clear="resetOnlineSearch"
      >
        <template #extra>
          <button
            type="button"
            class="icon-btn refresh-btn"
            :disabled="Boolean(onlineRef?.loading)"
            :title="t('online.refreshTitle')"
            :aria-label="t('online.refresh')"
            @click="onlineRef?.refresh()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <path
                d="M20 3v4h-4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </template>
      </ModToolbar>

      <!-- 顶栏右端 -->
      <div class="topbar-actions">
        <button
          type="button"
          class="launch-game-btn"
          :disabled="gameLaunching"
          :title="t('toolbar.launchGameTitle')"
          :aria-label="gameLaunching ? t('toolbar.launchGameBusy') : t('toolbar.launchGame')"
          @click="launchGameNow"
        >
          <span class="glyph">🎮</span>
          <span class="btn-text">{{ gameLaunching ? t("toolbar.launchGameBusy") : t("toolbar.launchGame") }}</span>
        </button>
        <ViewSwitch v-model:view-mode="viewMode" />
      </div>
    </template>

    <!-- 主体：本地页 / 在线页 -->
    <KeepAlive>
      <LocalBrowser
        v-if="mode === 'local'"
        ref="localRef"
        v-model:search="localSearch"
        v-model:sort-model="localSortModel"
        v-model:order-model="localOrder"
        :mod-root="modRoot"
        :view-mode="viewMode"
        :card-size="cardSize"
      />
    </KeepAlive>

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

    <!-- 全局浮层 -->
    <template #overlay>
      <SettingsModal
        v-if="showSettings"
        v-model:card-size="cardSize"
        v-model:theme="theme"
        v-model:accent="accent"
        v-model:ui-font-family="uiFontFamily"
        v-model:ui-font-weight="uiFontWeight"
        v-model:global-font-scale="globalFontScale"
        v-model:reader-font-size="readerFontSize"
        v-model:reader-line-height="readerLineHeight"
        v-model:reader-font-weight="readerFontWeight"
        v-model:card-font-size="cardFontSize"
        v-model:card-font-weight="cardFontWeight"
        v-model:latin-font="latinFont"
        v-model:installed-card-bg="installedCardBg"
        v-model:installed-card-bar="installedCardBar"
        v-model:installed-card-stripes="installedCardStripes"
        v-model:detail-button-mode="detailButtonMode"
        :root-path="localRef?.reportRoot ?? ''"
        :initial-tab="settingsInitialTab"
        :focus-game-root="settingsFocusGameRoot"
        @close="closeSettings"
        @root-changed="onModRootChanged"
      />

      <!-- 版本更新说明 -->
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

      <!-- 轻量提示 -->
      <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>

      <!-- 全局下载管理 -->
      <DownloadManager />
    </template>
  </AppShell>
</template>

<style scoped>
.app-toast {
  bottom: 96px;
}

/* 顶栏「启动游戏」按钮 */
.topbar-actions .launch-game-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  /* 操作按钮不可被 flex 压缩：内在宽度由内容决定，图标 / 文字切换只由 TopBar 布局阶段负责 */
  flex: 0 0 auto;
  flex-shrink: 0;
  width: auto;
  min-width: 0;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
  font-family: inherit;
  font-size: calc(11.5px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: calc(0.6px * var(--ui-tracking));
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border: 1px solid var(--gold-dim);
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.22);
}
.topbar-actions .launch-game-btn:hover:not(:disabled) {
  color: var(--text-on-accent);
  border-color: var(--gold);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  filter: brightness(1.08);
}
.topbar-actions .launch-game-btn:disabled {
  opacity: 0.62;
  cursor: progress;
}
.topbar-actions .launch-game-btn .glyph {
  font-size: calc(12.5px * var(--global-scale));
  line-height: 1;
}

/* 顶栏刷新 / 本地重扫：纯图标，跟随当前主题强调色，不使用固定蓝色。 */
.refresh-btn {
  width: 36px;
  padding: 0;
  justify-content: center;
  gap: 0;
  color: var(--accent-text);
  border-color: rgba(var(--accent-rgb), 0.45);
  background: var(--bg-panel-deep);
}
.refresh-btn:hover:not(:disabled) {
  color: var(--accent-bright);
  border-color: var(--accent);
  background: var(--bg-panel);
}
.refresh-btn:disabled {
  opacity: 0.55;
  cursor: progress;
}
.refresh-btn svg {
  width: 18px;
  height: 18px;
}
</style>
