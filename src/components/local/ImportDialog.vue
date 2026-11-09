<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { analyzeLocalZip, installLocalZip, cancelImportTask, type AnalyzeResult } from "../../api";
import { useToast } from "../../composables/useToast";
import { normalizeError } from "../../format";

const props = defineProps<{
  modelValue: boolean;
  zipPath: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [v: boolean];
  installed: [];
}>();

const { t } = useI18n();
const { showToast } = useToast();

const analyzing = ref(false);
const installing = ref(false);
const result = ref<AnalyzeResult | null>(null);
const error = ref<string | null>(null);
const forceConfirm = ref(false);
const currentTaskId = ref<string | null>(null);

watch(
  () => props.zipPath,
  async (path) => {
    if (!path || !props.modelValue) return;
    await runAnalyze(path);
  },
);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      if (currentTaskId.value && !installing.value) {
        cancelImportTask(currentTaskId.value).catch(() => {});
      }
      reset();
    }
  },
);

function reset() {
  analyzing.value = false;
  installing.value = false;
  result.value = null;
  error.value = null;
  forceConfirm.value = false;
  currentTaskId.value = null;
}

async function runAnalyze(path: string) {
  analyzing.value = true;
  error.value = null;
  result.value = null;
  try {
    const r = await analyzeLocalZip(path);
    result.value = r;
    currentTaskId.value = r.taskId;
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    analyzing.value = false;
  }
}

async function doInstall() {
  if (!result.value) return;
  installing.value = true;
  try {
    const r = await installLocalZip(result.value.taskId, forceConfirm.value);
    const parts: string[] = [];
    parts.push(t("import.success", { name: r.folderName }));
    if (r.backupPath) parts.push(t("import.backupCreated"));
    if (r.warnings.length) {
      for (const w of r.warnings) parts.push(`⚠ ${w}`);
    }
    showToast(parts.join("\n"), r.warnings.length ? "ok" : "ok");
    emit("installed");
    close();
  } catch (e) {
    showToast(normalizeError(e), "error");
  } finally {
    installing.value = false;
  }
}

function close() {
  emit("update:modelValue", false);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="import-overlay" @click.self="close">
      <div class="import-dialog">
        <div class="import-header">
          <h3>{{ t("import.title") }}</h3>
          <button class="import-close" @click="close" aria-label="Close">✕</button>
        </div>

        <div class="import-body">
          <div v-if="analyzing" class="import-state">
            <span class="spinner"></span>
            <p>{{ t("import.analyzing") }}</p>
          </div>

          <div v-else-if="error" class="import-error">
            <p>{{ error }}</p>
            <button class="btn-secondary" @click="close">{{ t("common.close") }}</button>
          </div>

          <div v-else-if="result" class="import-preview">
            <div class="preview-row">
              <label>{{ t("import.fieldTitle") }}</label>
              <span>{{ result.title }}</span>
            </div>
            <div class="preview-row">
              <label>{{ t("import.fieldAuthor") }}</label>
              <span>{{ result.author || "—" }}</span>
            </div>
            <div class="preview-row">
              <label>{{ t("import.fieldFolder") }}</label>
              <span class="mono">{{ result.targetFolder }}</span>
            </div>
            <div class="preview-row">
              <label>{{ t("import.fieldSize") }}</label>
              <span>{{ result.fileCount }} files · {{ formatBytes(result.bytes) }}</span>
            </div>
            <div v-if="result.description" class="preview-desc">
              <label>{{ t("import.fieldDesc") }}</label>
              <p>{{ result.description }}</p>
            </div>
            <div v-if="result.fixes.length" class="preview-fixes">
              <label>{{ t("import.fixesApplied") }}</label>
              <ul>
                <li v-for="(f, i) in result.fixes" :key="i">{{ f }}</li>
              </ul>
            </div>
            <div v-if="result.exists" class="preview-conflict">
              <p>⚠ {{ t("import.conflictWarning") }}</p>
              <label class="force-label">
                <input v-model="forceConfirm" type="checkbox" />
                {{ t("import.forceOverwrite") }}
              </label>
            </div>
          </div>
        </div>

        <div class="import-footer">
          <button class="btn-secondary" @click="close">{{ t("common.cancel") }}</button>
          <button
            v-if="result"
            class="btn-primary"
            :disabled="installing || (result.exists && !forceConfirm)"
            @click="doInstall"
          >
            {{ installing ? t("import.installing") : t("import.install") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.import-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.import-dialog {
  background: var(--card-bg, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.import-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #333);
}
.import-header h3 { margin: 0; font-size: 16px; }
.import-close {
  background: none; border: none; color: var(--text-dim, #888);
  cursor: pointer; font-size: 16px;
}
.import-body { padding: 20px; overflow-y: auto; flex: 1; }
.import-state { text-align: center; padding: 40px 0; }
.import-error { color: #f66; text-align: center; padding: 20px 0; }
.preview-row {
  display: flex; justify-content: space-between; padding: 6px 0;
  border-bottom: 1px solid var(--border-color, #2a2a3a);
}
.preview-row label { color: var(--text-dim, #888); font-size: 13px; }
.preview-row span { font-size: 14px; }
.mono { font-family: monospace; }
.preview-desc { margin-top: 12px; }
.preview-desc label, .preview-fixes label {
  display: block; color: var(--text-dim, #888); font-size: 13px; margin-bottom: 4px;
}
.preview-desc p { margin: 0; font-size: 13px; line-height: 1.5; }
.preview-fixes { margin-top: 12px; }
.preview-fixes ul { margin: 0; padding-left: 20px; font-size: 13px; }
.preview-conflict {
  margin-top: 16px; padding: 12px;
  background: rgba(255, 180, 0, 0.1); border-radius: 8px;
}
.preview-conflict p { margin: 0 0 8px; font-size: 13px; }
.force-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.import-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 20px; border-top: 1px solid var(--border-color, #333);
}
.btn-primary {
  background: var(--accent, #c9a84c); color: #1a1a2e;
  border: none; padding: 8px 20px; border-radius: 6px;
  cursor: pointer; font-weight: 600;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: transparent; color: var(--text-dim, #888);
  border: 1px solid var(--border-color, #444); padding: 8px 16px;
  border-radius: 6px; cursor: pointer;
}
.spinner {
  display: inline-block; width: 20px; height: 20px;
  border: 2px solid var(--border-color, #444);
  border-top-color: var(--accent, #c9a84c);
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
