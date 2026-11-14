<script setup lang="ts">
/**
 * v0.4 独立设置弹窗：通用（语言 + 检查更新）/ 网络（代理 + 记住登录）/ 关于。
 *
 * 代理与语言从原来的「顶栏语言下拉 + 在线页侧栏折叠面板」整体迁移到这里：
 * - 语言：applyLocale 立即生效，再 setLocale 写 settings.json（失败只报错，不回滚 UI）
 * - 代理：复用 set_network_settings（Rust 侧会重建登录窗口让它立即生效）
 *
 * 15 秒冷却：lastCheckMs 放在模块作用域，关掉弹窗再打开也绕不过去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ConfirmDialog from "./ConfirmDialog.vue";
import AppearanceTab from "./settings/AppearanceTab.vue";
import AboutTab from "./settings/AboutTab.vue";
import GeneralTab from "./settings/GeneralTab.vue";
import NetworkTab from "./settings/NetworkTab.vue";
import LocalTab from "./settings/LocalTab.vue";
import OnlineTab from "./settings/OnlineTab.vue";
import StorageTab from "./settings/StorageTab.vue";
import { CARD_SIZE_MAX, CARD_SIZE_MIN, CARD_SIZE_STEP, clampCardSize } from "../composables/useViewPrefs";
import {
  CARD_FONT_SIZE_MAX,
  CARD_FONT_SIZE_MIN,
  CARD_FONT_WEIGHT_OPTIONS,
  GLOBAL_SCALE_MAX,
  GLOBAL_SCALE_MIN,
  GLOBAL_SCALE_STEP,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_FONT_WEIGHT_OPTIONS,
  READER_LINE_HEIGHT_OPTIONS,
  TYPOGRAPHY_DEFAULTS,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_WEIGHT_OPTIONS,
  clampCardFontSize,
  clampGlobalScale,
  clampReaderFontSize,
  normalizeReaderFontWeight,
  normalizeReaderLineHeight,
  normalizeCardFontWeight,
  normalizeUiFontWeight,
  type UiFontFamily,
} from "../api";
import type { ScanReport } from "../types";

/** 全局视图偏好：卡片大小与主界面用同一个 v-model（设置里拖完，列表立即跟着变） */
const props = withDefaults(
  defineProps<{
    /** 当前根目录（只用于展示，不参与业务） */
    rootPath?: string;
    /** 打开时直接切到哪个 Tab（顶栏「启动游戏」缺配置时传 general） */
    initialTab?: "general" | "appearance" | "network" | "local" | "online" | "storage" | "about";
    /** 打开后滚动并高亮「游戏根目录」一行 */
    focusGameRoot?: boolean;
  }>(),
  {
    rootPath: "",
    initialTab: "general",
    focusGameRoot: false,
  },
);

const emit = defineEmits<{
  close: [];
  "root-changed": [report: ScanReport];
}>();
const { t, locale } = useI18n();

/**
 * 提示文本统一存「key + 参数」，渲染时才翻译。
 *
 * 为什么不是存翻译结果：ref 里一旦存了译文，切换语言后这段旧文字不会跟着变，
 * 用户就会在英文 / 西语界面里看到上一条中文提示（反馈里的「游戏根目录已保存」
 * 「已保存：127.0.0.1:7897」「已打开日志文件夹」都是这个原因）。
 * string 分支留给后端原始错误串（本身不随界面语言变化）。
 */
type Tab = "general" | "appearance" | "network" | "local" | "online" | "storage" | "about";
const tab = ref<Tab>(props.initialTab);

/** 卡片最小宽度：与主界面滑块、Rust 侧 clamp 同口径 */
const cardSize = defineModel<number>("cardSize", { default: 200 });

/** 界面主题："dark"（默认）| "light"；主界面 App.vue 持有真值并负责落盘 */
const theme = defineModel<string>("theme", { default: "dark" });

/** 强调色：真实颜色由前端注册表定义，默认 gold；主界面 App.vue 持有真值并负责落盘 */
const accent = defineModel<string>("accent", { default: "gold" });

/** 主题选项（文案跟随界面语言，不新增 i18n key） */
const THEME_OPTIONS = computed(() => [
  { value: "dark", label: t("settingsUi.themeDark") },
  { value: "light", label: t("settingsUi.themeLight") },
]);

