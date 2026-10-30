<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";

/** 羊皮纸风格二次确认框：复用 style.css 的 .modal 系（position: fixed 浮层） */
const props = defineProps<{
  title: string;
  message: string;
  detail?: string | null;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** false = 用金色主按钮（“全部启用”这类非破坏性操作）；默认 true = 红色危险按钮 */
  danger?: boolean;
}>();

const emit = defineEmits<{ (e: "confirm"): void; (e: "cancel"): void }>();

const { t } = useI18n();

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || props.busy) return;
  emit("cancel");
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-backdrop" @click.self="busy ? null : emit('cancel')">
    <div class="modal confirm-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>{{ title }}</h2>
        <span class="modal-sub">{{ t("confirm.diskWarning") }}</span>
        <button type="button" class="modal-x" :disabled="busy" @click="emit('cancel')">✕</button>
      </div>
      <div class="modal-body">
        <p class="confirm-text">{{ message }}</p>
        <p v-if="detail" class="confirm-detail mono">{{ detail }}</p>
        <div v-if="error" class="path-error">{{ error }}</div>
        <div class="confirm-actions">
          <button type="button" :disabled="busy" @click="emit('cancel')">{{ t("confirm.cancel") }}</button>
          <button
            type="button"
            :class="danger === false ? 'primary' : 'danger'"
            :disabled="busy"
            @click="emit('confirm')"
          >
            {{ busy ? t("confirm.working") : (confirmLabel ?? t("confirm.defaultConfirm")) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
