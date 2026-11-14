<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import ViewSwitch from "./ViewSwitch.vue";

/**
 * 公共工具栏：搜索框 + 排序下拉 +（可选）视图切换。
 *
 * 本地页与在线页**复用同一个组件**，因此：
 *   - 控件顺序、间距、换行（防挤压）完全一致；
 *   - viewMode 走 v-model，直接绑到 App.vue 的全局状态上，页面切换不丢；
 *   - 页面专属按钮（重新扫描 / 刷新 …）走 #extra 插槽，紧跟在排序下拉后面。
 *
 * v2.1 布局调优：
 *   - 搜索框不再吃掉整行，排序下拉与 #extra 里的按钮**紧贴搜索框右侧**；
 *   - 视图切换已改为独立的 <ViewSwitch>：本地页与在线页都把它放在各自列表抬头右端
 *     两个页面都将其放在顶栏右端，因此都传 show-view-switch=false（组件内该分支仅作兼底保留）。
 */
interface ToolbarOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    /** 搜索框 placeholder / title */
    searchPlaceholder?: string;
    searchTitle?: string;
    /** 搜索框禁用（本地排序模式会锁住筛选） */
    searchDisabled?: boolean;
    /** true = 提交式搜索：只在回车 / 点「搜索」时提交（官方搜索） */
    submitMode?: boolean;
    /** 「搜索」按钮文案（提交式搜索才用） */
    submitLabel?: string;
    /** 清空按钮的可见性；不传则按搜索框是否有内容自动判断 */
    clearVisible?: boolean;
    /** 排序下拉：选项为空则不渲染 */
    sortOptions?: ToolbarOption[];
    sortTitle?: string;
    sortDisabled?: boolean;
    /** 升降序下拉（在线官方接口专用）；不传则不渲染 */
    orderLabels?: { desc: string; asc: string } | null;
    orderTitle?: string;
    /** 是否在工具栏内渲染视图切换（本地页把它放到列表抬头，传 false） */
    showViewSwitch?: boolean;
  }>(),
  {
    searchPlaceholder: "",
    searchTitle: "",
    searchDisabled: false,
    submitMode: false,
    submitLabel: "",
    clearVisible: undefined,
    sortOptions: () => [],
    sortTitle: "",
    sortDisabled: false,
    orderLabels: null,
    orderTitle: "",
    showViewSwitch: true,
  },
);

const emit = defineEmits<{
  (event: "submit"): void;
  (event: "clear"): void;
}>();

const { t } = useI18n();

/** 搜索词：输入过程中只改 model，提交时机由页面决定（在线页不防抖、不发请求） */
const search = defineModel<string>("search", { default: "" });
/** 排序键 */
const sort = defineModel<string>("sort", { default: "" });
/** 升降序 */
const order = defineModel<"DESC" | "ASC">("order", { default: "DESC" });
/** 视图模式（全局状态，两个页面共用；各页都在顶栏右端渲染切换控件） */
const viewMode = defineModel<"grid" | "list">("viewMode", { default: "grid" });

const showClear = computed(() =>
  props.clearVisible === undefined ? search.value.length > 0 : props.clearVisible,
);

const isDescending = computed(() => order.value === "DESC");
const orderToggleTitle = computed(() => {
  if (!props.orderLabels) return props.orderTitle;
  const current = isDescending.value ? props.orderLabels.desc : props.orderLabels.asc;
  const next = isDescending.value ? props.orderLabels.asc : props.orderLabels.desc;
  return t("online.orderToggleTitle", { current, next });
});

function toggleOrder(): void {
  order.value = isDescending.value ? "ASC" : "DESC";
}

function clearSearch() {
  search.value = "";
  emit("clear");
}
</script>

