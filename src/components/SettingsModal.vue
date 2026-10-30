<script setup lang="ts">
/**
 * v0.4 独立设置弹窗：通用（语言 + 检查更新）/ 网络（代理 + 记住登录）/ 关于。
 *
 * 代理与语言从原来的「顶栏语言下拉 + 在线页侧栏折叠面板」整体迁移到这里：
 * - 语言：applyLocale 立即生效，再 setLocale 写 settings.json（失败只报错，不回滚 UI）
 * - 代理：复用 set_network_settings（Rust 侧会重建登录窗口让它立即生效）
 *
 * 15 秒冷却：lastCheckMs 放在模块作用域，关掉弹窗再打开也绕不过去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { appVersion, checkUpdate, openExternalUrl, setLocale } from "../api";
import { translateBackendMessage } from "../format";
import { applyLocale, LOCALE_OPTIONS, type Locale } from "../i18n";
import { getNetworkSettings, setNetworkSettings } from "../online/service";
import {
  getTranslateSettings,
  setTranslateSettings,
  translationCacheClear,
  translationCacheStat,
} from "../online/service";
import {
  applyTranslateSettings,
  languageName,
  resetTranslations,
} from "../online/translation";
import { clearOnlineCache, onlineCacheStat } from "../online/cache";
import {
  canCheck as modCanCheck,
  checking as modChecking,
  cooldownLeft as modCooldown,
  error as modError,
  report as modReport,
  resumeCooldown as resumeModCooldown,
  runModUpdateCheck,
} from "../modUpdates";
import type { CacheOverview, NetworkSettingsView, TranslateSettingsView, TranslationCacheStat } from "../online/types";
import type { UpdateInfo } from "../types";

const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();

type Tab = "general" | "network" | "translate" | "about";
const tab = ref<Tab>("general");

const REPO_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const AUTHOR_URL = "https://github.com/Einsteinband";

function describe(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return String(e);
  }
}

// ---------------- 通用：语言 ----------------

const currentLocale = computed(() => String(locale.value));
const localeSaving = ref(false);
const localeError = ref<string | null>(null);

async function changeLocale(event: Event) {
  const next = (event.target as HTMLSelectElement).value as Locale;
  // 先切 UI（立即生效），再落盘；写盘失败只提示，不把界面弹回去
  applyLocale(next);
  localeSaving.value = true;
  localeError.value = null;
  try {
    await setLocale(next);
  } catch (e) {
    localeError.value = describe(e);
  } finally {
    localeSaving.value = false;
  }
}

// ---------------- 通用：版本 + 检查更新 ----------------

const version = ref("—");
const currentVersionText = computed(() => t("settings.currentVersion", { version: version.value }));

/** 冷却时长：15 秒内不允许再次请求 GitHub（同时防止 403 限流） */
const COOLDOWN_MS = 15_000;
/** 模块作用域：弹窗关闭再打开仍然记住上次检查时间 */
let lastCheckMs = 0;

const checking = ref(false);
const checkError = ref<string | null>(null);
const latest = ref<UpdateInfo | null>(null);
const cooldownLeft = ref(0);
let cooldownTimer: number | null = null;

const canCheck = computed(() => !checking.value && cooldownLeft.value === 0);
const hasUpdate = computed(() => latest.value?.hasUpdate === true);

