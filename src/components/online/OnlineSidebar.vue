<script setup lang="ts">
import { reactive } from "vue";
import { useI18n } from "vue-i18n";
import { tagLabel, type ModTag, type SessionStatus } from "../../online/types";

/**
 * 分组折叠状态：与 LocalSidebar 同一模式，持久化到 localStorage。
 */
const STORAGE_KEY = "aoe2mm:sidebarCollapse:online";

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
    /* 隐私模式静默回落 */
  }
};

/**
 * 在线页左侧栏：来源 / 收藏 / 官方分类 / 账号。
 *
 * 纯展示组件：状态真源在 `useOnlineList`（来源、收藏、分类）与 `useOnlineSession`（账号），
 * 这里只把交互上抛给页面。样式全部复用 style.css 的 .side-group / .side-item。
 */
defineProps<{
  onlySubscribed: boolean;
  favoritesOnly: boolean;
  activeTag: number | null;
  tags: ModTag[];
  tagsError: string | null;
  session: SessionStatus | null;
  netClearing: boolean;
  netError: string | null;
  netMessage: string | null;
  favoriteCount: number;
}>();

const emit = defineEmits<{
  (event: "pick-subscribed", value: boolean): void;
  (event: "toggle-favorites"): void;
  (event: "pick-tag", value: number | null): void;
  (event: "refresh-session"): void;
  (event: "logout"): void;
}>();

const { t } = useI18n();
</script>

<template>
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
        :class="{ active: !onlySubscribed && !favoritesOnly }"
        @click="emit('pick-subscribed', false)"
      >
        <span class="label">{{ t("sidebar.allMods") }}</span>
      </button>
      <button
        type="button"
        class="side-item"
        :class="{ active: onlySubscribed && !favoritesOnly }"
        @click="emit('pick-subscribed', true)"
      >
        <span class="label">{{ t("sidebar.subscribed") }}</span>
      </button>
    </div>
  </div>

  <!-- v0.5：我的收藏（只过滤 isFavorite，按 modId 匹配 user_data.json） -->
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
        @click="emit('toggle-favorites')"
      >
        <span class="label">⭐ {{ t("favorites.label") }}</span>
        <span class="count">{{ favoriteCount }}</span>
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
        :class="{ active: !favoritesOnly && activeTag === null }"
        @click="emit('pick-tag', null)"
      >
        <span class="label">{{ t("sidebar.allContent") }}</span>
      </button>
      <button
        v-for="item in tags"
        :key="item.modTypeId"
        type="button"
        class="side-item"
        :class="{ active: !favoritesOnly && activeTag === item.modTypeId }"
        :title="item.modTypeName"
        @click="emit('pick-tag', item.modTypeId)"
      >
        <span class="label">{{ tagLabel(item) }}</span>
      </button>

      <div v-if="!tags.length" class="side-note note">{{ t("online.tagsLoading") }}</div>
      <div v-else-if="tagsError" class="side-note note">{{ tagsError }}</div>
    </div>
  </div>

  <!-- 账号区（登录态 / Cookie 数 / 重新检查 / 退出登录）已整体迁到左下角
       「账号与网络」二级菜单：全应用只保留一个入口，不再在这里重复一份。 -->

  <!-- 代理 / 记住登录已迁到顶栏齿轮里的设置弹窗（SettingsModal → 网络） -->
</template>

<style scoped>
/* 只补充本地界面没有的元素；布局全部复用 style.css 的本地类 */
.side-note {
  padding: 2px 10px 4px;
  line-height: 1.6;
  word-break: break-all;
}
.side-msg {
  padding: 2px 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--gold);
}
.side-msg.error {
  color: var(--danger-text);
}

/* 折叠标题：与 LocalSidebar 保持一致的 caret 旋转与 spacer */
.side-title.collapsible {
  cursor: pointer;
  user-select: none;
}
.side-title.collapsible:hover {
  color: var(--gold-text);
}
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
