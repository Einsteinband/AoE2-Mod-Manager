<script setup lang="ts">
/**
 * 关于 Tab：版本信息 + 更新检查 + 更新历史 + 诊断工具
 *
 * 自包含：自己加载版本、检查更新、拉取历史、复制诊断信息。
 * 冷却时间 lastCheckMs 保持模块作用域，切 Tab 不绕过。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  appVersion,
  checkUpdate,
  diagnosticsInfo,
  fetchGithubReleases,
  openExternalUrl,
  openLogsDir,
  renderReleaseMarkdown,
} from "../../api";
import type { GithubRelease } from "../../api";
import { msgText, normalizeBackendError, type Msg } from "../../format";
import type { UpdateInfo } from "../../types";

const { t } = useI18n();

const REPO_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const ISSUES_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager/issues";
const LANZOU_URL = "https://wwblm.lanzouv.com/b01i5yfj5e";

/** 冷却时长：15 秒内不允许再次请求 GitHub（同时防止 403 限流） */
const COOLDOWN_MS = 15_000;
/** 模块作用域：弹窗关闭再打开、切 Tab 重建组件，仍然记住上次检查时间 */
let lastCheckMs = 0;

// ---------------- 版本 + 检查更新 ----------------
const version = ref("—");
const currentVersionText = computed(() => t("settings.currentVersion", { version: version.value }));

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

async function runCheck(): Promise<void> {
  if (!canCheck.value) return;
  checking.value = true;
  checkError.value = null;
  latest.value = null;
  try {
    const info = await checkUpdate();
    latest.value = info;
    version.value = info.currentVersion || version.value;
    enterCooldown();
    if (info.hasUpdate) {
      try {
        await openExternalUrl(info.releaseUrl);
      } catch (e) {
        checkError.value = normalizeBackendError(e);
      }
    }
  } catch (e) {
    checkError.value = normalizeBackendError(e);
    enterCooldown();
  } finally {
    checking.value = false;
  }
}

async function openRelease(): Promise<void> {
  const url = latest.value?.releaseUrl ?? `${REPO_URL}/releases/latest`;
  try {
    await openExternalUrl(url);
  } catch (e) {
    checkError.value = normalizeBackendError(e);
  }
}

async function openRepo(): Promise<void> {
  try {
    await openExternalUrl(REPO_URL);
  } catch (e) {
    checkError.value = normalizeBackendError(e);
  }
}

async function openIssues(): Promise<void> {
  try {
    await openExternalUrl(ISSUES_URL);
  } catch (e) {
    checkError.value = normalizeBackendError(e);
  }
}

async function openCloud(): Promise<void> {
  try {
    await openExternalUrl(LANZOU_URL);
  } catch (e) {
    checkError.value = normalizeBackendError(e);
  }
}

// ---------------- 更新历史 ----------------
const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref<string | null>(null);
const history = ref<GithubRelease[]>([]);
let historyLoaded = false;

async function toggleHistory(): Promise<void> {
  historyOpen.value = !historyOpen.value;
  if (!historyOpen.value) return;
  if (historyLoaded || historyLoading.value) return;
  await loadHistory();
}

async function loadHistory(): Promise<void> {
  historyLoading.value = true;
  historyError.value = null;
  try {
    const list = await fetchGithubReleases();
    history.value = [...list].sort((a, b) =>
      String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")),
    );
    historyLoaded = true;
  } catch (e) {
    historyError.value = normalizeBackendError(e);
  } finally {
    historyLoading.value = false;
  }
}

/** ISO8601 → 本地 YYYY-MM-DD（解析失败就直接截前 10 位） */
function formatReleaseDate(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw.slice(0, 10);
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------- 诊断与日志 ----------------
const diagProblem = ref("");
const diagBusy = ref(false);
const diagError = ref<Msg | null>(null);
const diagMessage = ref<Msg | null>(null);
const diagCopied = ref(false);

/**
 * 写系统剪贴板。
 * 优先用 WebView2 的 Clipboard API；失败再退回 textarea + execCommand。
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略，走下面的兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

async function openLogsFolder(): Promise<void> {
  diagError.value = null;
  diagMessage.value = null;
  try {
    const path = await openLogsDir();
    diagMessage.value = { key: "settings.diagOpenLogsDone", params: { path } };
  } catch (e) {
    diagError.value = normalizeBackendError(e);
  }
}

async function copyDiagnostics(): Promise<void> {
  diagBusy.value = true;
  diagError.value = null;
  diagMessage.value = null;
  try {
    const info = await diagnosticsInfo();
    const problem = diagProblem.value.trim() || t("settings.diagProblemFallback");
    const logs = info.logLines.length
      ? info.logLines.join("\n")
      : t("settings.diagNoLog");
    const text = t("settings.diagPrompt", {
      version: info.version,
      problem,
      os: info.os,
      logFile: info.logFile || info.logDir,
      logs,
    });
    const ok = await copyTextToClipboard(text);
    if (!ok) {
      diagError.value = { key: "settings.diagCopyFailed", params: { error: "clipboard rejected" } };
      return;
    }
    diagCopied.value = true;
  } catch (e) {
    diagError.value = { key: "settings.diagCopyFailed", params: { error: normalizeBackendError(e) } };
  } finally {
    diagBusy.value = false;
  }
}

onMounted(async () => {
  try {
    version.value = await appVersion();
  } catch {
    /* 版本号拿不到就保持占位符 */
  }
  // 上次检查还在冷却期内：接着倒计时，按钮保持禁用
  if (lastCheckMs > 0 && Date.now() - lastCheckMs < COOLDOWN_MS) startCooldownTimer();
});

