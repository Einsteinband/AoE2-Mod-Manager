<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineMod } from "../online/types";
import { customNameOf, displayTitle, isFavorite } from "../userData";
import { translatedTitleOf } from "../online/translation";
import BaseModCard from "./base/BaseModCard.vue";

const props = defineProps<{
  mod: OnlineMod;
  active: boolean;
  thumb?: string | null;
  /**
   * 本机磁盘事实：来自统一安装索引 installed.localIndex[modId]。
   * 与服务端订阅标记 userInstalled 区分；页面装配层负责取值，卡片不另建判断。
   */
  installed?: boolean;
}>();
const emit = defineEmits<{
  (event: "select", mod: OnlineMod): void;
  /** 右键 / 键盘菜单键：把卡片与原始事件交给页面装配层打开上下文菜单（不改选中态） */
  (event: "context-menu", mod: OnlineMod, menuEvent: MouseEvent | KeyboardEvent): void;
}>();

const { t } = useI18n();

/** 图片失败阶段：0=还没试本地封面，1=本地坏了试网络，2=都坏了 */
const triedLocal = ref(false);
const failed = ref(false);

watch(
  () => [props.mod.modId, props.thumb] as const,
  () => {
    triedLocal.value = false;
    failed.value = false;
  },
);

/** 本地封面（asset: 协议）优先，其次官网 CDN；两者都失败才显示占位字 */
const src = computed<string | null>(() => {
  if (failed.value) return null;
  const local = props.thumb ?? null;
  if (local && !triedLocal.value) return local;
  return props.mod.thumbnail ?? null;
});

function onImageError() {
  if (props.thumb && !triedLocal.value) {
    triedLocal.value = true;
    return;
  }
  failed.value = true;
}

// v0.5：备注名优先做主标题，副标题小字回显官方标题
// v0.2.4：没备注名时，手动翻译过的模组优先显示中文标题（未翻译就原样显示，绝不自动请求）
const custom = computed(() => customNameOf(props.mod.modId));
const translated = computed(() => translatedTitleOf(props.mod.modId));
/** 标题优先级：备注名 > 中文译文 > 官方原标题 */
const title = computed(() => displayTitle(props.mod.modId, translated.value ?? props.mod.title));
/** 副标题只服务于备注名（📝）；译文不再叠英文原名 */
const sub = computed(() => (custom.value ? props.mod.title : null));
const favorited = computed(() => isFavorite(props.mod.modId));

function formatCount(n: number | null): string {
  if (n === null) return t("labels.unknown");
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

// ---------------- 右键上下文菜单（目标快照由页面层持有，卡片不改变选中态） ----------------

function onContextMenu(menuEvent: MouseEvent): void {
  menuEvent.preventDefault();
  emit("context-menu", props.mod, menuEvent);
}

function onMenuKeydown(menuEvent: KeyboardEvent): void {
  if (menuEvent.key === "ContextMenu" || (menuEvent.shiftKey && menuEvent.key === "F10")) {
    menuEvent.preventDefault();
    emit("context-menu", props.mod, menuEvent);
  }
}
</script>

<template>
  <BaseModCard
    :title="title"
    :sub="sub"
    :cover-url="src"
    :fallback-text="mod.title.slice(0, 2)"
    :favorited="favorited"
    :workshop-id="mod.modId"
    :author="mod.creator"
    :installed="installed === true"
    :active="active"
    @click="emit('select', mod)"
    @img-error="onImageError"
    @contextmenu="onContextMenu"
    @keydown="onMenuKeydown"
  >
    <!-- 封面右上角：本机已安装角标（磁盘事实，低视觉权重，不占卡片正文行高） -->
    <template #badges>
      <span v-if="installed === true" class="badge installed installed-badge">{{ t("online.cardInstalled") }}</span>
    </template>
    <!-- 第一行 meta：在线状态徽章 + 安装数 -->
    <template #meta-top>
      <span v-if="mod.updateAvailable" class="badge warn">{{ t("online.cardUpdate") }}</span>
      <span v-else-if="mod.userInstalled" class="badge sub">{{ t("online.cardSubscribed") }}</span>
      <span>
        {{ t("online.cardInstalls", { n: formatCount(mod.installs) + (mod.installsTruncated ? "+" : "") }) }}
      </span>
    </template>
  </BaseModCard>
</template>

<style scoped>
/* 在线卡片的状态徽章样式 */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: calc(var(--card-font-size) * 0.75);
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel-hi);
  color: var(--muted);
  white-space: nowrap;
}
.badge.warn {
  border-color: var(--danger-border);
  color: var(--danger-text);
  background: var(--danger-surface-top);
}
.badge.sub {
  border-color: rgba(var(--info-rgb), 0.45);
  color: var(--info-text);
  background: var(--panel-hi);
}
.badge.installed {
  border-color: var(--ok-border);
  color: var(--ok-text);
  background: var(--ok-surface-top);
}
.installed-badge {
  position: absolute;
  top: 5px;
  right: 5px;
  letter-spacing: calc(0.5px * var(--ui-tracking));
  white-space: nowrap;
  pointer-events: none;
}
</style>
