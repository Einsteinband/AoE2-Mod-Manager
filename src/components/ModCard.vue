<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry } from "../types";
import { fileUrl, toggleModEnabled } from "../api";
import { sourceHint, sourceLabel, translateBackendMessage, formatDateTime } from "../format";
import { customNameOf, displayTitle, isFavorite } from "../userData";
import { translatedTitleOf } from "../online/translation";
import BaseModCard from "./base/BaseModCard.vue";

const props = defineProps<{
  mod: ModEntry;
  active: boolean;
  /** 排序模式下显示在卡片右上角的加载序号（1 起） */
  order?: number;
  /** 排序模式：卡片可拖拽（光标与边框变化） */
  sortable?: boolean;
  /** v0.4：服务端版本比本地新（右上角红底白字 [可更新]） */
  hasUpdate?: boolean;
  /** 同一模组在 local 与 subscribed 各有一份（账号仍订阅），左上角红色角标 */
  conflict?: boolean;
  /** v0.7：可更新视图中显示选择复选框 */
  selectable?: boolean;
  /** v0.7：复选框是否勾选 */
  selected?: boolean;
  /** v0.7：该模组正在更新中（禁用复选框和更新按钮） */
  updating?: boolean;
}>();
const emit = defineEmits<{
  (event: "select", mod: ModEntry): void;
  /** 卡片快捷开关写入成功：只让父组件局部 patch 这条记录 */
  (event: "toggled", payload: { id: string; enabled: boolean }): void;
  /** 写入失败 / 未登记：由父组件统一弹 Toast */
  (event: "toggle-error", message: string): void;
  /** 数据模组的启用请求：互斥裁决在父组件，卡片自己不动磁盘 */
  (event: "request-enable", payload: { id: string }): void;
  /** v0.7：勾选/取消勾选（可更新视图） */
  (event: "check", payload: { id: string; checked: boolean }): void;
  /** v0.7：单个更新按钮 */
  (event: "update", mod: ModEntry): void;
  /** 右键 / 键盘菜单键：把卡片与原始事件交给页面装配层打开上下文菜单（不改选中态） */
  (event: "context-menu", mod: ModEntry, menuEvent: MouseEvent | KeyboardEvent): void;
}>();

const { t } = useI18n();

const imgFailed = ref(false);
/** 占位条目走 coverUrl（图片缓存 asset URL）；真实条目仍走磁盘路径 thumbnail */
const coverUrl = computed(() => {
  if (imgFailed.value) return null;
  if (props.mod.coverUrl) return props.mod.coverUrl;
  return props.mod.thumbnail ? fileUrl(props.mod.thumbnail) : null;
});
/** 未安装收藏占位：适配本地卡片形状，但不显示本地来源角标与启停开关 */
const uninstalled = computed(() => props.mod.uninstalled === true);
/** 真实磁盘条目视为本机已安装；ghost 占位不进入已安装视觉状态 */
const installed = computed(() => !uninstalled.value);

/** 本地封面解码 / 路径失效：回落到占位块，避免停在坏图状态 */
function onImageError() {
  imgFailed.value = true;
}

watch(
  () => props.mod.id,
  () => {
    imgFailed.value = false;
  },
);

const statusClass = computed(() => {
  if (props.mod.enabled === true) return "on";
  if (props.mod.enabled === false) return "off";
  return "unknown";
});

// ---------------- v0.9：卡片快捷开关（替代原来的纯状态圆点） ----------------

/** 写入中：禁止重复点击，按钮降透明度 */
const toggling = ref(false);
/** 游戏是否已登记（enabled === null = mod-status.json 里没有这条记录） */
const registered = computed(() => props.mod.enabled !== null);

const toggleTitle = computed(() => {
  if (toggling.value) return t("card.toggleWorking");
  if (props.mod.enabled === null) return t("card.notRegisteredHint");
  return props.mod.enabled ? t("card.toggleDisable") : t("card.toggleEnable");
});

function errorMessage(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return t("labels.unknown");
  }
}

/**
 * 点击开关：阻断冒泡（不打开详情页）→ 调 toggle_mod_enabled → 通知父组件局部 patch。
 * 只写这一条记录，不触发全量重扫描，列表不闪、滚动条不跳。
 */
async function toggleEnabled(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (toggling.value) return;
  if (!registered.value) {
    emit("toggle-error", t("card.notRegisteredHint"));
    return;
  }
  const target = props.mod.enabled !== true;
  // 数据模组：游戏同一时间只能加载一个，启用前必须交给父组件做互斥裁决
  if (target && props.mod.isDataMod) {
    emit("request-enable", { id: props.mod.id });
    return;
  }
  toggling.value = true;
  try {
    const result = await toggleModEnabled(
      props.mod.workshopId,
      props.mod.kind,
      props.mod.folderName,
      target,
    );
    emit("toggled", { id: props.mod.id, enabled: result.enabled });
  } catch (e) {
    emit("toggle-error", errorMessage(e));
  } finally {
    toggling.value = false;
  }
}

