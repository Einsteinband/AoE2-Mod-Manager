<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  decideTopbarLayout,
  resolveAllowedStage,
  TOPBAR_LAYOUT_CONSTANTS,
  type TopbarLevel,
} from "./topbarLayout";

/**
 * 应用顶栏：纹章 + 标题 + 本地/在线切换 + 默认插槽（放 <ModToolbar>）+ 齿轮入口。
 *
 * 顶栏本身不含任何业务状态：模式切换走 v-model:mode，
 * 打开作者主页 / 设置弹窗都只 emit，由 App.vue 决定怎么落地（Rust openExternalUrl / 模态框）。
 */
const props = withDefaults(
  defineProps<{
    /** 作者主页地址（只用于 <a> 的 href，真正的打开由父组件交给系统浏览器） */
    authorUrl?: string;
  }>(),
  { authorUrl: "https://github.com/Einsteinband" },
);

const mode = defineModel<"local" | "online">("mode", { default: "local" });

const emit = defineEmits<{
  (event: "open-author"): void;
  (event: "open-settings"): void;
  (event: "stage-change", level: TopbarLevel): void;
}>();

const { t, locale } = useI18n();

/**
 * UI 危险状态驱动的渐进布局：
 *   - expanded：品牌 / 标签 / 搜索 / 下拉 / 操作按钮保持完整文字；
 *   - brand-short：先缩短品牌文字与副标题；
 *   - brand-badge：品牌仅保留徽章；
 *   - launch-icon：Launch 先去文字图标化，ViewSwitch 仍保留文字；
 *   - view-icon：ViewSwitch 再去文字图标化；
 *   - compact：Rescan/Refresh 与下拉适度收窄。
 *
 * 阶段由顶栏全宽容器的真实可用宽度统一控制；不判断语言，也不设置语言 / 页面专用固定断点。
 * 控件内在需求宽度、搜索最小宽、内部间距和 padding 只用于计算各阶段进入 / 退出阈值。
 */
interface IntrinsicCache {
  brandExpanded: number;
  brandShort: number;
  brandBadge: number;
  tabs: number;
  settings: number;
  searchMin: number;
  viewText: number;
  viewIcon: number;
  toolbarExpanded: number;
  toolbarCompact: number;
  actionsExpanded: number;
  actionsLaunchIcon: number;
  actionsCompact: number;
}

const topbarEl = ref<HTMLElement | null>(null);
const level = ref<TopbarLevel>("expanded");
watch(level, (value) => emit("stage-change", value), { immediate: true });
let resizeObserver: ResizeObserver | null = null;
let contentObserver: MutationObserver | null = null;
/** 固定控件内在宽度缓存；mode / locale 等影响文案尺寸的变化会整体失效。 */
let intrinsicCache: IntrinsicCache | null = null;
/** 当前排期是否来自真实尺寸变化；内容变化不允许在窗口不变时触发品牌恢复。 */
let sizeEvaluationPending = false;
/** 上一次顶栏外部盒子宽度；内部 padding / gap / 高度变化不应被当成窗口变宽。 */
let lastOuterWidth: number | null = null;
/** 帧内去重：RO、resize、mode、locale 等多个来源在同一帧只排一次复测。 */
let relayoutScheduled = false;

function cloneMeasure(
  el: Element | null | undefined,
  mutate?: (clone: HTMLElement) => void,
): number {
  if (!el) return 0;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  clone.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;flex:0 0 auto;width:auto;min-width:0;max-width:none;white-space:nowrap;overflow:visible;";
  mutate?.(clone);
  document.body.appendChild(clone);
  const width = clone.getBoundingClientRect().width;
  clone.remove();
  return width;
}

/** 按目标等级测量工具栏：下拉宽度随等级变化；compact 下额外按钮去文字图标化。 */
function measureToolbar(
  toolbar: Element | null | undefined,
  selectMin: number,
  selectMax: number,
  iconizeButtons: boolean,
): number {
  return cloneMeasure(toolbar, (clone) => {
    clone.style.gap = `${TOPBAR_LAYOUT_CONSTANTS.toolbarGap}px`;
    clone.querySelectorAll("select").forEach((node) => {
      const select = node as HTMLElement;
      select.style.minWidth = `${selectMin}px`;
      select.style.maxWidth = `${selectMax}px`;
      select.style.width = "auto";
      select.style.flex = "0 0 auto";
    });
    clone.querySelectorAll("button").forEach((node) => {
      const button = node as HTMLElement;
      button.style.flex = "0 0 auto";
      button.style.whiteSpace = "nowrap";
      if (iconizeButtons) {
        button.style.width = `${TOPBAR_LAYOUT_CONSTANTS.launchIconWidth}px`;
        button.style.padding = "0 8px";
        button.style.justifyContent = "center";
        button.querySelectorAll(".btn-text").forEach((text) => {
          (text as HTMLElement).style.display = "none";
        });
      }
    });
  });
}

