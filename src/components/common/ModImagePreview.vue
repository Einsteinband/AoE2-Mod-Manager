<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  url: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
}>();

const { t } = useI18n();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.16;

const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const dragging = ref(false);

let dragStart: { pointerX: number; pointerY: number; panX: number; panY: number } | null = null;

const imageStyle = computed(() => ({
  transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${zoom.value})`,
}));

function closePreview(): void {
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closePreview();
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function zoomAtCenter(event: WheelEvent): void {
  const currentZoom = zoom.value;
  const nextZoom = clampZoom(
    currentZoom * (event.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP)),
  );
  if (nextZoom === currentZoom) return;

  const centerRatio = nextZoom / currentZoom;
  panX.value *= centerRatio;
  panY.value *= centerRatio;
  zoom.value = nextZoom;
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging.value = true;
  dragStart = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    panX: panX.value,
    panY: panY.value,
  };
  event.preventDefault();
}

function moveDrag(event: PointerEvent): void {
  if (!dragging.value || !dragStart) return;
  panX.value = dragStart.panX + (event.clientX - dragStart.pointerX);
  panY.value = dragStart.panY + (event.clientY - dragStart.pointerY);
}

function endDrag(): void {
  dragging.value = false;
  dragStart = null;
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointermove", moveDrag);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
});
</script>

<template>
  <div
    class="modal-backdrop image-preview"
    role="dialog"
    aria-modal="true"
    :aria-label="t('detail.imagePreviewOpen')"
    @wheel.prevent="zoomAtCenter"
    @click.self="closePreview"
  >
    <button
      type="button"
      class="modal-x image-preview-close"
      :aria-label="t('detail.imagePreviewClose')"
      @click.stop="closePreview"
    >
      ✕
    </button>

    <img
      class="image-preview-image"
      :class="{ 'is-dragging': dragging }"
      :src="props.url"
      :aria-label="t('detail.imagePreviewOpen')"
      :style="imageStyle"
      draggable="false"
      @pointerdown="startDrag"
      @dragstart.prevent
      @click.stop
    />

    <p class="image-preview-hint">{{ t("detail.imagePreviewHint") }}</p>
  </div>
</template>

<style scoped>
.image-preview {
  z-index: 60;
  padding: 24px;
}

.image-preview-close {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
}

.image-preview-image {
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  object-fit: contain;
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  transform-origin: center center;
  cursor: grab;
  user-select: none;
  transition: transform 0.12s ease-out;
}

.image-preview-image.is-dragging {
  cursor: grabbing;
  transition: none;
}

.image-preview-hint {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  pointer-events: none;
  color: var(--muted);
  font-size: calc(11px * var(--global-scale));
  letter-spacing: calc(0.3px * var(--ui-tracking));
  white-space: nowrap;
}
</style>