/** 冷却倒计时：250ms 一跳，归零后自动清掉定时器 */
function startCooldownTimer() {
  const tick = () => {
    const left = COOLDOWN_MS - (Date.now() - lastCheckMs);
    if (left <= 0) {
      cooldownLeft.value = 0;
      if (cooldownTimer !== null) {
        window.clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      return;
    }
    cooldownLeft.value = Math.ceil(left / 1000);
  };
  if (cooldownTimer !== null) window.clearInterval(cooldownTimer);
  tick();
  if (cooldownLeft.value > 0) cooldownTimer = window.setInterval(tick, 250);
}

/** 成功或失败都进冷却：GitHub 匿名接口被刷会直接 403 */
function enterCooldown() {
  lastCheckMs = Date.now();
  startCooldownTimer();
}

/** 状态机文案：idle → loading → cooldown（✓已是最新）/ error */
const checkStatusText = computed(() => {
  if (checking.value) return t("settings.checking");
  if (checkError.value) return checkError.value;
  if (latest.value?.hasUpdate) return t("settings.found", { version: latest.value.latestVersion });
  if (cooldownLeft.value > 0) return t("settings.cooldown", { s: cooldownLeft.value });
  if (latest.value) return t("settings.upToDate");
  return t("settings.checkIdle");
});

async function runCheck() {
  if (!canCheck.value) return;
  checking.value = true;
  checkError.value = null;
  latest.value = null;
  try {
    const info = await checkUpdate();
    latest.value = info;
    version.value = info.currentVersion || version.value;
    enterCooldown();
    // 手动点“检查更新”属于明确意图：发现新版本就直接拉起系统浏览器
    if (info.hasUpdate) {
      try {
        await openExternalUrl(info.releaseUrl);
      } catch (e) {
        checkError.value = describe(e);
      }
    }
  } catch (e) {
    checkError.value = describe(e);
    enterCooldown();
  } finally {
    checking.value = false;
  }
}

async function openRelease() {
  const url = latest.value?.releaseUrl ?? `${REPO_URL}/releases/latest`;
  try {
    await openExternalUrl(url);
  } catch (e) {
    checkError.value = describe(e);
  }
}

async function openRepo() {
  try {
    await openExternalUrl(REPO_URL);
  } catch (e) {
    checkError.value = describe(e);
  }
}

async function openAuthor() {
  try {
    await openExternalUrl(AUTHOR_URL);
  } catch (e) {
    checkError.value = describe(e);
  }
}

// ---------------- 通用：本地模组批量更新检测（用户点击才触发） ----------------

const modStatusText = computed(() => {
  if (modChecking.value) return t("settings.modUpdateChecking");
  if (modError.value) return modError.value;
  const rep = modReport.value;
  if (!rep) return t("settings.modUpdateIdle");
  const base =
    rep.updateCount > 0
      ? t("settings.modUpdateResult", {
          n: rep.updateCount,
          total: rep.totalLocal,
          pages: rep.pages,
        })
      : t("settings.modUpdateAllCurrent", { total: rep.totalLocal, pages: rep.pages });
  const unknown =
    rep.unknownCount > 0 ? ` ${t("settings.modUpdateUnknown", { n: rep.unknownCount })}` : "";
  const cooldown =
    modCooldown.value > 0 ? ` ${t("settings.modUpdateCooldown", { s: modCooldown.value })}` : "";
  return `${base}${unknown}${cooldown}`;
});

async function runModCheck() {
  await runModUpdateCheck();
}

// ---------------- 网络：代理 + 记住登录 ----------------

const netView = ref<NetworkSettingsView | null>(null);
const netAuto = ref(true);
const netUrl = ref("");
const netRemember = ref(true);
const netSaving = ref(false);
const netError = ref<string | null>(null);
const netMessage = ref<string | null>(null);
const netLoading = ref(false);

// ---------------- 网络：在线数据缓存（v0.6） ----------------

const cacheStat = ref<CacheOverview | null>(null);
const cacheBusy = ref(false);
const cacheMessage = ref<string | null>(null);
const cacheError = ref<string | null>(null);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 缓存概览文案：JSON 记录 + 封面图分开报，0 条时明确说“暂无缓存” */
const cacheStatusText = computed(() => {
  const stat = cacheStat.value;
  if (!stat) return t("cache.reading");
  if (stat.entries <= 0 && stat.imageEntries <= 0) return t("cache.empty");
  const json = t("cache.stat", { n: stat.entries, size: formatBytes(stat.bytes) });
  const images = t("cache.imageLine", {
    n: stat.imageEntries,
    size: formatBytes(stat.imageBytes),
  });
  return `${json} · ${images}`;
});

async function loadCacheStat() {
  try {
    cacheStat.value = await onlineCacheStat();
  } catch {
    cacheStat.value = null;
  }
}

/** 清理：Rust 同时删 online_cache.json 与 image_cache，完成后重读概览 */
async function doClearCache() {
  if (cacheBusy.value) return;
  cacheBusy.value = true;
  cacheError.value = null;
  cacheMessage.value = null;
  try {
    const report = await clearOnlineCache();
    const removed = report.entriesRemoved > 0 || report.imagesRemoved > 0 || report.removed;
    cacheMessage.value = removed
      ? t("cache.cleared", { n: report.entriesRemoved, images: report.imagesRemoved })
      : t("cache.clearedEmpty");
    await loadCacheStat();
  } catch (e) {
    cacheError.value = t("cache.error", { msg: describe(e) });
  } finally {
    cacheBusy.value = false;
  }
}

/** 折叠面板里那句“当前走哪条链路” */
const netSummary = computed(() => {
  const view = netView.value;
  if (!view) return t("online.netReading");
  if (view.error) return t("online.netConfigError");
  const proxy = view.effectiveProxy;
  switch (view.source) {
    case "manual":
      return t("online.netManual", { proxy: proxy ?? t("online.netNotSet") });
    case "system":
      return t("online.netSystem", { proxy: proxy ?? t("online.netDirectWord") });
    case "env":
      return t("online.netEnv", { proxy: proxy ?? t("online.netUnknownWord") });
    default:
      return t("online.netDirect");
  }
});

async function loadNetwork() {
  netLoading.value = true;
  netError.value = null;
  try {
    const view = await getNetworkSettings();
    netView.value = view;
    netAuto.value = view.auto;
    netRemember.value = view.rememberLogin;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? view.effectiveProxy ?? "");
    if (view.error) netError.value = view.error;
  } catch (e) {
    netError.value = describe(e);
  } finally {
    netLoading.value = false;
  }
}