// ---------------- 右键上下文菜单（目标快照由页面层持有，卡片不改变选中态） ----------------

function onContextMenu(menuEvent: MouseEvent): void {
  menuEvent.preventDefault();
  emit("context-menu", props.mod, menuEvent);
}

function onMenuKeydown(menuEvent: KeyboardEvent): void {
  // Shift+F10 或键盘菜单键：与右键等价，交给页面层定位落点
  if (menuEvent.key === "ContextMenu" || (menuEvent.shiftKey && menuEvent.key === "F10")) {
    menuEvent.preventDefault();
    emit("context-menu", props.mod, menuEvent);
  }
}

// v0.5：有备注名时主标题用备注名，副标题小字回显原英文标题
// v0.2.4：没备注名时，已翻译的模组直接显示中文标题（跟详情页的「显示原文/中文」开关联动）
const custom = computed(() => customNameOf(props.mod.workshopId));
const translated = computed(() => translatedTitleOf(props.mod.workshopId));
const title = computed(() =>
  displayTitle(props.mod.workshopId, translated.value ?? props.mod.displayName),
);
/** 副标题只服务于备注名（📝）；译文不再叠英文原名 */
const sub = computed(() => (custom.value ? props.mod.displayName : null));
const favorited = computed(() => isFavorite(props.mod.workshopId));

/** 安装时间：只有 metadata 记录了真实安装时间才显示；旧模组为 null 时不伪造 */
const installedAtText = computed(() => {
  const ms = props.mod.installedAtMs;
  if (!ms || ms <= 0) return null;
  return t("card.installedAt", { date: formatDateTime(ms) });
});
</script>

<template>
  <BaseModCard
    :title="title"
    :sub="sub"
    :cover-url="coverUrl"
    :fallback-text="mod.displayName.slice(0, 2)"
    :favorited="favorited"
    :workshop-id="mod.workshopId"
    :author="mod.author"
    :installed="installed"
    :active="active"
    @click="emit('select', mod)"
    @img-error="onImageError"
    @contextmenu="onContextMenu"
    @keydown="onMenuKeydown"
  >
    <!-- 角标 slot：排序序号、可更新红标、来源角标等 -->
    <template #badges>
      <span v-if="order !== undefined" class="order-badge" :title="`#${order}`">{{ order }}</span>
      <span v-if="hasUpdate" class="update-badge" :title="t('card.updateBadgeHint')">
        {{ t("card.updateBadge") }}
      </span>
      <input
        v-if="selectable"
        type="checkbox"
        class="card-select"
        :checked="selected"
        :disabled="updating"
        @click.stop
        @change="emit('check', { id: mod.id, checked: ($event.target as HTMLInputElement).checked })"
      />
      <div class="thumb-badges">
        <span v-if="conflict" class="conflict-badge" :title="t('subscription.conflictBadgeHint')">
          {{ t("subscription.conflictBadge") }}
        </span>
        <span
          v-if="!uninstalled"
          class="source-badge"
          :class="mod.source"
          :title="sourceHint(mod.source)"
        >
          {{ sourceLabel(mod.source) }}
        </span>
        <span v-if="mod.isDataMod" class="data-badge" :title="t('card.dataModBadgeHint')">
          {{ t("card.dataModBadge") }}
        </span>
      </div>
    </template>

    <!-- 第一行 meta：启用/禁用开关 + 数据模组标记 -->
    <template #meta-top>
      <span v-if="mod.isDataMod" class="data-mark" :title="t('card.dataModBadgeHint')">⚙️</span>
      <span
        v-if="!uninstalled"
        class="card-toggle"
        :class="[statusClass, { busy: toggling }]"
        role="switch"
        :aria-checked="mod.enabled === true"
        :aria-busy="toggling"
        :title="toggleTitle"
        @click="toggleEnabled"
      >
        <svg v-if="statusClass === 'on'" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.4 4.8 8.6 9.5 3.4" />
        </svg>
        <svg v-else-if="statusClass === 'off'" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.2 6h5.6" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="3.9" />
        </svg>
      </span>
      <button
        v-if="hasUpdate && selectable"
        type="button"
        class="card-update-btn"
        :disabled="updating"
        @click.stop="emit('update', mod)"
      >
        {{ updating ? t("updates.updating") : t("updates.updateBtn") }}
      </button>
      <span v-if="installedAtText" class="card-installed-time">{{ installedAtText }}</span>
    </template>
  </BaseModCard>
</template>

