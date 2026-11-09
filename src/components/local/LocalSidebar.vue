<script setup lang="ts">
import { reactive } from "vue";
import { useI18n } from "vue-i18n";
import { localizedTagName } from "../../online/types";
import type { SourceFilter, StatusFilter } from "../../types";

/**
 * 分组折叠状态：key = 分组标识，true = 收起。
 * 持久化到 localStorage（与 SettingsModal 弹窗位置同一通道，纯 UI 偏好）。
 */
const STORAGE_KEY = "aoe2mm:sidebarCollapse:local";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const collapsed = reactive<Record<string, boolean>>(loadCollapsed());

const toggleGroup = (key: string) => {
  collapsed[key] = !collapsed[key];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...collapsed }));
  } catch {
    /* 隐私模式 / 存储满：静默回落，仅本次会话不持久化 */
  }
};

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
  updatesOnly: boolean;
  updatesAvailableCount: number;
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
  (event: "pick-updates-only"): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="sortMode" class="sort-lock-note">{{ t("sort.sidebarLocked") }}</div>

  <div class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.source }"
      @click="toggleGroup('source')"
    >
      <span>{{ t("sidebar.source") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.source">
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
  </div>

  <!-- 动态「待更新」入口：仅在有确认可更新模组时显示 -->
  <div v-if="updatesAvailableCount > 0" class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.updates }"
      @click="toggleGroup('updates')"
    >
      <span>{{ t("updates.groupTitle") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.updates">
      <button
        type="button"
        class="side-item"
        :class="{ active: updatesOnly }"
        :disabled="sortMode"
        @click="emit('pick-updates-only')"
      >
        <span class="label">{{ t("updates.pendingLabel") }}</span>
        <span class="count">{{ updatesAvailableCount }}</span>
      </button>
    </div>
  </div>

  <!-- v0.5：我的收藏（只过滤 isFavorite，按 WorkshopID 匹配 user_data.json） -->
  <div class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.favorites }"
      @click="toggleGroup('favorites')"
    >
      <span>{{ t("favorites.groupTitle") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.favorites">
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
  </div>

  <div class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.officialTags }"
      @click="toggleGroup('officialTags')"
    >
      <span>{{ t("sidebar.officialTags") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.officialTags">
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
  </div>

  <div v-if="inferredTagList.length" class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.inferredTags }"
      @click="toggleGroup('inferredTags')"
    >
      <span>{{ t("sidebar.inferredTags") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.inferredTags">
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
  </div>

  <div class="side-group">
    <div
      class="side-title collapsible"
      :class="{ collapsed: collapsed.status }"
      @click="toggleGroup('status')"
    >
      <span>{{ t("sidebar.status") }}</span>
      <span class="side-title-spacer"></span>
      <svg class="side-caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2 L6 4 L2 6 Z" fill="currentColor"/></svg>
    </div>
    <div v-show="!collapsed.status">
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
  </div>
</template>

<style scoped>
.sort-lock-note {
  margin: 0 0 10px;
  padding: 7px 9px;
  border: 1px dashed var(--gold-dim);
  border-radius: 4px;
  font-size: calc(11px * var(--global-scale));
  line-height: 1.5;
  color: var(--gold-text);
  background: rgba(var(--accent-rgb), 0.08);
}

/* 可折叠分组标题：复用全局 .side-title 排版，仅加点击反馈与 caret */
.side-title.collapsible {
  cursor: pointer;
  user-select: none;
}
.side-title.collapsible:hover {
  color: var(--gold-text);
}
/* 全局 .side-title::after 是 flex:1 渐变分隔线；折叠标题用 spacer 替代它，把 caret 顶到最右 */
.side-title.collapsible::after {
  display: none;
}
.side-title-spacer {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--line), transparent);
}
.side-caret {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-left: 6px;
  opacity: 0.7;
  transition: transform 0.15s ease;
}
.side-title.collapsed .side-caret {
  transform: rotate(-90deg);
}
</style>
