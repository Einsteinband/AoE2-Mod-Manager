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
  // 安装
  primaryAction: "install" | "uninstall-local";
  subscribeLabel: string;
  subscribeBusy: boolean;
  installing: boolean;
  progress: DownloadProgress | null;
  actionMessage: string | null;
  installError: string | null;
  installNote: string | null;
  openingWeb: boolean;
  // 详情
  descText: string | null;
  detailLoading: boolean;
  detailError: string | null;
  hasDetail: boolean;
  rawEntries: { key: string; value: string }[];
}>();

/** 覆盖确认勾选 / 需要覆盖时的提示开关（v-model 双向绑定，父组件持有真源） */
const needForce = defineModel<boolean>("needForce", { default: false });
const forceOverwrite = defineModel<boolean>("forceOverwrite", { default: false });

const emit = defineEmits<{
  (event: "translate"): void;
  (event: "toggle-favorite"): void;
  (event: "rename"): void;
  (event: "install"): void;
  (event: "uninstall"): void;
  (event: "reinstall"): void;
  (event: "stop-install"): void;
  (event: "open-webpage"): void;
}>();

const { t, locale } = useI18n();

/**
 * 分区标题 / 展开按钮文案：仅本组件内部使用，故不新增语言包键。
 */
const ui = computed(() =>
  String(locale.value).toLowerCase().startsWith("zh")
    ? {
        actions: "操作",
        moreActions: "其他操作",
        status: "状态",
        meta: "作者与版本",
        more: "更多技术信息",
        rawFields: "服务端原始字段",
        expand: "展开全文",
        collapse: "收起",
      }
    : {
        actions: "Actions",
        moreActions: "More actions",
        status: "Status",
        meta: "Author & version",
        more: "More technical info",
        rawFields: "Raw server fields",
        expand: "Show more",
        collapse: "Show less",
      },
);

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

    <!-- ② 操作区（v2.0 前置）：翻译 / 收藏 / 备注 / 安装 / 卸载 / 重装 / 取消下载 / 官网 -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ ui.actions }}</h4>

      <!-- v0.2.4：一键翻译（手动触发；未点击时绝不发任何翻译请求） -->
      <div class="translate-row">
        <button
          type="button"
          class="translate-btn"
          :class="{ active: translateActive }"
          :disabled="translateDisabled"
          :title="t('translate.triggerTitle')"
          @click="emit('translate')"
        >
          <span class="translate-icon">🌐</span>
          {{ translateLabel }}
        </button>
        <span v-if="translateProvider" class="translate-note">{{ translateProvider }}</span>
        <span v-else-if="translateNote" class="translate-note">{{ translateNote }}</span>
      </div>

      <!-- v0.5：收藏 / 备注名 -->
      <div class="fav-row">
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
          :disabled="!canFavorite || renameBusy"
          :title="t('favorites.renameTitle')"
          @click="emit('rename')"
        >
          <span class="fav-star">📝</span>
          {{ t("favorites.rename") }}
        </button>
      </div>
      <div v-if="favError" class="online-error">{{ favError }}</div>

      <!-- 主操作：安装（实心金色）/ 卸载（危险红，父组件的二次确认弹窗照常触发） -->
      <div class="detail-actions">
        <button
          v-if="primaryAction === 'install'"
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
      <pre v-if="installNote" class="online-note-box">{{ installNote }}</pre>
    </section>

    <!-- ③ 描述区（v2.1）：夹在主操作与其他操作之间，长文本折叠 -->
    <section class="dv-zone dv-zone-desc">
      <h4 class="dv-zone-title">{{ t("online.description") }}</h4>
      <div v-if="descText" class="dv-desc" :class="{ clamped: descClamped }">{{ descText }}</div>
      <div v-else-if="detailLoading" class="note">{{ t("online.loading") }}</div>
      <div v-else-if="detailError" class="note">{{ detailError }}</div>
      <div v-else class="note">{{ t("online.noDetail") }}</div>
      <button v-if="descLong" type="button" class="dv-desc-toggle" @click="descExpanded = !descExpanded">
        {{ descExpanded ? ui.collapse : ui.expand }}
      </button>
    </section>

    <!-- ④ 其他操作（v2.1 后置）：重装 / 取消下载 / 在网站浏览 -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ ui.moreActions }}</h4>
      <div class="detail-actions">
        <button
          v-if="localEntry"
          type="button"
          class="dv-btn-ghost"
          :disabled="subscribeBusy"
          @click="emit('reinstall')"
        >
          {{ installing ? t("online.installing") : mod.updateAvailable ? t("online.updateLocal") : t("online.reinstallLocal") }}
        </button>
        <button v-if="installing" type="button" class="dv-btn-ghost" @click="emit('stop-install')">
          {{ t("online.cancelDownload") }}
        </button>
        <button type="button" class="dv-btn-ghost" :disabled="openingWeb" @click="emit('open-webpage')">
          {{ t("online.browseSite") }}
        </button>
      </div>
    </section>

    <!-- ⑤ 状态区：本机安装状态 / 是否可更新 -->
    <section class="dv-zone dv-zone-status">
      <h4 class="dv-zone-title">{{ ui.status }}</h4>
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
      <h4 class="dv-zone-title">{{ ui.meta }}</h4>
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

    <!-- ⑦ 低频信息：订阅数 / 评分 / 体积 / 服务端原始字段，默认收起 -->
    <details class="dv-zone dv-more">
      <summary class="dv-more-summary">{{ ui.more }}</summary>
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

      <div class="dv-raw">
        <h5 class="dv-sub-title">{{ ui.rawFields }} · #{{ mod.modId }}</h5>
        <div v-if="detailLoading" class="note">{{ t("online.loading") }}</div>
        <div v-else-if="detailError" class="note">{{ detailError }}</div>
        <template v-else-if="hasDetail">
          <div v-for="entry in rawEntries" :key="entry.key" class="field">
            <span class="k">{{ entry.key }}</span>
            <span class="v mono">{{ entry.value }}</span>
          </div>
        </template>
        <div v-else class="note">{{ t("online.noDetail") }}</div>
      </div>
    </details>
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
  font-family: Consolas, monospace;
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
</style>
