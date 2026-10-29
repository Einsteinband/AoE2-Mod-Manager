<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineMod } from "../online/types";
import { initials } from "../format";
import { customNameOf, displayTitle, isFavorite } from "../userData";

/** 在线模组卡片：与本地 ModCard 共用 style.css 的 .mod-card / .card-* 类，
 *  宽高比、字号、内边距、Badge 位置全部保持一致（不另写一套尺寸）。 */
const props = defineProps<{ mod: OnlineMod; active: boolean }>();
const emit = defineEmits<{ (event: "select", mod: OnlineMod): void }>();

const { t } = useI18n();

const imgFailed = ref(false);
watch(
  () => props.mod.modId,
  () => {
    imgFailed.value = false;
  },
);

const coverUrl = () => (props.mod.thumbnail && !imgFailed.value ? props.mod.thumbnail : null);

// v0.5：备注名优先做主标题，副标题小字回显官方标题
const title = computed(() => displayTitle(props.mod.modId, props.mod.title));
const custom = computed(() => customNameOf(props.mod.modId));
const favorited = computed(() => isFavorite(props.mod.modId));

function formatCount(n: number | null): string {
  if (n === null) return "未知";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
</script>

<template>
  <button class="mod-card" :class="{ active }" type="button" @click="emit('select', mod)">
    <div class="card-thumb">
      <img
        v-if="coverUrl()"
        :src="coverUrl() ?? ''"
        alt=""
        loading="lazy"
        draggable="false"
        @error="imgFailed = true"
      />
      <div v-else class="placeholder">{{ initials(mod.title) }}</div>
      <span v-if="favorited" class="fav-badge" :title="t('favorites.badgeTitle')">⭐</span>
      <span v-if="!coverUrl()" class="no-cover">无封面</span>
    </div>
    <div class="card-body">
      <div class="card-title" :title="title">{{ title }}</div>
      <div v-if="custom" class="card-sub" :title="mod.title">📝 {{ mod.title }}</div>
      <div class="card-meta">
        <span v-if="mod.updateAvailable" class="badge warn">{{ t("online.cardUpdate") }}</span>
        <span v-else-if="mod.userInstalled" class="badge sub">{{ t("online.cardSubscribed") }}</span>
        <span v-else class="badge">{{ t("online.cardOnline") }}</span>
        <span>
          {{ t("online.cardInstalls", { n: formatCount(mod.installs) + (mod.installsTruncated ? "+" : "") }) }}
        </span>
      </div>
      <div class="card-meta">
        <span>#{{ mod.modId }}</span>
        <span v-if="mod.creator" class="author" :title="mod.creator">{{ mod.creator }}</span>
        <span v-else class="author missing">作者未提供</span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.card-meta .author {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta .author.missing {
  color: #6b5940;
  font-style: italic;
}
</style>
