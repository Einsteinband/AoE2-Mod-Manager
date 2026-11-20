<script setup lang="ts">
/**
 * 「收藏」工作区（第三个独立页面）。
 *
 * 页面自己决定展示模式：**官方在线信息 + 本机安装状态**。
 * 它不读本地页 / 在线页的筛选状态，也不依赖当前停留在哪个页面。
 *
 * 信息区（标题 / 作者 / 描述 / 发布时间 / 更新时间 / 版本 / 订阅数 / 封面）
 * 一律来自 `useFavorites` 的在线快照；本地只决定操作区按钮：
 *   未安装 → [下载安装]；已安装 → [开启/关闭] + 卸载 + 打开文件夹。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "../../composables/useToast";
import {
  customNameOf,
  displayTitle,
  ensureUserData,
  isFavorite,
  setCustomName,
  setFavorite,
} from "../../userData";
import ModCard from "../ModCard.vue";
import ModGrid from "../common/ModGrid.vue";
import ModDetail from "../ModDetail.vue";
import PageShell from "../layout/PageShell.vue";
import ViewSwitch from "../common/ViewSwitch.vue";
import ConfirmDialog from "../ConfirmDialog.vue";
import RenameDialog from "../RenameDialog.vue";
import ContextMenu from "../common/ContextMenu.vue";
import type { ContextMenuItem } from "../common/contextMenuTypes";
import { useContextMenu } from "../../composables/useContextMenu";
import { buildLocalMenuItems } from "../../composables/local/useLocalModMenu";
import { buildOnlineMenuItems } from "../../composables/online/useOnlineModMenu";
import { useFavorites } from "../../favorites/useFavorites";
import { favoriteIsInstalled } from "../../favorites/model";
import { deleteModFiles, revealModFolder, toggleModEnabled } from "../../api";
import { openModWebpage } from "../../online/service";
import {
  hasTranslatableText,
  isDescriptionLoaded,
  currentTargetLanguageName,
  ensureTranslation,
  isQueued,
  isShowingOriginal,
  isTranslating,
  toggleOriginal,
  translationErrorKind,
  translationOf,
} from "../../online/translation";
import { normalizeBackendError, translateBackendMessage } from "../../format";
import type { ModEntry } from "../../types";

const props = withDefaults(
  defineProps<{
    search?: string;
    sort?: string;
    order?: "DESC" | "ASC";
    cardSize?: number;
  }>(),
  {
    search: "",
    sort: "updated",
    order: "DESC",
    cardSize: 200,
  },
);

/** 收藏页的网格 / 列表切换：与 App 的全局 viewMode 双向同步 */
const viewMode = defineModel<"grid" | "list">("viewMode", { default: "grid" });

const emit = defineEmits<{
  (event: "open-online"): void;
  /** 空态「清除筛选」：搜索词归 App 持有，这里只上抛请求 */
  (event: "reset-search"): void;
}>();

const { t } = useI18n();
const { toast, showToast } = useToast();
const workspace = useFavorites();
const { loading, error, entries, scope, installedCount, uninstalledCount, refresh, install } = workspace;

const selectedModId = ref<number | null>(null);

const query = computed(() => String(props.search ?? "").trim().toLowerCase());

const filtered = computed<ModEntry[]>(() => {
  const q = query.value;
  return entries.value.filter((entry) => {
    if (scope.value === "installed" && !favoriteIsInstalled(entry)) return false;
    if (scope.value === "uninstalled" && favoriteIsInstalled(entry)) return false;
    if (!q) return true;
    const modId = entry.workshopId ?? 0;
    const haystack = [
      displayTitle(modId, entry.displayName),
      customNameOf(modId) ?? "",
      entry.author ?? "",
      entry.description ?? "",
      String(modId),
    ];
    return haystack.some((value) => value.toLowerCase().includes(q));
  });
});

