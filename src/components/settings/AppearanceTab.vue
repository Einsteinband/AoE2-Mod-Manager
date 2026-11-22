<script setup lang="ts">
/**
 * 外观设置 Tab：主题 + 字体 + 排版三层调节
 *
 * 通过 inject 从 SettingsModal 父组件获取所有状态和方法，避免 props 满天飞。
 */
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import type { UiFontFamily } from "../../api";
import { ACCENT_THEMES } from "../../config/accentThemes";
import { cardTogglePrefs, setCardTogglePrefs, type CardToggleStyle } from "../../composables/local/cardTogglePrefs";

const { t } = useI18n();

interface AppearanceSettings {
  // 状态（都是 ref，模板里要 .value）
  theme: { value: string };
  accent: { value: string };
  uiFontFamily: { value: UiFontFamily };
  latinFont: { value: boolean };
  installedCardBg: { value: boolean };
  installedCardBar: { value: boolean };
  installedCardBarSide: { value: string };
  enabledCardBar: { value: boolean };
  enabledCardBarSide: { value: string };
  cardDivider: { value: boolean };
  backToTop: { value: boolean };
  installedCardStripes: { value: boolean };
  detailButtonMode: { value: string };
  uiFontWeight: { value: number };
  showAdvancedTypography: { value: boolean };
  globalFontScale: { value: number };
  cardSize: { value: number };
  readerFontSize: { value: number };
  readerLineHeight: { value: number };
  readerFontWeight: { value: number };
  cardFontSize: { value: number };
  cardFontWeight: { value: number };
  isEnglishUi: { value: boolean };

  // 方法
  applyFontFamily: (e: Event) => void;
  stepUiFontWeight: (dir: number) => void;
  weightLabel: (weight: number) => string;
  snapGlobalScale: () => void;
  snapCardSize: () => void;
  snapReaderFontSize: () => void;
  stepLineHeight: (dir: number) => void;
  lineHeightLabel: (lh: number) => string;
  stepReaderFontWeight: (dir: number) => void;
  snapCardFontSize: () => void;
  stepCardFontWeight: (dir: number) => void;

  // 常量
  THEME_OPTIONS: { value: string; label: string }[];
  FONT_FAMILY_OPTIONS_LABELED: { value: string; label: string }[];
  GLOBAL_SCALE_MIN: number;
  GLOBAL_SCALE_MAX: number;
  GLOBAL_SCALE_STEP: number;
  CARD_SIZE_MIN: number;
  CARD_SIZE_MAX: number;
  CARD_SIZE_STEP: number;
  READER_FONT_SIZE_MIN: number;
  READER_FONT_SIZE_MAX: number;
  CARD_FONT_SIZE_MIN: number;
  CARD_FONT_SIZE_MAX: number;
}

const settings = inject<AppearanceSettings>("appearanceSettings");
if (!settings) {
  throw new Error("AppearanceTab must be used inside SettingsModal");
}

// 用 computed 包一层，解决解构 ref 后赋值不生效的问题
const theme = computed({
  get: () => settings.theme.value,
  set: (val: string) => { settings.theme.value = val; },
});
const accent = computed({
  get: () => settings.accent.value,
  set: (val: string) => { settings.accent.value = val; },
});
const uiFontFamily = computed({
  get: () => settings.uiFontFamily.value,
  set: (val: UiFontFamily) => { settings.uiFontFamily.value = val; },
});
const latinFont = computed({
  get: () => settings.latinFont.value,
  set: (val: boolean) => { settings.latinFont.value = val; },
});
const installedCardBg = computed({
  get: () => settings.installedCardBg.value,
  set: (val: boolean) => { settings.installedCardBg.value = val; },
});
const installedCardBar = computed({
  get: () => settings.installedCardBar.value,
  set: (val: boolean) => { settings.installedCardBar.value = val; },
});
const installedCardBarSide = computed({
  get: () => settings.installedCardBarSide.value,
  set: (val: string) => { settings.installedCardBarSide.value = val; },
});
const enabledCardBar = computed({
  get: () => settings.enabledCardBar.value,
  set: (val: boolean) => { settings.enabledCardBar.value = val; },
});
const enabledCardBarSide = computed({
  get: () => settings.enabledCardBarSide.value,
  set: (val: string) => { settings.enabledCardBarSide.value = val; },
});
/** 卡片分隔线：标题区与信息区之间的淡虚线（纯装饰，默认显示） */
const cardDivider = computed({
  get: () => settings.cardDivider.value,
  set: (val: boolean) => { settings.cardDivider.value = val; },
});
/** 回到列表顶部按钮：列表底部中央的悬浮件（默认显示） */
const backToTop = computed({
  get: () => settings.backToTop.value,
  set: (val: boolean) => { settings.backToTop.value = val; },
});
const installedCardStripes = computed({
  get: () => settings.installedCardStripes.value,
  set: (val: boolean) => { settings.installedCardStripes.value = val; },
});
const detailButtonMode = computed({
  get: () => settings.detailButtonMode.value,
  set: (val: string) => { settings.detailButtonMode.value = val; },
});

