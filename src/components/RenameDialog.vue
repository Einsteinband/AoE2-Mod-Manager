<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

/** 羊皮纸风格「设置备注名」弹窗：复用 style.css 的 .modal 系，不引入新 UI 框架 */
const props = defineProps<{
  /** 原英文标题（只做提示，不可编辑） */
  original: string;
  /** 现有备注名（null = 还没有） */
  initial: string | null;
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: "save", name: string): void;
  (e: "cancel"): void;
}>();

const { t } = useI18n();
const value = ref(props.initial ?? "");
const inputEl = ref<HTMLInputElement | null>(null);

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape" && !props.busy) emit("cancel");
}

onMounted(async () => {
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => window.removeEventListener("keydown", onKey));

function submit() {
  if (props.busy) return;
  emit("save", value.value);
}
</script>

<template>
  <div class="modal-backdrop" @click.self="busy ? null : emit('cancel')">
    <div class="modal rename-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>{{ t("favorites.dialogTitle") }}</h2>
        <button type="button" class="modal-x" :disabled="busy" @click="emit('cancel')">✕</button>
      </div>
      <div class="modal-body">
        <p class="note" style="margin: 0 0 2px">
          {{ t("favorites.dialogOriginal", { title: original }) }}
        </p>
        <input
          ref="inputEl"
          v-model="value"
          class="rename-input"
          type="text"
          maxlength="60"
          :placeholder="t('favorites.dialogPlaceholder')"
          :disabled="busy"
          @keydown.enter.prevent="submit"
        />
        <p class="note" style="margin: 4px 0 0">{{ t("favorites.dialogHint") }}</p>
        <div v-if="error" class="path-error">{{ error }}</div>
        <div class="rename-actions">
          <button type="button" :disabled="busy" @click="emit('cancel')">
            {{ t("favorites.cancel") }}
          </button>
          <button type="button" class="primary" :disabled="busy" @click="submit">
            {{ busy ? t("favorites.saving") : t("favorites.save") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
