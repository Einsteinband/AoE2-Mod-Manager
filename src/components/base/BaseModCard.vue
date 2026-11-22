<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { initials } from "../../format";

/**
 * 模组卡片底座组件：统一渲染封面、标题、ID、作者等共有结构。
 * 本地卡片和在线卡片通过 slot 传入各自专属的角标和状态按钮。
 *
 * 卡片骨架（各区域高度规则，禁止由可选内容撑高整卡）：
 *   .card-thumb  —— 16:9 封面（宽度由网格列决定，高度等比）
 *   .card-title  —— 固定两行高（2.88em），一行标题也占满两行，超两行省略号截断
 *   .card-divider —— 标题区与信息区之间的淡虚线（绝对定位，不参与布局、不改卡高）
 *   .card-meta.meta-top —— 底部操作行，`min-height: var(--card-action-row-height)`
 *   .card-meta.meta-info —— ID / 作者信息行（ID 带 `.card-id`，列表模式下只隐藏它）
 *   .card-body  —— `flex: 1 1 auto`，填充 Grid 行拉伸留下的剩余高度
 * 名称只占一行标题：有自定义备注名时直接用它替换原名，不再额外渲染原名副标题行。
 */
const props = withDefaults(
  defineProps<{
    /** 主标题（已由调用方算好优先级：备注名 > 译文 > 原名） */
    title: string;
    /** 标题悬停提示：有备注名时传原名，否则留空沿用标题本身 */
    titleHint?: string | null;
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
    titleHint: null,
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
      <!-- 信息区边缘条 slot：本地身份条之外的附加竖条（已启用状态侧边栏等） -->
      <slot name="body-bar" />
      <div class="card-title" :title="titleHint || title">{{ title }}</div>
      <!-- 分隔线：标题区与信息区之间的一条淡虚线（纯装饰，绝对定位、不参与布局，
           因此不改变卡片高度；显隐由设置项 html[data-card-divider] 驱动） -->
      <span class="card-divider" aria-hidden="true"></span>
      <!-- 底部操作行：只要调用方提供了 meta-top 槽这一行就恒定存在（哪怕内容为空），
           行高由 style.css 的 --card-action-row-height 固定。本地卡片的启用控件、
           在线卡片的状态徽章都只是行内元素，不能反过来决定这一行的高度。 -->
      <div v-if="$slots['meta-top']" class="card-meta meta-top">
        <slot name="meta-top" />
      </div>
      <!-- ID / 作者信息行：具名 class `meta-info`，列表模式按语义隐藏 ID（`.card-id`），
           不再靠 `> span:first-child` 之类的 DOM 顺序判断，避免误伤 meta-top 里的
           启用控件 / ⚙️ / 状态徽章。 -->
      <div class="card-meta meta-info">
        <span class="card-id">{{ displayId }}</span>
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