/** ViewSwitch 图标态需求宽度：克隆后隐藏文字，只保留两枚图标。 */
function measureViewSwitchIcons(viewSwitch: Element | null | undefined): number {
  return cloneMeasure(viewSwitch, (clone) => {
    clone.querySelectorAll(".view-text").forEach((text) => {
      (text as HTMLElement).style.display = "none";
    });
  });
}

function scheduleRelayout(allowRecovery = false): void {
  sizeEvaluationPending ||= allowRecovery;
  if (relayoutScheduled) return;
  relayoutScheduled = true;
  void nextTick(() => {
    relayoutScheduled = false;
    relayout(sizeEvaluationPending);
    sizeEvaluationPending = false;
  });
}

/** RO / window resize 等外部尺寸事件候选；是否允许恢复由 relayout 比较真实外部宽度后决定。 */
function scheduleSizeRelayout(): void {
  scheduleRelayout(true);
}

/** ResizeObserver 只观察顶栏本体；回调本身不等同于窗口变宽，高度 / 内部变化不得直接恢复。 */
function scheduleObservedSize(): void {
  scheduleSizeRelayout();
}

function relayout(allowRecovery = false): void {
  const el = topbarEl.value;
  if (!el) return;

  const outerWidth = el.clientWidth;
  const padL = parseFloat(getComputedStyle(el).paddingLeft) || 14;
  const padR = parseFloat(getComputedStyle(el).paddingRight) || 14;
  const available = outerWidth - padL - padR;
  const outerWidthIncreased =
    lastOuterWidth === null || outerWidth - lastOuterWidth > 0.5;
  // 只有外部盒子真实变宽才允许反向恢复；高度、padding、gap、品牌 / 右侧控件内部变化均不构成恢复依据。

  const brand = el.querySelector(".brand");
  const tabs = el.querySelector(".mode-tabs");
  const toolbar = el.querySelector(".mod-toolbar .toolbar");
  const settings = el.querySelector(".settings-entry");
  const search = el.querySelector<HTMLElement>(".search-box");
  const launch = el.querySelector<HTMLElement>(".launch-game-btn");
  const viewSwitch = el.querySelector(".view-switch");

  if (!intrinsicCache) {
    const settingsWidth = settings ? settings.getBoundingClientRect().width : 0;
    const searchMin = (search ? parseFloat(getComputedStyle(search).minWidth) : 0) || 96;
    const viewTextWidth = cloneMeasure(viewSwitch);
    const viewIconWidth = measureViewSwitchIcons(viewSwitch);

    intrinsicCache = {
      brandExpanded: cloneMeasure(brand),
      brandShort: cloneMeasure(brand, (clone) => clone.classList.add("is-brand-short")),
      brandBadge: cloneMeasure(brand, (clone) => clone.classList.add("is-brand-badge")),
      tabs: cloneMeasure(tabs),
      settings: settingsWidth,
      searchMin,
      viewText: viewTextWidth,
      viewIcon: viewIconWidth,
      toolbarExpanded: measureToolbar(toolbar, 70, 120, false),
      toolbarCompact: measureToolbar(toolbar, 64, 96, true),
      actionsExpanded: cloneMeasure(launch) + viewTextWidth,
      actionsLaunchIcon: TOPBAR_LAYOUT_CONSTANTS.launchIconWidth + viewTextWidth,
      actionsCompact: TOPBAR_LAYOUT_CONSTANTS.launchIconWidth + viewIconWidth,
    };
  }

  const cached = intrinsicCache;
  const decision = decideTopbarLayout(level.value, {
    available,
    windowWidth: window.innerWidth,
    topLevelChildCount: el.children.length,
    brandExpanded: cached.brandExpanded,
    brandShort: cached.brandShort,
    brandBadge: cached.brandBadge,
    tabs: cached.tabs,
    settings: cached.settings,
    searchMin: cached.searchMin,
    toolbarExpanded: cached.toolbarExpanded,
    toolbarCompact: cached.toolbarCompact,
    actionsExpanded: cached.actionsExpanded,
    actionsLaunchIcon: cached.actionsLaunchIcon,
    actionsCompact: cached.actionsCompact,
  });

  const nextLevel = resolveAllowedStage({
    currentLevel: level.value,
    decision,
    sizeEvent: allowRecovery,
    widthIncreased: outerWidthIncreased,
  });

  lastOuterWidth = outerWidth;

  if (nextLevel !== level.value) {
    level.value = nextLevel;
    // 状态类改变控件尺寸后，下一帧按真实排布重新评估；内容变化不允许触发反向恢复。
    scheduleRelayout(false);
  }
}