const sorted = computed<ModEntry[]>(() => {
  const list = [...filtered.value];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const dir = props.order === "ASC" ? 1 : -1;
  list.sort((a, b) => {
    if (props.sort === "name") {
      return dir * collator.compare(displayTitle(a.workshopId, a.displayName), displayTitle(b.workshopId, b.displayName));
    }
    if (props.sort === "installs") {
      const av = a.onlineInfo?.installs ?? -1;
      const bv = b.onlineInfo?.installs ?? -1;
      if (av !== bv) return dir * (av - bv);
      return collator.compare(a.displayName, b.displayName);
    }
    // 默认：按官方最后更新时间（在线信息，不是本地安装时间）
    const av = a.onlineInfo?.updatedMs ?? a.lastUpdateMs ?? -1;
    const bv = b.onlineInfo?.updatedMs ?? b.lastUpdateMs ?? -1;
    if (av !== bv) return dir * (av - bv);
    return collator.compare(a.displayName, b.displayName);
  });
  return list;
});

/** 当前选中：按 WorkshopID 跟随；选中项被内部分类 / 搜索过滤掉时落到当前可见列表首项 */
const selected = computed<ModEntry | null>(() => {
  const visible = sorted.value;
  const id = selectedModId.value;
  if (id) {
    const hit = visible.find((entry) => (entry.workshopId ?? 0) === id);
    if (hit) return hit;
  }
  return visible[0] ?? null;
});

watch(
  entries,
  (list) => {
    if (!list.length) {
      selectedModId.value = null;
      return;
    }
    const id = selectedModId.value;
    if (id && list.some((entry) => (entry.workshopId ?? 0) === id)) return;
    selectedModId.value = (list[0].workshopId ?? 0) || null;
  },
  { immediate: true },
);

void refresh();

function selectMod(mod: ModEntry): void {
  selectedModId.value = mod.workshopId ?? 0;
}

function patchEnabled(id: string, enabled: boolean): void {
  const entry = entries.value.find((mod) => mod.id === id);
  if (entry) entry.enabled = enabled;
}

function patchCover(id: string, path: string): void {
  const entry = entries.value.find((mod) => mod.id === id);
  if (!entry) return;
  entry.thumbnail = path;
  entry.coverUrl = null;
}

function downloadEntry(entry: ModEntry): void {
  const result = install(entry);
  if (result.accepted) {
    showToast(t("favorites.downloadQueued"));
    return;
  }
  const key =
    result.reason === "noId"
      ? "favorites.downloadNoId"
      : result.reason === "offline"
        ? "online.offlineBlocked"
        : "favorites.downloadBusy";
  showToast(t(key), "error");
}

function download(): void {
  const entry = selected.value;
  if (!entry) return;
  downloadEntry(entry);
}

function removed(): void {
  void refresh();
}

// ---------------- 卡片右键上下文菜单 ----------------
// 与本地页 / 在线页共用同一套菜单构建器与浮层组件：
// 收藏项不是「一种新数据」，而是「官方信息 + 本机安装状态」，
// 因此按 `favoriteIsInstalled` 分流到已安装（本地菜单口径）或未安装（在线菜单口径），
// 菜单本身永远可以打开，内容随安装状态变化。

const cardMenu = useContextMenu<ModEntry>();
const menuOpen = cardMenu.open;
const menuX = cardMenu.x;
const menuY = cardMenu.y;

/** 备注弹窗 / 卸载确认作用在右键快照上，不改选中态 */
const renameTarget = ref<ModEntry | null>(null);
const renameBusy = ref(false);
const renameError = ref<string | null>(null);
const deleteTarget = ref<ModEntry | null>(null);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

function onCardContextMenu(mod: ModEntry, event: MouseEvent | KeyboardEvent): void {
  cardMenu.openAt(event, mod);
}

const deleteConfirmMessage = computed(() => {
  const mod = deleteTarget.value;
  if (!mod) return "";
  const body =
    mod.source === "tool"
      ? t("detail.confirmTool")
      : mod.source === "official"
        ? t("detail.confirmOfficial")
        : t("detail.confirmUnknown");
  return `${body}\n\n${t("detail.confirmLocalOnly")}`;
});

