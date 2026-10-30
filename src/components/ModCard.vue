<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry } from "../types";
import { fileUrl, toggleModEnabled } from "../api";
import { initials, sourceHint, sourceLabel, translateBackendMessage } from "../format";
import { customNameOf, displayTitle, isFavorite } from "../userData";
import { translatedTitleOf } from "../online/translation";

const props = defineProps<{
  mod: ModEntry;
  active: boolean;
  /** 排序模式下显示在卡片右上角的加载序号（1 起） */
  order?: number;
  /** 排序模式：卡片可拖拽（光标与边框变化） */
  sortable?: boolean;
  /** v0.4：服务端版本比本地新（右上角红底白字 [可更新]） */
  hasUpdate?: boolean;
}>();
const emit = defineEmits<{
  (event: "select", mod: ModEntry): void;
  /** 卡片快捷开关写入成功：只让父组件局部 patch 这条记录 */
  (event: "toggled", payload: { id: string; enabled: boolean }): void;
  /** 写入失败 / 未登记：由父组件统一弹 Toast */
  (event: "toggle-error", message: string): void;
}>();

const { t } = useI18n();

const imgFailed = ref(false);
const coverUrl = computed(() =>
  props.mod.thumbnail && !imgFailed.value ? fileUrl(props.mod.thumbnail) : null,
);

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
</script>

<template>
  <button
    class="mod-card"
    :class="{ active, sortable }"
    type="button"
    @click="emit('select', mod)"
  >
    <div class="card-thumb">
      <img v-if="coverUrl" :src="coverUrl" alt="" draggable="false" @error="imgFailed = true" />
      <div v-else class="placeholder">{{ initials(mod.displayName) }}</div>
      <span v-if="favorited" class="fav-badge" :title="t('favorites.badgeTitle')">⭐</span>
      <span v-if="!coverUrl" class="no-cover">{{ t("card.noCover") }}</span>
      <span v-if="order !== undefined" class="order-badge" :title="`#${order}`">{{ order }}</span>
      <span v-if="hasUpdate" class="update-badge" :title="t('card.updateBadgeHint')">
        {{ t("card.updateBadge") }}
      </span>
      <span class="source-badge" :class="mod.source" :title="sourceHint(mod.source)">
        {{ sourceLabel(mod.source) }}
      </span>
    </div>
    <div class="card-body">
      <div class="card-title" :title="title">{{ title }}</div>
      <div v-if="sub" class="card-sub" :title="mod.displayName">📝 {{ mod.displayName }}</div>
      <div class="card-meta status-row">
        <span
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
      </div>
      <div class="card-meta">
        <span>{{ mod.workshopId ? `#${mod.workshopId}` : t("card.noNumericId") }}</span>
        <span v-if="mod.author" class="author">{{ mod.author }}</span>
        <span v-else class="author missing">{{ t("card.authorMissing") }}</span>
      </div>
    </div>
  </button>
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
  background: linear-gradient(180deg, #8fbb6c, var(--ok));
  border-color: #b6d79b;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(120, 162, 92, 0.85), inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.card-toggle.on:hover {
  box-shadow: 0 0 12px rgba(140, 190, 110, 1), inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.card-toggle.off {
  background: linear-gradient(180deg, #554330, #3d2f22);
  border-color: #7a6449;
  color: #efe2cc;
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.card-toggle.off:hover {
  border-color: var(--gold-dim);
  color: var(--gold-bright);
}
.card-toggle.unknown {
  background: transparent;
  border-color: #6a5642;
  border-style: dashed;
  color: #6a5642;
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
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1.5;
  border-radius: 3px;
  border: 1px solid #f0d3c8;
  background: linear-gradient(180deg, #b4453b, #8f2f28);
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
  pointer-events: none;
}

/* 卡片左上角来源角标：羊皮纸底 + 金框（本工具）/ 蓝框（官方）/ 朴素灰（未知） */
.source-badge {
  position: absolute;
  top: 5px;
  left: 5px;
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 9px;
  letter-spacing: 0.4px;
  line-height: 1.5;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(8, 6, 4, 0.82);
  color: var(--muted);
  white-space: nowrap;
  pointer-events: none;
}
.source-badge.tool {
  border-color: rgba(201, 162, 77, 0.6);
  color: var(--gold-bright);
  background: rgba(43, 34, 22, 0.88);
}
.source-badge.official {
  border-color: rgba(120, 150, 190, 0.55);
  color: #9fc0e2;
  background: rgba(18, 24, 32, 0.88);
}
.source-badge.unknown {
  border-color: var(--line);
  color: var(--parch-dim);
  background: rgba(20, 16, 12, 0.88);
}
.card-meta .author {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta .author.missing {
  color: #6b5940;
  font-style: italic;
}
</style>