async function saveNetwork() {
  if (netSaving.value) return;
  netSaving.value = true;
  netError.value = null;
  netMessage.value = null;
  try {
    const view = await setNetworkSettings({
      auto: netAuto.value,
      proxyUrl: netAuto.value ? null : netUrl.value.trim(),
      rememberLogin: netRemember.value,
    });
    netView.value = view;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? "");
    if (view.error) {
      netError.value = view.error;
    } else {
      netMessage.value = t("online.netSaved", {
        proxy: view.effectiveProxy ?? t("online.netDirectWord"),
      });
    }
  } catch (e) {
    netError.value = describe(e);
  } finally {
    netSaving.value = false;
  }
}

// ---------------- 翻译（目标语言 / 引擎 / 缓存） ----------------

const translateView = ref<TranslateSettingsView | null>(null);
const translateLoading = ref(false);
const translateSaving = ref(false);
const translateError = ref<string | null>(null);
const translateMessage = ref<string | null>(null);

/** 下拉框的值："" = 跟随界面语言 */
const targetChoice = ref("");
const engineChoice = ref("auto");
const customUrl = ref("");
/** 只输入新 key；留空 = 不修改已保存的 key */
const customKey = ref("");

const translationCache = ref<TranslationCacheStat | null>(null);
const translationCacheBusy = ref(false);
const translationCacheMessage = ref<string | null>(null);
const translationCacheError = ref<string | null>(null);

const supportedLangs = computed<string[]>(
  () => translateView.value?.supportedLanguages ?? ["zh-cn", "zh-tw", "en", "ja", "ko", "ru", "fr", "de", "es"],
);

/** 当前实际生效的语言名（跟随模式会随 UI 语言提示） */
const effectiveTargetLabel = computed(() =>
  languageName(translateView.value?.resolvedLanguage ?? "zh-cn"),
);

/** 下拉候选：Rust 预设列表 + 已保存但不在预设里的自定义值（防止回显成空白项） */
const targetOptions = computed<string[]>(() => {
  const list = [...supportedLangs.value];
  const saved = (translateView.value?.targetLanguage ?? "").trim();
  if (saved && !list.includes(saved)) list.push(saved);
  return list;
});

/** 上一次**成功落盘**的值：切换失败时用它把下拉框退回去 */
const savedTargetChoice = ref("");
const savedEngineChoice = ref("auto");