/** 取整到 20 的倍数并夹进 160..=320：与 useViewPrefs / Rust 侧完全一致 */
function snapCardSize() {
  cardSize.value = clampCardSize(Number(cardSize.value));
}

/**
 * v2.4：三层排版（界面 / 正文阅读 / 卡片列表）。
 * 真值由 App.vue 持有，改动会立即写到 <html> 的 CSS 变量上（不重建组件树），
 * 落盘由 App.vue 统一防抖（300ms）调用 api.saveTypographyPrefs。
 */

// 【界面】字体种类 + 界面字重 + 全局缩放
const uiFontFamily = defineModel<UiFontFamily>("uiFontFamily", { default: "hei" });
const uiFontWeight = defineModel<number>("uiFontWeight", { default: 400 });
const globalFontScale = defineModel<number>("globalFontScale", { default: 100 });

// 【正文阅读】字号 + 行距 + 字重
const readerFontSize = defineModel<number>("readerFontSize", { default: 14 });
const readerLineHeight = defineModel<number>("readerLineHeight", { default: 1.6 });
const readerFontWeight = defineModel<number>("readerFontWeight", { default: 400 });

// 【卡片列表】字号 + 字重（v3.3 新增字重）
const cardFontSize = defineModel<number>("cardFontSize", { default: 12 });
const cardFontWeight = defineModel<number>("cardFontWeight", { default: 400 });

/**
 * v3.5：英文界面专用西文字体栈开关。
 * 只对英文界面有意义（中文界面由中文字体优先），所以设置项在中文界面下不渲染，
 * 值本身照常保存，切回英文后仍是用户上次的选择。
 */
const latinFont = defineModel<boolean>("latinFont", { default: true });
/** 已安装卡片：强调色信息区背景开关（主界面 App.vue 持有真值并落盘） */
const installedCardBg = defineModel<boolean>("installedCardBg", { default: true });
/** 已安装卡片：左侧主题色标识条开关 */
const installedCardBar = defineModel<boolean>("installedCardBar", { default: true });
/** 已安装卡片：右下角斜线装饰开关 */
const installedCardStripes = defineModel<boolean>("installedCardStripes", { default: true });
/** 详情页辅助按钮显示模式："icon"（默认）| "text"；真值由 App.vue 持有并经 localStorage 持久化 */
const detailButtonMode = defineModel<string>("detailButtonMode", { default: "icon" });
/** 当前是否英文界面（决定「西文字体」这一行是否出现） */
const isEnglishUi = computed(() => String(locale.value) === "en");

/** 字体种类下拉项（文案跟随界面语言） */
const FONT_FAMILY_OPTIONS_LABELED = computed(() =>
  UI_FONT_FAMILY_OPTIONS.map((value) => ({
    value,
    label:
      value === "youyuan"
        ? t("settingsUi.fontFamilyYouyuan")
        : value === "system"
          ? t("settingsUi.fontFamilySystem")
          : value === "serif"
            ? t("settingsUi.fontFamilySerif")
            : t("settingsUi.fontFamilyHei"),
  })),
);

/** 字重档位的文案（400 常规 / 700 加粗） */
function weightLabel(value: number): string {
  return value >= 700 ? t("settingsUi.weightBold") : t("settingsUi.weightNormal");
}

/** 行距档位的文案（1.4 紧凑 / 1.6 标准 / 1.8 宽松） */
function lineHeightLabel(value: number): string {
  return value === 1.4
    ? t("settingsUi.lineHeightCompact")
    : value === 1.8
      ? t("settingsUi.lineHeightLoose")
      : t("settingsUi.lineHeightStandard");
}

/** 在固定档位序列里左 / 右挪一格；到头就停住（按钮同时 disabled） */
function stepBy(current: number, options: readonly number[], dir: -1 | 1): number {
  const idx = options.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = Math.min(options.length - 1, Math.max(0, base + dir));
  return options[next] ?? current;
}

function stepUiFontWeight(dir: -1 | 1) {
  uiFontWeight.value = normalizeUiFontWeight(stepBy(uiFontWeight.value, UI_FONT_WEIGHT_OPTIONS, dir));
}
function stepLineHeight(dir: -1 | 1) {
  readerLineHeight.value = normalizeReaderLineHeight(
    stepBy(readerLineHeight.value, READER_LINE_HEIGHT_OPTIONS, dir),
  );
}
function stepReaderFontWeight(dir: -1 | 1) {
  readerFontWeight.value = normalizeReaderFontWeight(
    stepBy(readerFontWeight.value, READER_FONT_WEIGHT_OPTIONS, dir),
  );
}
function stepCardFontWeight(dir: -1 | 1) {
  cardFontWeight.value = normalizeCardFontWeight(
    stepBy(cardFontWeight.value, CARD_FONT_WEIGHT_OPTIONS, dir),
  );
}

