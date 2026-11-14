<script setup lang="ts">
/**
 * 设置 → Online：翻译设置（目标语言、引擎、批量标题翻译、缓存统计）。
 *
 * 从 SettingsModal 迁移，自包含状态和业务逻辑。
 * 复用 online/service.ts 的 API，不重复实现服务层。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { msgText, normalizeBackendError, type Msg } from "../../format";
import {
  getTranslateSettings,
  setTranslateSettings,
  titleTranslateStart,
  titleTranslateStatus,
  titleTranslateStop,
  translationCacheStat,
} from "../../online/service";
import { applyTranslateSettings, languageName } from "../../online/translation";
import type { TitleJobStatus, TranslateSettingsView, TranslationCacheStat } from "../../online/types";

const { t, locale } = useI18n();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------- 翻译设置状态 ----------------

const translateView = ref<TranslateSettingsView | null>(null);
const translateLoading = ref(false);
const translateSaving = ref(false);
const translateError = ref<Msg | null>(null);
const translateMessage = ref<Msg | null>(null);

/** 下拉框的值："" = 跟随界面语言 */
const targetChoice = ref("");
const engineChoice = ref("auto");

// ---------------- 翻译缓存（只读统计） ----------------

const translationCache = ref<TranslationCacheStat | null>(null);

const supportedLangs = computed<string[]>(
  () => translateView.value?.supportedLanguages ?? ["zh-cn", "zh-tw", "en", "ja", "ko", "ru", "fr", "de", "es"],
);

/** 当前实际生效的语言名（跟随模式会随 UI 语言提示） */
const effectiveTargetLabel = computed(() =>
  languageName(translateView.value?.resolvedLanguage ?? "zh-cn"),
);

/** 下拉候选：Rust 预设列表 + 已保存但不在预设里的自定义值 */
const targetOptions = computed<string[]>(() => {
  const list = [...supportedLangs.value];
  const saved = (translateView.value?.targetLanguage ?? "").trim();
  if (saved && !list.includes(saved)) list.push(saved);
  return list;
});

/** 上一次成功落盘的值：切换失败时回退 */
const savedTargetChoice = ref("");
const savedEngineChoice = ref("auto");

/** 两个下拉框的 DOM 引用 */
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

/** 引擎下拉只剩 Auto / Google */
function engineForSelect(provider: string): string {
  return provider.trim().toLowerCase() === "google" ? "google" : "auto";
}

async function loadTranslate() {
  translateLoading.value = true;
  translateError.value = null;
  try {
    const view = await getTranslateSettings();
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = engineForSelect(view.provider);
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = engineForSelect(view.provider);
  } catch (e) {
    translateError.value = normalizeBackendError(e);
  } finally {
    translateLoading.value = false;
  }
}

async function saveTranslate(): Promise<boolean> {
  if (translateSaving.value) return false;
  translateSaving.value = true;
  translateError.value = null;
  translateMessage.value = null;
  try {
    const view = await setTranslateSettings({
      targetLanguage: targetChoice.value,
      provider: engineChoice.value,
      customUrl: null,
      customKey: null,
    });
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = engineForSelect(view.provider);
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = engineForSelect(view.provider);
    applyTranslateSettings(view, String(locale.value));
    translateMessage.value = { key: "settings.translateSaved" };
    return true;
  } catch (e) {
    translateError.value = normalizeBackendError(e);
    return false;
  } finally {
    translateSaving.value = false;
  }
}

