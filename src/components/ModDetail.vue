<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry, ModStats, ModUpdateItem } from "../types";
import { deleteModFiles, fileUrl, revealModFolder, toggleModEnabled } from "../api";
import {
  formatBytes,
  formatDateTime,
  kindLabel,
  sourceLabel,
  statusLabel,
} from "../format";
import ConfirmDialog from "./ConfirmDialog.vue";
import { openModWebpage } from "../online/service";
import { localizedTagName } from "../online/types";
import {
  activeTranslation,
  canTranslateText,
  currentTargetLanguageName,
  ensureTranslation,
  isQueued,
  isShowingOriginal,
  isTranslating,
  loadCachedTranslation,
  toggleOriginal,
  translationErrorKind,
  translationLangEpoch,
  translationOf,
} from "../online/translation";
import { translateBackendMessage } from "../format";
import {
  customNameOf,
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

const { t, locale } = useI18n();

/**
 * 详情页分区标题 / 折叠按钮文案。
 * 只在本组件内使用，因此不额外新增语言包键（本次改造不改 i18n 文件）。
 */
const ui = computed(() =>
  String(locale.value).toLowerCase().startsWith("zh")
    ? {
        actions: "操作",
        moreActions: "其他操作",
        status: "状态",
        meta: "作者与更新时间",
        more: "更多技术信息",
        expand: "展开全文",
        collapse: "收起",
      }
    : {
        actions: "Actions",
        moreActions: "More actions",
        status: "Status",
        meta: "Author & updates",
        more: "More technical info",
        expand: "Show more",
        collapse: "Show less",
      },
);

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

// ---------------- v0.2.4：一键翻译（复用在线页的 translation_cache.json） ----------------
/**
 * 翻译入口只看 WorkshopID：
 * 手动拷进 local 目录的模组既不能在官方查重，也无法稳定绑定缓存，
 * 所以直接隐藏按钮（与收藏/备注名的判定保持一致）。
 */
const translateId = computed(() => {
  const id = props.mod.workshopId ?? 0;
  return id > 0 ? id : 0;
});
const selectedTranslation = computed(() => activeTranslation(translateId.value));
const hasTranslation = computed(() => translationOf(translateId.value) !== null);
const translateBusy = computed(() => isTranslating(translateId.value));
const translateQueued = computed(() => isQueued(translateId.value));
const showingOriginalText = computed(() => isShowingOriginal(translateId.value));

/** 详情标题优先级：备注名 > 中文译文 > info.json / 文件夹原名 */
const headerTitle = computed(() => {
  const custom = customName.value;
  if (custom) return custom;
  const zh = selectedTranslation.value?.title?.trim();
  return zh ? zh : props.mod.displayName;
});

/** 标题下小字：**只**用于备注名回显；译文不再叠英文原名 */
const titleSub = computed(() =>
  customName.value ? `${t("favorites.originalTitle")}: ${props.mod.displayName}` : null,
);

/** 描述：中文译文优先，否则用本地 info.json / mod-status 里的原文 */
const descText = computed(() => {
  const zh = selectedTranslation.value?.desc?.trim();
  return zh ? zh : props.mod.description ?? "";
});

/** 描述过短（无描述的手工模组）= 不够翻译，按钮置灰并提示 */
const canTranslate = computed(() => canTranslateText(props.mod.description));

/** 长描述折叠：超过约 8 行（或换行很多）才出现「展开全文」 */
const DESC_COLLAPSE_AT = 260;
const descExpanded = ref(false);
const descLong = computed(() => {
  const text = descText.value;
  if (!text) return false;
  return text.length > DESC_COLLAPSE_AT || text.split("\n").length > 8;
});
/** 未展开且确实过长时才截断 */
const descClamped = computed(() => descLong.value && !descExpanded.value);

const translateLabel = computed(() => {
  if (translateBusy.value) return t("translate.busy");
  if (translateQueued.value) return t("translate.queued");
  if (!hasTranslation.value) {
    return t("translate.trigger", { lang: currentTargetLanguageName() });
  }
  return showingOriginalText.value
    ? t("translate.showTranslated", { lang: currentTargetLanguageName() })
    : t("translate.showOriginal");
});

const translateProvider = computed(() => {
  const tr = translationOf(translateId.value);
  if (!tr) return null;
  return tr.cached
    ? t("translate.fromCache", { name: tr.provider })
    : t("translate.provider", { name: tr.provider });
});

/** 只读探测本地译文缓存（无网络）：在线页翻过 / 上次会话翻过 → 打开即中文 */
async function probeTranslationCache(): Promise<void> {
  const id = translateId.value;
  if (id <= 0) return;
  await loadCachedTranslation(
    { modId: id, title: props.mod.displayName },
    props.mod.description ?? "",
  );
}

async function onTranslateClick(): Promise<void> {
  const id = translateId.value;
  if (id <= 0) return;
  // ① 当前**目标语言**下已有译文：按钮是「显示原文 / 显示译文」的开关，不发任何请求。
  //    （translationOf 会过滤掉旧语言槽位，所以换语言后这里一定是 null）
  if (translationOf(id)) {
    toggleOriginal(id);
    return;
  }
  if (translateBusy.value || translateQueued.value) return;
  // ② 没翻过 / 只翻过旧语言 → 走当前目标语言的请求；
  //    ensureTranslation 会先丢掉旧语言条目，所以点一次就会去翻新语言而不是切原文。
  if (!canTranslate.value) {
    showToast(t("translate.notReady"), "error");
    return;
  }
  try {
    const tr = await ensureTranslation(
      { modId: id, title: props.mod.displayName },
      props.mod.description ?? "",
    );
    if (tr.truncated) {
      showToast(t("translate.truncated", { chars: tr.charCount }));
    } else {
      showToast(tr.cached ? t("translate.fromCacheToast") : t("translate.okToast"));
    }
  } catch (e) {
    showToast(translationErrorText(e), "error");
  }
}

function translationErrorText(error: unknown): string {
  switch (translationErrorKind(error)) {
    case "network":
      return t("translate.failNetwork");
    case "busy":
      return t("translate.failBusy");
    case "quota":
      return t("translate.failQuota");
    case "not_ready":
      return t("translate.notReady");
    default:
      return t("translate.failGeneric", { msg: rawMessageOf(error) });
  }
}

function rawMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as Error)?.message;
  return message ?? String(error ?? "");
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
  () => [props.mod.id, props.mod.workshopId, translationLangEpoch()] as const,
  () => {
    imgFailed.value = false;
    // 换模组时描述折叠状态归零，避免上一个模组的「展开」状态被带过来
    descExpanded.value = false;
    toggleError.value = null;
    confirmOpen.value = false;
    deleteError.value = null;
    favError.value = null;
    renameOpen.value = false;
    // 只读查一次缓存（无网络）：命中就瞬间显示中文，未命中也只是让按钮可点
    void probeTranslationCache();
  },
  { immediate: true },
);
</script>

