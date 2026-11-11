<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DownloadProgress, OnlineMod } from "../../online/types";
import type { InstalledIndexEntry } from "../../types";
import { sourceLabel } from "../../format";

/**
 * 在线页右侧详情面板（纯展示）。
 *
 * 所有取值都在 `useOnlineDetail` / `useOnlineInstall` / `useOnlineFavorite` 里算好，
 * 这里只负责排版与事件上抛：不持有状态、不发请求、不推断业务规则。
 *
 * 注意：本组件自带 scoped 样式（scoped 样式不会穿透到子组件），
 * 因此 `.online-error` / `.online-note-box` 两条与父页面共用的规则在这里重复了一份，
 * 保证从 OnlineBrowser 迁出后视觉效果完全一致。
 */
const props = defineProps<{
  mod: OnlineMod | null;
  thumb: string | null;
  title: string;
  subtitle: string | null;
  tags: string[];
  // 翻译
  translateLabel: string;
  translateProvider: string | null;
  translateNote: string | null;
  translateDisabled: boolean;
  translateActive: boolean;
  // 收藏 / 备注
  favorited: boolean;
  canFavorite: boolean;
  favBusy: boolean;
  favError: string | null;
  renameBusy: boolean;
  // 字段
  ratingText: string;
  sizeText: string;
  fileCountText: string;
  diskText: string;
  versionText: string;
  createdText: string | null;
  updatedText: string | null;
  localEntry: InstalledIndexEntry | null;
  localIndexError: string | null;
  // 安装 / 下载队列
  primaryAction: "install" | "uninstall-local";
  subscribeLabel: string;
  subscribeBusy: boolean;
  installing: boolean;
  /** 排队中（尚未开始） */
  queued: boolean;
  /** 队列位次（1 起） */
  queuePos: number | null;
  /** 已请求取消、等待后端收尾 */
  cancelRequested: boolean;
  progress: DownloadProgress | null;
  actionMessage: string | null;
  installError: string | null;
  installNote: string | null;
  openingWeb: boolean;
  /** 「打开所在文件夹」请求进行中 */
  revealingFolder: boolean;
  // 详情
  descText: string | null;
  detailLoading: boolean;
  detailError: string | null;
  /** 断网且本地无详情缓存：显示友好提示，不显示任何 DNS / 传输层报错 */
  detailUncached: boolean;
}>();

/** 覆盖确认勾选 / 需要覆盖时的提示开关（v-model 双向绑定，父组件持有真源） */
const needForce = defineModel<boolean>("needForce", { default: false });
const forceOverwrite = defineModel<boolean>("forceOverwrite", { default: false });

const emit = defineEmits<{
  (event: "refresh-cover"): void;
  (event: "translate"): void;
  (event: "toggle-favorite"): void;
  (event: "rename"): void;
  (event: "install"): void;
  (event: "leave-queue"): void;
  (event: "uninstall"): void;
  (event: "reinstall"): void;
  (event: "stop-install"): void;
  (event: "open-webpage"): void;
  (event: "reveal-folder"): void;
}>();

const { t } = useI18n();

/** 在线封面重试阶段：获取地址 → 排队下载 → 完成 / 失败（无逐字节进度） */
type CoverStage = "idle" | "fetching" | "downloading" | "done" | "failed";
const coverStage = ref<CoverStage>("idle");
/** 在线封面加载失败（失败态由本地 <img> @error 驱动，不发请求） */
const thumbFailed = ref(false);
/** 重试进行中：获取 / 下载阶段都禁止重复点击 */
const thumbReloading = computed(() => coverStage.value === "fetching" || coverStage.value === "downloading");

/** 封面成功 / 失败轻提示（与本地详情同一套 .app-toast 全局样式） */
const coverToast = ref<{ text: string; kind: "ok" | "error" } | null>(null);
let coverToastTimer: number | null = null;
function showCoverToast(text: string, kind: "ok" | "error" = "ok"): void {
  coverToast.value = { text, kind };
  if (coverToastTimer !== null) window.clearTimeout(coverToastTimer);
  coverToastTimer = window.setTimeout(() => {
    coverToast.value = null;
    coverToastTimer = null;
  }, 3200);
}

/** 进行中阶段的可见文案（完成 / 失败走 toast，不在此长期占位） */
const coverStatusText = computed(() => {
  if (coverStage.value === "fetching") return t("detail.coverFetching");
  if (coverStage.value === "downloading") return t("detail.coverDownloading");
  return null;
});

function onThumbLoad(): void {
  coverStage.value = "done";
  showCoverToast(t("detail.coverUpdated"));
}