/** 「高级排版」是否展开：默认收起，外观页首屏只留字体种类 + 界面字重 */
const showAdvancedTypography = ref(false);

/** 滑块松手时夹回合法档位（拖动过程中已经是合法值，这里只是兑底） */
function snapGlobalScale() {
  globalFontScale.value = clampGlobalScale(Number(globalFontScale.value));
}
function snapReaderFontSize() {
  readerFontSize.value = clampReaderFontSize(Number(readerFontSize.value));
}
function snapCardFontSize() {
  cardFontSize.value = clampCardFontSize(Number(cardFontSize.value));
}

/** 下拉框回写的值再归一化一次：坏值一律改成最近的合法档位 */
function applyFontFamily(event: Event) {
  const raw = (event.target as HTMLSelectElement).value;
  uiFontFamily.value = (
    UI_FONT_FAMILY_OPTIONS as readonly string[]
  ).includes(raw)
    ? (raw as UiFontFamily)
    : "hei";
}

// ---------------- 外观设置：provide 给 AppearanceTab 子组件 ----------------
provide("appearanceSettings", {
  // 状态
  theme,
  accent,
  uiFontFamily,
  latinFont,
  installedCardBg,
  installedCardBar,
  installedCardStripes,
  detailButtonMode,
  uiFontWeight,
  showAdvancedTypography,
  globalFontScale,
  cardSize,
  readerFontSize,
  readerLineHeight,
  readerFontWeight,
  cardFontSize,
  cardFontWeight,
  isEnglishUi,

  // 方法
  applyFontFamily,
  stepUiFontWeight,
  weightLabel,
  snapGlobalScale,
  snapCardSize,
  snapReaderFontSize,
  stepLineHeight,
  lineHeightLabel,
  stepReaderFontWeight,
  snapCardFontSize,
  stepCardFontWeight,

  // 常量
  THEME_OPTIONS,
  FONT_FAMILY_OPTIONS_LABELED,
  GLOBAL_SCALE_MIN,
  GLOBAL_SCALE_MAX,
  GLOBAL_SCALE_STEP,
  CARD_SIZE_MIN,
  CARD_SIZE_MAX,
  CARD_SIZE_STEP,
  READER_FONT_SIZE_MIN,
  READER_FONT_SIZE_MAX,
  CARD_FONT_SIZE_MIN,
  CARD_FONT_SIZE_MAX,
});

/** 恢复默认排版的二次确认开关 */
const showResetConfirm = ref(false);

/**
 * 恢复默认排版：只重置「字体种类 / 界面字重 / 缩放 / 正文字号·行距·字重 / 卡片字号·字重 /
 * 英文西文栈开关」九个排版变量；卡片大小（cardSize）与主题模式（theme）不在其中，绝不会被误伤。
 * 九个值一次性同步赋值 → App.vue 的 watch 会合并成一次 300ms 防抖写盘。
 */
function resetTypography() {
  uiFontFamily.value = TYPOGRAPHY_DEFAULTS.fontFamily;
  uiFontWeight.value = TYPOGRAPHY_DEFAULTS.uiFontWeight;
  globalFontScale.value = TYPOGRAPHY_DEFAULTS.globalScale;
  readerFontSize.value = TYPOGRAPHY_DEFAULTS.readerFontSize;
  readerLineHeight.value = TYPOGRAPHY_DEFAULTS.readerLineHeight;
  readerFontWeight.value = TYPOGRAPHY_DEFAULTS.readerFontWeight;
  cardFontSize.value = TYPOGRAPHY_DEFAULTS.cardFontSize;
  cardFontWeight.value = TYPOGRAPHY_DEFAULTS.cardFontWeight;
  latinFont.value = TYPOGRAPHY_DEFAULTS.latinFont;
  showResetConfirm.value = false;
}

// ---------------- v3.3：游戏根目录聚焦协调 ----------------
// 业务逻辑已下沉到 GeneralTab；这里只负责切 Tab + 调用子组件暴露的聚焦方法。

