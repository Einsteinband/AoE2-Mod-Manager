<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry, ModStats, ModUpdateItem } from "../types";
import { deleteModFiles, fileUrl, revealModFolder, toggleModEnabled } from "../api";
import { activeTaskOfMod, latestTaskOfMod } from "../online/downloadQueue";
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
  /** 本地/订阅重复的一句话提示（null = 无冲突） */
  conflictHint?: string | null;
}>();

const emit = defineEmits<{
  (e: "toggled", payload: { enabled: boolean }): void;
  (e: "removed", payload: { id: string }): void;
  (e: "update"): void;
  /** 「未安装」收藏条目：操作区的「下载安装」按钮上抛，由页面统一入队 */
  (e: "download"): void;
  /** 数据模组的启用请求：互斥裁决在父组件，详情页自己不动磁盘 */
  (e: "request-enable", payload: { id: string }): void;
}>();

const { t } = useI18n();

const imgFailed = ref(false);
/** 封面重试阶段：本地模组无网络下载源，只有重新加载 / 完成 / 失败 */
type CoverStage = "idle" | "reloading" | "done" | "failed";
const coverStage = ref<CoverStage>("idle");
/** 封面重新加载中：防止短时间重复点击 */
const coverReloading = computed(() => coverStage.value === "reloading");
/** 强制 <img> 重建重渲同一资源（本地文件 / 缓存 asset URL 无网络重下链路） */
const coverReloadKey = ref(0);
const revealing = ref(false);
const revealError = ref<string | null>(null);
const toggling = ref(false);
const toggleError = ref<string | null>(null);
const confirmOpen = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);
const openingWeb = ref(false);
const webError = ref<string | null>(null);
/** 描述拉取 / 翻译失败的错误（API 404 等）：描述为空时优先显示真实错误，而不是吞掉变成「未提供描述」 */
const descError = ref<string | null>(null);

// v0.5：收藏 / 备注名（只和 WorkshopID 绑定，改完立即落盘 + 局部 Patch，不重扫）
const canFavorite = computed(() => (props.mod.workshopId ?? 0) > 0);
/**
 * v0.6：收藏里的「已卸载 / 未安装」占位条目。
 * 它没有本地目录与 mod-status.json 记录，所以目录类 / 开关类操作全部隐藏，
 * 只在操作区保留一个「下载安装」按钮（收藏、备注名、官网跳转照常可用）。
 */
const uninstalled = computed(() => props.mod.uninstalled === true);
/** 正在下载 / 已在下载队列（同名模组不重复入队） */
const activeDownloadTask = computed(() => {
  const id = props.mod.workshopId ?? 0;
  return id > 0 ? activeTaskOfMod(id) : null;
});
/** 最近一次下载任务的错误（失败时在详情面板红框显示，与在线页口径一致） */
const downloadError = computed(() => {
  const id = props.mod.workshopId ?? 0;
  if (id <= 0) return null;
  const task = latestTaskOfMod(id);
  if (!task || task.status !== "failed") return null;
  return task.error;
});
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
    // 描述为空时，把 API 错误（如 HTTP 404）暴露到描述区，而不是吞掉变成「未提供描述」
    descError.value = rawMessageOf(e);
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
  if (typeof error === "string") return translateBackendMessage(error);
  const message = (error as Error)?.message;
  return translateBackendMessage(message ?? String(error ?? ""));
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

/** 基本信息区：文件体积（安装后目录统计，非压缩包大小） */
const sizeText = computed(() => {
  if (props.statsLoading) return t("detail.counting");
  if (props.stats) return formatBytes(props.stats.sizeBytes);
  if (props.statsError) return translateBackendMessage(props.statsError);
  return "—";
});

/** 基本信息区：文件数量 */
const fileCountText = computed(() => {
  if (props.statsLoading) return t("detail.counting");
  if (props.stats) return t("detail.files", { n: props.stats.fileCount.toLocaleString() });
  return "—";
});

/**
 * 复制 Workshop ID 到系统剪贴板：优先 Clipboard API，失败退回 textarea + execCommand。
 * 无 ID 时按钮不可点，不会触发。
 */
async function copyWorkshopId(): Promise<void> {
  const id = props.mod.workshopId;
  if (!id || id <= 0) return;
  const text = String(id);
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
  showToast(ok ? t("detail.copied") : t("detail.copyFailed"), ok ? "ok" : "error");
}

