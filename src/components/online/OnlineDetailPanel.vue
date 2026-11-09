<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

/** 长描述折叠：与本地详情页保持同一套阈值 */
const DESC_COLLAPSE_AT = 260;
const descExpanded = ref(false);
const descLong = computed(() => {
  const text = props.descText;
  if (!text) return false;
  return text.length > DESC_COLLAPSE_AT || text.split("\n").length > 8;
});
const descClamped = computed(() => descLong.value && !descExpanded.value);

// 换模组时重置折叠状态
watch(
  () => props.mod?.modId,
  () => {
    descExpanded.value = false;
  },
);
</script>

<template>
  <div class="detail-header">
    <h2>{{ t("online.detailTitle") }}</h2>
    <span v-if="mod" class="badge">#{{ mod.modId }}</span>
  </div>

  <div v-if="!mod" class="detail-empty">
    {{ t("online.detailEmpty") }}<br />
    <span class="note">{{ t("online.detailEmptyNote") }}</span>
  </div>

  <div v-else class="detail-body">
    <!-- ① 识别区：封面 + 名称 + 标签 -->
    <section class="dv-zone dv-ident">
      <img v-if="thumb" class="detail-cover" :src="thumb" alt="" />
      <div v-else class="no-cover-box">{{ t("online.noThumbnail") }}</div>

      <h3 class="detail-title">{{ title }}</h3>
      <div v-if="subtitle" class="detail-title-orig">{{ subtitle }}</div>

      <div v-if="tags.length" class="detail-badges">
        <span v-for="name in tags" :key="name" class="badge">{{ name }}</span>
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

      <!-- 常用辅助操作：收藏 + 翻译 -->
      <div class="dv-action-row dv-action-secondary">
        <button
          type="button"
          class="fav-btn"
          :class="{ active: favorited }"
          :disabled="!canFavorite || favBusy"
          :title="t('favorites.favoriteTitle')"
          @click="emit('toggle-favorite')"
        >
          <span class="fav-star">{{ favorited ? "⭐" : "☆" }}</span>
          {{ favorited ? t("favorites.favorited") : t("favorites.favorite") }}
        </button>
        <button
          type="button"
          class="fav-btn"
          :class="{ active: translateActive }"
          :disabled="translateDisabled"
          :title="t('translate.triggerTitle')"
          @click="emit('translate')"
        >
          <span class="fav-star">🌐</span>
          {{ translateLabel }}
        </button>
      </div>
      <div v-if="favError" class="online-error">{{ favError }}</div>
      <div v-if="translateProvider" class="translate-note-row">
        <span class="translate-note">{{ translateProvider }}</span>
      </div>

      <!-- 次要操作：打开文件夹 + 网站浏览 + 重装 + 更多操作（备注名） -->
      <div class="detail-actions">
        <button
          v-if="primaryAction === 'uninstall-local'"
          type="button"
          class="dv-btn-ghost"
          :disabled="revealingFolder"
          :title="t('detail.openFolder')"
          @click="emit('reveal-folder')"
        >
          {{ revealingFolder ? t("detail.opening") : t("detail.openFolder") }}
        </button>
        <button
          v-if="localEntry"
          type="button"
          class="dv-btn-ghost"
          :disabled="subscribeBusy"
          @click="emit('reinstall')"
        >
          {{ installing ? t("online.installing") : mod.updateAvailable ? t("online.updateLocal") : t("online.reinstallLocal") }}
        </button>
        <button
          v-if="installing"
          type="button"
          class="dv-btn-ghost"
          :disabled="cancelRequested"
          @click="emit('stop-install')"
        >
          {{ cancelRequested ? t("downloader.stopping") : t("online.cancelDownload") }}
        </button>
        <button type="button" class="dv-btn-ghost" :disabled="openingWeb" @click="emit('open-webpage')">
          {{ t("online.browseSite") }}
        </button>
        <details class="more-actions">
          <summary class="dv-btn-ghost more-actions-summary">
            ⋯ {{ t("detailPanel.more") }}
          </summary>
          <div class="more-actions-menu">
            <button
              type="button"
              :disabled="!canFavorite || renameBusy"
              :title="t('favorites.renameTitle')"
              @click="emit('rename'); ($event.currentTarget as HTMLButtonElement).closest('details')!.open = false"
            >
              📝 {{ t("favorites.rename") }}
            </button>
          </div>
        </details>
      </div>
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

    <!-- ⑥ 作者 / 版本 / 时间 -->
    <section class="dv-zone dv-zone-meta">
      <h4 class="dv-zone-title">{{ t("detailPanel.meta") }}</h4>
      <div class="field">
        <span class="k">{{ t("online.author") }}</span>
        <span class="v" :class="{ missing: !mod.creator }">
          {{ mod.creator ?? t("labels.notProvided") }}
        </span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.version") }}</span>
        <span class="v">{{ versionText }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.created") }}</span>
        <span class="v" :class="{ missing: !createdText }">{{ createdText ?? t("labels.notProvided") }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.updated") }}</span>
        <span class="v" :class="{ missing: !updatedText }">{{ updatedText ?? t("labels.notProvided") }}</span>
      </div>
    </section>

    <!-- ⑦ 低频信息：订阅数 / 评分 / 体积 / 状态（不折叠、不显示分区标题，直接平铺） -->
    <section class="dv-zone dv-zone-more">
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
      <div class="field">
        <span class="k">{{ t("online.modSize") }}</span>
        <span class="v">{{ sizeText }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.diskSize") }}</span>
        <span class="v">{{ diskText }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.status") }}</span>
        <span class="v">{{ mod.modStatus ?? t("labels.notProvided") }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("online.subscribed") }}</span>
        <span class="v">{{ mod.userInstalled ? t("online.yesOfficial") : t("online.no") }}</span>
      </div>
    </section>
  </div>
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

/* 更多操作下拉菜单 */
.more-actions {
  position: relative;
}
.more-actions-summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}
.more-actions-summary::-webkit-details-marker {
  display: none;
}
.more-actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-panel);
  box-shadow: 0 8px 20px rgba(var(--shadow-rgb), 0.4);
  z-index: 10;
  padding: 4px 0;
}
.more-actions-menu button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--parch);
  font-size: calc(12px * var(--global-scale));
  cursor: pointer;
  white-space: nowrap;
}
.more-actions-menu button:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.1);
  color: var(--gold-text);
}
.more-actions-menu button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 辅助操作行统一间距 */
.dv-action-secondary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.translate-note-row {
  margin-top: 4px;
}
.translate-note {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
}
</style>