/** GeneralTab 组件引用（用于外部触发时滚动定位游戏根目录行） */
const generalTabRef = ref<InstanceType<typeof GeneralTab> | null>(null);

/** 切到 GeneralTab，等子组件挂载后调其 focusGameRootRow() */
async function focusGameRootRow(): Promise<void> {
  tab.value = "general";
  await nextTick();
  generalTabRef.value?.focusGameRootRow();
}

/** 弹窗已经打开时再次请求聚焦（例如用户又点了一次「启动游戏」） */
watch(
  () => props.focusGameRoot,
  (next) => {
    if (next) void focusGameRootRow();
  },
);

// ---------------- 全局键盘事件 ----------------

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

// ---------------- v3.4：设置改为可拖动浮动面板（去掉全屏遮罩，主界面可继续操作） ----------------
//
// 面板不再铺满遮罩：只把 .modal 本体固定在视口上，标题栏可拖，
// 位置写进 localStorage，下次打开回到原处；拖出屏幕时按视口夹紧。

const PANEL_POS_KEY = "aoe2mm:settings-panel-pos";
/** 面板左上角（px）。null = 没拖过，走 CSS 的居中定位 */
const panelPos = ref<{ x: number; y: number } | null>(null);
const dragging = ref(false);
const panelRef = ref<HTMLElement | null>(null);

const panelStyle = computed<Record<string, string>>((): Record<string, string> => {
  const pos = panelPos.value;
  if (!pos) return {};
  return { left: `${pos.x}px`, top: `${pos.y}px`, transform: "none" };
});

const PANEL_MARGIN = 8;

/** 夹在视口内，四边各留 8px，避免拖到屏幕外面找不回来 */
function clampPanelPos(x: number, y: number): { x: number; y: number } {
  const rect = panelRef.value?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  const maxX = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

let dragOrigin = { pointerX: 0, pointerY: 0, panelX: 0, panelY: 0 };

function onDragStart(event: PointerEvent) {
  if (event.button !== 0) return;
  // 标题栏上的关闭按钮不该把面板拖起来
  if ((event.target as HTMLElement).closest("button")) return;
  const rect = panelRef.value?.getBoundingClientRect();
  if (!rect) return;
  dragOrigin = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    panelX: rect.left,
    panelY: rect.top,
  };
  dragging.value = true;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  event.preventDefault();
}

function onDragMove(event: PointerEvent) {
  panelPos.value = clampPanelPos(
    dragOrigin.panelX + (event.clientX - dragOrigin.pointerX),
    dragOrigin.panelY + (event.clientY - dragOrigin.pointerY),
  );
}

function onDragEnd() {
  dragging.value = false;
  window.removeEventListener("pointermove", onDragMove);
  if (!panelPos.value) return;
  try {
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos.value));
  } catch {
    /* 存储不可用就只保留本次会话的位置 */
  }
}

/** 打开时恢复上次位置（脏数据直接忽略，不影响打开） */
function restorePanelPos() {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof saved.x !== "number" || typeof saved.y !== "number") return;
    panelPos.value = clampPanelPos(saved.x, saved.y);
  } catch {
    /* 位置记忆损坏不阻塞设置面板 */
  }
}

/** 窗口尺寸变小后，原来记的位置可能越界，重新夹紧 */
function onWindowResize() {
  if (panelPos.value) panelPos.value = clampPanelPos(panelPos.value.x, panelPos.value.y);
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  restorePanelPos();
  // 从顶栏「启动游戏」跳过来：滚动到「游戏根目录」一行并高亮
  if (props.focusGameRoot) void focusGameRootRow();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("pointermove", onDragMove);
});
</script>