function onThumbError(): void {
  thumbFailed.value = true;
  coverStage.value = "failed";
  showCoverToast(t("detail.coverLoadFailed"), "error");
}

/** 上抛父组件走现有缩略图链路重试；面板只呈现加载态与按钮 */
function reloadThumb(): void {
  if (thumbReloading.value) return;
  thumbFailed.value = false;
  // 服务端未提供缩略图 URL：无链路可重试，给出获取失败提示，按钮保持可点
  if (!props.mod?.thumbnail) {
    coverStage.value = "failed";
    showCoverToast(t("detail.coverFetchFailed"), "error");
    return;
  }
  coverStage.value = "fetching";
  emit("refresh-cover");
  // 父组件回退官网 URL 并排队后台下载；当前后台链路无逐字节进度事件，此阶段仅为「下载中」标签
  coverStage.value = "downloading";
}

/** 长描述折叠：与本地详情页保持同一套阈值 */
const DESC_COLLAPSE_AT = 260;
const descExpanded = ref(false);
const descLong = computed(() => {
  const text = props.descText;
  if (!text) return false;
  return text.length > DESC_COLLAPSE_AT || text.split("\n").length > 8;
});
const descClamped = computed(() => descLong.value && !descExpanded.value);

/** 复制 Workshop ID：优先 Clipboard API，失败退回 textarea + execCommand */
const copied = ref(false);
let copyTimer: number | null = null;
async function copyWorkshopId(): Promise<void> {
  if (!props.mod) return;
  const text = String(props.mod.modId);
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand("copy");
      document.body.removeChild(area);
    } catch {
      ok = false;
    }
  }
  copied.value = ok;
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copied.value = false;
    copyTimer = null;
  }, 2400);
}

onBeforeUnmount(() => {
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  if (coverToastTimer !== null) window.clearTimeout(coverToastTimer);
});

// 换模组时重置折叠状态
watch(
  () => props.mod?.modId,
  () => {
    descExpanded.value = false;
    thumbFailed.value = false;
    coverStage.value = "idle";
  },
);
</script>