<template>
  <div class="detail-header">
    <h2>{{ t("detail.title") }}</h2>
    <span class="badge" :class="'source-' + mod.source">
      {{ sourceLabel(mod.source) }}
    </span>
    <span class="badge" :class="mod.kind === 'local' ? 'local' : 'sub'">{{ kindLabel(mod.kind) }}</span>
  </div>

  <div class="detail-body">
    <!-- ① 识别区：封面 + 模组名 + 来源/分类标签 -->
    <section class="dv-zone dv-ident">
      <img v-if="coverUrl" class="detail-cover" :src="coverUrl" alt="" @error="imgFailed = true" />
      <div v-else class="no-cover-box">
        {{ t("detail.coverMissing") }}<br />
        {{ t("detail.coverMissingDetail") }}
      </div>

      <h3 class="detail-title">{{ headerTitle }}</h3>
      <div v-if="titleSub" class="detail-title-orig">{{ titleSub }}</div>

      <div class="detail-badges">
        <span v-for="tag in mod.contentTags" :key="tag" class="badge">{{ localizedTagName(tag) }}</span>
        <span v-if="mod.nameFromFolder !== mod.displayName" class="badge">
          {{ t("detail.folder") }}: {{ mod.nameFromFolder }}
        </span>
      </div>
    </section>

    <!-- ② 操作区（v2.0 前置）：所有可点按钮集中在这里，紧跟识别区，先能做再读描述
         （顺序：主操作 → 辅助 → 危险） -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ ui.actions }}</h4>

      <!-- v0.2.4：一键翻译（仅手动触发；打开详情页只做一次本地缓存查询，绝无网络请求） -->
      <div v-if="translateId > 0" class="translate-row">
        <button
          type="button"
          class="translate-btn"
          :class="{ active: hasTranslation && !showingOriginalText }"
          :disabled="translateBusy || translateQueued || (!hasTranslation && !canTranslate)"
          :title="t('translate.triggerTitle')"
          @click="onTranslateClick"
        >
          <span class="translate-icon">🌐</span>
          {{ translateLabel }}
        </button>
        <span v-if="translateProvider" class="translate-note">{{ translateProvider }}</span>
        <span v-else-if="!canTranslate" class="translate-note">{{ t("translate.waitingContent") }}</span>
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

      <!-- 主操作：启用 / 停用（金色高亮的开关控件） -->
      <div class="dv-action-row">
        <button
          type="button"
          class="toggle dv-toggle"
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
      </div>
    </section>

    <!-- ③ 描述区（v2.1）：夹在主操作与其他操作之间，长文本折叠 -->
    <section class="dv-zone dv-zone-desc">
      <h4 class="dv-zone-title">{{ t("detail.description") }}</h4>
      <div v-if="descText" class="dv-desc" :class="{ clamped: descClamped }">{{ descText }}</div>
      <div v-else class="note">{{ t("detail.descriptionMissing") }}</div>
      <button v-if="descLong" type="button" class="dv-desc-toggle" @click="descExpanded = !descExpanded">
        {{ descExpanded ? ui.collapse : ui.expand }}
      </button>
    </section>

    <!-- ④ 其他操作（v2.1 后置）：打开所在文件夹 / 在网站浏览 / 卸载模组 -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ ui.moreActions }}</h4>

      <!-- 辅助操作：打开目录 / 官网（描边 Ghost 样式） -->
      <div class="dv-action-row">
        <button type="button" class="dv-btn-ghost" :disabled="revealing" @click="revealFolder">
          {{ revealing ? t("detail.opening") : t("detail.openFolder") }}
        </button>
        <button
          type="button"
          class="dv-btn-ghost"
          :disabled="!canOpenWebsite || openingWeb"
          :title="canOpenWebsite ? t('detail.browseSiteTitle') : t('detail.browseSiteDisabled')"
          @click="openWebsite"
        >
          {{ openingWeb ? t("detail.opening") : t("detail.browseSite") }}
        </button>
      </div>
      <p v-if="!canOpenWebsite" class="dv-action-note">{{ t("detail.noWorkshopNote") }}</p>
      <div v-if="revealError" class="path-actions">
        <span class="path-error">{{ revealError }}</span>
      </div>
      <div v-if="webError" class="path-actions">
        <span class="path-error">{{ webError }}</span>
      </div>

      <!-- 危险操作：卸载本机文件（红色 + 二次确认） -->
      <div class="dv-action-row dv-action-danger">
        <button
          type="button"
          class="danger delete-btn"
          :disabled="deleting || toggling"
          :title="t('detail.deleteTitle')"
          @click="askDelete"
        >
          {{ t("detail.deleteMod") }}
        </button>
      </div>
    </section>

    <!-- ⑤ 状态区：启用/停用、加载优先级、数据提示 -->
    <section class="dv-zone dv-zone-status">
      <h4 class="dv-zone-title">{{ ui.status }}</h4>
      <div class="detail-badges dv-status-badges">
        <span class="badge" :class="mod.enabled === null ? 'warn' : ''">{{ statusLabel(mod.enabled) }}</span>
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
        <span class="k">{{ t("detail.source") }}</span>
        <span class="v source-cell">
          <span class="badge" :class="'source-' + mod.source">{{ sourceLabel(mod.source) }}</span>
        </span>
      </div>
      <div v-if="mod.issues.length" class="dv-issues">
        <h5 class="dv-sub-title">{{ t("detail.dataIssues") }}</h5>
        <ul class="issue-list">
          <li v-for="issue in mod.issues" :key="issue">{{ translateBackendMessage(issue) }}</li>
        </ul>
      </div>
    </section>

    <!-- ⑥ 作者 / 版本 / 更新时间 -->
    <section class="dv-zone dv-zone-meta">
      <h4 class="dv-zone-title">{{ ui.meta }}</h4>
      <div class="field">
        <span class="k">{{ t("detail.author") }}</span>
        <span class="v" :class="{ missing: !mod.author }">
          {{ mod.author ?? t("detail.authorMissing") }}
        </span>
      </div>
      <div class="field">
        <span class="k">{{ t("detail.lastUpdate") }}</span>
        <span class="v" :class="{ missing: !mod.lastUpdateMs }">{{ formatDateTime(mod.lastUpdateMs) }}</span>
      </div>
    </section>

    <!-- ⑦ 低频技术信息：默认收起，点开才占位 -->
    <details class="dv-zone dv-more">
      <summary class="dv-more-summary">{{ ui.more }}</summary>
      <div class="field">
        <span class="k">{{ t("detail.workshopId") }}</span>
        <span class="v" :class="{ missing: !mod.workshopId }">
          {{ mod.workshopId ?? t("detail.workshopIdMissing") }}
        </span>
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
    </details>
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