const menuItems = computed<ContextMenuItem[]>(() => {
  const mod = cardMenu.target.value;
  if (!mod) return [];
  const id = mod.workshopId ?? 0;
  const favorited = id > 0 && isFavorite(id);
  const hasTranslation = id > 0 && translationOf(id) !== null;
  const canText = hasTranslatableText(mod.displayName, mod.description);
  const translating = id > 0 && isTranslating(id);
  const queued = id > 0 && isQueued(id);
  const showingOriginal = id > 0 && isShowingOriginal(id);

  if (!favoriteIsInstalled(mod)) {
    return buildOnlineMenuItems(
      id,
      {
        entry: null,
        taskStatus: null,
        favorited,
        offline: false,
        cachedTranslation: hasTranslation,
        showingOriginal,
        translating,
        queued,
        canText,
      },
      {
        installLocal: t("online.installLocal"),
        reinstallLocal: t("online.reinstallLocal"),
        installing: t("online.installing"),
        downloading: t("online.downloading"),
        enqueued: t("downloader.enqueued"),
        favorite: t("favorites.favorite"),
        favorited: t("favorites.favorited"),
        rename: t("favorites.rename"),
        translateBusy: t("translate.busy"),
        translateQueued: t("translate.queued"),
        translateTrigger: t("translate.trigger", { lang: currentTargetLanguageName() }),
        translateShowTranslated: t("translate.showTranslated", { lang: currentTargetLanguageName() }),
        translateShowOriginal: t("translate.showOriginal"),
        // 只有描述**确实没取到**时才说「等待加载」
        waitingHint: isDescriptionLoaded(mod.description)
          ? t("translate.noContent")
          : t("translate.waitingContent"),
        openFolder: t("detail.openFolder"),
        browseSite: t("detail.browseSite"),
        offlineHint: t("online.offlineBlocked"),
      },
    );
  }

  const items = buildLocalMenuItems(
    mod,
    { favorited, hasTranslation, canText, translating, queued, showingOriginal, hidden: false },
    {
      enable: t("menu.enable"),
      disable: t("menu.disable"),
      favorite: t("favorites.favorite"),
      favorited: t("favorites.favorited"),
      rename: t("favorites.rename"),
      translateBusy: t("translate.busy"),
      translateQueued: t("translate.queued"),
      translateTrigger: t("translate.trigger", { lang: currentTargetLanguageName() }),
      translateShowTranslated: t("translate.showTranslated", { lang: currentTargetLanguageName() }),
      translateShowOriginal: t("translate.showOriginal"),
      openFolder: t("detail.openFolder"),
      browseSite: t("detail.browseSite"),
      deleteMod: t("detail.deleteMod"),
      notRegisteredHint: t("card.notRegisteredHint"),
    },
  );

  // 数据模组互斥裁决依赖本地页的完整模组列表，收藏页不绕过它
  if (mod.isDataMod && mod.enabled !== true) {
    const index = items.findIndex((item) => item.id === "toggle");
    if (index >= 0) {
      items[index] = { ...items[index], disabled: true, hint: t("detail.dataModWarning") };
    }
  }
  return items;
});

