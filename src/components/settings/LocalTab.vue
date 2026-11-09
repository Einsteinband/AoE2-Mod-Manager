<script setup lang="ts">
/**
 * 本地设置 Tab：索引开关 / 本地搜索开关 / 模组批量更新检测
 *
 * 这些设置只属于本地页，状态和交互逻辑全部自包含，
 * 不与 SettingsModal 共享状态。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getSettings, setEnableIndexing, setEnableLocalSearch } from "../../api";
import { normalizeBackendError } from "../../format";
import { localSearchEnabled } from "../../sessionState";
import {
  canCheck as modCanCheck,
  checking as modChecking,
  cooldownLeft as modCooldown,
  error as modError,
  report as modReport,
  resumeCooldown as resumeModCooldown,
  runModUpdateCheck,
  checkProgress as modCheckProgress,
} from "../../modUpdates";

const { t } = useI18n();


// ---------------- 自动索引（v1.2） ----------------

/** 开关状态：默认关闭（settings.json 缺字段也是 false） */
const indexingEnabled = ref(false);
const indexingSaving = ref(false);
const indexingError = ref<string | null>(null);

async function loadIndexing() {
  try {
    const settings = await getSettings();
    indexingEnabled.value = settings.enableIndexing === true;
  } catch (e) {
    indexingError.value = normalizeBackendError(e);
  }
}

/**
 * 切换开关：先切界面再落盘（失败回滚）。
 * 开启 = Rust 立即在后台补建一次索引；关闭 = 本轮爬取在下一页之前停下。
 */
async function toggleIndexing(event: Event) {
  const next = (event.target as HTMLInputElement).checked;
  indexingEnabled.value = next;
  indexingSaving.value = true;
  indexingError.value = null;
  try {
    await setEnableIndexing(next);
  } catch (e) {
    indexingEnabled.value = !next;
    indexingError.value = normalizeBackendError(e);
  } finally {
    indexingSaving.value = false;
  }
}

// ---------------- 在线页本地搜索框（v1.2） ----------------

const localSearchOn = ref(false);
const localSearchSaving = ref(false);
const localSearchError = ref<string | null>(null);

async function loadLocalSearch() {
  try {
    const settings = await getSettings();
    localSearchOn.value = settings.enableLocalSearch === true;
  } catch (e) {
    localSearchError.value = normalizeBackendError(e);
  }
}

/** 纯界面开关：写 settings.json + 同步运行时镜像（在线页立即生效） */
async function toggleLocalSearch(event: Event) {
  const next = (event.target as HTMLInputElement).checked;
  localSearchOn.value = next;
  localSearchSaving.value = true;
  localSearchError.value = null;
  try {
    await setEnableLocalSearch(next);
    localSearchEnabled.value = next;
  } catch (e) {
    localSearchOn.value = !next;
    localSearchError.value = normalizeBackendError(e);
  } finally {
    localSearchSaving.value = false;
  }
}

// ---------------- 本地模组批量更新检测 ----------------

const modStatusText = computed(() => {
  if (modChecking.value) return t("settings.modUpdateChecking");
  if (modError.value) return modError.value;
  const rep = modReport.value;
  if (!rep) return t("settings.modUpdateIdle");

  // 按分类统计
  let hasUpdate = 0;
  let upToDate = 0;
  let pending = 0;
  let detailFailed = 0;
  let dataIncomplete = 0;
  let noWorkshopId = 0;
  for (const item of rep.items ?? []) {
    switch (item.category) {
      case "matched":
        if (item.hasUpdate) hasUpdate++;
        else upToDate++;
        break;
      case "known_not_in_installed":
        pending++;
        break;
      case "detail_failed":
        detailFailed++;
        break;
      case "data_incomplete":
        dataIncomplete++;
        break;
      case "no_workshop_id":
        noWorkshopId++;
        break;
    }
  }

  const parts: string[] = [];

  // 主结论
  if (hasUpdate > 0) {
    parts.push(t("settings.modUpdateHasUpdate", { n: hasUpdate }));
  } else if (upToDate > 0 && pending === 0 && detailFailed === 0 && dataIncomplete === 0) {
    parts.push(t("settings.modUpdateAllCurrent", { total: rep.totalLocal, pages: rep.pages }));
  } else {
    parts.push(t("settings.modUpdateCheckDone", { total: rep.totalLocal, pages: rep.pages }));
  }

  // 补充分类（只显示非零项）
  if (upToDate > 0 && hasUpdate > 0) {
    parts.push(t("settings.modUpdateUpToDate", { n: upToDate }));
  }
  if (pending > 0) {
    parts.push(t("settings.modUpdatePending", { n: pending }));
  }
  if (detailFailed > 0) {
    parts.push(t("settings.modUpdateDetailFailed", { n: detailFailed }));
  }
  if (dataIncomplete > 0) {
    parts.push(t("settings.modUpdateDataIncomplete", { n: dataIncomplete }));
  }
  if (noWorkshopId > 0) {
    parts.push(t("settings.modUpdateThirdPartyLocal", { n: noWorkshopId }));
  }

  // Detail 补充检测统计
  if (rep.detailRequested && rep.detailRequested > 0) {
    parts.push(t("settings.modUpdateDetailQueried", {
      n: rep.detailRequested,
      ok: rep.detailSucceeded ?? 0,
      fail: rep.detailFailed ?? 0,
    }));
  }

  const cooldown =
    modCooldown.value > 0 ? t("settings.modUpdateCooldown", { s: modCooldown.value }) : "";
  return parts.join(" · ") + (cooldown ? ` ${cooldown}` : "");
});