onBeforeUnmount(() => {
  if (cooldownTimer !== null) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
});
</script>

<template>
  <section class="settings-card about-card">
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

    <div class="about-line">
      <span class="row-title">{{ t("settings.version") }}</span>
      <span class="about-value">v{{ version }}</span>
    </div>
    <div class="about-line">
      <span class="row-title">{{ t("settings.github") }}</span>
      <button type="button" class="about-link" @click="openRepo">{{ REPO_URL }}</button>
    </div>
    <div class="about-line">
      <span class="row-title">{{ t("settings.feedback") }}</span>
      <button type="button" class="about-link" @click="openIssues">
        {{ t("settings.feedbackButton") }}
      </button>
    </div>

    <div class="about-line about-cloud">
      <span class="row-title">{{ t("settings.cloudTitle") }}</span>
      <div class="about-cloud-actions">
        <button type="button" class="about-link" @click="openCloud">
          {{ t("settings.cloudButton") }}
        </button>
        <span class="about-cloud-password">{{ t("settings.cloudPassword") }}</span>
      </div>
    </div>

    <div class="settings-sep"></div>

    <!-- 本地日志 -->
    <div class="diag-block">
      <div class="diag-head">
        <span class="row-title">{{ t("settings.diagTitle") }}</span>
        <span class="row-note">{{ t("settings.diagNote") }}</span>
      </div>
      <input
        v-model="diagProblem"
        type="text"
        class="diag-input"
        maxlength="200"
        :placeholder="t('settings.diagProblemPlaceholder')"
      />
      <div class="diag-actions">
        <button type="button" class="settings-check" :disabled="diagBusy" @click="openLogsFolder">
          {{ t("settings.diagOpenLogs") }}
        </button>
        <button
          type="button"
          class="settings-check diag-copy"
          :disabled="diagBusy"
          :title="t('settings.diagCopyHint')"
          @click="copyDiagnostics"
        >
          <span v-if="diagBusy" class="spinner"></span>
          {{ diagBusy ? t("settings.diagCopying") : t("settings.diagCopy") }}
        </button>
      </div>
      <p v-if="diagError" class="settings-status bad">{{ msgText(diagError) }}</p>
      <p v-else-if="diagMessage" class="settings-status ok">{{ msgText(diagMessage) }}</p>
    </div>

    <div class="settings-sep"></div>

    <!-- 更新历史 -->
    <div class="about-history-head">
      <span class="row-title">{{ t("settings.changelogTitle") }}</span>
      <button type="button" class="about-link" @click="toggleHistory">
        {{ historyOpen ? t("settings.changelogHide") : t("settings.changelogShow") }}
      </button>
    </div>

    <div v-if="historyOpen" class="about-history">
      <p v-if="historyLoading" class="about-history-note">
        {{ t("settings.changelogLoading") }}
      </p>
      <p v-else-if="historyError" class="about-history-note error">
        {{ historyError }}
        <button type="button" class="about-history-retry" @click="loadHistory">
          {{ t("settings.changelogRetry") }}
        </button>
      </p>
      <template v-else-if="history.length">
        <article v-for="release in history" :key="release.tagName" class="about-history-item">
          <header class="about-history-item-head">
            <span class="about-history-version">v{{ release.version || release.tagName }}</span>
            <span class="about-history-name">{{ release.name }}</span>
            <span class="about-history-date">{{ formatReleaseDate(release.publishedAt) }}</span>
          </header>
          <div
            v-if="release.body"
            class="release-notes"
            v-html="renderReleaseMarkdown(release.body)"
          ></div>
          <p v-else class="about-history-note">{{ t("settings.changelogEmptyBody") }}</p>
        </article>
      </template>
      <p v-else class="about-history-note">{{ t("settings.changelogEmpty") }}</p>
    </div>

    <!-- 「已复制」提示弹窗 -->
    <div v-if="diagCopied" class="modal-backdrop" @click.self="diagCopied = false">
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>{{ t("settings.diagCopiedTitle") }}</h2>
          <span class="modal-sub">{{ t("settings.diagCopiedSubtitle") }}</span>
          <button type="button" class="modal-x" @click="diagCopied = false">✕</button>
        </div>
        <div class="modal-body">
          <p class="confirm-text">{{ t("settings.diagCopiedMessage") }}</p>
          <div class="confirm-actions">
            <button type="button" class="primary" @click="diagCopied = false">
              {{ t("settings.diagCopiedOk") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.about-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}
.about-value {
  font-size: calc(12px * var(--global-scale));
  color: var(--gold-text);
}
.about-link {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--parch-dim);
}
.about-link:hover {
  color: var(--parch);
  border-color: var(--gold-dim);
}
.about-cloud {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.about-cloud-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.about-cloud-password {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
}
.diag-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
}
.diag-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.diag-input {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: calc(12px * var(--global-scale));
}
.diag-actions {
  display: flex;
  gap: 8px;
}
.diag-copy {
  margin-left: auto;
}
.about-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.about-history {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
}
.about-history-note {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--muted);
}
.about-history-note.error {
  color: var(--danger-text);
}
.about-history-retry {
  margin-left: 8px;
  padding: 2px 8px;
  font-size: calc(11px * var(--global-scale));
  cursor: pointer;
}
.about-history-item {
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
}
.about-history-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.about-history-version {
  font-weight: var(--ui-font-weight-strong);
  color: var(--gold-text);
}
.about-history-name {
  flex: 1;
  font-size: calc(12px * var(--global-scale));
}
.about-history-date {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
}
.release-notes {
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.6;
  color: var(--parch-dim);
}
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
  margin-right: 4px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
