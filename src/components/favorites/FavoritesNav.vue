<script setup lang="ts">
/**
 * 侧栏「收藏」一级入口（本地页 / 在线页 / 收藏页共用同一份）。
 *
 * 收藏是**独立工作区**，不是顶部「本地 / 在线」的筛选条件。
 * 收藏内部不再提供「本地 / 在线」二级分类：点击一级行直接进入收藏工作区（全部分类）。
 * 计数仍读全应用共享的 useFavorites，各入口不会各算一套。
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
  <div class="side-group fav-nav">
    <button
      type="button"
      class="side-item fav-nav-root"
      :class="{ active: props.active }"
      :title="t('favorites.navTitle')"
      @click="openAll"
    >
      <span class="label">⭐ {{ t("favorites.groupTitle") }}</span>
      <span class="count">{{ entries.length }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 一级入口复用 .side-item 排版，只把计数贴到右侧 */
.fav-nav-root {
  width: 100%;
}
</style>