<template>
  <div class="mod-toolbar">
    <div
      class="search-box"
      :class="{ 'official-search': submitMode, 'has-order': Boolean(orderLabels) }"
    >
      <span class="glyph">⌕</span>
      <input
        v-model="search"
        type="search"
        :placeholder="searchPlaceholder"
        :title="searchTitle"
        :disabled="searchDisabled"
        spellcheck="false"
        @keyup.enter="submitMode && emit('submit')"
      />
      <button
        v-if="orderLabels"
        class="order-toggle"
        type="button"
        :aria-pressed="isDescending"
        :title="orderToggleTitle"
        :aria-label="orderToggleTitle"
        @click="toggleOrder"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            v-if="isDescending"
            d="M8 2v11M3.5 8.5 8 13l4.5-4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            v-else
            d="M8 14V3M3.5 7.5 8 3l4.5 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        v-if="showClear"
        class="clear"
        type="button"
        :title="t('search.clear')"
        :aria-label="t('search.clear')"
        @click="clearSearch"
      >
        ✕
      </button>
      <button v-if="submitMode" type="button" class="go" @click="emit('submit')">
        {{ submitLabel }}
      </button>
    </div>

    <div class="toolbar">
      <select v-if="sortOptions.length" v-model="sort" :title="sortTitle" :disabled="sortDisabled">
        <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>

      <!-- 页面专属按钮：固定插在排序之后、视图切换之前，两个页面占位顺序一致 -->
      <slot name="extra" />

      <!-- 视图切换：本地页传 show-view-switch=false（它已被移到顶栏右端 .topbar-actions，紧贴齿轮左侧），
           在线页仍留在这里 -->
      <ViewSwitch v-if="showViewSwitch" v-model:view-mode="viewMode" />
    </div>
  </div>
</template>

<style scoped>
/* v2.1：搜索框不再吃掉整行 —— 排序下拉与 #extra 里的按钮（重新扫描 / 刷新）
   紧贴搜索框右边缘，留给顶栏右侧留白，不再被 justify-content: flex-end 顶到最右。 */
.mod-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 本地 / 在线共用同一中栏：外层面板按同一 flex 权重占用剩余空间，
     内部搜索框再吸收剩余宽度，避免两个页面因控件内在宽度不同形成外宽漂移。 */
  flex: 1 1 auto;
  flex-wrap: nowrap;
  min-width: 0;
  overflow: visible;
}
/* 搜索框是唯一的弹性空间承担者：优先收缩搜索，操作按钮不参与压缩；
   96px 为保证输入框可辨识的最小宽度，不再按固定视口断点分档。 */
.mod-toolbar .search-box {
  flex: 1 1 180px;
  min-width: 96px;
  max-width: 480px;
}
.mod-toolbar .search-box.has-order {
  min-width: 112px;
}
.mod-toolbar .search-box.has-order input {
  padding-right: 72px;
}
.mod-toolbar .search-box.has-order .clear {
  right: 38px;
}
.mod-toolbar .search-box input {
  flex: 1 1 auto;
  min-width: 0;
}
.mod-toolbar .search-box .order-toggle {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  margin: 0 6px 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-text);
  background: var(--bg-panel-deep);
  border: 1px solid rgba(var(--accent-rgb), 0.45);
  border-radius: 3px;
  cursor: pointer;
}
.mod-toolbar .search-box .order-toggle[aria-pressed="true"] {
  color: var(--accent-bright);
  background: rgba(var(--accent-rgb), 0.16);
  border-color: var(--accent);
}
.mod-toolbar .search-box .order-toggle svg {
  width: 16px;
  height: 16px;
}
.mod-toolbar .toolbar {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-start;
  flex-wrap: nowrap;
}
/* 下拉框绝不收缩，防止箭头变形 */
.mod-toolbar .toolbar select {
  flex: 0 0 auto;
  min-width: 70px;
  max-width: 120px;
}
/* extra 插槽里的按钮不收缩，保持常驻图标按钮宽度（Refresh / Rescan 必须始终可点）；
   文字不换行、不被省略号截断，图标化只由顶栏明确的布局状态切换 */
.mod-toolbar .toolbar ::slotted(button) {
  flex: 0 0 auto;
  min-width: 36px;
  white-space: nowrap;
  overflow: visible;
}
</style>