/** 卡片启用/禁用按钮：显示开关与样式都读写同一个全局单例（立即生效 + 自动落盘） */
const cardToggleShow = computed({
  get: () => cardTogglePrefs.show,
  set: (val: boolean) => setCardTogglePrefs({ show: val }),
});
const cardToggleStyle = computed(() => cardTogglePrefs.style);
function setCardToggleStyle(style: CardToggleStyle) {
  setCardTogglePrefs({ style });
}

const DETAIL_BTN_MODE_OPTIONS = computed(() => [
  { value: "icon", label: t("settingsUi.detailBtnModeIcon") },
  { value: "text", label: t("settingsUi.detailBtnModeText") },
]);
const uiFontWeight = computed({
  get: () => settings.uiFontWeight.value,
  set: (val: number) => { settings.uiFontWeight.value = val; },
});
const showAdvancedTypography = computed({
  get: () => settings.showAdvancedTypography.value,
  set: (val: boolean) => { settings.showAdvancedTypography.value = val; },
});
const globalFontScale = computed({
  get: () => settings.globalFontScale.value,
  set: (val: number) => { settings.globalFontScale.value = val; },
});
const cardSize = computed({
  get: () => settings.cardSize.value,
  set: (val: number) => { settings.cardSize.value = val; },
});
const readerFontSize = computed({
  get: () => settings.readerFontSize.value,
  set: (val: number) => { settings.readerFontSize.value = val; },
});
const readerLineHeight = computed({
  get: () => settings.readerLineHeight.value,
  set: (val: number) => { settings.readerLineHeight.value = val; },
});
const readerFontWeight = computed({
  get: () => settings.readerFontWeight.value,
  set: (val: number) => { settings.readerFontWeight.value = val; },
});
const cardFontSize = computed({
  get: () => settings.cardFontSize.value,
  set: (val: number) => { settings.cardFontSize.value = val; },
});
const cardFontWeight = computed({
  get: () => settings.cardFontWeight.value,
  set: (val: number) => { settings.cardFontWeight.value = val; },
});
const isEnglishUi = computed(() => settings.isEnglishUi.value);

// 方法和常量直接从 settings 里拿
const {
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
} = settings;
</script>

