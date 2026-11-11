<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { initials } from "../../format";

/**
 * 模组卡片底座组件：统一渲染封面、标题、副标题、ID、作者等共有结构。
 * 本地卡片和在线卡片通过 slot 传入各自专属的角标和状态按钮。
 */
const props = withDefaults(
  defineProps<{
    /** 主标题 */
    title: string;
    /** 副标题（备注名时显示） */
    sub?: string | null;
    /** 封面图 URL，null 时显示占位 */
    coverUrl?: string | null;
    /** 占位图上显示的首字母缩写（不传则自动从标题生成） */
    fallbackText?: string;
    /** 是否收藏（显示 ⭐ 角标） */
    favorited?: boolean;
    /** 模组 ID（显示为 #xxx），null/0 时显示"无数字ID" */
    workshopId?: string | number | null;
    /** 作者名 */
    author?: string | null;
    /** 本机已安装状态：由调用方按本地扫描或统一安装索引传入，卡片不反推 */
    installed?: boolean;
    /** 卡片 meta 行附加信息（如本地模组安装时间），null/空时不渲染 */
    extraMeta?: string | null;
    /** 是否激活态 */
    active?: boolean;
  }>(),
  {
    sub: null,
    coverUrl: null,
    fallbackText: "",
    favorited: false,
    workshopId: null,
    author: null,
    installed: false,
    extraMeta: null,
    active: false,
  },
);

const emit = defineEmits<{
  (event: "img-error"): void;
}>();

const { t } = useI18n();

const imgFailed = computed(() => false); // 由父组件控制时传入，这里只做占位
const fallback = computed(() => props.fallbackText || initials(props.title));

const displayId = computed(() => {
  if (props.workshopId && props.workshopId !== 0) return `#${props.workshopId}`;
  return t("card.noNumericId");
});
</script>

<template>
  <button class="mod-card" :class="{ active }" type="button">
    <div class="card-thumb">
      <img
        v-if="coverUrl && !imgFailed"
        :src="coverUrl"
        alt=""
        draggable="false"
        @error="emit('img-error')"
      />
      <div v-else class="placeholder">{{ fallback }}</div>
      <span v-if="favorited" class="fav-badge" :title="t('favorites.badgeTitle')">⭐</span>
      <span v-if="!coverUrl" class="no-cover">{{ t("card.noCover") }}</span>
      <!-- 额外角标 slot：来源角标、可更新红标等 -->
      <slot name="badges" />
    </div>
    <div class="card-body" :class="{ 'is-installed': installed }">
      <div class="card-title" :title="title">{{ title }}</div>
      <div v-if="sub" class="card-sub" :title="sub">📝 {{ sub }}</div>
      <!-- 第一行 meta：状态开关、徽章等（由外部传入） -->
      <div v-if="$slots['meta-top']" class="card-meta meta-top">
        <slot name="meta-top" />
      </div>
      <div class="card-meta">
        <span>{{ displayId }}</span>
        <span v-if="author" class="author">{{ author }}</span>
        <span v-else class="author missing">{{ t("card.authorMissing") }}</span>
        <span v-if="extraMeta" class="extra-meta">{{ extraMeta }}</span>
      </div>
    </div>
  </button>
</template>

<style scoped>
/* 卡片基础样式已在全局 style.css 的 .mod-card / .card-* 里定义，
   这里只补充 BaseModCard 特有的少量样式。 */

/* 角标 slot 容器：绝对定位在封面图右上角 */
.card-thumb :slotted([name="badges"]) {
  position: absolute;
  top: 0;
  right: 0;
}
</style>
