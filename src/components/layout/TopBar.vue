<script setup lang="ts">
import { useI18n } from "vue-i18n";

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
}>();

const { t } = useI18n();
</script>

<template>
  <header class="topbar">
    <div class="brand">
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
