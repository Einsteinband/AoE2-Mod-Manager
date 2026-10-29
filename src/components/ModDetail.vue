<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry, ModStats, ModUpdateItem } from "../types";
import { deleteModFiles, fileUrl, revealModFolder, toggleModEnabled } from "../api";
import {
  formatBytes,
  formatDateTime,
  kindLabel,
  sourceHint,
  sourceLabel,
  statusLabel,
} from "../format";
import ConfirmDialog from "./ConfirmDialog.vue";
import { openModWebpage } from "../online/service";
import { localizedTagName } from "../online/types";
import { translateBackendMessage } from "../format";
import {
  customNameOf,
  displayTitle,
  isFavorite,
  setCustomName,
  setFavorite,
} from "../userData";
import RenameDialog from "./RenameDialog.vue";

const props = defineProps<{
  mod: ModEntry;
  stats: ModStats | null;
  statsLoading: boolean;
  statsError: string | null;
  /** v0.4：批量更新检测结果（null = 未检测 / 服务端没这个模组） */
  updateInfo?: ModUpdateItem | null;
  /** 正在覆盖安装 */
  updating?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggled", payload: { enabled: boolean }): void;
  (e: "removed", payload: { id: string }): void;
  (e: "update"): void;
}>();

const { t } = useI18n();

const imgFailed = ref(false);
const revealing = ref(false);
const revealError = ref<string | null>(null);
const toggling = ref(false);
const toggleError = ref<string | null>(null);
const confirmOpen = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);
const openingWeb = ref(false);
const webError = ref<string | null>(null);

// v0.5：收藏 / 备注名（只和 WorkshopID 绑定，改完立即落盘 + 局部 Patch，不重扫）
const canFavorite = computed(() => (props.mod.workshopId ?? 0) > 0);
const favorited = computed(() => isFavorite(props.mod.workshopId));
const customName = computed(() => customNameOf(props.mod.workshopId));
const favBusy = ref(false);
const favError = ref<string | null>(null);
const renameOpen = ref(false);
const renameBusy = ref(false);
const renameError = ref<string | null>(null);

/**
 * 收藏 / 备注的即时反馈。
 * 关键：只改 userData 的全局单例（响应式），卡片与详情页的 ⭐ 会自己重算，
 * 不调 scanMods、不重扫目录，所以列表不会闪、滚动条不跳。
 */
const toast = ref<{ text: string; kind: "ok" | "error" } | null>(null);
let toastTimer: number | null = null;
function showToast(text: string, kind: "ok" | "error" = "ok") {
  toast.value = { text, kind };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
    toastTimer = null;
  }, 3200);
}

onBeforeUnmount(() => {
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});

async function toggleFavorite() {
  if (!canFavorite.value || favBusy.value) return;
  favBusy.value = true;
  favError.value = null;
  try {
    const next = await setFavorite(props.mod.workshopId, !favorited.value);
    showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
  } catch (e) {
    favError.value = errorText(e, "favorites.failSave");
  } finally {
    favBusy.value = false;
  }
}

function openRename() {
  if (!canFavorite.value) return;
  renameError.value = null;
  renameOpen.value = true;
}

async function applyRename(name: string) {
  if (renameBusy.value) return;
  renameBusy.value = true;
  renameError.value = null;
  try {
    await setCustomName(props.mod.workshopId, name);
    renameOpen.value = false;
    showToast(t("favorites.savedToast"));
  } catch (e) {
    renameError.value = errorText(e, "favorites.failSave");
  } finally {
    renameBusy.value = false;
  }
}

const hasUpdate = computed(() => props.updateInfo?.hasUpdate === true);
/** 服务端 vs 本地的时间对比文案（接口没给时间时只说“检测到新版本”） */
const updateTimeNote = computed(() => {
  const info = props.updateInfo;
  if (!info) return "";
  if (!info.serverLastUpdateMs || !info.localLastUpdateMs) return t("detail.updateNoTime");
  return t("detail.updateTimes", {
    server: formatDateTime(info.serverLastUpdateMs),
    local: formatDateTime(info.localLastUpdateMs),
  });
});

