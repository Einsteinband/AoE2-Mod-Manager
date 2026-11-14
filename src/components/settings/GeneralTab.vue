<script setup lang="ts">
/**
 * 通用设置 Tab：语言选择 + 在线大小排序开关 + 模组根目录 + 游戏根目录
 *
 * 自包含：自己加载、保存、校验、交互，SettingsModal 只负责 Tab 组织和外部协调。
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import { LOCALE_OPTIONS, applyLocale, type Locale } from "../../i18n";
import {
  detectGameRoot,
  getSettings,
  pickFolder,
  setGameRootDir,
  setLocale,
  setModRoot,
} from "../../api";
import type { ScanReport } from "../../types";
import { msgText, normalizeBackendError, type Msg } from "../../format";
import {
  onlineSizeSortEnabled,
  setOnlineSizeSortEnabled,
} from "../../composables/online/onlineSizeSortSetting";

const { t, locale } = useI18n();

function toggleOnlineSizeSort(event: Event): void {
  setOnlineSizeSortEnabled((event.target as HTMLInputElement).checked);
}

const props = defineProps<{
  /** 当前模组根目录（外部传入，只用于展示） */
  rootPath?: string;
}>();

const emit = defineEmits<{
  /** 模组根目录已改（后端已写 settings.json 并返回完整扫描结果） */
  (e: "root-changed", report: ScanReport): void;
}>();

// ---------------- 语言 ----------------
const currentLocale = computed(() => String(locale.value));
const localeSaving = ref(false);
const localeError = ref<string | null>(null);

async function applyAndSaveLocale(next: Locale): Promise<void> {
  applyLocale(next);
  localeSaving.value = true;
  localeError.value = null;
  try {
    await setLocale(next);
  } catch (e) {
    localeError.value = normalizeBackendError(e);
  } finally {
    localeSaving.value = false;
  }
}

function onLocaleChange(e: Event): void {
  const next = (e.target as HTMLSelectElement).value as Locale;
  void applyAndSaveLocale(next);
}

// ---------------- 模组根目录 ----------------
const modRootBusy = ref(false);
const modRootMessage = ref<Msg | null>(null);
const modRootError = ref<Msg | null>(null);

/**
 * 换模组根目录：选目录 → 后端 `set_mod_root` 写 settings.json 并直接返回完整扫描结果。
 * 之前这里只 emit 一个 `change-root`，App 那边把它接到「打开设置 + 闪烁游戏根目录」，
 * 而按钮本来就在设置页内，于是点下去没有任何可见反应（也没有真正改根目录）。
 */
async function pickModRoot(): Promise<void> {
  if (modRootBusy.value) return;
  modRootError.value = null;
  modRootMessage.value = null;
  let picked: string | null = null;
  try {
    picked = await pickFolder(props.rootPath || null);
  } catch (e) {
    modRootError.value = normalizeBackendError(e);
    return;
  }
  if (!picked) return;
  modRootBusy.value = true;
  try {
    const next = await setModRoot(picked);
    emit("root-changed", next);
    modRootMessage.value = { key: "settingsUi.rootSaved" };
  } catch (e) {
    modRootError.value = normalizeBackendError(e);
  } finally {
    modRootBusy.value = false;
  }
}

// ---------------- 游戏根目录 ----------------
const gameRoot = ref<string | null>(null);
const gameRootBusy = ref(false);
const gameRootMessage = ref<Msg | null>(null);
const gameRootError = ref<Msg | null>(null);
const gameRootFlash = ref(false);
const gameRootRow = ref<HTMLElement | null>(null);
let gameRootFlashTimer: number | null = null;

function clearGameRootFlash(): void {
  if (gameRootFlashTimer !== null) {
    window.clearTimeout(gameRootFlashTimer);
    gameRootFlashTimer = null;
  }
  gameRootFlash.value = false;
}