async function runModCheck() {
  await runModUpdateCheck();
}

onMounted(async () => {
  void loadIndexing();
  void loadLocalSearch();
  // 模组批量检测的冷却跨弹窗保留
  resumeModCooldown();
});
</script>

<template>
  <section class="settings-card">
    <!-- 自动索引 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settings.indexing") }}</span>
        <span class="row-note">{{ t("settings.indexingNote") }}</span>
      </div>
      <label class="settings-check-line">
        <input
          type="checkbox"
          :checked="indexingEnabled"
          :disabled="indexingSaving"
          @change="toggleIndexing"
        />
        {{ indexingEnabled ? t("settings.indexingOn") : t("settings.indexingOff") }}
      </label>
    </div>
    <div v-if="indexingError" class="settings-msg error">{{ indexingError }}</div>

    <div class="settings-sep"></div>

    <!-- 在线页本地搜索框 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settings.localSearch") }}</span>
        <span class="row-note">{{ t("settings.localSearchNote") }}</span>
      </div>
      <label class="settings-check-line">
        <input
          type="checkbox"
          :checked="localSearchOn"
          :disabled="localSearchSaving"
          @change="toggleLocalSearch"
        />
        {{ localSearchOn ? t("settings.localSearchOn") : t("settings.localSearchOff") }}
      </label>
    </div>
    <div v-if="localSearchError" class="settings-msg error">{{ localSearchError }}</div>

    <div class="settings-sep"></div>

    <!-- 模组批量更新检测 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settings.modUpdate") }}</span>
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

    <!-- 实时检测进度 -->
    <div v-if="modCheckProgress" class="settings-row" style="grid-template-columns: 1fr">
      <div class="progress-track">
        <div
          class="progress-fill"
          :style="{ width: (modCheckProgress.total > 0 ? (modCheckProgress.completed / modCheckProgress.total) * 100 : 0) + '%' }"
        ></div>
      </div>
      <span class="progress-text">{{ modCheckProgress.completed }} / {{ modCheckProgress.total }}</span>
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

    <div class="settings-sep"></div>

    <p class="settings-hint">{{ t("settingsUi.rootPath") }}</p>
  </section>
</template>

<style scoped>
.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  font-size: calc(12.5px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--parch);
}
.row-note {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  line-height: 1.6;
}
.settings-check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.settings-sep {
  height: 1px;
  opacity: 0.2;
  margin: 4px 0;
}
.settings-msg {
  font-size: calc(11.5px * var(--global-scale));
}
.settings-msg.error {
  color: var(--danger-text);
}
.settings-hint {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  margin: 0;
}
.settings-status {
  font-size: calc(11.5px * var(--global-scale));
  margin: 0;
}
.settings-status.ok {
  color: var(--ok-text-strong);
}
.settings-status.bad {
  color: var(--danger-text);
}
.settings-check {
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.progress-track {
  height: 6px;
  border-radius: 3px;
  background: rgba(var(--accent-rgb), 0.15);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--gold-text);
  transition: width 0.2s ease;
}
.progress-text {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  text-align: center;
  margin-top: 2px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
