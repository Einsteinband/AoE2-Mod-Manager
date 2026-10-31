<script setup lang="ts">
import { computed } from "vue";
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
 */
const props = withDefaults(
  defineProps<{
    /** 分组无障碍名称的覆盖（一般不用传） */
    groupLabel?: string;
  }>(),
  { groupLabel: "" },
);

const viewMode = defineModel<"grid" | "list">("viewMode", { default: "grid" });

const { t, locale } = useI18n();

/** 只在本组件内使用的文案（不新增语言包键，与项目其他组件保持一致） */
const ui = computed(() =>
  String(locale.value).toLowerCase().startsWith("zh")
    ? { grid: "网格", list: "列表", group: "视图切换" }
    : { grid: "Grid", list: "List", group: "View mode" },
);

function setView(next: "grid" | "list") {
  viewMode.value = next;
}
</script>

<template>
  <div class="view-switch" role="group" :aria-label="props.groupLabel || ui.group">
    <button
      type="button"
      class="view-btn"
      :class="{ active: viewMode === 'grid' }"
      :title="t('toolbar.viewToGrid')"
      :aria-pressed="viewMode === 'grid'"
      @click="setView('grid')"
    >
      {{ ui.grid }}
    </button>
    <button
      type="button"
      class="view-btn"
      :class="{ active: viewMode === 'list' }"
      :title="t('toolbar.viewToList')"
      :aria-pressed="viewMode === 'list'"
      @click="setView('list')"
    >
      {{ ui.list }}
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
  padding: 6px 10px;
  font-size: 11.5px;
  line-height: 1.45;
  letter-spacing: 0.8px;
  white-space: nowrap;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
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
  font-weight: 600;
}
.view-switch .view-btn:active {
  transform: none;
}
</style>
