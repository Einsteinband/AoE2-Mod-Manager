<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ModEntry } from "../types";
import { fileUrl } from "../api";
import { initials, sourceHint, sourceLabel, statusLabel } from "../format";

const props = defineProps<{
  mod: ModEntry;
  active: boolean;
  /** 排序模式下显示在卡片右上角的加载序号（1 起） */
  order?: number;
  /** 排序模式：卡片可拖拽（光标与边框变化） */
  sortable?: boolean;
}>();
const emit = defineEmits<{ (event: "select", mod: ModEntry): void }>();

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
      <span v-if="!coverUrl" class="no-cover">{{ t("card.noCover") }}</span>
      <span v-if="order !== undefined" class="order-badge" :title="`#${order}`">{{ order }}</span>
      <span class="source-badge" :class="mod.source" :title="sourceHint(mod.source)">
        {{ sourceLabel(mod.source) }}
      </span>
    </div>
    <div class="card-body">
      <div class="card-title" :title="mod.displayName">{{ mod.displayName }}</div>
      <div class="card-meta status-row">
        <span class="status-chip" :class="statusClass" :title="statusLabel(mod.enabled)">
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
