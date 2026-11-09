<script setup lang="ts">
/**
 * 外观设置 Tab：主题 + 字体 + 排版三层调节
 *
 * 通过 inject 从 SettingsModal 父组件获取所有状态和方法，避免 props 满天飞。
 */
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import type { UiFontFamily } from "../../api";

const { t } = useI18n();

interface AppearanceSettings {
  // 状态（都是 ref，模板里要 .value）
  theme: { value: string };
  uiFontFamily: { value: UiFontFamily };
  latinFont: { value: boolean };
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
const uiFontFamily = computed({
  get: () => settings.uiFontFamily.value,
  set: (val: UiFontFamily) => { settings.uiFontFamily.value = val; },
});
const latinFont = computed({
  get: () => settings.latinFont.value,
  set: (val: boolean) => { settings.latinFont.value = val; },
});
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
        <span class="row-note">{{ t("settingsUi.themeNote") }}</span>
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

    <div class="settings-sep"></div>

    <!-- 【外观】：首屏只留「字体种类 + 界面字重」，其余 6 项收进「更多排版选项」 -->
    <h3 class="settings-group-title">{{ t("settingsUi.groupUi") }}</h3>

    <div class="settings-row">
      <div class="row-label">
        <span class="row-title">{{ t("settingsUi.fontFamilyTitle") }}</span>
        <span class="row-note">{{ t("settingsUi.fontFamilyNote") }}</span>
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
        <span class="row-note">{{ t("settingsUi.latinFontNote") }}</span>
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
        <span class="row-note">{{ t("settingsUi.uiFontWeightNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.globalScaleNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.cardSizeNote") }}</span>
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

      <p class="settings-hint">{{ t("settingsUi.cardSizeHint") }}</p>

      <div class="settings-sep"></div>

      <!-- 【正文阅读】：字号 12–24px / 行距 / 字重 -->
      <h3 class="settings-group-title">{{ t("settingsUi.groupReader") }}</h3>

      <div class="settings-row">
        <div class="row-label">
          <span class="row-title">{{ t("settingsUi.readerFontSizeTitle") }}</span>
          <span class="row-note">{{ t("settingsUi.readerFontSizeNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.lineHeightNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.fontWeightNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.cardFontSizeNote") }}</span>
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
          <span class="row-note">{{ t("settingsUi.cardFontWeightNote") }}</span>
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
.latin-font-check {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
</style>