/** 对外暴露：外部触发聚焦（顶栏「启动游戏」缺配置时） */
function focusGameRootRow(): void {
  clearGameRootFlash();
  gameRootFlash.value = true;
  gameRootFlashTimer = window.setTimeout(() => {
    gameRootFlash.value = false;
    gameRootFlashTimer = null;
  }, 2000);
  nextTick(() => {
    gameRootRow.value?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
defineExpose({ focusGameRootRow });

async function loadGameRoot(): Promise<void> {
  try {
    const settings = await getSettings();
    gameRoot.value = settings.gameRootDir ?? null;
  } catch {
    gameRoot.value = null;
  }
}

async function pickGameRoot(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  try {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: t("settings.gameRootPickTitle"),
      defaultPath: gameRoot.value ?? undefined,
    });
    if (typeof picked !== "string" || !picked) return;
    gameRootBusy.value = true;
    const saved = await setGameRootDir(picked);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootSaved" };
  } catch (e) {
    gameRootError.value = normalizeBackendError(e);
  } finally {
    gameRootBusy.value = false;
  }
}

async function detectGameRootDir(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  gameRootBusy.value = true;
  try {
    const found = await detectGameRoot();
    if (!found) {
      gameRootError.value = { key: "settings.gameRootDetectFailed" };
      return;
    }
    const saved = await setGameRootDir(found);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootSaved" };
  } catch (e) {
    gameRootError.value = normalizeBackendError(e);
  } finally {
    gameRootBusy.value = false;
  }
}

async function clearGameRoot(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  gameRootBusy.value = true;
  try {
    const saved = await setGameRootDir(null);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootCleared" };
  } catch (e) {
    gameRootError.value = normalizeBackendError(e);
  } finally {
    gameRootBusy.value = false;
  }
}

onMounted(() => {
  void loadGameRoot();
});
</script>

<template>
  <section class="settings-card">
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settings.language") }}</span>
      </div>
      <select
        class="settings-select"
        :value="currentLocale"
        :disabled="localeSaving"
        :aria-label="t('settings.language')"
        @change="onLocaleChange"
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
        <span class="row-title">{{ t("settings.onlineSizeSort") }}</span>
        <span class="row-note">{{ t("settings.onlineSizeSortNote") }}</span>
      </div>
      <label class="settings-check-line">
        <input
          type="checkbox"
          :checked="onlineSizeSortEnabled"
          :aria-label="t('settings.onlineSizeSort')"
          @change="toggleOnlineSizeSort"
        />
        {{ onlineSizeSortEnabled ? t("settings.onlineSizeSortOn") : t("settings.onlineSizeSortOff") }}
      </label>
    </div>

    <div class="settings-sep"></div>

    <!-- v2.1：模组根目录从「外观」搬回「通用」 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.rootTitle") }}</span>
        <span class="row-note mono">{{ rootPath || t("settingsUi.rootEmpty") }}</span>
        <span v-if="modRootError" class="game-root-warn">{{ msgText(modRootError) }}</span>
        <span v-else-if="modRootMessage" class="game-root-ok">{{ msgText(modRootMessage) }}</span>
      </div>
      <button
        type="button"
        class="settings-check"
        :disabled="modRootBusy"
        @click="pickModRoot"
      >
        <span v-if="modRootBusy" class="spinner"></span>
        {{ t("settingsUi.changeRoot") }}
      </button>
    </div>

    <div class="settings-sep"></div>

    <!-- v3.3：游戏根目录 —— 「启动游戏」走 Steam 协议，必须知道游戏装在哪 -->
    <div
      ref="gameRootRow"
      class="settings-row game-root-row"
      :class="{ 'game-root-flash': gameRootFlash }"
    >
      <div class="row-label">
        <span class="row-title">{{ t("settings.gameRoot") }}</span>
        <span class="row-note mono game-root-path" :title="gameRoot ?? ''">
          {{ gameRoot || t("settings.gameRootEmpty") }}
        </span>
        <span v-if="gameRootError" class="game-root-warn">{{ msgText(gameRootError) }}</span>
        <span v-else-if="gameRootMessage" class="game-root-ok">{{ msgText(gameRootMessage) }}</span>
      </div>
      <div class="game-root-actions">
        <button
          type="button"
          class="settings-check"
          :disabled="gameRootBusy"
          @click="pickGameRoot"
        >
          <span v-if="gameRootBusy" class="spinner"></span>
          {{ t("settings.gameRootPick") }}
        </button>
        <button
          type="button"
          class="settings-check"
          :disabled="gameRootBusy"
          @click="detectGameRootDir"
        >
          {{ t("settings.gameRootDetect") }}
        </button>
        <button
          v-if="gameRoot"
          type="button"
          class="cache-dir-reset"
          :disabled="gameRootBusy"
          @click="clearGameRoot"
        >
          {{ t("settings.gameRootClear") }}
        </button>
      </div>
    </div>

  </section>
</template>

<style scoped>
.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row-title {
  font-weight: 600;
}
.row-note {
  font-size: 0.85em;
  opacity: 0.7;
}
.row-note.mono {
  font-family: monospace;
}
.settings-select {
  padding: 6px 10px;
  border-radius: 6px;
}
.settings-msg {
  font-size: 0.9em;
}
.settings-msg.error {
  color: var(--danger-text);
}
.settings-sep {
  height: 1px;
  opacity: 0.2;
  margin: 4px 0;
}
.settings-hint {
  font-size: 0.85em;
  opacity: 0.7;
  margin: 0;
}
.game-root-row {
  align-items: flex-start;
}
.game-root-flash {
  animation: flash 1s ease-out;
}
@keyframes flash {
  0% { background: rgba(255, 215, 0, 0.3); }
  100% { background: transparent; }
}
.game-root-path {
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-root-warn {
  color: var(--danger-text);
  font-size: 0.85em;
}
.game-root-ok {
  color: var(--ok-text-strong);
  font-size: 0.85em;
}
.game-root-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.settings-check-line input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--gold);
  cursor: pointer;
}
.settings-check {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.cache-dir-reset {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0,0,0,0.2);
  border-top-color: var(--text-muted);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