<template>
  <div
    ref="panelRef"
    class="modal settings-modal settings-floating"
    :class="{ 'is-dragging': dragging }"
    :style="panelStyle"
  >
    <header class="modal-head settings-drag-handle" @pointerdown="onDragStart">
      <h2>{{ t("settings.title") }}</h2>
      <span class="modal-sub">{{ t("settings.subtitle") }}</span>
      <button type="button" class="modal-x" :title="t('settings.close')" @click="emit('close')">
        ✕
      </button>
    </header>

      <div class="settings-layout">
        <nav class="settings-tabs">
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'general' }"
            @click="tab = 'general'"
          >
            ⚙ {{ t("settings.tabGeneral") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'appearance' }"
            @click="tab = 'appearance'"
          >
            🎨 {{ t("settingsUi.tabAppearance") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'network' }"
            @click="tab = 'network'"
          >
            🌐 {{ t("settings.tabNetwork") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'local' }"
            @click="tab = 'local'"
          >
            🧩 {{ t("nav.local") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'online' }"
            @click="tab = 'online'"
          >
            ☁ {{ t("settings.tabTranslate") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'storage' }"
            @click="tab = 'storage'"
          >
            🗂 {{ t("settings.tabStorage") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'about' }"
            @click="tab = 'about'"
          >
            ℹ {{ t("settings.tabAbout") }}
          </button>
        </nav>

        <div class="settings-pane">
          <!-- 通用 -->
          <GeneralTab
            v-if="tab === 'general'"
            ref="generalTabRef"
            :root-path="props.rootPath"
            @root-changed="emit('root-changed', $event)"
          />

          <!-- 外观（v2.0 新增）：主题模式 + 卡片大小滑块 -->
          <AppearanceTab v-else-if="tab === 'appearance'" />
          <NetworkTab v-else-if="tab === 'network'" />

          <!-- 本地模组：索引 / 搜索 / 批量更新检测 -->
          <LocalTab v-else-if="tab === 'local'" />

          <!-- 模组翻译：目标语言 / 翻译引擎 / 批量标题翻译 / 翻译缓存统计（只读） -->
          <OnlineTab v-else-if="tab === 'online'" />

          <!-- 数据与缓存（v1.x）：单目录 + 二次确认迁移 -->
          <StorageTab v-else-if="tab === 'storage'" />

          <!-- 关于（v2.0）：「软件更新」从通用 Tab 整体搬到这里（版本号 / 检查更新 / 发布页） -->
          <AboutTab v-else />
        </div>
      </div>

    <!-- v3.0：恢复默认排版的二次确认（叠在设置弹窗之上） -->
    <ConfirmDialog
      v-if="showResetConfirm"
      :title="t('settingsUi.resetTypographyTitle')"
      :message="t('settingsUi.resetTypographyMessage')"
      :confirm-label="t('settingsUi.resetTypographyConfirm')"
      :danger="false"
      @confirm="resetTypography"
      @cancel="showResetConfirm = false"
    />
  </div>
</template>

<style scoped>
.settings-modal {
  width: min(720px, 100%);
}

/* v3.4：设置改成可拖动浮动面板 —— 去掉全屏遮罩，主界面照常可点可滚。
   位置由 panelPos（left/top）驱动，没拖过时退回这里的居中定位。
   层级 32：高于主界面内容，低于 .modal-backdrop(40)，其它模态弹窗仍能盖住它。 */
.settings-floating {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 32;
  max-height: calc(100vh - 16px);
  box-shadow:
    0 18px 46px rgba(0, 0, 0, 0.55),
    var(--shadow),
    inset 0 0 0 1px rgba(var(--accent-rgb), 0.12);
}
/* 标题栏即拖动把手；关闭按钮在 onDragStart 里已被排除 */
.settings-drag-handle {
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.settings-floating.is-dragging .settings-drag-handle {
  cursor: grabbing;
}
.settings-floating.is-dragging {
  user-select: none;
}

/* 固定尺寸：左侧导航 + 右侧内容区都锁死在同一个高度里，
   切换标签时弹窗不再跟着内容长短抽动（本次要把 max-height / min-height 全部拿掉）。 */
.settings-layout {
  display: flex;
  height: 520px;
  overflow: hidden;
}

@media (max-height: 640px) {
  /* 屏幕真实高度不够时整体降一档，仍然是一个定高容器，不会因标签内容而变 */
  .settings-layout {
    height: 420px;
  }
}

/* 左栏：固定 180px，自身单独滚动 */
.settings-tabs {
  flex: 0 0 180px;
  width: 180px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 12px;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(var(--accent-rgb), 0.05), transparent);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.settings-tab {
  text-align: left;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: calc(12px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--muted);
}
.settings-tab:hover {
  color: var(--parch);
  background: var(--bg-panel);
  border-color: transparent;
}
.settings-tab.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: var(--ui-font-weight-strong);
}

/* 右栏：吃掉剩余宽度，横向不溢出，纵向自己滚；
   scrollbar-gutter: stable 保证从「没有滚动条」切到「有滚动条」时宽度不跳。 */
.settings-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 24px;
  scrollbar-gutter: stable;
}

.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.06);
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
/* v2.4：排版三层的子分组标题（界面 / 正文阅读 / 卡片列表）——
   分组标题本身也跟随全局缩放，150% 时不会显得比正文还小 */
.settings-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  min-width: 0;
  font-size: calc(11px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: calc(2px * var(--ui-tracking));
  text-transform: uppercase;
  color: var(--gold-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.settings-group-title::after {
  content: "";
  flex: 1 1 auto;
  min-width: 12px;
  height: 1px;
  background: linear-gradient(90deg, var(--line), transparent);
}
.row-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-title {
  font-size: calc(12.5px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--parch);
}
.row-note {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  line-height: 1.6;
}

.settings-select,
.settings-input {
  padding: 7px 9px;
  font-size: calc(12px * var(--global-scale));
}
.settings-select {
  min-width: 120px;
}
/* v2.3：排版下拉框固定窄宽，字号放大到 20px 时也不会把左侧标签挤掉 */
.typography-select {
  min-width: 108px;
  max-width: 132px;
}
.settings-input {
  width: 100%;
}

.settings-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 2px 0;
}

.settings-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  letter-spacing: calc(0.8px * var(--ui-tracking));
}
.settings-check:disabled {
  opacity: 0.6;
}

/* v2.2 外观 Tab：主题模式（分段按钮，深色 / 明亮）。
   激活态沿用「金底 + 深字」，与非激活态拉开层级但同样安静。 */
.settings-segment {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
}
/* 四档强调色 pills 较长，空间不足时允许换行，避免把右列撑出卡片 */
.settings-segment--wrap {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.settings-segment-btn {
  min-width: 74px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--parch-dim);
  letter-spacing: calc(0.8px * var(--ui-tracking));
}
.settings-segment-btn:hover:not(.active) {
  color: var(--parch);
  background: var(--bg-hover);
}
.settings-segment-btn.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: var(--ui-font-weight-strong);
}

/* v2.0 外观 Tab：卡片大小滑块（从主界面顶栏搬过来，尺寸口径与 useViewPrefs 一致） */
.settings-range-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.settings-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 0 1 150px;
  width: 150px;
  min-width: 90px;
  height: 4px;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  cursor: pointer;
}
.settings-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--gold-bright);
  background: var(--bg-panel-deep);
  box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.7);
}
.settings-range::-webkit-slider-thumb:hover {
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.95);
}
.settings-range-value {
  flex: 0 0 auto;
  min-width: 52px;
  text-align: right;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--gold-text);
  letter-spacing: calc(0.6px * var(--ui-tracking));
}
/* 根目录路径回显：等宽字体 + 允许折行，长路径不会把右侧按钮顶出去 */
.row-note.mono {
  font-family: var(--font-mono);
  font-size: calc(10.5px * var(--global-scale));
  word-break: break-all;
  color: var(--parch-dim);
}