/** 两个下拉框的 DOM 引用：Vue 只在 ref 变化时回写 value，回退时需要显式对齐 */
const targetSelect = ref<HTMLSelectElement | null>(null);
const engineSelect = ref<HTMLSelectElement | null>(null);

function syncSelectDom() {
  if (targetSelect.value) targetSelect.value.value = targetChoice.value;
  if (engineSelect.value) engineSelect.value.value = engineChoice.value;
}

const translationCacheText = computed(() => {
  const stat = translationCache.value;
  if (!stat) return t("translateCache.reading");
  if (stat.entries <= 0) return t("translateCache.empty");
  const langs = stat.byLanguage
    .map((item) => `${languageName(item.lang)} ${item.count}`)
    .join(" · ");
  return t("translateCache.stat", {
    n: stat.entries,
    mods: stat.mods,
    size: formatBytes(stat.bytes),
    langs,
  });
});

function pickSelect(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

async function loadTranslate() {
  translateLoading.value = true;
  translateError.value = null;
  try {
    const view = await getTranslateSettings();
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = view.provider;
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = view.provider;
    customUrl.value = view.customUrl ?? "";
    customKey.value = "";
  } catch (e) {
    translateError.value = describe(e);
  } finally {
    translateLoading.value = false;
  }
}

/**
 * 保存并**立即生效**：解析出具体语言、清空预热，列表会自己重新接缓存。
 * 返回 true = 已落盘；false = 失败（调用方负责把下拉框退回旧值）。
 */
async function saveTranslate(): Promise<boolean> {
  if (translateSaving.value) return false;
  translateSaving.value = true;
  translateError.value = null;
  translateMessage.value = null;
  try {
    const view = await setTranslateSettings({
      targetLanguage: targetChoice.value,
      provider: engineChoice.value,
      customUrl: customUrl.value.trim() || null,
      customKey: customKey.value.trim() || null,
    });
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = view.provider;
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = view.provider;
    customKey.value = "";
    // 全局状态：立即更新 targetLang + langEpoch++，详情页/列表按钮文案同步刷新
    applyTranslateSettings(view, String(locale.value));
    translateMessage.value = t("settings.translateSaved");
    return true;
  } catch (e) {
    translateError.value = describe(e);
    return false;
  } finally {
    translateSaving.value = false;
  }
}

/**
 * 下拉框**即时保存**：改完立刻落盘 + 同步全局状态。
 * 失败（写盘异常 / 后端拒绝）→ 把两个下拉框都退回上次成功的值，界面与磁盘保持一致。
 */
async function commitTranslate(pick: "target" | "engine", next: string) {
  // 上一次保存还没回来：忽略这次切换，并把下拉框的 DOM 值退回当前状态
  if (translateSaving.value) {
    syncSelectDom();
    return;
  }
  if (pick === "target") targetChoice.value = next;
  else engineChoice.value = next;
  const prevTarget = savedTargetChoice.value;
  const prevEngine = savedEngineChoice.value;
  const ok = await saveTranslate();
  if (ok) return;
  // 回退：下拉框回到上一次成功保存的值，并在下方显示错误
  targetChoice.value = prevTarget;
  engineChoice.value = prevEngine;
  await nextTick();
  syncSelectDom();
  translateError.value = t("favorites.failSave", { msg: translateError.value ?? "" });
}

function onTargetChange(event: Event) {
  void commitTranslate("target", pickSelect(event));
}

function onEngineChange(event: Event) {
  void commitTranslate("engine", pickSelect(event));
}

async function loadTranslationCache() {
  try {
    translationCache.value = await translationCacheStat();
  } catch {
    translationCache.value = null;
  }
}

async function doClearTranslationCache() {
  if (translationCacheBusy.value) return;
  translationCacheBusy.value = true;
  translationCacheError.value = null;
  translationCacheMessage.value = null;
  try {
    const report = await translationCacheClear();
    translationCacheMessage.value = report.removed
      ? t("translateCache.cleared", { n: report.entriesRemoved })
      : t("translateCache.clearedEmpty");
    // 内存里的译文也要清，否则卡片还显示已删除的译文
    resetTranslations();
    await loadTranslationCache();
  } catch (e) {
    translationCacheError.value = t("translateCache.error", { msg: describe(e) });
  } finally {
    translationCacheBusy.value = false;
  }
}

// ---------------- 生命周期 ----------------

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  void loadNetwork();
  void loadCacheStat();
  void loadTranslate();
  void loadTranslationCache();
  try {
    version.value = await appVersion();
  } catch {
    /* 版本号拿不到就保持占位符，不影响其它功能 */
  }
  // 上次检查还在冷却期内：接着倒计时，按钮保持禁用
  if (lastCheckMs > 0 && Date.now() - lastCheckMs < COOLDOWN_MS) startCooldownTimer();
  // 模组批量检测的冷却同样跨弹窗保留
  resumeModCooldown();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (cooldownTimer !== null) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal settings-modal">
      <header class="modal-head">
        <h2>{{ t("settings.title") }}</h2>
        <span class="modal-sub">{{ t("settings.subtitle") }}</span>
        <button type="button" class="modal-x" :title="t('settings.close')" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="settings-layout">
        <nav class="settings-tabs">
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'general' }"
            @click="tab = 'general'"
          >
            ⚙ {{ t("settings.tabGeneral") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'network' }"
            @click="tab = 'network'"
          >
            🌐 {{ t("settings.tabNetwork") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'translate' }"
            @click="tab = 'translate'"
          >
            🈯 {{ t("settings.tabTranslate") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'about' }"
            @click="tab = 'about'"
          >
            ℹ {{ t("settings.tabAbout") }}
          </button>
        </nav>

        <div class="settings-pane">
          <!-- 通用 -->
          <section v-if="tab === 'general'" class="settings-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.language") }}</span>
                <span class="row-note">{{ t("settings.languageNote") }}</span>
              </div>
              <select
                class="settings-select"
                :value="currentLocale"
                :disabled="localeSaving"
                :aria-label="t('settings.language')"
                @change="changeLocale"
              >
                <option v-for="option in LOCALE_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="localeError" class="settings-msg error">{{ localeError }}</div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.update") }}</span>
                <span class="row-note">{{ currentVersionText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="!canCheck"
                :title="t('settings.checkUpdate')"
                @click="runCheck"
              >
                <span v-if="checking" class="spinner"></span>
                {{ checking ? t("settings.checking") : t("settings.checkUpdate") }}
              </button>
            </div>

            <p class="settings-status" :class="{ ok: cooldownLeft > 0 && !hasUpdate, bad: !!checkError }">
              {{ checkStatusText }}
            </p>

            <div v-if="hasUpdate" class="settings-update-note">
              <p>{{ t("settings.foundBody", { version: latest?.latestVersion ?? "" }) }}</p>
              <p v-if="latest?.publishedAt" class="note">
                {{ t("settings.publishedAt", { time: latest.publishedAt }) }}
              </p>
              <button type="button" class="settings-release" @click="openRelease">
                {{ t("settings.openRelease") }}
              </button>
            </div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.modUpdate") }}</span>
                <span class="row-note">{{ t("settings.modUpdateNote") }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="!modCanCheck"
                :title="t('settings.modUpdateButton')"
                @click="runModCheck"
              >
                <span v-if="modChecking" class="spinner"></span>
                {{ modChecking ? t("settings.modUpdateChecking") : t("settings.modUpdateButton") }}
              </button>
            </div>

            <p
              class="settings-status"
              :class="{
                ok: !!modReport && !modError && modReport.updateCount === 0,
                bad: !!modError,
              }"
            >
              {{ modStatusText }}
            </p>

            <p v-if="modReport && modReport.updateCount > 0" class="settings-hint">
              {{ t("settings.modUpdateHint") }}
            </p>
          </section>

          <!-- 网络 -->
          <section v-else-if="tab === 'network'" class="settings-card">
            <p class="settings-summary">{{ netSummary }}</p>

            <label class="settings-check-line">
              <input v-model="netAuto" type="checkbox" :disabled="netSaving" />
              {{ t("online.followSystem") }}
            </label>

            <input
              v-if="!netAuto"
              v-model="netUrl"
              class="settings-input"
              type="text"
              placeholder="http://127.0.0.1:7897"
              spellcheck="false"
              :disabled="netSaving"
            />

            <label class="settings-check-line">
              <input v-model="netRemember" type="checkbox" :disabled="netSaving" />
              {{ t("online.rememberLogin") }}
            </label>

            <div class="settings-actions">
              <button type="button" :disabled="netSaving" @click="saveNetwork">
                {{ netSaving ? t("online.saving") : t("online.save") }}
              </button>
              <button type="button" :disabled="netSaving || netLoading" @click="loadNetwork">
                {{ t("online.detect") }}
              </button>
            </div>

            <p class="settings-hint">{{ t("settings.networkNote") }}</p>
            <div v-if="netError" class="settings-msg error">{{ netError }}</div>
            <div v-else-if="netMessage" class="settings-msg">{{ netMessage }}</div>

            <!-- v0.6：在线数据缓存（SWR）清理入口 -->
            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("cache.sectionTitle") }}</span>
                <span class="row-note">{{ cacheStatusText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="cacheBusy"
                :title="t('cache.clearButton')"
                @click="doClearCache"
              >
                <span v-if="cacheBusy" class="spinner"></span>
                {{ cacheBusy ? t("cache.clearing") : t("cache.clearButton") }}
              </button>
            </div>

            <p class="settings-hint">{{ t("cache.note") }}</p>
            <div v-if="cacheError" class="settings-msg error">{{ cacheError }}</div>
            <div v-else-if="cacheMessage" class="settings-msg">{{ cacheMessage }}</div>
          </section>

          <!-- 翻译 -->
          <section v-else-if="tab === 'translate'" class="settings-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.translateTarget") }}</span>
                <span class="row-note">{{ t("settings.translateTargetNote", { lang: effectiveTargetLabel }) }}</span>
              </div>
              <select
                ref="targetSelect"
                class="settings-select"
                :value="targetChoice"
                :disabled="translateLoading || translateSaving"
                :aria-label="t('settings.translateTarget')"
                @change="onTargetChange"
              >
                <option value="">
                  {{ t("settings.translateFollowUi", { lang: effectiveTargetLabel }) }}
                </option>
                <option v-for="code in targetOptions" :key="code" :value="code">
                  {{ languageName(code) }}
                </option>
              </select>
            </div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.translateEngine") }}</span>
                <span class="row-note">{{ t("settings.translateEngineNote") }}</span>
              </div>
              <select
                ref="engineSelect"
                class="settings-select"
                :value="engineChoice"
                :disabled="translateLoading || translateSaving"
                :aria-label="t('settings.translateEngine')"
                @change="onEngineChange"
              >
                <option value="auto">{{ t("settings.translateEngineAuto") }}</option>
                <option value="google">Google</option>
                <option value="mymemory">MyMemory</option>
                <option value="custom">{{ t("settings.translateEngineCustom") }}</option>
              </select>
            </div>

            <template v-if="engineChoice === 'custom'">
              <input
                v-model="customUrl"
                class="settings-input"
                type="text"
                placeholder="https://api.example.com/translate"
                spellcheck="false"
                :disabled="translateSaving"
              />
              <input
                v-model="customKey"
                class="settings-input"
                type="password"
                :placeholder="
                  translateView?.customKeySet ? t('settings.translateCustomKeyKept') : t('settings.translateCustomKey')
                "
                spellcheck="false"
                autocomplete="off"
                :disabled="translateSaving"
              />
              <p class="settings-hint">{{ t("settings.translateCustomDev") }}</p>
            </template>

            <div class="settings-actions">
              <button type="button" :disabled="translateSaving || translateLoading" @click="saveTranslate">
                {{ translateSaving ? t("online.saving") : t("online.save") }}
              </button>
            </div>
            <p class="settings-hint">{{ t("settings.translateAutoSave") }}</p>

            <div v-if="translateError" class="settings-msg error">{{ translateError }}</div>
            <div v-else-if="translateMessage" class="settings-msg">{{ translateMessage }}</div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("translateCache.sectionTitle") }}</span>
                <span class="row-note">{{ translationCacheText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="translationCacheBusy"
                :title="t('translateCache.clearButton')"
                @click="doClearTranslationCache"
              >
                <span v-if="translationCacheBusy" class="spinner"></span>
                {{ translationCacheBusy ? t("translateCache.clearing") : t("translateCache.clearButton") }}
              </button>
            </div>

            <p class="settings-hint">{{ t("translateCache.note") }}</p>
            <div v-if="translationCacheError" class="settings-msg error">{{ translationCacheError }}</div>
            <div v-else-if="translationCacheMessage" class="settings-msg">{{ translationCacheMessage }}</div>
          </section>

          <!-- 关于 -->
          <section v-else class="settings-card about-card">
            <div class="about-line">
              <span class="row-title">{{ t("settings.version") }}</span>
              <span class="about-value">v{{ version }}</span>
            </div>
            <div class="about-line">
              <span class="row-title">{{ t("settings.github") }}</span>
              <button type="button" class="about-link" @click="openRepo">{{ REPO_URL }}</button>
            </div>
            <div class="about-line">
              <span class="row-title">{{ t("settings.author") }}</span>
              <button type="button" class="about-link" @click="openAuthor">{{ AUTHOR_URL }}</button>
            </div>
            <p class="settings-hint">{{ t("settings.aboutNote") }}</p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-modal {
  width: min(680px, 100%);
}

.settings-layout {
  display: grid;
  grid-template-columns: 156px minmax(0, 1fr);
  min-height: 320px;
  max-height: min(70vh, 560px);
}

.settings-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 10px;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(201, 162, 77, 0.05), transparent);
  overflow-y: auto;
}
.settings-tab {
  text-align: left;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-family: var(--serif);
  font-size: 12px;
  letter-spacing: 0.8px;
  color: var(--muted);
}
.settings-tab:hover {
  color: var(--parch);
  background: #181310;
  border-color: transparent;
}
.settings-tab.active {
  color: #1b1409;
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: 600;
}