<template>
  <section class="settings-card">
    <!-- v2.2：主题模式（深色 / 明亮），点一下立即换肤，不重载页面 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.themeTitle") }}</span>
      </div>
      <div class="settings-segment" role="radiogroup" :aria-label="t('settingsUi.themeTitle')">
        <button
          v-for="option in THEME_OPTIONS"
          :key="option.value"
          type="button"
          role="radio"
          class="settings-segment-btn"
          :class="{ active: theme === option.value }"
          :aria-checked="theme === option.value"
          @click="theme = option.value as any"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <!-- v3.6：强调色主题（与明暗模式正交），点一下立即换肤，不重载页面 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.accentTitle") }}</span>
      </div>
      <div class="accent-swatch-grid" role="radiogroup" :aria-label="t('settingsUi.accentTitle')">
        <button
          v-for="theme in ACCENT_THEMES"
          :key="theme.id"
          type="button"
          role="radio"
          class="accent-swatch"
          :class="{ active: accent === theme.id }"
          :aria-checked="accent === theme.id"
          :title="t(theme.labelKey)"
          @click="accent = theme.id"
        >
          <span
            class="swatch-color"
            :style="{ background: `linear-gradient(180deg, ${theme.dark.bright}, ${theme.dark.accent})` }"
            aria-hidden="true"
          />
          <span class="swatch-check" aria-hidden="true">✓</span>
          <span class="swatch-label">{{ t(theme.labelKey) }}</span>
        </button>
      </div>
    </div>

    <!-- 详情页辅助按钮：图标（默认）/ 原始文字，只影响模组详情操作按钮 -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.detailBtnModeTitle") }}</span>
      </div>
      <div class="settings-segment" role="radiogroup" :aria-label="t('settingsUi.detailBtnModeTitle')">
        <button
          v-for="option in DETAIL_BTN_MODE_OPTIONS"
          :key="option.value"
          type="button"
          role="radio"
          class="settings-segment-btn"
          :class="{ active: detailButtonMode === option.value }"
          :aria-checked="detailButtonMode === option.value"
          @click="detailButtonMode = option.value"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="settings-sep"></div>

    <h3 class="settings-group-title">{{ t("settingsUi.installedCardDecorTitle") }}</h3>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.installedCardBgTitle") }}</span>
      </div>
      <input
        v-model="installedCardBg"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.installedCardBgTitle')"
      />
    </div>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.installedCardBarTitle") }}</span>
        <span class="row-note">{{ t("settingsUi.installedCardBarNote") }}</span>
      </div>
      <div class="card-bar-controls">
        <input
          v-model="installedCardBar"
          type="checkbox"
          class="installed-card-decor-check"
          :aria-label="t('settingsUi.installedCardBarTitle')"
        />
        <select
          v-model="installedCardBarSide"
          class="settings-select card-bar-side-select"
          :disabled="!installedCardBar"
          :aria-label="t('settingsUi.cardBarSideTitle')"
        >
          <option value="left">{{ t("settingsUi.cardBarSideLeft") }}</option>
          <option value="right">{{ t("settingsUi.cardBarSideRight") }}</option>
        </select>
      </div>
    </div>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.installedCardStripesTitle") }}</span>
      </div>
      <input
        v-model="installedCardStripes"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.installedCardStripesTitle')"
      />
    </div>

    <div class="settings-sep"></div>

    <!-- 已启用状态侧边栏：与上面的「已安装卡片样式」互相独立 -->
    <h3 class="settings-group-title">{{ t("settingsUi.enabledCardBarTitle") }}</h3>
    <p class="row-note card-bar-group-note">{{ t("settingsUi.enabledCardBarNote") }}</p>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.enabledCardBarShowTitle") }}</span>
      </div>
      <input
        v-model="enabledCardBar"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.enabledCardBarShowTitle')"
      />
    </div>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.cardBarSideTitle") }}</span>
      </div>
      <select
        v-model="enabledCardBarSide"
        class="settings-select card-bar-side-select"
        :disabled="!enabledCardBar"
        :aria-label="t('settingsUi.cardBarSideTitle')"
      >
        <option value="left">{{ t("settingsUi.cardBarSideLeft") }}</option>
        <option value="right">{{ t("settingsUi.cardBarSideRight") }}</option>
      </select>
    </div>

    <div class="settings-sep"></div>

    <!-- 启用/禁用按钮：显示开关 + 左右切换式样式选择（只影响展示，不动业务逻辑） -->
    <h3 class="settings-group-title">{{ t("settingsUi.cardToggleGroupTitle") }}</h3>
    <p class="row-note card-bar-group-note">{{ t("settingsUi.cardToggleGroupNote") }}</p>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.cardToggleShowTitle") }}</span>
      </div>
      <input
        v-model="cardToggleShow"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.cardToggleShowTitle')"
      />
    </div>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.cardToggleStyleTitle") }}</span>
        <span class="row-note">{{ t("settingsUi.cardToggleStyleNote") }}</span>
      </div>
      <div class="card-toggle-seg" role="group" :aria-label="t('settingsUi.cardToggleStyleTitle')">
        <button
          type="button"
          class="card-toggle-seg-btn"
          :class="{ 'is-active': cardToggleStyle === 'circle' }"
          :aria-pressed="cardToggleStyle === 'circle'"
          @click="setCardToggleStyle('circle')"
        >
          {{ t("settingsUi.cardToggleStyleCircle") }}
        </button>
        <button
          type="button"
          class="card-toggle-seg-btn"
          :class="{ 'is-active': cardToggleStyle === 'switch' }"
          :aria-pressed="cardToggleStyle === 'switch'"
          @click="setCardToggleStyle('switch')"
        >
          {{ t("settingsUi.cardToggleStyleSwitch") }}
        </button>
      </div>
    </div>

    <div class="settings-sep"></div>

    <!-- 回到列表顶部按钮：列表底部中央的悬浮件（默认显示） -->
    <h3 class="settings-group-title">{{ t("settingsUi.backToTopGroupTitle") }}</h3>
    <p class="row-note card-bar-group-note">{{ t("settingsUi.backToTopGroupNote") }}</p>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.backToTopShowTitle") }}</span>
      </div>
      <input
        v-model="backToTop"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.backToTopShowTitle')"
      />
    </div>

    <div class="settings-sep"></div>

    <!-- 卡片分隔线：标题区与信息区之间的淡虚线（纯装饰，默认显示） -->
    <h3 class="settings-group-title">{{ t("settingsUi.cardDividerGroupTitle") }}</h3>
    <p class="row-note card-bar-group-note">{{ t("settingsUi.cardDividerGroupNote") }}</p>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.cardDividerShowTitle") }}</span>
      </div>
      <input
        v-model="cardDivider"
        type="checkbox"
        class="installed-card-decor-check"
        :aria-label="t('settingsUi.cardDividerShowTitle')"
      />
    </div>

    <div class="settings-sep"></div>

    <!-- 【外观】：首屏只留「字体种类 + 界面字重」，其余 6 项收进「更多排版选项」 -->
    <h3 class="settings-group-title">{{ t("settingsUi.groupUi") }}</h3>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.fontFamilyTitle") }}</span>
      </div>
      <select
        class="settings-select typography-select"
        :value="uiFontFamily"
        :aria-label="t('settingsUi.fontFamilyTitle')"
        @change="applyFontFamily"
      >
        <option v-for="opt in FONT_FAMILY_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>

    <!-- v3.5：英文界面专用的西文字体栈（只在英文界面出现；中文界面由中文字体优先，开关没有意义） -->
    <div v-if="isEnglishUi" class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.latinFontTitle") }}</span>
      </div>
      <input
        v-model="latinFont"
        type="checkbox"
        class="latin-font-check"
        :aria-label="t('settingsUi.latinFontTitle')"
      />
    </div>

    <!-- 界面字重：左右切换（400 常规 ↔ 700 加粗） -->
    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.uiFontWeightTitle") }}</span>
      </div>
      <div class="seg-stepper" role="group" :aria-label="t('settingsUi.uiFontWeightTitle')">
        <button
          type="button"
          class="seg-stepper-btn"
          :disabled="uiFontWeight <= 400"
          :aria-label="`${t('settingsUi.uiFontWeightTitle')} −`"
          @click="stepUiFontWeight(-1)"
        >
          ‹
        </button>
        <span class="seg-stepper-value">{{ weightLabel(uiFontWeight) }}</span>
        <button
          type="button"
          class="seg-stepper-btn"
          :disabled="uiFontWeight >= 700"
          :aria-label="`${t('settingsUi.uiFontWeightTitle')} +`"
          @click="stepUiFontWeight(1)"
        >
          ›
        </button>
      </div>
    </div>

    <button
      type="button"
      class="typography-more"
      :aria-expanded="showAdvancedTypography"
      @click="showAdvancedTypography = !showAdvancedTypography"
    >
      <span>{{ t("settingsUi.moreTypography") }}</span>
      <span class="typography-more-arrow" :class="{ 'is-open': showAdvancedTypography }">▾</span>
    </button>

    <div v-show="showAdvancedTypography" class="typography-advanced">
      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.globalScaleTitle") }}</span>
        </div>
        <div class="settings-range-wrap">
          <input
            v-model.number="globalFontScale"
            class="settings-range"
            type="range"
            :min="GLOBAL_SCALE_MIN"
            :max="GLOBAL_SCALE_MAX"
            :step="GLOBAL_SCALE_STEP"
            :aria-label="t('settingsUi.globalScaleTitle')"
            :title="globalFontScale + '%'"
            @change="snapGlobalScale"
          />
          <span class="settings-range-value">{{ globalFontScale }}%</span>
        </div>
      </div>

      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.cardSize") }}</span>
        </div>
        <div class="settings-range-wrap">
          <input
            v-model.number="cardSize"
            class="settings-range"
            type="range"
            :min="CARD_SIZE_MIN"
            :max="CARD_SIZE_MAX"
            :step="CARD_SIZE_STEP"
            :title="t('toolbar.cardSize', { n: cardSize })"
            :aria-label="t('toolbar.cardSize', { n: cardSize })"
            @change="snapCardSize"
          />
          <span class="settings-range-value">{{ cardSize }}px</span>
        </div>
      </div>

      <div class="settings-sep"></div>

      <!-- 【正文阅读】：字号 12–24px / 行距 / 字重 -->
      <h3 class="settings-group-title">{{ t("settingsUi.groupReader") }}</h3>

      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.readerFontSizeTitle") }}</span>
        </div>
        <div class="settings-range-wrap">
          <input
            v-model.number="readerFontSize"
            class="settings-range"
            type="range"
            :min="READER_FONT_SIZE_MIN"
            :max="READER_FONT_SIZE_MAX"
            step="1"
            :aria-label="t('settingsUi.readerFontSizeTitle')"
            :title="readerFontSize + 'px'"
            @change="snapReaderFontSize"
          />
          <span class="settings-range-value">{{ readerFontSize }}px</span>
        </div>
      </div>

      <!-- 行距：左右切换（1.4 紧凑 ↔ 1.6 标准 ↔ 1.8 宽松） -->
      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.lineHeightTitle") }}</span>
        </div>
        <div class="seg-stepper" role="group" :aria-label="t('settingsUi.lineHeightTitle')">
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="readerLineHeight <= 1.4"
            :aria-label="`${t('settingsUi.lineHeightTitle')} −`"
            @click="stepLineHeight(-1)"
          >
            ‹
          </button>
          <span class="seg-stepper-value">{{ lineHeightLabel(readerLineHeight) }}</span>
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="readerLineHeight >= 1.8"
            :aria-label="`${t('settingsUi.lineHeightTitle')} +`"
            @click="stepLineHeight(1)"
          >
            ›
          </button>
        </div>
      </div>

      <!-- 正文字重：左右切换（400 常规 ↔ 700 加粗） -->
      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.fontWeightTitle") }}</span>
        </div>
        <div class="seg-stepper" role="group" :aria-label="t('settingsUi.fontWeightTitle')">
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="readerFontWeight <= 400"
            :aria-label="`${t('settingsUi.fontWeightTitle')} −`"
            @click="stepReaderFontWeight(-1)"
          >
            ‹
          </button>
          <span class="seg-stepper-value">{{ weightLabel(readerFontWeight) }}</span>
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="readerFontWeight >= 700"
            :aria-label="`${t('settingsUi.fontWeightTitle')} +`"
            @click="stepReaderFontWeight(1)"
          >
            ›
          </button>
        </div>
      </div>

      <div class="settings-sep"></div>

      <!-- 【卡片列表】：字号 10–16px + 字重（v3.3 新增） -->
      <h3 class="settings-group-title">{{ t("settingsUi.groupCard") }}</h3>

      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.cardFontSizeTitle") }}</span>
        </div>
        <div class="settings-range-wrap">
          <input
            v-model.number="cardFontSize"
            class="settings-range"
            type="range"
            :min="CARD_FONT_SIZE_MIN"
            :max="CARD_FONT_SIZE_MAX"
            step="1"
            :aria-label="t('settingsUi.cardFontSizeTitle')"
            :title="cardFontSize + 'px'"
            @change="snapCardFontSize"
          />
          <span class="settings-range-value">{{ cardFontSize }}px</span>
        </div>
      </div>

      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.cardFontWeightTitle") }}</span>
        </div>
        <div class="seg-stepper" role="group" :aria-label="t('settingsUi.cardFontWeightTitle')">
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="cardFontWeight <= 400"
            :aria-label="`${t('settingsUi.cardFontWeightTitle')} −`"
            @click="stepCardFontWeight(-1)"
          >
            ‹
          </button>
          <span class="seg-stepper-value">{{ weightLabel(cardFontWeight) }}</span>
          <button
            type="button"
            class="seg-stepper-btn"
            :disabled="cardFontWeight >= 700"
            :aria-label="`${t('settingsUi.cardFontWeightTitle')} +`"
            @click="stepCardFontWeight(1)"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.typography-more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 4px;
  cursor: pointer;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch-dim);
}
.typography-more:hover {
  color: var(--parch);
  border-color: var(--gold-dim);
}
.typography-more-arrow {
  transition: transform 0.2s;
}
.typography-more-arrow.is-open {
  transform: rotate(180deg);
}
.typography-advanced {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-left: 8px;
  border-left: 2px solid var(--line-soft);
}
.seg-stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.seg-stepper-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.seg-stepper-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.seg-stepper-value {
  min-width: 60px;
  text-align: center;
  font-size: calc(12px * var(--global-scale));
}
.latin-font-check,
.installed-card-decor-check {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

/* v1.1：卡片侧边栏两组设置 —— 开关 + 位置下拉并排，关闭开关时位置控件禁用 */
.card-bar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-bar-side-select {
  min-width: 92px;
}
.card-bar-side-select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.card-bar-group-note {
  margin: -6px 0 0;
}

/* v1.2：卡片启用/禁用按钮 —— 显示开关 + 左右切换式样式选择（双选项一律用分段控件） */
.card-toggle-seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel-lo);
}
.card-toggle-seg-btn {
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--parch-dim);
  font-size: calc(12px * var(--global-scale));
  letter-spacing: calc(0.4px * var(--ui-tracking));
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.card-toggle-seg-btn:hover {
  color: var(--parch);
  border-color: var(--line-soft);
}
.card-toggle-seg-btn.is-active {
  background: rgba(var(--accent-rgb), 0.16);
  border-color: rgba(var(--accent-rgb), 0.55);
  color: var(--gold-bright);
}

/* 强调色色块选择器：四列网格，窄窗降两列；色块、勾选与标签统一 */
.accent-swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.accent-swatch {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-lo);
  cursor: pointer;
}
.accent-swatch:hover:not(.active) {
  border-color: var(--gold-dim);
  background: var(--bg-hover);
}
.accent-swatch:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 1px;
}
.accent-swatch .swatch-color {
  position: relative;
  width: 100%;
  height: 26px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.15);
}
.accent-swatch .swatch-check {
  position: absolute;
  top: 13px;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  opacity: 0;
}
.accent-swatch.active .swatch-check {
  opacity: 1;
}
.accent-swatch.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.accent-swatch .swatch-label {
  font-size: calc(11px * var(--global-scale, 1));
  color: var(--parch-dim);
  letter-spacing: calc(0.4px * var(--ui-tracking));
  white-space: nowrap;
}
.accent-swatch.active .swatch-label {
  color: var(--parch);
  font-weight: var(--ui-font-weight-strong, 600);
}
@media (max-width: 560px) {
  .accent-swatch-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