/** 下拉框即时保存：改完立刻落盘，失败回退 */
async function commitTranslate(pick: "target" | "engine", next: string) {
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
  targetChoice.value = prevTarget;
  engineChoice.value = prevEngine;
  await nextTick();
  syncSelectDom();
  translateError.value = { key: "favorites.failSave", params: { msg: msgText(translateError.value) } };
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

// ---------------- 批量标题翻译 ----------------

const titleJob = ref<TitleJobStatus | null>(null);
const titleJobBusy = ref(false);
const titleJobError = ref<string | null>(null);
let titleJobTimer: number | null = null;

function stopTitleJobPoll(): void {
  if (titleJobTimer !== null) {
    window.clearInterval(titleJobTimer);
    titleJobTimer = null;
  }
}

function scheduleTitleJobPoll(): void {
  if (titleJobTimer !== null) return;
  titleJobTimer = window.setInterval(() => {
    void (async () => {
      try {
        titleJob.value = await titleTranslateStatus();
      } catch {
        return;
      }
      if (!titleJob.value?.running) stopTitleJobPoll();
    })();
  }, 2000);
}

async function loadTitleJob(): Promise<void> {
  try {
    titleJob.value = await titleTranslateStatus();
    titleJobError.value = null;
  } catch (e) {
    titleJobError.value = normalizeBackendError(e);
  }
  if (titleJob.value?.running) scheduleTitleJobPoll();
}

async function startTitleJob(): Promise<void> {
  if (titleJobBusy.value) return;
  titleJobBusy.value = true;
  titleJobError.value = null;
  try {
    titleJob.value = await titleTranslateStart();
    scheduleTitleJobPoll();
  } catch (e) {
    titleJobError.value = normalizeBackendError(e);
  } finally {
    titleJobBusy.value = false;
  }
}

async function stopTitleJob(): Promise<void> {
  try {
    const result = await titleTranslateStop();
    // 乐观更新：Rust 端停止是异步的，返回时 running 可能仍为 true，
    // 直接强制设为 false，让 UI 立即切换到「开始翻译」状态
    titleJob.value = { ...result, running: false };
  } catch (e) {
    titleJobError.value = normalizeBackendError(e);
  }
  stopTitleJobPoll();
}

const titleJobText = computed(() => {
  const job = titleJob.value;
  if (!job) return t("titleTranslate.reading");
  if (!job.indexReady) return t("titleTranslate.needIndex");
  const base = job.running
    ? t("titleTranslate.running", { done: job.done, total: job.total })
    : t("titleTranslate.idle", { done: job.done, total: job.total });
  return job.failed > 0 ? `${base} · ${t("titleTranslate.failed", { n: job.failed })}` : base;
});

// ---------------- 生命周期 ----------------

onMounted(async () => {
  void loadTranslate();
  void loadTranslationCache();
  void loadTitleJob();
});

onBeforeUnmount(() => {
  stopTitleJobPoll();
});
</script>

<template>
  <section class="settings-card">
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
      </select>
    </div>

    <p class="settings-hint">{{ t("settings.translateAutoSave") }}</p>

    <div v-if="translateError" class="settings-msg error">{{ msgText(translateError) }}</div>
    <div v-else-if="translateMessage" class="settings-msg">{{ msgText(translateMessage) }}</div>

    <div class="settings-sep"></div>

    <!-- 批量翻译标题 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("titleTranslate.sectionTitle") }}</span>
        <span class="row-note">{{ t("titleTranslate.note") }}</span>
      </div>
      <button
        type="button"
        class="settings-check"
        :disabled="titleJobBusy || (!titleJob?.running && !titleJob?.indexReady)"
        @click="titleJob?.running ? stopTitleJob() : startTitleJob()"
      >
        <span v-if="titleJobBusy" class="spinner"></span>
        {{ titleJob?.running ? t("titleTranslate.stop") : t("titleTranslate.start") }}
      </button>
    </div>

    <p class="settings-hint">{{ titleJobText }}</p>

    <div v-if="titleJobError" class="settings-msg error">{{ titleJobError }}</div>

    <div class="settings-sep"></div>

    <!-- 翻译缓存：只读统计 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("translateCache.sectionTitle") }}</span>
        <span class="row-note">{{ translationCacheText }}</span>
      </div>
    </div>
  </section>
</template>