<style scoped>
/* v0.9：卡片右下角快捷开关（沿用原有状态配色：绿勾 / 灰杠 / 虚线未知） */
.card-toggle {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid transparent;
  cursor: pointer;
  transition: box-shadow 0.15s ease, background 0.15s ease, transform 0.12s ease;
}
.card-toggle svg {
  width: 12px;
  height: 12px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.card-toggle:hover {
  transform: scale(1.14);
}
.card-toggle.on {
  background: var(--ok);
  border-color: var(--ok-border-bright);
  color: var(--text-inverse);
  box-shadow: 0 0 8px rgba(var(--ok-rgb), 0.85), inset 0 0 0 1px rgba(var(--sheen-rgb), 0.25);
}
.card-toggle.on:hover {
  box-shadow: 0 0 12px rgba(var(--ok-glow-rgb), 1), inset 0 0 0 1px rgba(var(--sheen-rgb), 0.35);
}
.card-toggle.off {
  background: var(--panel-hi);
  border-color: var(--switch-off-border);
  color: var(--switch-off-text);
  box-shadow: 0 0 6px rgba(var(--shadow-rgb), 0.5), inset 0 0 0 1px rgba(var(--sheen-rgb), 0.08);
}
.card-toggle.off:hover {
  border-color: var(--gold-dim);
  color: var(--gold-bright);
}
.card-toggle.unknown {
  background: var(--panel-lo);
  border-color: var(--border-strong);
  border-style: dashed;
  color: var(--border-strong);
}
.card-toggle.unknown:hover {
  border-color: var(--gold-dim);
  color: var(--gold-dim);
}
.card-toggle.busy {
  opacity: 0.5;
  cursor: progress;
  transform: none;
}

/* v0.4：右上角「可更新」角标。排序模式的序号在左上，两者互不遮挡 */
.update-badge {
  position: absolute;
  top: 5px;
  right: 5px;
  padding: 1px 6px;
  font-size: calc(var(--card-font-size) * 0.8);
  font-weight: var(--card-font-weight);
  letter-spacing: calc(0.5px * var(--ui-tracking));
  line-height: 1.5;
  border-radius: 3px;
  border: 1px solid var(--danger-text-strong);
  background: var(--danger-strong);
  color: var(--text-inverse);
  text-shadow: 0 1px 1px rgba(var(--shadow-rgb), 0.45);
  box-shadow: 0 1px 4px rgba(var(--shadow-rgb), 0.5);
  white-space: nowrap;
  pointer-events: none;
}

/* 左上角角标容器：来源角标 + 数据模组角标竖排，互不遮挡 */
.thumb-badges {
  position: absolute;
  top: 5px;
  left: 5px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  pointer-events: none;
}

/* 卡片左上角来源角标 */
.source-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: calc(var(--card-font-size) * 0.75);
  letter-spacing: calc(0.4px * var(--ui-tracking));
  line-height: 1.5;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel-hi);
  color: var(--muted);
  white-space: nowrap;
  pointer-events: none;
}
.source-badge.tool {
  border-color: rgba(var(--accent-rgb), 0.6);
  color: var(--gold-bright);
  background: var(--panel-hi);
}
.source-badge.official {
  border-color: rgba(var(--info-rgb), 0.55);
  color: var(--info-text);
  background: var(--panel-hi);
}
.source-badge.unknown {
  border-color: var(--line);
  color: var(--parch-dim);
  background: var(--panel-hi);
}

/* 数据模组角标 */
.data-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: calc(var(--card-font-size) * 0.75);
  letter-spacing: calc(0.4px * var(--ui-tracking));
  line-height: 1.5;
  border-radius: 999px;
  border: 1px solid rgba(var(--accent-rgb), 0.75);
  background: var(--panel-hi);
  color: var(--gold-bright);
  white-space: nowrap;
  pointer-events: none;
}

/* 列表模式缩略图太小，改用状态行前的齿轮小图标 */
.data-mark {
  display: none;
  font-size: calc(var(--card-font-size) * 0.8);
  line-height: 1;
  pointer-events: none;
}
.card-grid.list-mode .data-mark {
  display: inline;
}

/* v0.7：可更新视图中的选择复选框（左上角，与来源角标错开） */
.card-select {
  position: absolute;
  top: 5px;
  left: 50%;
  transform: translateX(-50%);
  width: 16px;
  height: 16px;
  cursor: pointer;
  z-index: 2;
  accent-color: var(--gold-bright);
}

/* v0.7：卡片上的单个更新按钮 */
.card-update-btn {
  margin-left: auto;
  padding: 2px 8px;
  font-size: calc(var(--card-font-size) * 0.75);
  line-height: 1.5;
  border-radius: 3px;
  border: 1px solid var(--danger-text-strong);
  background: var(--danger-strong);
  color: var(--text-inverse);
  cursor: pointer;
  white-space: nowrap;
}

.card-installed-time {
  color: var(--text-dim);
  font-size: calc(var(--card-font-size) * 0.82);
  line-height: 1.5;
  white-space: nowrap;
}
.card-update-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}
</style>