.settings-status {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
  letter-spacing: calc(0.4px * var(--ui-tracking));
}
.settings-status.ok {
  color: var(--ok-text);
}
.settings-status.bad {
  color: var(--danger-text);
}

.settings-update-note {
  border: 1px solid rgba(var(--accent-rgb), 0.55);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(var(--accent-rgb), 0.06);
}
.settings-update-note p {
  margin: 0 0 6px;
  font-size: calc(12px * var(--global-scale));
  line-height: 1.7;
  color: var(--parch);
}
.settings-update-note p.note {
  color: var(--muted);
  font-size: calc(11px * var(--global-scale));
}
.settings-release {
  padding: 6px 12px;
  letter-spacing: calc(0.8px * var(--ui-tracking));
}

.settings-summary {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--gold-text);
}

.settings-check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch-dim);
}

/* v3.5：英文界面「西文字体栈」开关（单独占 .settings-row 的右列） */
.latin-font-check {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--gold);
  cursor: pointer;
}

.settings-actions {
  display: flex;
  gap: 8px;
}

/* v3.3：字重 / 行距的左右切换控件（‹ 值 ›，替代原来的下拉框） */
.seg-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-panel-deep);
}
.seg-stepper-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--parch-dim);
  font-family: inherit;
  font-size: calc(14px * var(--global-scale));
  line-height: 1;
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.seg-stepper-btn:hover:not(:disabled) {
  color: var(--gold-bright);
  background: rgba(var(--accent-rgb), 0.1);
}
.seg-stepper-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.seg-stepper-value {
  min-width: 56px;
  text-align: center;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch);
  white-space: nowrap;
}