.settings-pane {
  overflow-y: auto;
  padding: 14px 16px 18px;
}

.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
  box-shadow: inset 0 0 0 1px rgba(201, 162, 77, 0.06);
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.row-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-title {
  font-family: var(--serif);
  font-size: 12.5px;
  letter-spacing: 0.8px;
  color: var(--parch);
}
.row-note {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
}

.settings-select,
.settings-input {
  padding: 7px 9px;
  font-size: 12px;
}
.settings-select {
  min-width: 120px;
}
.settings-input {
  width: 100%;
}

.settings-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 2px 0;
}

.settings-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  font-family: var(--serif);
  letter-spacing: 0.8px;
}
.settings-check:disabled {
  opacity: 0.6;
}

.settings-status {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
  font-family: var(--serif);
  letter-spacing: 0.4px;
}
.settings-status.ok {
  color: #9fbf84;
}
.settings-status.bad {
  color: #dfae9e;
}

.settings-update-note {
  border: 1px solid rgba(201, 162, 77, 0.55);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(201, 162, 77, 0.06);
}
.settings-update-note p {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--parch);
}
.settings-update-note p.note {
  color: var(--muted);
  font-size: 11px;
}
.settings-release {
  padding: 6px 12px;
  font-family: var(--serif);
  letter-spacing: 0.8px;
}

.settings-summary {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--gold-bright);
  font-family: var(--serif);
}

.settings-check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--parch-dim);
}

.settings-actions {
  display: flex;
  gap: 8px;
}

.settings-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--muted);
}

.settings-msg {
  font-size: 11.5px;
  line-height: 1.7;
  color: #9fbf84;
}
.settings-msg.error {
  color: #dfae9e;
}

.about-card {
  gap: 14px;
}
.about-line {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.about-value {
  font-family: var(--serif);
  font-size: 13px;
  color: var(--gold-bright);
  letter-spacing: 1px;
}
.about-link {
  justify-self: start;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: #14100c;
  color: var(--parch-dim);
  font-size: 11.5px;
  word-break: break-all;
  text-align: left;
}
.about-link:hover {
  color: var(--gold-bright);
  border-color: var(--gold-dim);
}
</style>
