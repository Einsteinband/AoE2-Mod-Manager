<script setup lang="ts">
/**
 * 本地 / 在线卡片共用的右键上下文菜单组件。
 *
 * 组件职责（UI + 交互机制，不含业务）：
 * - 按坐标定位，靠近视口边缘时自动反向翻转，不超出可视区域；
 * - 点击菜单外部、按 Escape、页面滚动、窗口尺寸变化、组件卸载时关闭；
 * - 键盘：↑/↓ 移动可用项、Enter/Space 执行、Escape 关闭；
 * - 菜单项的可见性、可用性、图标与动作由页面装配层通过 `items` 传入。
 *
 * 样式只消费现有主题变量（深浅主题 + 四档 accent 自动跟随），危险项固定走 `--danger-*`。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ContextMenuItem } from "./contextMenuTypes";

const props = defineProps<{
  x: number;
  y: number;
  items: ContextMenuItem[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{
  (event: "select", id: string): void;
  (event: "close"): void;
}>();

const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);

/** 只在可用项之间移动焦点，禁用项跳过 */
const enabledIndexes = computed(() =>
  props.items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled).map(({ index }) => index),
);

// ---------------- 定位：挂载后测量尺寸并做边缘翻转 ----------------
const style = ref<Record<string, string>>({ left: `${props.x}px`, top: `${props.y}px` });

async function measureAndPlace(): Promise<void> {
  const el = root.value;
  if (!el) return;
  await nextTick();
  const width = el.offsetWidth || 0;
  const height = el.offsetHeight || 0;
  const viewW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewH = window.innerHeight || document.documentElement.clientHeight || 0;
  const margin = 8;

  let left = props.x;
  if (width > 0) {
    if (left + width > viewW - margin) left = Math.max(margin, viewW - width - margin);
  }
  let top = props.y;
  if (height > 0) {
    if (top + height > viewH - margin) top = Math.max(margin, viewH - height - margin);
  }
  style.value = { left: `${left}px`, top: `${top}px` };
}

// ---------------- 关闭：外部点击 / Esc / 滚动 / 缩放 / 卸载 ----------------
function onDocumentPointerDown(event: MouseEvent): void {
  const el = root.value;
  if (el && event.target instanceof Node && el.contains(event.target)) return;
  emit("close");
}

function onWindowScroll(): void {
  emit("close");
}

function onWindowResize(): void {
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }

  const enabled = enabledIndexes.value;
  if (enabled.length === 0) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const current = activeIndex.value;
    const pos = enabled.indexOf(current);
    const nextPos =
      event.key === "ArrowDown"
        ? (pos + 1 + enabled.length) % enabled.length
        : (pos - 1 + enabled.length) % enabled.length;
    activeIndex.value = enabled[nextPos];
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    activeIndex.value = enabled[0];
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    activeIndex.value = enabled[enabled.length - 1];
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && activeIndex.value >= 0) {
    event.preventDefault();
    activate(activeIndex.value);
  }
}

// ---------------- 条目动作 ----------------
function activate(index: number): void {
  const item = props.items[index];
  if (!item || item.disabled) return;
  activeIndex.value = index;
  emit("select", item.id);
}

function onItemMouseEnter(index: number): void {
  activeIndex.value = index;
}

onMounted(() => {
  void measureAndPlace();
  window.addEventListener("mousedown", onDocumentPointerDown, true);
  window.addEventListener("keydown", onKeydown);
  // 捕获阶段监听滚动：卡片网格内部滚动也能关闭菜单
  window.addEventListener("scroll", onWindowScroll, true);
  window.addEventListener("resize", onWindowResize);
  root.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onDocumentPointerDown, true);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", onWindowScroll, true);
  window.removeEventListener("resize", onWindowResize);
});
</script>

<template>
  <div
    ref="root"
    class="ctx-menu"
    role="menu"
    :aria-label="ariaLabel ?? t('menu.ariaLabel')"
    :style="style"
    tabindex="-1"
    @contextmenu.prevent
  >
    <template v-for="(item, index) in items" :key="item.id">
      <div v-if="item.dividerBefore" class="ctx-menu-divider" aria-hidden="true"></div>
      <button
        type="button"
        role="menuitem"
        class="ctx-menu-item"
        :class="{ active: activeIndex === index, danger: item.danger, disabled: item.disabled }"
        :disabled="item.disabled"
        :aria-disabled="item.disabled || undefined"
        @mouseenter="onItemMouseEnter(index)"
        @click="activate(index)"
      >
        <span class="ctx-menu-icon" aria-hidden="true">{{ item.icon ?? "" }}</span>
        <span class="ctx-menu-label">{{ item.label }}</span>
        <span v-if="item.hint" class="ctx-menu-hint">{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 80;
  min-width: 208px;
  padding: 6px;
  border: 1px solid var(--gold-dim);
  border-radius: 4px;
  background: linear-gradient(180deg, var(--menu-top), var(--menu-bottom));
  box-shadow: 0 14px 32px rgba(var(--shadow-rgb), 0.62);
  outline: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ctx-menu-divider {
  height: 1px;
  margin: 4px 2px;
  background: var(--line-soft);
}

.ctx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--parch);
  font-size: calc(12px * var(--global-scale));
  text-align: left;
  letter-spacing: calc(0.3px * var(--ui-tracking));
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.ctx-menu-item.active:not(.disabled) {
  background: var(--bg-hover);
  border-color: var(--gold-dim);
}

.ctx-menu-item.disabled {
  opacity: 0.45;
  cursor: default;
}

.ctx-menu-item.danger {
  color: var(--danger-text);
}

.ctx-menu-item.danger.active:not(.disabled) {
  background: rgba(var(--danger-rgb), 0.1);
  border-color: rgba(var(--danger-rgb), 0.45);
}

.ctx-menu-icon {
  flex: 0 0 18px;
  text-align: center;
  font-size: calc(12px * var(--global-scale));
  line-height: 1;
}

.ctx-menu-label {
  flex: 1 1 auto;
  white-space: nowrap;
}

.ctx-menu-hint {
  color: var(--muted);
  font-size: calc(11px * var(--global-scale));
  white-space: nowrap;
}
</style>
