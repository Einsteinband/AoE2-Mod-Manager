<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * 公共卡片网格容器：本地模组页与在线模组页共用**同一套**排版与滚动骨架。
 *
 * 骨架（尺寸全部写在 style.css，本组件不写任何像素值）：
 *   .grid-scroll  —— 唯一滚动容器（scrollbar-gutter: stable，页面外层永不出滚动条）
 *   .card-grid    —— repeat(auto-fill, minmax(var(--card-size), 1fr))
 *   .list-mode    —— 紧凑列表模式（与网格模式共用同一批 DOM，不重新渲染）
 *
 * 三个插槽的分工：
 *   default  —— 状态面板 / 提示条（不参与网格排版，直接落在滚动区里）
 *   #cards   —— 卡片本体（网格里唯一的子元素来源）
 *   #foot    —— 网格之后的页脚（在线页的滚动哨兵 / 加载提示）
 */
withDefaults(
  defineProps<{
    /** 视图模式：grid = 大图网格，list = 紧凑列表 */
    viewMode?: "grid" | "list";
    /** 网格模式下的最小卡片宽度（px），由全局状态传入 */
    cardSize?: number;
    /** 追加到 .card-grid 的类名（如排序模式的 sort-grid） */
    gridClass?: string;
  }>(),
  { viewMode: "grid", cardSize: 200, gridClass: "" },
);

const emit = defineEmits<{
  (event: "ready", payload: { scrollEl: HTMLElement | null; gridEl: HTMLElement | null }): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);
const gridEl = ref<HTMLElement | null>(null);

/**
 * 把两个真实 DOM 交给父组件：本地页的滚动位置还原、排序模式的 Sortable 挂载都要用。
 * 卸载时回传 null，父组件据此解绑监听，避免把监听留在已销毁的节点上。
 */
onMounted(() => {
  emit("ready", { scrollEl: scrollEl.value, gridEl: gridEl.value });
});

onBeforeUnmount(() => {
  emit("ready", { scrollEl: null, gridEl: null });
});

defineExpose({ scrollEl, gridEl });
</script>

<template>
  <div ref="scrollEl" class="grid-scroll">
    <slot />
    <div
      ref="gridEl"
      class="card-grid"
      :class="[gridClass, { 'list-mode': viewMode === 'list' }]"
      :style="{ '--card-size': cardSize + 'px' }"
    >
      <slot name="cards" />
    </div>
    <slot name="foot" />
  </div>
</template>
