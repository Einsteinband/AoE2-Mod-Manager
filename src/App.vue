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
  type TypographyPrefs,
  type UiFontFamily,
} from "./api";
import { applyLocale, detectSystemLocale, normalizeLocale } from "./i18n";
import { getTranslateSettings } from "./online/service";
import { kickIndexSync } from "./online/indexSync";
import { initDownloadQueue, onTaskSettled } from "./online/downloadQueue";
import { hydrateFavoriteMeta } from "./favoriteMeta";
import { SORT_OPTIONS } from "./online/types";
import { useToast } from "./composables/useToast";
import { useViewPrefs } from "./composables/useViewPrefs";
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

function submitOnlineSearch() {
  const next = onlineQueryDraft.value.trim();
  onlineQueryDraft.value = next;
  if (next === onlineQuery.value) {
    if (next) void onlineRef.value?.refresh?.();
    return;
  }
  onlineQuery.value = next;
}
function resetOnlineSearch() {
  onlineQueryDraft.value = "";
  onlineQuery.value = "";
}

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

/** 本地排序项（i18n 文案） */
const localSortOptions = computed(() => [
  { value: "name", label: t("toolbar.sortName") },
  { value: "updated", label: t("toolbar.sortUpdated") },
  { value: "download", label: t("toolbar.sortDownload") },
  { value: "priority", label: t("toolbar.sortPriority") },
  { value: "folder", label: t("toolbar.sortFolder") },
]);

const onlineSortOptions = computed(() =>
  SORT_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
);
const onlineOrderLabels = computed(() => ({
  desc: t("online.sortDesc"),
  asc: t("online.sortAsc"),
}));

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
  if (!themeReady) return;
  void setTheme(next).catch((e) => console.warn("[theme] failed to save", e));
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

// ---------------- 顶栏「启动游戏」 ----------------
const { launching: gameLaunching, launch: launchGameNow } = useGameLaunch({
  notify: showToast,
  normalizeError: (e: unknown) => String(e),
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

// ---------------- 作者主页 ----------------
const AUTHOR_URL = "https://github.com/Einsteinband";
async function openAuthorPage() {
  try { await openExternalUrl(AUTHOR_URL); } catch (e) { showToast(String(e), "error"); }
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
    :local-count="localRef?.modsCount ?? 0"
    @open-author="openAuthorPage"
    @open-settings="showSettings = true"
  >
    <!-- 顶栏工具栏 -->
    <template #toolbar>
      <!-- 本地模式 -->
      <ModToolbar
        v-if="mode === 'local'"
        v-model:search="localSearch"
        v-model:sort="localSortModel"
        v-model:view-mode="viewMode"
        :search-placeholder="localRef?.sortMode ? t('sort.searchDisabled') : t('search.placeholder')"
        :search-disabled="localRef?.sortMode ?? false"
        :sort-options="localSortOptions"
        :sort-disabled="localRef?.sortMode ?? false"
        :sort-title="localRef?.sortMode ? t('sort.sortDisabled') : t('toolbar.sortLabel')"
        :show-view-switch="false"
      >
        <template #extra>
          <button
            type="button"
            class="icon-btn"
            :disabled="(localRef?.loading ?? true) || !localRef?.hasReport"
            :title="t('toolbar.rescanTitle')"
            @click="localRef?.rescan()"
          >
            <span class="glyph">⟳</span>
            <span class="btn-text">{{ t("toolbar.rescan") }}</span>
          </button>
        </template>
      </ModToolbar>

      <!-- 在线模式 -->
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
          <button type="button" class="icon-btn" :title="t('online.refreshTitle')" @click="onlineRef?.refresh()">
            <span class="glyph">⟳</span>
            <span class="btn-text">{{ t("online.refresh") }}</span>
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
          @click="launchGameNow"
        >
          <span class="glyph">🎮</span>
          <span class="btn-text">{{ gameLaunching ? t("toolbar.launchGameBusy") : t("toolbar.launchGame") }}</span>
        </button>
        <ViewSwitch v-model:view-mode="viewMode" />
      </div>
    </template>

    <!-- 信息栏（rootbar）：数据从 LocalBrowser expose 获取 -->
    <template #info>
      <div v-if="mode === 'local'" class="rootbar">
        <span>{{ t("rootbar.root") }}</span>
        <span class="path" :title="localRef?.reportRoot ?? ''">{{ localRef?.reportRoot ?? t("rootbar.notSet") }}</span>
        <span class="sep">|</span>
        <span class="pill">{{ t("rootbar.local", { n: localRef?.sourceCounts?.local ?? 0 }) }}</span>
        <span class="pill">{{ t("rootbar.subscribed", { n: localRef?.sourceCounts?.subscribed ?? 0 }) }}</span>
        <span class="pill">
          {{ t("rootbar.showing", { shown: localRef?.sortedCount ?? 0, total: localRef?.modsCount ?? 0 }) }}
        </span>
        <span class="sep">|</span>
        <span>{{ t("rootbar.scannedAt", { time: localRef?.lastScanText ?? "" }) }}</span>
        <span class="spacer"></span>
        <button
          v-if="(localRef?.warnings?.length ?? 0) > 0"
          type="button"
          class="warn-pill"
          @click="localRef?.toggleWarnings?.()"
        >
          ⚠ {{ t("rootbar.warnings", { n: localRef?.warnings?.length ?? 0 }) }}
        </button>
      </div>
    </template>

    <!-- 主体：本地页 / 在线页 -->
    <KeepAlive>
      <LocalBrowser
        v-if="mode === 'local'"
        ref="localRef"
        v-model:search="localSearch"
        v-model:sort-model="localSortModel"
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
        v-model:ui-font-family="uiFontFamily"
        v-model:ui-font-weight="uiFontWeight"
        v-model:global-font-scale="globalFontScale"
        v-model:reader-font-size="readerFontSize"
        v-model:reader-line-height="readerLineHeight"
        v-model:reader-font-weight="readerFontWeight"
        v-model:card-font-size="cardFontSize"
        v-model:card-font-weight="cardFontWeight"
        v-model:latin-font="latinFont"
        :root-path="localRef?.reportRoot ?? ''"
        :initial-tab="settingsInitialTab"
        :focus-game-root="settingsFocusGameRoot"
        @close="closeSettings"
        @change-root="openGameRootSettings"
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
</style>