/** 返回 raw 错误串，渲染时由 translateBackendMessage 翻译，切语言即时跟随。 */
function errorText(e: unknown, fallbackKey: string): string {
  if (typeof e === "string") return e;
  const message = (e as Error)?.message;
  return message ?? `aoe2mm:err:${fallbackKey}`;
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
  // 数据模组：游戏同一时间只能加载一个，启用前必须交给父组件做互斥裁决
  if (target && props.mod.isDataMod) {
    emit("request-enable", { id: props.mod.id });
    return;
  }
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

const coverUrl = computed(() => {
  if (imgFailed.value) return null;
  // v0.6：未安装占位条目只有图片缓存的 asset URL，没有磁盘路径
  if (props.mod.coverUrl) return props.mod.coverUrl;
  return props.mod.thumbnail ? fileUrl(props.mod.thumbnail) : null;
});

/** 封面加载成功：结束重试态并提示已更新 */
function onCoverLoad(): void {
  coverStage.value = "done";
  showToast(t("detail.coverUpdated"));
}

/** 封面加载失败：回到失败态，按钮保留可再次点击 */
function onCoverError(): void {
  imgFailed.value = true;
  coverStage.value = "failed";
  showToast(t("detail.coverLoadFailed"), "error");
}

/** 重新尝试读取现有封面资源；本地模组无网络下载链路，仅强制重渲 */
function reloadCover(): void {
  if (coverReloading.value) return;
  imgFailed.value = false;
  // 清失败态后仍无资源（本地确实缺文件 / 无缓存 URL）：给出获取失败提示，按钮保持可点
  if (!coverUrl.value) {
    coverStage.value = "failed";
    showToast(t("detail.coverFetchFailed"), "error");
    return;
  }
  coverStage.value = "reloading";
  coverReloadKey.value += 1;
}

watch(
  () => [props.mod.id, props.mod.workshopId, translationLangEpoch()] as const,
  () => {
    imgFailed.value = false;
    coverStage.value = "idle";
    // 换模组时描述折叠状态归零，避免上一个模组的「展开」状态被带过来
    descExpanded.value = false;
    toggleError.value = null;
    confirmOpen.value = false;
    deleteError.value = null;
    favError.value = null;
    renameOpen.value = false;
    descError.value = null;
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
      <div class="cover-frame">
        <img
          v-if="coverUrl"
          :key="coverReloadKey"
          class="detail-cover"
          :src="coverUrl"
          alt=""
          @load="onCoverLoad"
          @error="onCoverError"
        />
        <div v-else class="no-cover-box">
          {{ t("detail.coverMissing") }}<br />
          {{ t("detail.coverMissingDetail") }}
        </div>
        <button
          v-if="!coverUrl || imgFailed"
          type="button"
          class="cover-reload-btn"
          :disabled="coverReloading"
          :aria-label="t('detail.refreshCover')"
          :title="t('detail.refreshCoverHint')"
          @click="reloadCover"
        >
          <span :class="{ 'is-spinning': coverReloading }" aria-hidden="true">🔄</span>
        </button>
      </div>
      <p v-if="coverStage === 'reloading'" class="cover-status">{{ t("detail.coverReloading") }}</p>

      <h3 class="detail-title">{{ headerTitle }}</h3>
      <div v-if="titleSub" class="detail-title-orig">{{ titleSub }}</div>

      <div class="detail-badges">
        <span v-if="conflictHint" class="conflict-badge">{{ conflictHint }}</span>
        <span v-for="tag in mod.contentTags" :key="tag" class="badge">{{ localizedTagName(tag) }}</span>
      </div>

      <!-- 基本信息：Workshop ID（可复制）+ 文件体积 + 文件数量，紧凑横排 -->
      <div class="basic-row">
        <button
          type="button"
          class="basic-chip basic-chip-copy"
          :disabled="!mod.workshopId"
          :title="mod.workshopId ? t('detail.copyIdTitle') : t('detail.workshopIdMissing')"
          :aria-label="mod.workshopId ? `${t('detail.workshopId')}: ${mod.workshopId}` : t('detail.workshopIdMissing')"
          @click="copyWorkshopId"
        >
          <span class="chip-label">{{ t("detail.workshopId") }}</span>
          <span class="chip-value">{{ mod.workshopId ?? t("detail.workshopIdMissing") }}</span>
        </button>
        <span class="basic-chip">
          <span class="chip-label">{{ t("detail.fileSize") }}</span>
          <span class="chip-value">{{ sizeText }}</span>
        </span>
        <span
          class="basic-chip"
          :title="stats?.truncated ? t('detail.sizeTruncated') : undefined"
        >
          <span class="chip-label">{{ t("detail.fileCount") }}</span>
          <span class="chip-value">{{ fileCountText }}</span>
        </span>
      </div>
    </section>

    <!-- ② 操作区（v2.0 前置）：所有可点按钮集中在这里，紧跟识别区，先能做再读描述
         （顺序：主操作 → 常用辅助 → 次要操作 → 危险） -->
    <section class="dv-zone dv-zone-actions">
      <h4 class="dv-zone-title">{{ t("detailPanel.actions") }}</h4>

      <!-- 主操作：启用 / 停用（金色高亮的开关控件）—— 未安装条目没有 mod-status.json 记录，不显示 -->
      <div v-if="!uninstalled" class="dv-action-row">
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

      <!-- 未安装的收藏：唯一的写盘类操作就是把它装回来 -->
      <div v-if="uninstalled" class="dv-action-row">
        <button
          type="button"
          class="primary install-btn"
          :disabled="!!activeDownloadTask || !canFavorite"
          :title="activeDownloadTask ? t('detail.downloadQueued') : t('detail.downloadTitle')"
          @click="emit('download')"
        >
          {{ activeDownloadTask ? t("detail.downloadQueued") : t("detail.downloadInstall") }}
        </button>
      </div>
      <div v-if="downloadError" class="path-actions">
        <span class="path-error">{{ downloadError }}</span>
      </div>

      <!-- 更新提示（有更新时显示） -->
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

      <!-- 数据模组提示 -->
      <div v-if="mod.isDataMod" class="dv-datamod-warn">
        <span class="dv-warn-icon">⚙️</span>
        <span>{{ t("detail.dataModWarning") }}</span>
      </div>

      <!-- 辅助操作单行：收藏、翻译、打开文件夹、网站浏览、备注名 -->
      <div class="dv-action-row dv-action-secondary">
        <button
          type="button"
          class="fav-btn"
          :class="{ active: favorited }"
          :disabled="!canFavorite || favBusy"
          :title="canFavorite ? t('favorites.favoriteTitle') : t('favorites.noId')"
          :aria-label="favorited ? t('favorites.favorited') : t('favorites.favorite')"
          @click="toggleFavorite"
        >
          <span class="fav-star">{{ favorited ? "⭐" : "☆" }}</span>
          <span class="sr-only">{{ favorited ? t("favorites.favorited") : t("favorites.favorite") }}</span>
        </button>
        <button
          v-if="translateId > 0"
          type="button"
          class="fav-btn"
          :class="{ active: hasTranslation && !showingOriginalText }"
          :disabled="translateBusy || translateQueued || (!hasTranslation && !canTranslate)"
          :title="t('translate.triggerTitle')"
          :aria-label="translateLabel"
          @click="onTranslateClick"
        >
          <span class="fav-star">🌐</span>
          <span class="sr-only">{{ translateLabel }}</span>
        </button>
        <button
          v-if="!uninstalled"
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="revealing"
          :title="t('detail.openFolder')"
          :aria-label="t('detail.openFolder')"
          @click="revealFolder"
        >
          <span aria-hidden="true">📁</span>
          <span class="sr-only">{{ revealing ? t("detail.opening") : t("detail.openFolder") }}</span>
        </button>
        <button
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="!canOpenWebsite || openingWeb"
          :title="canOpenWebsite ? t('detail.browseSiteTitle') : t('detail.browseSiteDisabled')"
          :aria-label="t('detail.browseSite')"
          @click="openWebsite"
        >
          <span aria-hidden="true">🔗</span>
          <span class="sr-only">{{ openingWeb ? t("detail.opening") : t("detail.browseSite") }}</span>
        </button>
        <button
          type="button"
          class="dv-btn-ghost icon-btn"
          :disabled="!canFavorite || renameBusy"
          :title="canFavorite ? t('favorites.renameTitle') : t('favorites.noId')"
          :aria-label="t('favorites.rename')"
          @click="openRename"
        >
          <span aria-hidden="true">📝</span>
          <span class="sr-only">{{ t("favorites.rename") }}</span>
        </button>
      </div>
      <div v-if="favError" class="path-actions">
        <span class="path-error">{{ translateBackendMessage(favError) }}</span>
      </div>
      <p v-if="!canOpenWebsite" class="dv-action-note">{{ t("detail.noWorkshopNote") }}</p>
      <div v-if="revealError" class="path-actions">
        <span class="path-error">{{ translateBackendMessage(revealError) }}</span>
      </div>
      <div v-if="webError" class="path-actions">
        <span class="path-error">{{ translateBackendMessage(webError) }}</span>
      </div>

      <!-- 危险操作：卸载本机文件（红色 + 二次确认）—— 未安装条目无文件可删 -->
      <div v-if="!uninstalled" class="dv-action-row dv-action-danger">
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

    <!-- ③ 描述区：夹在操作区与状态之间，长文本折叠 -->
    <section class="dv-zone dv-zone-desc">
      <h4 class="dv-zone-title">{{ t("detail.description") }}</h4>
      <div v-if="descText" class="dv-desc" :class="{ clamped: descClamped }">{{ descText }}</div>
      <div v-else-if="descError" class="note">{{ descError }}</div>
      <div v-else class="note">{{ t("detail.descriptionMissing") }}</div>
      <button v-if="descLong" type="button" class="dv-desc-toggle" @click="descExpanded = !descExpanded">
        {{ descExpanded ? t("detailPanel.collapse") : t("detailPanel.expand") }}
      </button>
    </section>

    <!-- ⑤ 状态区：启用/停用、加载优先级、数据提示（仅已安装条目） -->
    <section v-if="!uninstalled" class="dv-zone dv-zone-status">
      <h4 class="dv-zone-title">{{ t("detailPanel.status") }}</h4>
      <div class="detail-badges dv-status-badges">
        <span class="badge" :class="mod.enabled === null ? 'warn' : ''">{{ statusLabel(mod.enabled) }}</span>
      </div>
      <div v-if="toggleError" class="path-actions">
        <span class="path-error">{{ translateBackendMessage(toggleError) }}</span>
      </div>
      <div v-else-if="mod.enabled === null" class="path-actions">
        <span class="path-error">{{ t("detail.statusNoRecord") }}</span>
      </div>
      <div v-if="mod.issues.length" class="dv-issues">
        <h5 class="dv-sub-title">{{ t("detail.dataIssues") }}</h5>
        <ul class="issue-list">
          <li v-for="issue in mod.issues" :key="issue">{{ translateBackendMessage(issue) }}</li>
        </ul>
      </div>
    </section>

    <!-- ⑥ 更多信息：作者 / 发布时间 / 更新时间。
         本地模组没有可靠的首次发布时间来源：installedAtMs 是本机安装时间、
         lastUpdateMs 是最近更新时间，都不能冒充发布时间，这里固定显示未知，不推算。 -->
    <section class="dv-zone dv-zone-meta">
      <h4 class="dv-zone-title">{{ t("detailPanel.more") }}</h4>
      <div class="field">
        <span class="k">{{ t("detail.author") }}</span>
        <span class="v" :class="{ missing: !mod.author }">
          {{ mod.author ?? t("detail.authorMissing") }}
        </span>
      </div>
      <div class="field">
        <span class="k">{{ t("detail.published") }}</span>
        <span class="v missing">{{ t("labels.unknown") }}</span>
      </div>
      <div class="field">
        <span class="k">{{ t("detail.lastUpdate") }}</span>
        <span class="v" :class="{ missing: !mod.lastUpdateMs }">{{ formatDateTime(mod.lastUpdateMs) }}</span>
      </div>
    </section>
  </div>

  <!-- v0.5：备注名弹窗 -->
  <RenameDialog
    v-if="renameOpen"
    :original="mod.displayName"
    :initial="customName"
    :busy="renameBusy"
    :error="translateBackendMessage(renameError)"
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
    :error="translateBackendMessage(deleteError)"
    @confirm="confirmDelete"
    @cancel="confirmOpen = false"
  />

  <!-- 收藏 / 备注成功后的轻提示（固定右下角，不参与三栏布局） -->
  <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>
</template>

<style scoped>
/* 数据模组提示条：红金边框 + 羊皮纸底，与「可更新」面板同族但语气更克制（不是错误） */
.dv-datamod-warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 4px;
  padding: 9px 11px;
  border: 1px solid rgba(var(--accent-rgb), 0.6);
  border-radius: 4px;
  background: rgba(var(--badge-tool-rgb), 0.55);
  color: var(--parch);
  font-size: calc(12px * var(--global-scale));
  line-height: 1.55;
  letter-spacing: calc(0.3px * var(--ui-tracking));
}
.dv-datamod-warn .dv-warn-icon {
  flex: 0 0 auto;
  font-size: calc(13px * var(--global-scale));
  line-height: 1.4;
}

/* v0.6：未安装收藏条目的「下载安装」主按钮（与更新按钮同一金色主按钮风格） */
.install-btn {
  padding: 6px 14px;
  letter-spacing: calc(0.6px * var(--ui-tracking));
  white-space: nowrap;
}

/* 辅助操作行统一间距 */
.dv-action-secondary {
  gap: 8px;
  flex-wrap: wrap;
}
</style>
