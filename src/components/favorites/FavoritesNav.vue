<script setup lang="ts">
/**
 * 顶栏右侧「收藏」入口（本地页 / 在线页 / 收藏页共用同一份）。
 *
 * 收藏是独立工作区，不是本地 / 在线筛选条件。点击一级入口直接进入全部分类；
 * 计数读全应用共享的 useFavorites，各入口不会各算一套。
 */
import { useI18n } from "vue-i18n";
import { useFavorites, type FavoriteStatusFilter } from "../../favorites/useFavorites";

const props = defineProps<{
  /** 当前是否正处于收藏工作区（决定高亮，不影响计数） */
  active?: boolean;
}>();

const emit = defineEmits<{
  (event: "open-favorites", scope: FavoriteStatusFilter): void;
}>();

const { t } = useI18n();
const { entries } = useFavorites();

/** 收藏内部已无分类 UI：任何入口进入收藏都落到全部分类 */
function openAll(): void {
  emit("open-favorites", "all");
}
</script>

<template>
  <div class="fav-nav fav-topbar-nav">
    <button
      type="button"
      class="fav-nav-root fav-topbar-btn"
      :class="{ active: props.active }"
      :title="t('favorites.navTitle')"
      :aria-label="t('favorites.groupTitle')"
      @click="openAll"
    >
      <svg class="fav-star" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
          fill="currentColor"
        />
      </svg>
      <span class="fav-label">{{ t("favorites.groupTitle") }}</span>
      <span class="fav-count">{{ entries.length }}</span>
    </button>
  </div>
</template>

<style scoped>
.fav-topbar-nav {
  display: inline-flex;
  align-items: center;
}

.fav-topbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel-deep);
  color: var(--muted);
  font-family: inherit;
  font-size: calc(11.5px * var(--global-scale));
  font-weight: var(--ui-font-weight);
  letter-spacing: calc(0.8px * var(--ui-tracking));
  white-space: nowrap;
  cursor: pointer;
  box-shadow: none;
}

.fav-topbar-btn:hover:not(.active) {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: var(--bg-panel);
}

.fav-topbar-btn.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: var(--ui-font-weight-strong);
}

.fav-star {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.fav-label {
  flex: 0 0 auto;
}

.fav-count {
  min-width: 18px;
  padding: 0 2px;
  color: var(--muted);
  font-family: var(--app-font-family);
  font-size: calc(11px * var(--global-scale));
  line-height: 1.45;
  text-align: center;
}

.fav-topbar-btn.active .fav-count {
  color: inherit;
}
</style>