onMounted(() => {
  relayout(true);
  // 插槽内容完成布局后复测一次；这是初始布局确认，按真实尺寸阈值允许校正阶段。
  scheduleRelayout(true);
  if (typeof ResizeObserver !== "undefined" && topbarEl.value) {
    resizeObserver = new ResizeObserver(scheduleObservedSize);
    resizeObserver.observe(topbarEl.value, { box: "content-box" });
  }
  if (typeof MutationObserver !== "undefined" && topbarEl.value) {
    contentObserver = new MutationObserver(() => {
      intrinsicCache = null;
      scheduleRelayout(false);
    });
    contentObserver.observe(topbarEl.value, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
  window.addEventListener("resize", scheduleSizeRelayout);
});

// 本地 / 在线切换会重建插槽内工具栏；语言切换会改变文字宽度。
// 两者都会使固定控件内在缓存失效，再统一走同一评估入口。
watch(mode, () => {
  intrinsicCache = null;
  scheduleRelayout(false);
});
watch(locale, () => {
  intrinsicCache = null;
  scheduleRelayout(false);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  contentObserver?.disconnect();
  contentObserver = null;
  intrinsicCache = null;
  sizeEvaluationPending = false;
  lastOuterWidth = null;
  relayoutScheduled = false;
  window.removeEventListener("resize", scheduleSizeRelayout);
});
</script>

<template>
  <header
    ref="topbarEl"
    class="topbar"
    :class="{
      'is-brand-short': level === 'brand-short',
      'is-brand-badge': level === 'brand-badge',
      'is-launch-icon': level === 'launch-icon',
      'is-view-icon': level === 'view-icon',
      'is-compact': level === 'compact',
    }"
  >
    <div
      class="brand"
      :class="{
        'is-brand-short': level === 'brand-short',
        'is-brand-badge':
          level === 'brand-badge' ||
          level === 'launch-icon' ||
          level === 'view-icon' ||
          level === 'compact',
      }"
    >
      <span class="crest">⚔</span>
      <div>
        <h1>
          <span class="name-full">{{ t("app.name") }}</span>
          <span class="name-2">{{ t("app.nameShort2") }}</span>
          <span class="name-3">{{ t("app.mediumName") }}</span>
          <span class="name-4">{{ t("app.shortName") }}</span>
        </h1>
        <p class="tagline">
          {{ t("app.taglinePrefix") }}<a
            class="author-link"
            :href="props.authorUrl"
            :title="t('app.authorTitle')"
            @click.prevent="emit('open-author')"
            >{{ t("app.author") }}</a
          >
        </p>
      </div>
    </div>

    <nav class="mode-tabs">
      <button type="button" :class="{ active: mode === 'local' }" @click="mode = 'local'">
        <span class="nav-full">{{ t("nav.local") }}</span>
        <span class="nav-short">{{ t("nav.localShort") }}</span>
      </button>
      <button type="button" :class="{ active: mode === 'online' }" @click="mode = 'online'">
        <span class="nav-full">{{ t("nav.online") }}</span>
        <span class="nav-short">{{ t("nav.onlineShort") }}</span>
      </button>
    </nav>

    <!-- v2.0：搜索 / 排序切换——由父组件塞入 <ModToolbar>，两种模式同一位置。
         网格/列表切换也在本插槽里（尾部、齿轮左侧），两种模式同一位置。 -->
    <slot />

    <button
      type="button"
      class="settings-entry"
      :title="t('settings.open')"
      :aria-label="t('settings.open')"
      @click="emit('open-settings')"
    >
      ⚙
    </button>
  </header>
</template>