/** 确认弹窗文案：三态分别说清楚删完会发生什么 */
const confirmBody = computed(() => {
  if (props.mod.source === "tool") return t("detail.confirmTool");
  if (props.mod.source === "official") return t("detail.confirmOfficial");
  return t("detail.confirmUnknown");
});

/** 三种来源都要补同一句：本工具不再代替你退订 */
const confirmMessage = computed(
  () => `${confirmBody.value}\n\n${t("detail.confirmLocalOnly")}`,
);

/** 有 WorkshopID 才能定位官网页面；无 ID 的本地模组不算失败，只是没得浏览 */
const canOpenWebsite = computed(() => (props.mod.workshopId ?? 0) > 0);

function errorText(e: unknown, fallbackKey: string): string {
  if (typeof e === "string") return translateBackendMessage(e);
  const message = (e as Error)?.message;
  return message ? translateBackendMessage(message) : t(fallbackKey);
}

async function openWebsite() {
  const id = props.mod.workshopId;
  if (!id || id <= 0 || openingWeb.value) return;
  openingWeb.value = true;
  webError.value = null;
  try {
    await openModWebpage(id);
  } catch (e) {
    webError.value = errorText(e, "detail.errOpenWebsite");
  } finally {
    openingWeb.value = false;
  }
}

/** 目标状态：已启用 → 停用；已停用 / 未知 → 启用 */
function nextEnabled(): boolean {
  return props.mod.enabled !== true;
}

async function toggleEnabled() {
  if (toggling.value) return;
  const target = nextEnabled();
  toggling.value = true;
  toggleError.value = null;
  try {
    const result = await toggleModEnabled(
      props.mod.workshopId,
      props.mod.kind,
      props.mod.folderName,
      target,
    );
    // 只通知父组件做局部 patch，详细状态以写入结果为准
    emit("toggled", { enabled: result.enabled });
  } catch (e) {
    toggleError.value = errorText(e, "detail.errToggle");
  } finally {
    toggling.value = false;
  }
}

function askDelete() {
  deleteError.value = null;
  confirmOpen.value = true;
}

/** 删除：后端先确认游戏未运行，再只删这一个目录；成功后由父组件局部移除，不重扫 */
async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    await deleteModFiles(props.mod.kind, props.mod.folderName, props.mod.workshopId);
    confirmOpen.value = false;
    emit("removed", { id: props.mod.id });
  } catch (e) {
    deleteError.value = errorText(e, "detail.errDelete");
  } finally {
    deleting.value = false;
  }
}

async function revealFolder() {
  if (revealing.value) return;
  revealing.value = true;
  revealError.value = null;
  try {
    await revealModFolder(props.mod.path);
  } catch (e) {
    revealError.value = errorText(e, "detail.errReveal");
  } finally {
    revealing.value = false;
  }
}

const coverUrl = computed(() =>
  props.mod.thumbnail && !imgFailed.value ? fileUrl(props.mod.thumbnail) : null,
);

watch(
  () => props.mod.id,
  () => {
    imgFailed.value = false;
    toggleError.value = null;
    confirmOpen.value = false;
    deleteError.value = null;
    favError.value = null;
    renameOpen.value = false;
  },
);
</script>