async function onMenuSelect(itemId: string): Promise<void> {
  const mod = cardMenu.target.value;
  if (!mod) return;
  const id = mod.workshopId ?? 0;

  switch (itemId) {
    case "install": {
      cardMenu.close();
      downloadEntry(mod);
      return;
    }
    case "toggle": {
      cardMenu.close();
      if (mod.enabled === null) {
        showToast(t("card.notRegisteredHint"), "error");
        return;
      }
      const target = mod.enabled !== true;
      // 数据模组启用必须走本地页的互斥流程，菜单里已置灰，这里再兜一层
      if (target && mod.isDataMod) return;
      try {
        const result = await toggleModEnabled(id, mod.kind, mod.folderName, target);
        patchEnabled(mod.id, result.enabled);
        void refresh();
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "favorite": {
      if (id <= 0) return;
      cardMenu.close();
      await ensureUserData();
      try {
        const next = await setFavorite(id, !isFavorite(id));
        showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
        // 收藏页以收藏集合为数据源：取消收藏后必须重读，条目才会消失
        void refresh();
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "rename": {
      if (id <= 0) return;
      cardMenu.close();
      renameError.value = null;
      renameTarget.value = mod;
      return;
    }
    case "translate": {
      cardMenu.close();
      await translateFromMenu(mod);
      return;
    }
    case "folder": {
      cardMenu.close();
      if (!mod.path) return;
      try {
        await revealModFolder(mod.path);
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "website": {
      cardMenu.close();
      if (id <= 0) return;
      try {
        await openModWebpage(id);
      } catch (e) {
        showToast(normalizeBackendError(e), "error");
      }
      return;
    }
    case "delete": {
      cardMenu.close();
      deleteError.value = null;
      deleteTarget.value = mod;
      return;
    }
  }
}

function translationErrorMessage(error: unknown): string {
  switch (translationErrorKind(error)) {
    case "network":
      return t("translate.failNetwork");
    case "busy":
      return t("translate.failBusy");
    case "quota":
      return t("translate.failQuota");
    case "not_ready":
      // 后端 MIN_DESC_CHARS 拦截：描述存在但内容过短，不是「还没加载」
      return t("translate.tooShort");
    default:
      return t("translate.failGeneric", { msg: translateBackendMessage(String(error ?? "")) });
  }
}

async function translateFromMenu(mod: ModEntry): Promise<void> {
  const id = mod.workshopId ?? 0;
  if (id <= 0) return;
  // 已有译文：只切原文 / 译文，不发请求
  if (translationOf(id)) {
    toggleOriginal(id);
    return;
  }
  if (isTranslating(id) || isQueued(id)) return;
  if (!hasTranslatableText(mod.displayName, mod.description)) {
    showToast(
      isDescriptionLoaded(mod.description)
        ? t("translate.noContent")
        : t("translate.notReady"),
      "error",
    );
    return;
  }
  try {
    const tr = await ensureTranslation({ modId: id, title: mod.displayName }, mod.description ?? "");
    if (tr.truncated) {
      showToast(t("translate.truncated", { chars: tr.charCount }));
    } else {
      showToast(tr.cached ? t("translate.fromCacheToast") : t("translate.okToast"));
    }
  } catch (e) {
    showToast(translationErrorMessage(e), "error");
  }
}

async function applyMenuRename(name: string): Promise<void> {
  const mod = renameTarget.value;
  if (!mod || renameBusy.value) return;
  const id = mod.workshopId ?? 0;
  if (id <= 0) {
    renameTarget.value = null;
    return;
  }
  renameBusy.value = true;
  renameError.value = null;
  try {
    await setCustomName(id, name);
    renameTarget.value = null;
    showToast(t("favorites.savedToast"));
    void refresh();
  } catch (e) {
    renameError.value = normalizeBackendError(e);
  } finally {
    renameBusy.value = false;
  }
}

function closeMenuRename(): void {
  renameTarget.value = null;
}

async function confirmMenuDelete(): Promise<void> {
  const mod = deleteTarget.value;
  if (!mod || deleting.value) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    await deleteModFiles(mod.kind, mod.folderName, mod.workshopId);
    deleteTarget.value = null;
    // 卸载只改本机安装状态：重读收藏，信息区仍用官方值
    void refresh();
  } catch (e) {
    deleteError.value = normalizeBackendError(e);
  } finally {
    deleting.value = false;
  }
}

function cancelMenuDelete(): void {
  deleteTarget.value = null;
}

defineExpose({ refresh, loading });
</script>

<template>
  <PageShell sidebar-class="fav-sidebar">
    <template #sidebar>
      <div class="sidebar-top">
        <ViewSwitch v-model:view-mode="viewMode" />
      </div>

      <div class="side-group">
        <div class="side-title"><span>{{ t("favorites.groupTitle") }}</span></div>
        <button
          type="button"
          class="side-item"
          :class="{ active: scope === 'installed' }"
          @click="scope = 'installed'"
        >
          <span class="label">{{ t("favorites.filterInstalled") }}</span>
          <span class="count">{{ installedCount }}</span>
        </button>
        <button
          type="button"
          class="side-item"
          :class="{ active: scope === 'uninstalled' }"
          @click="scope = 'uninstalled'"
        >
          <span class="label">{{ t("favorites.filterUninstalled") }}</span>
          <span class="count">{{ uninstalledCount }}</span>
        </button>
      </div>
    </template>

    <template #content>
      <div class="fav-head">
        <h2>{{ t("favorites.heading") }}</h2>
        <p class="fav-sub">{{ t("favorites.workspaceHint", { n: entries.length }) }}</p>
      </div>

      <ModGrid :view-mode="viewMode" :card-size="cardSize">
        <div v-if="loading" class="state-panel">
          <h2><span class="spinner"></span>{{ t("state.scanningTitle") }}</h2>
          <p>{{ t("state.scanningBody") }}</p>
        </div>

        <div v-else-if="error" class="state-panel">
          <h2>{{ t("state.scanFailedTitle") }}</h2>
          <p>{{ error }}</p>
          <div class="actions">
            <button type="button" @click="refresh()">{{ t("state.retry") }}</button>
          </div>
        </div>

        <div v-else-if="!entries.length" class="state-panel">
          <h2>{{ t("favorites.empty") }}</h2>
          <p>{{ t("favorites.emptyNone") }}</p>
          <div class="actions">
            <button type="button" @click="emit('open-online')">{{ t("favorites.goOnline") }}</button>
          </div>
        </div>

        <div v-else-if="!sorted.length" class="state-panel">
          <h2>{{ t("state.filteredTitle") }}</h2>
          <p>{{ t("state.filteredBody", { total: entries.length }) }}</p>
          <div class="actions">
            <button type="button" @click="scope = 'all'; emit('reset-search')">
              {{ t("state.clearFilters") }}
            </button>
          </div>
        </div>

        <template #cards>
          <ModCard
            v-for="mod in sorted"
            :key="mod.id"
            :mod="mod"
            :active="(mod.workshopId ?? 0) === (selected?.workshopId ?? 0)"
            @select="selectMod"
            @toggled="(payload) => patchEnabled(payload.id, payload.enabled)"
            @toggle-error="(message) => showToast(message, 'error')"
            @context-menu="onCardContextMenu"
          />
        </template>
      </ModGrid>
    </template>

    <template #detail>
      <ModDetail
        v-if="selected"
        :mod="selected"
        :stats="null"
        :stats-loading="false"
        :stats-error="null"
        @toggled="(payload) => selected && patchEnabled(selected.id, payload.enabled)"
        @removed="removed"
        @download="download"
        @cover-updated="(payload) => patchCover(payload.id, payload.path)"
      />
      <div v-else class="fav-detail-empty">
        <p>{{ t("online.detailEmpty") }}</p>
      </div>

      <!-- 卡片右键：备注名弹窗（作用于右键快照） -->
      <RenameDialog
        v-if="renameTarget"
        :original="renameTarget.displayName"
        :initial="customNameOf(renameTarget.workshopId)"
        :busy="renameBusy"
        :error="renameError ? translateBackendMessage(renameError) : null"
        @save="applyMenuRename"
        @cancel="closeMenuRename"
      />

      <!-- 卡片右键：卸载二次确认（危险操作，确认后才删目录） -->
      <ConfirmDialog
        v-if="deleteTarget"
        :title="t('detail.confirmTitle')"
        :message="deleteConfirmMessage"
        :detail="deleteTarget.path"
        :confirm-label="t('detail.deleteConfirmLabel')"
        :busy="deleting"
        :error="deleteError ? translateBackendMessage(deleteError) : null"
        @confirm="confirmMenuDelete"
        @cancel="cancelMenuDelete"
      />

      <!-- 卡片右键上下文菜单（fixed 浮层；关闭逻辑由共享组件统一处理） -->
      <ContextMenu
        v-if="menuOpen"
        :x="menuX"
        :y="menuY"
        :items="menuItems"
        @select="onMenuSelect"
        @close="cardMenu.close"
      />

      <!-- 轻量提示（收藏页自己的 toast 实例，Actions 的反馈必须可见） -->
      <div v-if="toast" class="app-toast" :class="toast.kind">{{ toast.text }}</div>
    </template>
  </PageShell>
</template>

<style scoped>
.fav-sidebar {
  padding: 10px 10px 18px;
}
.sidebar-top {
  display: flex;
  align-items: center;
  margin: 0 0 12px;
}
.fav-head {
  padding: 8px var(--layout-page-pad-x, 18px) 2px;
}
.fav-head h2 {
  margin: 0;
  font-size: calc(15px * var(--global-scale));
  color: var(--accent-bright);
}
.fav-sub {
  margin: 3px 0 0;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--text-dim);
}
.fav-detail-empty {
  padding: 18px;
  color: var(--text-dim);
  font-size: calc(12px * var(--global-scale));
}
</style>
