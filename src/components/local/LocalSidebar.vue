<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { localizedTagName } from "../../online/types";
import type { SourceFilter, StatusFilter } from "../../types";

/**
 * 本地页左侧筛选栏（纯展示 + 事件上抛）。
 *
 * 只负责排版与高亮：所有条件真源都在 `useLocalFilters`，这里既不持有也不推断状态，
 * 因此不会出现“侧栏高亮”和“实际过滤条件”不一致的问题。
 * 顺序与样式沿用 style.css 的 .side-group / .side-item，未改动任何视觉。
 */
interface TagOption {
  name: string;
  count: number;
}

defineProps<{
  /** 排序模式：侧栏整体置灰锁定（条件不能与全量排序共存） */
  sortMode: boolean;
  source: SourceFilter;
  status: StatusFilter;
  favoritesOnly: boolean;
  activeTag: string | null;
  officialTagList: TagOption[];
  inferredTagList: TagOption[];
  sourceCounts: { all: number; local: number; subscribed: number };
  statusCounts: { enabled: number; disabled: number; unknown: number };
  favoriteLocalCount: number;
}>();

const emit = defineEmits<{
  (event: "pick-source", value: SourceFilter): void;
  (event: "pick-status", value: StatusFilter): void;
  (event: "pick-tag", value: string | null): void;
  (event: "toggle-favorites"): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="sortMode" class="sort-lock-note">{{ t("sort.sidebarLocked") }}</div>

  <div class="side-group">
    <div class="side-title">{{ t("sidebar.source") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: source === 'all' && !favoritesOnly }"
      @click="emit('pick-source', 'all')"
    >
      <span class="label">{{ t("sidebar.allMods") }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: source === 'local' && !favoritesOnly }"
      @click="emit('pick-source', 'local')"
    >
      <span class="label">{{ t("sidebar.local") }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: source === 'subscribed' && !favoritesOnly }"
      @click="emit('pick-source', 'subscribed')"
    >
      <span class="label">{{ t("sidebar.subscribed") }}</span>
    </button>
  </div>

  <!-- v0.5：我的收藏（只过滤 isFavorite，按 WorkshopID 匹配 user_data.json） -->
  <div class="side-group">
    <div class="side-title">{{ t("favorites.groupTitle") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: favoritesOnly }"
      :disabled="sortMode"
      @click="emit('toggle-favorites')"
    >
      <span class="label">⭐ {{ t("favorites.label") }}</span>
      <span class="count">{{ favoriteLocalCount }}</span>
    </button>
  </div>

  <div class="side-group">
    <div class="side-title">{{ t("sidebar.officialTags") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: activeTag === null && !favoritesOnly }"
      @click="emit('pick-tag', null)"
    >
      <span class="label">{{ t("sidebar.allContent") }}</span>
    </button>
    <button
      v-for="item in officialTagList"
      :key="item.name"
      type="button"
      class="side-item"
      :class="{ active: activeTag === item.name && !favoritesOnly }"
      :title="t('sidebar.tagCount', { name: localizedTagName(item.name), n: item.count })"
      @click="emit('pick-tag', item.name)"
    >
      <span class="label">{{ localizedTagName(item.name) }}</span>
    </button>
    <div v-if="!officialTagList.length" class="side-note note" style="padding: 4px 10px">
      {{ t("sidebar.officialEmpty") }}
    </div>
  </div>

  <div v-if="inferredTagList.length" class="side-group">
    <div class="side-title">{{ t("sidebar.inferredTags") }}</div>
    <button
      v-for="item in inferredTagList"
      :key="item.name"
      type="button"
      class="side-item"
      :class="{ active: activeTag === item.name && !favoritesOnly }"
      :title="t('sidebar.tagCount', { name: localizedTagName(item.name), n: item.count })"
      @click="emit('pick-tag', item.name)"
    >
      <span class="label">{{ localizedTagName(item.name) }}</span>
    </button>
  </div>

  <div class="side-group">
    <div class="side-title">{{ t("sidebar.status") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: status === 'all' && !favoritesOnly }"
      @click="emit('pick-status', 'all')"
    >
      <span class="label">{{ t("sidebar.all") }}</span><span class="count">{{ sourceCounts.all }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: status === 'enabled' && !favoritesOnly }"
      @click="emit('pick-status', 'enabled')"
    >
      <span class="label">{{ t("sidebar.enabled") }}</span>
      <span class="count">{{ statusCounts.enabled }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: status === 'disabled' && !favoritesOnly }"
      @click="emit('pick-status', 'disabled')"
    >
      <span class="label">{{ t("sidebar.disabled") }}</span>
      <span class="count">{{ statusCounts.disabled }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: status === 'unknown' && !favoritesOnly }"
      @click="emit('pick-status', 'unknown')"
    >
      <span class="label">{{ t("sidebar.unknown") }}</span>
      <span class="count">{{ statusCounts.unknown }}</span>
    </button>
  </div>
</template>
