<script setup lang="ts">
import { useI18n } from "vue-i18n";

/**
 * 视图切换：纯文字分段控件（网格 / 列表）。
 *
 * 拆成独立组件的唯一原因：本地页把它放在「列表抬头右侧的批量操作组」里，
 * 在线页仍留在顶栏工具栏中 —— 两处必须是**同一个控件**（同一套字号/描边/选中态），
 * 所以尺寸样式只在这里维护一份，不在两个页面各抄一遍。
 *
 * 行为与旧图标按钮完全一致：只改全局 viewMode（App.vue 的 useViewPrefs），
 * 不重新渲染卡片、不触发任何请求。
 *
 * 响应式：侧栏变窄时收成纯图标。基准由各页 `.sidebar-top` 的
 * `container-type: inline-size` 提供，按控件真实可用宽度判断，不读窗口宽度；
 * 没有容器祖先的场景（如工具栏兼容分支）不受影响，仍显示图标 + 文字。
 * 文字隐藏只是样式层，按钮的无障碍名称始终由 aria-label 提供。
 */
const props = withDefaults(
  defineProps<{
    /** 分组无障碍名称的覆盖（一般不用传） */
    groupLabel?: string;
  }>(),
  { groupLabel: "" },
);

const viewMode = defineModel<"grid" | "list">("viewMode", { default: "grid" });

const { t } = useI18n();

function setView(next: "grid" | "list") {
  viewMode.value = next;
}
</script>

<template>
  <div class="view-switch" role="group" :aria-label="props.groupLabel || t('viewSwitch.group')">
    <button
      type="button"
      class="view-btn"
      :class="{ active: viewMode === 'grid' }"
      :title="t('toolbar.viewToGrid')"
      :aria-label="t('viewSwitch.grid')"
      :aria-pressed="viewMode === 'grid'"
      @click="setView('grid')"
    >
      <span class="view-icon">▦</span>
      <span class="view-text">{{ t("viewSwitch.grid") }}</span>
    </button>
    <button
      type="button"
      class="view-btn"
      :class="{ active: viewMode === 'list' }"
      :title="t('toolbar.viewToList')"
      :aria-label="t('viewSwitch.list')"
      :aria-pressed="viewMode === 'list'"
      @click="setView('list')"
    >
      <span class="view-icon">☰</span>
      <span class="view-text">{{ t("viewSwitch.list") }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 分段控件：外框一条细描边，两枚文字按钮共用一条内缝。
   字号 / 行高与顶栏按钮（11.5px / 1.45）完全对齐，
   所以放进顶栏工具栏不会比下拉框高一档，放进列表抬头也不会把那一行撑高。 */
.view-switch {
  display: inline-flex;
  align-items: stretch;
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-panel-deep);
}
.view-switch .view-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 10px;
  height: 32px;
  font-size: 11.5px;
  line-height: 1;
  letter-spacing: calc(0.8px * var(--ui-tracking));
  white-space: nowrap;
  flex: 0 0 auto;
  flex-shrink: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
}
.view-switch .view-icon {
  font-size: 14px;
}
.view-switch .view-text {
  display: inline;
}
.view-switch .view-btn + .view-btn {
  border-left: 1px solid var(--line);
}
.view-switch .view-btn:hover:not(.active) {
  color: var(--gold-bright);
  background: rgba(var(--accent-rgb), 0.08);
}
.view-switch .view-btn.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  font-weight: var(--ui-font-weight-strong);
}
.view-switch .view-btn:active {
  transform: none;
}

/* 侧栏可用宽度不足时收成纯图标（文字隐藏，tooltip / aria-label 仍保留）。
   容器由三个页面的 `.sidebar-top` 声明 `container-type: inline-size` 提供，
   判断依据是控件真实可用宽度，不读窗口宽度。
   阈值 160px 对应 ≤1024px 窗口的 176px 侧栏（内容区 156px）与紧凑态 150px 侧栏（内容区 130px）；
   190 / 216px 侧栏（内容区 170 / 196px）保持图标 + 文字。
   俄 / 西 / 德最长标签在 156px 时已接近裁切，提前一档收图标可避免任何语言被截断。 */
@container (max-width: 160px) {
  .view-switch .view-btn {
    /* 32×32 方形：图标居中，高度与两按钮之间的内缝保持不变 */
    width: 32px;
    padding: 0;
  }
  .view-switch .view-text {
    display: none;
  }
}
</style>