<template>
  <div class="detail-header">
    <h2>{{ t("online.detailTitle") }}</h2>
  </div>

  <div v-if="!mod" class="detail-empty">
    {{ t("online.detailEmpty") }}<br />
    <span class="note">{{ t("online.detailEmptyNote") }}</span>
  </div>

  <div v-else class="detail-body">
    <!-- ① 识别区：封面 + 名称 + 标签 -->
    <section class="dv-zone dv-ident">
      <div class="cover-frame">
        <img
          v-if="thumb"
          class="detail-cover"
          :src="thumb"
          alt=""
          @load="onThumbLoad"
          @error="onThumbError"
        />
        <div v-else class="no-cover-box">{{ t("online.noThumbnail") }}</div>
        <button
          v-if="!thumb || thumbFailed"
          type="button"
          class="cover-reload-btn"
          :disabled="thumbReloading"
          :aria-label="t('detail.refreshCover')"
          :title="t('detail.refreshCoverHint')"
          @click="reloadThumb"
        >
          <span :class="{ 'is-spinning': thumbReloading }" aria-hidden="true">🔄</span>
        </button>
      </div>
      <p v-if="coverStatusText" class="cover-status">{{ coverStatusText }}</p>

      <h3 class="detail-title">{{ title }}</h3>
      <div v-if="subtitle" class="detail-title-orig">{{ subtitle }}</div>

      <div v-if="tags.length" class="detail-badges">
        <span v-for="name in tags" :key="name" class="badge">{{ name }}</span>
      </div>

      <!-- 基本信息：Workshop ID（可复制）+ 文件体积 + 文件数量，紧凑横排 -->
      <div class="basic-row">
        <button
          type="button"
          class="basic-chip basic-chip-copy"
          :title="copied ? t('online.copied') : t('online.copyIdTitle')"
          :aria-label="`${t('detail.workshopId')}: ${mod.modId}`"
          @click="copyWorkshopId"
        >
          <span class="chip-label">{{ t("detail.workshopId") }}</span>
          <span class="chip-value">{{ mod.modId }}</span>
        </button>
        <span class="basic-chip">
          <span class="chip-label">{{ t("online.fileSize") }}</span>
          <span class="chip-value">{{ sizeText }}</span>
        </span>
        <span class="basic-chip">
          <span class="chip-label">{{ t("online.fileCount") }}</span>
          <span class="chip-value">{{ fileCountText }}</span>
        </span>
      </div>
    </section>

    <!-- ② 操作区（v2.0 前置）：主操作 → 常用辅助 → 次要操作 -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ t("detailPanel.actions") }}</h4>

      <!-- 主操作：安装 / 卸载 / 移出队列 -->
      <div class="detail-actions">
        <!-- 排队中：按钮依然可点（点它 = 移出队列），用户可立即去操作别的模组 -->
        <button
          v-if="queued"
          type="button"
          class="primary queued"
          :title="t('downloader.leaveQueue')"
          @click="emit('leave-queue')"
        >
          {{ subscribeLabel }}
        </button>
        <button
          v-else-if="primaryAction === 'install'"
          type="button"
          class="primary"
          :disabled="subscribeBusy"
          @click="emit('install')"
        >
          {{ subscribeLabel }}
        </button>
        <button v-else type="button" class="danger" :disabled="subscribeBusy" @click="emit('uninstall')">
          {{ subscribeLabel }}
        </button>
      </div>

      <div v-if="actionMessage" class="online-message">{{ actionMessage }}</div>

      <div v-if="installing || progress" class="online-progress">
        <div class="bar">
          <div class="fill" :style="{ width: (progress?.percent ?? 0) + '%' }"></div>
        </div>
        <div class="note">
          {{ progress?.phase ?? t("online.preparing") }} ·
          {{ ((progress?.received ?? 0) / 1024 / 1024).toFixed(1) }} MB
          <template v-if="progress && progress.total > 0">
            / {{ (progress.total / 1024 / 1024).toFixed(1) }} MB
          </template>
        </div>
      </div>

      <label v-if="needForce" class="online-force">
        <input v-model="forceOverwrite" type="checkbox" />
        {{ t("online.overwriteConfirm") }}
      </label>

      <div v-if="installError" class="online-error">{{ installError }}</div>

      <!-- 辅助操作单行：收藏、翻译、打开文件夹、重装、停止、网站浏览、备注名 -->
      <div class="detail-actions">
        <button
          type="button"
          class="fav-btn"
          :class="{ active: favorited }"
          :disabled="!canFavorite || favBusy"
          :title="t('favorites.favoriteTitle')"
          :aria-label="favorited ? t('favorites.favorited') : t('favorites.favorite')"
          @click="emit('toggle-favorite')"
        >
          <span class="fav-star">{{ favorited ? "⭐" : "☆" }}</span>
          <span class="sr-only">{{ favorited ? t("favorites.favorited") : t("favorites.favorite") }}</span>
        </button>
        <button
          type="button"
          class="fav-btn"
          :class="{ active: translateActive }"
          :disabled="translateDisabled"
          :title="t('translate.triggerTitle')"
          :aria-label="translateLabel"
          @click="emit('translate')"
        >
          <span class="fav-star">🌐</span>
          <span class="sr-only">{{ translateLabel }}</span>
        </button>
        <button
          v-if="primaryAction === 'uninstall-local'"
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="revealingFolder"
          :title="t('detail.openFolder')"
          :aria-label="t('detail.openFolder')"
          @click="emit('reveal-folder')"
        >
          <span aria-hidden="true">📁</span>
          <span class="sr-only">{{ revealingFolder ? t("detail.opening") : t("detail.openFolder") }}</span>
        </button>
        <button
          v-if="localEntry"
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="subscribeBusy"
          :title="mod.updateAvailable ? t('online.updateLocal') : t('online.reinstallLocal')"
          :aria-label="mod.updateAvailable ? t('online.updateLocal') : t('online.reinstallLocal')"
          @click="emit('reinstall')"
        >
          <span aria-hidden="true">🔄</span>
          <span class="sr-only">{{ installing ? t("online.installing") : mod.updateAvailable ? t("online.updateLocal") : t("online.reinstallLocal") }}</span>
        </button>
        <button
          v-if="installing"
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="cancelRequested"
          :title="t('online.cancelDownload')"
          :aria-label="t('online.cancelDownload')"
          @click="emit('stop-install')"
        >
          <span aria-hidden="true">⏹</span>
          <span class="sr-only">{{ cancelRequested ? t("downloader.stopping") : t("online.cancelDownload") }}</span>
        </button>
        <button
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="openingWeb"
          :title="t('online.browseSite')"
          :aria-label="t('online.browseSite')"
          @click="emit('open-webpage')"
        >
          <span aria-hidden="true">🔗</span>
          <span class="sr-only">{{ t("online.browseSite") }}</span>
        </button>
        <button
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="!canFavorite || renameBusy"
          :title="t('favorites.renameTitle')"
          :aria-label="t('favorites.rename')"
          @click="emit('rename')"
        >
          <span aria-hidden="true">📝</span>
          <span class="sr-only">{{ t("favorites.rename") }}</span>
        </button>
      </div>
      <div v-if="favError" class="online-error">{{ favError }}</div>
    </section>

    <!-- ③ 描述区（v2.1）：夹在主操作与其他操作之间，长文本折叠 -->
    <section class="dv-zone dv-zone-desc">
      <h4 class="dv-zone-title">{{ t("online.description") }}</h4>
      <div v-if="descText" class="dv-desc" :class="{ clamped: descClamped }">{{ descText }}</div>
      <div v-else-if="detailLoading" class="note">{{ t("online.loading") }}</div>
      <div v-else-if="detailError" class="note">{{ detailError }}</div>
      <div v-else-if="detailUncached" class="note">{{ t("online.detailUncached") }}</div>
      <div v-else class="note">{{ t("online.noDetail") }}</div>
      <button v-if="descLong" type="button" class="dv-desc-toggle" @click="descExpanded = !descExpanded">
        {{ descExpanded ? t("detailPanel.collapse") : t("detailPanel.expand") }}
      </button>
    </section>

    <!-- ⑤ 状态区：本机安装状态 / 是否可更新 -->
    <section class="dv-zone dv-zone-status">
      <h4 class="dv-zone-title">{{ t("detailPanel.status") }}</h4>
      <div class="field">
        <span class="k">{{ t("online.localState") }}</span>
        <span class="v source-cell" :class="{ missing: !localEntry }">
          <template v-if="localEntry">
            <span class="badge" :class="'source-' + localEntry.source">
              {{ sourceLabel(localEntry.source) }}
            </span>
            <span class="note" style="margin: 0">
              {{ localEntry.kind }} / {{ localEntry.folderName }}
            </span>
          </template>
          <template v-else>{{ t("online.notInstalled") }}</template>
        </span>
      </div>
      <div v-if="localIndexError" class="online-error">
        {{ t("online.localIndexError", { err: localIndexError }) }}
      </div>
      <div class="field">
        <span class="k">{{ t("online.updateAvailable") }}</span>
        <span class="v">{{ mod.updateAvailable ? t("online.yes") : t("online.yesOrUnknown") }}</span>
      </div>
    </section>

    <!-- ⑥ 更多信息：作者 / 发布时间 / 更新时间 / 版本 / 订阅数 / 评分。
         发布时间取服务端 createDate，更新时间取 lastUpdate，二者不混用；
         服务端磁盘占用、内部状态串与服务端订阅标记属内部信息，不在普通界面展示。 -->
    <section class="dv-zone dv-zone-meta">
      <h4 class="dv-zone-title">{{ t("detailPanel.more") }}</h4>
      <div class="field">
        <span class="k">{{ t("online.author") }}</span>
        <span class="v" :class="{ missing: !mod.creator }">
          {{ mod.creator ?? t("labels.notProvided") }}
        </span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.created") }}</span>
        <span class="v" :class="{ missing: !createdText }">{{ createdText ?? t("labels.notProvided") }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.updated") }}</span>
        <span class="v" :class="{ missing: !updatedText }">{{ updatedText ?? t("labels.notProvided") }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.version") }}</span>
        <span class="v">{{ versionText }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.installs") }}</span>
        <span class="v">
          {{ mod.installs ?? t("labels.notProvided") }}
          <template v-if="mod.installsTruncated">{{ t("online.installsTruncated") }}</template>
        </span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.rating") }}</span>
        <span class="v">{{ ratingText }}</span>
      </div>
    </section>
  </div>

  <!-- 封面重试成功 / 失败轻提示（固定右下角，复用全局 .app-toast） -->
  <div v-if="coverToast" class="app-toast" :class="coverToast.kind">{{ coverToast.text }}</div>
</template>

<style scoped>
/* 解析自 OnlineBrowser：只保留面板自身的消息 / 进度 / 覆盖确认样式。
   分区与折叠样式已统一抽到 style.css 的 .dv-* （本地与在线详情页共用同一套）。 */
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.online-message {
  margin-top: 10px;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--gold);
}
.online-error {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(var(--danger-rgb), 0.45);
  border-radius: 3px;
  background: rgba(var(--danger-rgb), 0.08);
  color: var(--danger-text);
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  white-space: pre-wrap;
}
.online-note-box {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel-deep);
  color: var(--parch-dim);
  font-size: calc(11px * var(--global-scale));
  line-height: 1.7;
  white-space: pre-wrap;
  font-family: var(--font-mono);
}
.online-progress {
  margin-top: 10px;
}
.online-progress .bar {
  height: 6px;
  border-radius: 3px;
  background: var(--surface-track);
  border: 1px solid var(--line);
  overflow: hidden;
}
.online-progress .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  transition: width 0.2s ease;
}
.online-force {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 12px;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.6;
  color: var(--danger-text);
}

/* 辅助操作行统一间距 */
.dv-action-secondary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
</style>