<template>
  <div class="detail-header">
    <h2>{{ t("detail.title") }}</h2>
    <span class="badge" :class="'source-' + mod.source" :title="sourceHint(mod.source)">
      {{ sourceLabel(mod.source) }}
    </span>
    <span class="badge" :class="mod.kind === 'local' ? 'local' : 'sub'">{{ kindLabel(mod.kind) }}</span>
  </div>

  <div class="detail-body">
    <img v-if="coverUrl" class="detail-cover" :src="coverUrl" alt="" @error="imgFailed = true" />
    <div v-else class="no-cover-box">
      {{ t("detail.coverMissing") }}<br />
      {{ t("detail.coverMissingDetail") }}
    </div>

    <h3 class="detail-title">{{ displayTitle(mod.workshopId, mod.displayName) }}</h3>
    <div v-if="customName" class="detail-title-orig">
      {{ t("favorites.originalTitle") }}: {{ mod.displayName }}
    </div>

    <!-- v0.5：收藏 / 备注名 -->
    <div class="fav-row">
      <button
        type="button"
        class="fav-btn"
        :class="{ active: favorited }"
        :disabled="!canFavorite || favBusy"
        :title="canFavorite ? t('favorites.favoriteTitle') : t('favorites.noId')"
        @click="toggleFavorite"
      >
        <span class="fav-star">{{ favorited ? "⭐" : "☆" }}</span>
        {{ favorited ? t("favorites.favorited") : t("favorites.favorite") }}
      </button>
      <button
        type="button"
        class="fav-btn"
        :disabled="!canFavorite || renameBusy"
        :title="canFavorite ? t('favorites.renameTitle') : t('favorites.noId')"
        @click="openRename"
      >
        <span class="fav-star">📝</span>
        {{ t("favorites.rename") }}
      </button>
      <span v-if="!canFavorite" class="note" style="margin: 0">{{ t("favorites.noId") }}</span>
    </div>
    <div v-if="favError" class="path-actions">
      <span class="path-error">{{ favError }}</span>
    </div>

    <div class="detail-badges">
      <span class="badge" :class="mod.enabled === null ? 'warn' : ''">{{ statusLabel(mod.enabled) }}</span>
      <span v-for="tag in mod.contentTags" :key="tag" class="badge">{{ localizedTagName(tag) }}</span>
      <span v-if="mod.nameFromFolder !== mod.displayName" class="badge">
        {{ t("detail.folder") }}: {{ mod.nameFromFolder }}
      </span>
    </div>

    <div class="field">
      <span class="k">{{ t("detail.author") }}</span>
      <span class="v" :class="{ missing: !mod.author }">
        {{ mod.author ?? t("detail.authorMissing") }}
      </span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.workshopId") }}</span>
      <span class="v" :class="{ missing: !mod.workshopId }">
        {{ mod.workshopId ?? t("detail.workshopIdMissing") }}
      </span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.source") }}</span>
      <span class="v source-cell">
        <span class="badge" :class="'source-' + mod.source">{{ sourceLabel(mod.source) }}</span>
        <span class="note" style="margin: 0">{{ sourceHint(mod.source) }}</span>
        <template v-if="mod.source === 'tool' && mod.metadataRecorded">
          <span class="note" style="margin: 0">{{ t("detail.metadataRecorded") }}</span>
        </template>
      </span>
    </div>
    <div v-if="hasUpdate" class="update-panel">
      <div class="update-panel-text">
        <strong>{{ t("detail.updateTitle") }}</strong>
        <span class="note" style="margin: 0">{{ updateTimeNote }}</span>
      </div>
      <button
        type="button"
        class="primary update-btn"
        :disabled="updating || deleting || toggling"
        :title="t('detail.updateTitle')"
        @click="emit('update')"
      >
        {{ updating ? t("detail.updating") : t("detail.updateNow") }}
      </button>
    </div>

    <div class="field">
      <span class="k">{{ t("detail.enabledState") }}</span>
      <span class="v toggle-row">
        <button
          type="button"
          class="toggle"
          :class="{ on: mod.enabled === true, unknown: mod.enabled === null }"
          :disabled="toggling"
          :aria-pressed="mod.enabled === true"
          :title="toggling ? t('detail.toggleTitleWriting') : t('detail.toggleTitleIdle')"
          @click="toggleEnabled"
        >
          <span class="toggle-track"><span class="toggle-knob"></span></span>
          <span class="toggle-text">
            {{ toggling ? t("detail.writing") : statusLabel(mod.enabled) }}
          </span>
        </button>
        <button
          type="button"
          class="danger delete-btn"
          :disabled="deleting || toggling"
          :title="t('detail.deleteTitle')"
          @click="askDelete"
        >
          {{ t("detail.deleteMod") }}
        </button>
      </span>
    </div>

    <div v-if="toggleError" class="path-actions">
      <span class="path-error">{{ toggleError }}</span>
    </div>
    <div v-else-if="mod.enabled === null" class="path-actions">
      <span class="path-error">{{ t("detail.statusNoRecord") }}</span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.priority") }}</span>
      <span class="v" :class="{ missing: mod.priority === null }">
        {{ mod.priority ?? t("labels.unknown") }}
      </span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.lastUpdate") }}</span>
      <span class="v" :class="{ missing: !mod.lastUpdateMs }">{{ formatDateTime(mod.lastUpdateMs) }}</span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.size") }}</span>
      <span class="v">
        <template v-if="statsLoading">{{ t("detail.counting") }}</template>
        <template v-else-if="stats">
          {{ formatBytes(stats.sizeBytes) }} / {{ t("detail.files", { n: stats.fileCount.toLocaleString() }) }}
          <span v-if="stats.truncated">{{ t("detail.sizeTruncated") }}</span>
        </template>
        <span v-else-if="statsError" class="missing">{{ translateBackendMessage(statsError) }}</span>
        <template v-else>—</template>
      </span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.folder") }}</span>
      <span class="v mono">{{ mod.folderName }}</span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.fullPath") }}</span>
      <span class="v mono">{{ mod.path }}</span>
    </div>
    <div class="path-actions">
      <button type="button" :disabled="revealing" @click="revealFolder">
        {{ revealing ? t("detail.opening") : t("detail.openFolder") }}
      </button>
      <button
        type="button"
        :disabled="!canOpenWebsite || openingWeb"
        :title="canOpenWebsite ? t('detail.browseSiteTitle') : t('detail.browseSiteDisabled')"
        @click="openWebsite"
      >
        {{ openingWeb ? t("detail.opening") : t("detail.browseSite") }}
      </button>
      <span v-if="revealError" class="path-error">{{ revealError }}</span>
      <span v-if="!canOpenWebsite" class="note" style="margin: 0; font-size: 10.5px">
        {{ t("detail.noWorkshopNote") }}
      </span>
      <span v-if="webError" class="path-error">{{ webError }}</span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.checksum") }}</span>
      <span class="v mono" :class="{ missing: !mod.checksum }">
        {{ mod.checksum ?? t("labels.notProvided") }}
      </span>
    </div>
    <div class="field">
      <span class="k">{{ t("detail.nameSource") }}</span>
      <span class="v">
        {{ mod.displayNameSource === "info.json" ? t("detail.nameFromInfoJson") : t("detail.nameFromFolder") }}
      </span>
    </div>

    <div class="field">
      <span class="k">{{ t("detail.categoryBasis") }}</span>
      <span class="v" :class="{ missing: mod.categorySource !== 'official' }">
        <template v-if="mod.categorySource === 'official'">
          {{ t("detail.categoryOfficial", { tags: mod.officialTags.join(" / ") }) }}
        </template>
        <template v-else>{{ t("detail.categoryHeuristic") }}</template>
      </span>
    </div>

    <div class="section">
      <h3>{{ t("detail.description") }}</h3>
      <div v-if="mod.description" class="desc">{{ mod.description }}</div>
      <div v-else class="note">{{ t("detail.descriptionMissing") }}</div>
    </div>

    <div v-if="mod.issues.length" class="section">
      <h3>{{ t("detail.dataIssues") }}</h3>
      <ul class="issue-list">
        <li v-for="issue in mod.issues" :key="issue">{{ translateBackendMessage(issue) }}</li>
      </ul>
    </div>
  </div>

  <!-- v0.5：备注名弹窗 -->
  <RenameDialog
    v-if="renameOpen"
    :original="mod.displayName"
    :initial="customName"
    :busy="renameBusy"
    :error="renameError"
    @save="applyRename"
    @cancel="renameOpen = false"
  />

  <!-- 二次确认：按来源给出不同后果的提示（羊皮纸浮层，不阻塞主线程） -->
  <ConfirmDialog
    v-if="confirmOpen"
    :title="t('detail.confirmTitle')"
    :message="confirmMessage"
    :detail="mod.path"
    :confirm-label="t('detail.deleteConfirmLabel')"
    :busy="deleting"
    :error="deleteError"
    @confirm="confirmDelete"
    @cancel="confirmOpen = false"
  />

  <!-- 收藏 / 备注成功后的轻提示（固定右下角，不参与三栏布局） -->
  <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>
</template>
