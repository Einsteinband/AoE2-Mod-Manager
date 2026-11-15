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
import { displayTitle, customNameOf } from "../../userData";
import ModCard from "../ModCard.vue";
import ModGrid from "../common/ModGrid.vue";
import ModDetail from "../ModDetail.vue";
import PageShell from "../layout/PageShell.vue";
import { useFavorites, type FavoriteStatusFilter } from "../../favorites/useFavorites";
import { favoriteIsInstalled } from "../../favorites/model";
import type { ModEntry } from "../../types";

const props = withDefaults(
  defineProps<{
    search?: string;
    sort?: string;
    order?: "DESC" | "ASC";
    viewMode?: "grid" | "list";
    cardSize?: number;
  }>(),
  {
    search: "",
    sort: "updated",
    order: "DESC",
    viewMode: "grid",
    cardSize: 200,
  },
);

const emit = defineEmits<{
  (event: "open-online"): void;
}>();

const { t } = useI18n();
const { showToast } = useToast();
const workspace = useFavorites();
const { loading, error, entries, installedCount, uninstalledCount, refresh, install } = workspace;

const filter = ref<FavoriteStatusFilter>("all");
const selectedModId = ref<number | null>(null);

const query = computed(() => String(props.search ?? "").trim().toLowerCase());

const filtered = computed<ModEntry[]>(() => {
  const q = query.value;
  return entries.value.filter((entry) => {
    if (filter.value === "installed" && !favoriteIsInstalled(entry)) return false;
    if (filter.value === "uninstalled" && favoriteIsInstalled(entry)) return false;
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

/** 当前选中：按 WorkshopID 跟随，安装 / 卸载后 entryId 变化也不丢选中 */
const selected = computed<ModEntry | null>(() => {
  const id = selectedModId.value;
  if (!id) return entries.value[0] ?? null;
  return entries.value.find((entry) => (entry.workshopId ?? 0) === id) ?? entries.value[0] ?? null;
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

function download(): void {
  const entry = selected.value;
  if (!entry) return;
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

function removed(): void {
  void refresh();
}

defineExpose({ refresh, loading });
</script>

<template>
  <PageShell sidebar-class="fav-sidebar">
    <template #sidebar>
      <div class="fav-filter-group">
        <h3 class="fav-group-title">{{ t("favorites.groupTitle") }}</h3>
        <button
          type="button"
          class="fav-filter"
          :class="{ active: filter === 'all' }"
          @click="filter = 'all'"
        >
          <span class="label">⭐ {{ t("favorites.filterAll") }}</span>
          <span class="count">{{ entries.length }}</span>
        </button>
        <button
          type="button"
          class="fav-filter"
          :class="{ active: filter === 'installed' }"
          @click="filter = 'installed'"
        >
          <span class="label">{{ t("favorites.filterInstalled") }}</span>
          <span class="count">{{ installedCount }}</span>
        </button>
        <button
          type="button"
          class="fav-filter"
          :class="{ active: filter === 'uninstalled' }"
          @click="filter = 'uninstalled'"
        >
          <span class="label">{{ t("favorites.filterUninstalled") }}</span>
          <span class="count">{{ uninstalledCount }}</span>
        </button>
      </div>
      <p class="fav-note">{{ t("favorites.modelNote") }}</p>
    </template>

    <template #content>
      <div class="fav-head">
        <h2>⭐ {{ t("favorites.heading") }}</h2>
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
          <h2>⭐ {{ t("favorites.empty") }}</h2>
          <p>{{ t("favorites.emptyNone") }}</p>
          <div class="actions">
            <button type="button" @click="emit('open-online')">{{ t("favorites.goOnline") }}</button>
          </div>
        </div>

        <div v-else-if="!sorted.length" class="state-panel">
          <h2>{{ t("state.filteredTitle") }}</h2>
          <p>{{ t("state.filteredBody", { total: entries.length }) }}</p>
          <div class="actions">
            <button type="button" @click="filter = 'all'">{{ t("state.clearFilters") }}</button>
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
    </template>
  </PageShell>
</template>

<style scoped>
.fav-sidebar {
  padding: 10px 10px 18px;
}
.fav-filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.fav-group-title {
  margin: 0 0 4px;
  font-size: calc(11px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--text-dim);
  text-transform: uppercase;
}
.fav-filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--parch);
  font-family: inherit;
  font-size: calc(12px * var(--global-scale));
  text-align: left;
  cursor: pointer;
}
.fav-filter:hover {
  background: rgba(var(--accent-rgb), 0.08);
}
.fav-filter.active {
  border-color: rgba(var(--accent-rgb), 0.5);
  background: rgba(var(--accent-rgb), 0.14);
  color: var(--accent-bright);
}
.fav-filter .count {
  opacity: 0.75;
}
.fav-note {
  margin: 0;
  padding: 0 4px;
  font-size: calc(11px * var(--global-scale));
  line-height: 1.6;
  color: var(--text-dim);
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
