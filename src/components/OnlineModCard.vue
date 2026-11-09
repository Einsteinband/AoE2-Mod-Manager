<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineMod } from "../online/types";
import { customNameOf, displayTitle, isFavorite } from "../userData";
import { translatedTitleOf } from "../online/translation";
import BaseModCard from "./base/BaseModCard.vue";

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
  if (n === null) return t("labels.unknown");
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
</script>

<template>
  <BaseModCard
    :title="title"
    :sub="sub"
    :cover-url="src"
    :fallback-text="mod.title.slice(0, 2)"
    :favorited="favorited"
    :workshop-id="mod.modId"
    :author="mod.creator"
    :active="active"
    @click="emit('select', mod)"
    @img-error="onImageError"
  >
    <!-- 第一行 meta：在线状态徽章 + 安装数 -->
    <template #meta-top>
      <span v-if="mod.updateAvailable" class="badge warn">{{ t("online.cardUpdate") }}</span>
      <span v-else-if="mod.userInstalled" class="badge sub">{{ t("online.cardSubscribed") }}</span>
      <span v-else class="badge">{{ t("online.cardOnline") }}</span>
      <span>
        {{ t("online.cardInstalls", { n: formatCount(mod.installs) + (mod.installsTruncated ? "+" : "") }) }}
      </span>
    </template>
  </BaseModCard>
</template>

<style scoped>
/* 在线卡片的状态徽章样式 */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: calc(var(--card-font-size) * 0.75);
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(var(--badge-base-rgb), 0.82);
  color: var(--muted);
  white-space: nowrap;
}
.badge.warn {
  border-color: rgba(var(--danger-rgb), 0.5);
  color: var(--danger-text);
  background: rgba(var(--danger-rgb), 0.08);
}
.badge.sub {
  border-color: rgba(var(--info-rgb), 0.45);
  color: var(--info-text);
  background: rgba(var(--info-rgb), 0.08);
}
</style>
