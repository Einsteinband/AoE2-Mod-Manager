<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

/**
 * 「回到列表顶部」悬浮按钮。
 *
 * 归属：模组列表区域（ModGrid 提供的唯一滚动容器 `.grid-scroll`）。
 * 定位：绝对定位挂在 `.content`（三栏骨架的中间列，PageShell 里已设为定位基准），
 *   水平居中于列表区域、贴着列表区域下沿 —— 不是窗口右下角，也不与下载管理悬浮按钮同区域。
 * 只做悬浮操作：不参与 `.card-grid` 排版，不占 Grid 单元格，因此不改变卡片尺寸与列表宽高。
 *
 * 显隐：滚动超过阈值才出现；回到顶部（scrollTop 落到阈值以下）自动消失。
 * 滚动方式：直接调用真实滚动容器的 `scrollTo`（smooth），不使用 window.scrollTo。
 */
const props = defineProps<{
  /** 模组列表的真实滚动容器（ModGrid 的 `.grid-scroll`）；为空时按钮不显示 */
  target?: HTMLElement | null;
}>();

const { t } = useI18n();

/** 距离顶部多少像素以内视为「已经在顶部」，此时隐藏按钮 */
const SHOW_OFFSET = 240;

const visible = ref(false);
let bound: HTMLElement | null = null;

function onScroll() {
  if (!bound) return;
  visible.value = bound.scrollTop > SHOW_OFFSET;
}

/** 绑定/解绑目标容器的滚动监听（切换页面或容器重建时自动重绑） */
function bind(next: HTMLElement | null) {
  if (bound === next) return;
  if (bound) bound.removeEventListener("scroll", onScroll);
  bound = next;
  if (bound) {
    bound.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  } else {
    visible.value = false;
  }
}

watch(() => props.target, (el) => bind(el ?? null), { immediate: true });
onBeforeUnmount(() => bind(null));

function scrollToTop(event: MouseEvent) {
  const el = bound;
  if (!el) return;
  // 按钮点击后会立即隐藏：先移走焦点，避免焦点留在不可见节点上
  (event.currentTarget as HTMLElement | null)?.blur();
  visible.value = false;
  el.scrollTo({ top: 0, behavior: "smooth" });
}
</script>

<template>
  <button
    v-if="visible && target"
    type="button"
    class="back-to-top"
    :title="t('content.backToTop')"
    :aria-label="t('content.backToTop')"
    @click="scrollToTop"
  >
    <!-- 纯向上箭头：只有两笔折线（chevron），没有竖线；项目图标体系（24 栅格 + currentColor 描边 + 圆头） -->
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 16.5 12 7.5l8.5 9" />
    </svg>
  </button>
</template>

<style scoped>
/* 小型圆角矩形 + 纯折线箭头；视觉与下载管理悬浮按钮同族（同一套描边 / 投影），
   但位置固定为「列表区域底部居中」，没有文字。
   v2.7：按确认的方案二 —— 加宽到 64×24、圆角 12、半透明表面（42% 不透明，
   能透出下方卡片），箭头去掉竖线只留两笔折线。半透明色写在 style.css 的主题变量
   --back-to-top-bg / -hover 里（深色、浅色各一份），这里只引用变量，不写死颜色。 */
.back-to-top {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  z-index: 20; /* 高于卡片，低于下载管理悬浮按钮（55）与弹窗 */
  width: 64px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--accent-rgb), 0.45);
  background: var(--back-to-top-bg);
  box-shadow: var(--shadow);
  color: var(--gold);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.back-to-top:hover {
  background: var(--back-to-top-bg-hover);
  border-color: var(--gold);
  color: var(--gold-bright);
  transform: translate(-50%, -1px);
}
.back-to-top:focus-visible {
  outline: 2px solid rgba(var(--accent-rgb), 0.7);
  outline-offset: 2px;
}
/* 图标盒 24px 高与按钮同高，但折线本身只占中间 9px 高度，视觉上仍是细箭头 */
.back-to-top svg {
  width: 24px;
  height: 24px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
