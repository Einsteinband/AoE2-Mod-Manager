<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineMod } from "../online/types";
import { initials } from "../format";
import { customNameOf, displayTitle, isFavorite } from "../userData";
import { translatedTitleOf } from "../online/translation";

/** 在线模组卡片：与本地 ModCard 共用 style.css 的 .mod-card / .card-* 类，
 *  宽高比、字号、内边距、Badge 位置全部保持一致（不另写一套尺寸）。 */
const props = defineProps<{ mod: OnlineMod; active: boolean; thumb?: string | null }>();
const emit = defineEmits<{ (event: "select", mod: OnlineMod): void }>();

const { t } = useI18n();

/** 图片失败阶段：0=还没试本地封面，1=本地坏了试网络，2=都坏了 */
const triedLocal = ref(false);
const failed = ref(false);

watch(
  () => [props.mod.modId, props.thumb] as const,
  () => {
    triedLocal.value = false;
    failed.value = false;
  },
);

/** 本地封面（asset: 协议）优先，其次官网 CDN；两者都失败才显示占位字 */
const src = computed<string | null>(() => {
  if (failed.value) return null;
  const local = props.thumb ?? null;
  if (local && !triedLocal.value) return local;
  return props.mod.thumbnail ?? null;
});

function onImageError() {
  if (props.thumb && !triedLocal.value) {
    triedLocal.value = true;
    return;
  }
  failed.value = true;
}

// v0.5：备注名优先做主标题，副标题小字回显官方标题
// v0.2.4：没备注名时，手动翻译过的模组优先显示中文标题（未翻译就原样显示，绝不自动请求）
const custom = computed(() => customNameOf(props.mod.modId));
const translated = computed(() => translatedTitleOf(props.mod.modId));
/** 标题优先级：备注名 > 中文译文 > 官方原标题 */
const title = computed(() => displayTitle(props.mod.modId, translated.value ?? props.mod.title));
/** 副标题只服务于备注名（📝）；译文不再叠英文原名 */
const sub = computed(() => (custom.value ? props.mod.title : null));
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
        v-if="src"
        :src="src"
        alt=""
        loading="lazy"
        draggable="false"
        @error="onImageError"
      />
      <div v-else class="placeholder">{{ initials(mod.title) }}</div>
      <span v-if="favorited" class="fav-badge" :title="t('favorites.badgeTitle')">⭐</span>
      <span v-if="!src" class="no-cover">无封面</span>
    </div>
    <div class="card-body">
      <div class="card-title" :title="title">{{ title }}</div>
      <div v-if="sub" class="card-sub" :title="mod.title">📝 {{ mod.title }}</div>
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