/* v3.3：「更多排版选项」折叠开关 —— 外观页首屏只留两项，其余按需展开 */
.typography-more {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 0 2px;
  padding: 6px 10px;
  border: 1px dashed var(--line);
  border-radius: 7px;
  background: transparent;
  color: var(--gold-dim);
  font-family: inherit;
  font-size: calc(11px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: calc(1px * var(--ui-tracking));
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease;
}
.typography-more:hover {
  color: var(--gold-bright);
  border-color: var(--gold-dim);
}
.typography-more-arrow {
  font-size: calc(11px * var(--global-scale));
  transition: transform 0.16s ease;
}
.typography-more-arrow.is-open {
  transform: rotate(180deg);
}

/* v3.0：恢复默认排版按钮（排版区块右下角，Ghot 风格，hover 点亮金色） */
.typography-reset-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.typography-reset {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--parch-dim);
  font-size: calc(12.5px * var(--global-scale));
  padding: 5px 12px;
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}
.typography-reset:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: rgba(var(--accent-rgb), 0.08);
}

.about-card {
  gap: 14px;
}
.about-line {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.about-value {
  font-size: calc(13px * var(--global-scale));
  color: var(--gold-text);
  letter-spacing: calc(1px * var(--ui-tracking));
}
.about-link {
  justify-self: start;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--parch-dim);
  font-size: calc(11.5px * var(--global-scale));
  word-break: break-all;
  text-align: left;
}
.about-link:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
}

/* v3.1：蓝奏云网盘行（右侧按钮 + 灰色密码提示） */
.about-line.about-cloud {
  grid-template-columns: minmax(0, 1fr) auto;
}
.about-cloud-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.about-cloud-password {
  font-size: calc(11px * var(--global-scale));
  letter-spacing: calc(0.6px * var(--ui-tracking));
  color: var(--muted);
  white-space: nowrap;
}

/* v3.1：更新历史折叠面板（面板内单独滚动，不拉长整个关于卡片） */
.about-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* v0.4.5 关于页：日志诊断区（问题描述输入框 + 两枚按钮） */
.diag-block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.diag-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.diag-input {
  width: 100%;
  font-size: calc(12px * var(--global-scale));
  padding: 7px 9px;
}
.diag-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 主按钮：金色描边高亮，和「检查更新」区分开 */
.diag-copy {
  border-color: var(--gold-dim);
  color: var(--gold-text);
}
.diag-copy:hover:not(:disabled) {
  border-color: var(--gold-text);
  background: rgba(var(--accent-rgb), 0.1);
}
.about-history {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-panel-deep);
}
.about-history-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}
.about-history-item:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
.about-history-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.about-history-version {
  font-size: calc(12.5px * var(--global-scale));
  letter-spacing: calc(1px * var(--ui-tracking));
  color: var(--gold-text);
}
.about-history-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--parch-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-history-date {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.about-history-note {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
}
.about-history-note.error {
  color: var(--danger-text);
}
.about-history-retry {
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--parch-dim);
  font-size: calc(11px * var(--global-scale));
}
.about-history-retry:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
}

/* v3.3：游戏根目录一行 —— 复用 .settings-row 的两列布局，
   只补「长路径单行省略」与「从顶栏跳过来时的金色高亮」。 */
.settings-row.game-root-row {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  row-gap: 10px;
  scroll-margin-block: 28px;
  border-radius: 4px;
  transition: background 0.25s ease, box-shadow 0.25s ease;
}
.settings-row.game-root-flash {
  background: rgba(var(--accent-rgb), 0.1);
  box-shadow: 0 0 0 1px var(--gold), 0 0 14px rgba(var(--accent-rgb), 0.4);
}
/* 优先级压过 .row-note.mono 的 break-all，否则长路径会把按钮顶出卡片 */
.row-note.mono.game-root-path {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: normal;
  color: var(--parch-dim);
}
.game-root-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}
.game-root-warn {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--danger-text);
}
.game-root-ok {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--ok-text-strong);
}
</style>
