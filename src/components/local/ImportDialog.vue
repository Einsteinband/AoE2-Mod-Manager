<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { analyzeLocalZip, installLocalZip, cancelImportTask, type AnalyzeResult } from "../../api";
import { useToast } from "../../composables/useToast";
import { normalizeBackendError } from "../../format";

const props = defineProps<{
  modelValue: boolean;
  zipPath: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [v: boolean];
  installed: [result: { folderName: string; targetPath: string; warnings: string[] }];
}>();

const { t } = useI18n();
const { showToast } = useToast();

const analyzing = ref(false);
const installing = ref(false);
const result = ref<AnalyzeResult | null>(null);
const error = ref<string | null>(null);
const forceConfirm = ref(false);
const currentTaskId = ref<string | null>(null);
/** 是否停留在「安装风险提醒」确认层（每次点安装都重新进入，不可永久关闭） */
const riskAsked = ref(false);

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
    } else if (props.zipPath) {
      // 重开弹窗时 zipPath 没变，watch(zipPath) 不触发，这里手动重跑分析
      runAnalyze(props.zipPath);
    }
  },
);

function reset() {
  analyzing.value = false;
  installing.value = false;
  result.value = null;
  error.value = null;
  forceConfirm.value = false;
  riskAsked.value = false;
  currentTaskId.value = null;
}

/** 预览层「安装」→ 先进入风险提醒层，不直接执行安装 */
function openRiskConfirm() {
  if (!result.value || installing.value) return;
  riskAsked.value = true;
}

/** 风险层取消：回到预览，不执行安装 */
function backToPreview() {
  riskAsked.value = false;
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
    const msg = normalizeBackendError(e);
    error.value = msg;
    // 同时弹全局错误 Toast，避免用户误以为还在加载
    showToast(msg, "error");
  } finally {
    analyzing.value = false;
  }
}

async function doInstall() {
  if (!result.value) return;
  installing.value = true;
  try {
    const r = await installLocalZip(result.value.taskId, forceConfirm.value);
    // 把安装结果传给父组件，由父组件显示 Toast（避免弹窗关闭后 Toast 消失）
    emit("installed", {
      folderName: r.folderName,
      targetPath: result.value.targetPath,
      warnings: r.warnings,
    });
    close();
  } catch (e) {
    showToast(normalizeBackendError(e), "error");
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
          <button class="import-close" @click="close" :aria-label="t('common.close')">✕</button>
        </div>

        <div class="import-body">
          <!-- 功能说明：常驻展示当前真实支持范围，不宣传未实现能力 -->
          <div class="import-notice">
            <p class="import-notice-title">{{ t("import.noticeTitle") }}</p>
            <p class="import-notice-body">{{ t("import.noticeBody") }}</p>
          </div>

          <div v-if="analyzing" class="import-state">
            <span class="spinner"></span>
            <p>{{ t("import.analyzing") }}</p>
          </div>

          <div v-else-if="error" class="import-error">
            <p>{{ error }}</p>
            <button class="btn-secondary" @click="close">{{ t("common.close") }}</button>
          </div>

          <div v-else-if="result && riskAsked" class="import-risk">
            <p class="import-risk-title">{{ t("import.riskTitle") }}</p>
            <p class="import-risk-intro">{{ t("import.riskIntro") }}</p>
            <ul class="import-risk-list">
              <li>{{ t("import.riskPoint1") }}</li>
              <li>{{ t("import.riskPoint2") }}</li>
              <li>{{ t("import.riskPoint3") }}</li>
              <li>{{ t("import.riskPoint4") }}</li>
            </ul>
            <p class="import-risk-concl">{{ t("import.riskConcl1") }}</p>
            <p class="import-risk-concl">{{ t("import.riskConcl2") }}</p>
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
              <label>{{ t("import.fieldTargetPath") }}</label>
              <span class="mono" :title="result.targetPath">{{ result.targetPath }}</span>
            </div>
            <div class="preview-row">
              <label>{{ t("import.fieldSize") }}</label>
              <span>{{ t("import.fileCount", { num: result.fileCount }) }} · {{ formatBytes(result.bytes) }}</span>
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
          <template v-if="result && riskAsked">
            <button class="btn-secondary" @click="backToPreview">{{ t("confirm.cancel") }}</button>
            <button
              class="btn-primary"
              :disabled="installing"
              @click="doInstall"
            >
              {{ installing ? t("import.installing") : t("import.riskConfirm") }}
            </button>
          </template>
          <template v-else>
            <button class="btn-secondary" @click="close">{{ t("confirm.cancel") }}</button>
            <button
              v-if="result"
              class="btn-primary"
              :disabled="installing || (result.exists && !forceConfirm)"
              @click="openRiskConfirm"
            >
              {{ installing ? t("import.installing") : t("import.install") }}
            </button>
          </template>
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
  background: var(--bg-panel-hi);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-main);
}
.import-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}
.import-header h3 { margin: 0; font-size: 16px; color: var(--text-bright); }
.import-close {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 16px;
}
.import-body { padding: 20px; overflow-y: auto; flex: 1; }
.import-state { text-align: center; padding: 40px 0; color: var(--text-soft); }
.import-error { color: var(--danger-text); text-align: center; padding: 20px 0; }
.preview-row {
  display: flex; justify-content: space-between; padding: 6px 0;
  border-bottom: 1px solid var(--border-soft);
}
.preview-row label { color: var(--text-muted); font-size: 13px; }
.preview-row span { font-size: 14px; color: var(--text-main); }
.mono { font-family: monospace; }
.preview-desc { margin-top: 12px; }
.preview-desc label, .preview-fixes label {
  display: block; color: var(--text-muted); font-size: 13px; margin-bottom: 4px;
}
.preview-desc p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-soft); }
.preview-fixes { margin-top: 12px; }
.preview-fixes ul { margin: 0; padding-left: 20px; font-size: 13px; color: var(--text-soft); }
.preview-conflict {
  margin-top: 16px; padding: 12px;
  background: rgba(var(--accent-rgb), 0.1); border: 1px solid var(--accent-gold-dim); border-radius: 8px;
}
.preview-conflict p { margin: 0 0 8px; font-size: 13px; color: var(--text-soft); }
.force-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--text-soft); }
.import-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 20px; border-top: 1px solid var(--border-color);
}
.btn-primary {
  background: var(--accent-gold); color: var(--text-on-accent);
  border: none; padding: 8px 20px; border-radius: 6px;
  cursor: pointer; font-weight: 600;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: transparent; color: var(--text-soft);
  border: 1px solid var(--border-color); padding: 8px 16px;
  border-radius: 6px; cursor: pointer;
}
.btn-secondary:hover { color: var(--text-bright); border-color: var(--border-strong); }
.import-notice {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: rgba(var(--accent-rgb), 0.08);
}
.import-notice-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--gold-text);
}
.import-notice-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-soft);
}

.import-risk-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--danger-text-strong);
}
.import-risk-intro {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-main);
}
.import-risk-list {
  margin: 0 0 10px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-soft);
}
.import-risk-concl {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-soft);
}

.spinner {
  display: inline-block; width: 20px; height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-gold);
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
