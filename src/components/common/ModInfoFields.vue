<script setup lang="ts">
/**
 * 「更多信息」字段组：本地详情、在线详情、收藏详情共用**同一份**布局。
 *
 * 为什么抽成组件：三个详情面板原本各写一套，于是出现了
 *   本地 = 作者 / 发布时间 / 版本 / 订阅数 / 最后更新，未知值写「未知」
 *   在线 = 作者 / 发布时间 / 最后更新 / 版本 / 订阅数 / 评分，未知值写「未提供」
 * 字段顺序、标签、间距、缺失态各不相同。这里的字段顺序与在线详情一致，
 * 标签复用同一组 `online.*` 文案，缺失态统一为 `labels.notProvided`。
 *
 * 只负责排版与格式化：数据来源仍由各页面自己决定（本地扫描 / 在线接口 / 收藏快照）。
 * `.field / .k / .v / .missing` 全部来自 style.css 的公共详情样式，组件不另写视觉。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    /** 作者 */
    author?: string | null;
    /** 发布时间（已格式化；null / 空串 = 官方未提供） */
    createdText?: string | null;
    /** 最后更新时间（已格式化） */
    updatedText?: string | null;
    /** 版本号 */
    versionText?: string | null;
    /** 版本缺失（调用方可能传入本地化「未提供」文案，需要显式标注缺失态） */
    versionMissing?: boolean;
    /** 订阅数 */
    installs?: number | null;
    /** 订阅数被服务端截断 */
    installsTruncated?: boolean;
    /** 评分；undefined = 该来源没有评分字段，不渲染这一行 */
    ratingText?: string | null;
    ratingMissing?: boolean;
  }>(),
  {
    author: null,
    createdText: null,
    updatedText: null,
    versionText: null,
    versionMissing: false,
    installs: null,
    installsTruncated: false,
    ratingText: undefined,
    ratingMissing: false,
  },
);

const { t } = useI18n();

function blank(value: string | null | undefined): boolean {
  return !value || !value.trim();
}

const authorText = computed(() => (blank(props.author) ? t("labels.notProvided") : props.author!.trim()));
const createdValue = computed(() => (blank(props.createdText) ? t("labels.notProvided") : props.createdText!));
const updatedValue = computed(() => (blank(props.updatedText) ? t("labels.notProvided") : props.updatedText!));
const versionValue = computed(() =>
  props.versionMissing || blank(props.versionText) ? t("labels.notProvided") : props.versionText!,
);
const installsValue = computed(() =>
  props.installs === null || props.installs === undefined
    ? t("labels.notProvided")
    : `${props.installs}${props.installsTruncated ? t("online.installsTruncated") : ""}`,
);
const showRating = computed(() => props.ratingText !== undefined);
const ratingValue = computed(() =>
  props.ratingMissing || blank(props.ratingText) ? t("labels.notProvided") : props.ratingText!,
);
</script>

<template>
  <div class="field">
    <span class="k">{{ t("online.author") }}</span>
    <span class="v" :class="{ missing: blank(author) }">{{ authorText }}</span>
  </div>
  <div class="field">
    <span class="k">{{ t("online.created") }}</span>
    <span class="v" :class="{ missing: blank(createdText) }">{{ createdValue }}</span>
  </div>
  <div class="field">
    <span class="k">{{ t("online.updated") }}</span>
    <span class="v" :class="{ missing: blank(updatedText) }">{{ updatedValue }}</span>
  </div>
  <div class="field">
    <span class="k">{{ t("online.version") }}</span>
    <span class="v" :class="{ missing: versionMissing || blank(versionText) }">{{ versionValue }}</span>
  </div>
  <div class="field">
    <span class="k">{{ t("online.installs") }}</span>
    <span class="v" :class="{ missing: installs === null || installs === undefined }">{{ installsValue }}</span>
  </div>
  <div v-if="showRating" class="field">
    <span class="k">{{ t("online.rating") }}</span>
    <span class="v" :class="{ missing: ratingMissing }">{{ ratingValue }}</span>
  </div>
</template>
