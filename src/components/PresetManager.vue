<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ApplyReport, ModEntry, Preset, PresetItem } from "../types";
import { applyPreset, deletePreset, listPresets, savePreset } from "../api";
import { formatDateTime, translateBackendMessage } from "../format";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{ mods: ModEntry[]; appliedId: string | null }>();
const emit = defineEmits<{ (e: "close"): void; (e: "applied", presetId: string): void }>();

const { t } = useI18n();

const presets = ref<Preset[]>([]);
const loading = ref(true);
const busy = ref<"" | "save" | "apply" | "delete">("");
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const name = ref("");
const result = ref<ApplyReport | null>(null);
const resultName = ref("");
const pendingDelete = ref<string | null>(null);
/** 待确认应用（覆盖式，必须先二次确认） */
const pendingApply = ref<Preset | null>(null);
const applyError = ref<string | null>(null);

/** 只有“当前已启用”的模组才进预设 */
const enabled = computed(() => props.mods.filter((m) => m.enabled === true));

const defaultName = computed(() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return t("preset.defaultName", { date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` });
});

const effectiveName = computed(() => name.value.trim() || defaultName.value);

function normalizeError(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return t("labels.unknown");
  }
}

/** 与 mod-status.json 的 Path 保持同一形状：local//9_xxx / subscribed//20505_xxx */
function toItems(mods: ModEntry[]): PresetItem[] {
  return mods.map((m) => ({
    workshopId: m.workshopId && m.workshopId > 0 ? m.workshopId : null,
    path: `${m.kind}//${m.folderName}`,
    title: m.displayName,
    priority: m.priority,
    kind: m.kind,
  }));
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    presets.value = await listPresets();
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    loading.value = false;
  }
}

async function doSave() {
  if (busy.value) return;
  const items = toItems(enabled.value);
  if (!items.length) {
    error.value = t("preset.noEnabled");
    return;
  }
  busy.value = "save";
  error.value = null;
  notice.value = null;
  result.value = null;
  try {
    const preset = await savePreset(effectiveName.value, items);
    presets.value = await listPresets();
    name.value = "";
    notice.value = t("preset.saved", { name: preset.name, n: preset.items.length });
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    busy.value = "";
  }
}

async function doApply(preset: Preset) {
  if (busy.value) return;
  if (props.appliedId === preset.id) return;
  applyError.value = null;
  pendingApply.value = preset;
}

function cancelApply() {
  if (busy.value === "apply") return;
  pendingApply.value = null;
  applyError.value = null;
}

/** 二次确认后真正执行：后端会覆盖式写入并自动备份/回读校验 */
async function confirmApply() {
  const preset = pendingApply.value;
  if (!preset || busy.value) return;
  busy.value = "apply";
  applyError.value = null;
  error.value = null;
  notice.value = null;
  result.value = null;
  try {
    const report = await applyPreset(preset.id);
    result.value = report;
    resultName.value = preset.name;
    pendingApply.value = null;
    // 交给 App.vue：重扫 + 记录指纹 + 标记“当前已应用”
    emit("applied", preset.id);
  } catch (e) {
    applyError.value = normalizeError(e);
    error.value = applyError.value;
  } finally {
    busy.value = "";
  }
}

async function doDelete(preset: Preset) {
  if (busy.value) return;
  if (pendingDelete.value !== preset.id) {
    pendingDelete.value = preset.id;
    return;
  }
  busy.value = "delete";
  error.value = null;
  try {
    presets.value = await deletePreset(preset.id);
    pendingDelete.value = null;
    notice.value = t("preset.deleted", { name: preset.name });
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    busy.value = "";
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  void load();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal preset-modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2>{{ t("preset.title") }}</h2>
        <span class="modal-sub">{{ t("preset.subtitle") }}</span>
        <button class="modal-x" type="button" :title="t('preset.closeTitle')" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="modal-body">
        <section class="preset-save">
          <div class="preset-save-row">
            <input
              v-model="name"
              type="text"
              :placeholder="defaultName"
              maxlength="40"
              spellcheck="false"
            />
            <button
              type="button"
              class="primary"
              :disabled="busy !== '' || loading || enabled.length === 0"
              @click="doSave"
            >
              {{ busy === "save" ? t("preset.saving") : t("preset.save", { n: enabled.length }) }}
            </button>
          </div>
          <p class="note">
            {{ t("preset.summary", { total: props.mods.length, enabled: enabled.length }) }}
          </p>
        </section>

        <div v-if="error" class="preset-alert error">{{ error }}</div>
        <div v-if="notice" class="preset-alert ok">{{ notice }}</div>

        <section v-if="result" class="preset-alert ok">
          <strong>{{ resultName }}: {{ translateBackendMessage(result.message) }}</strong>
          <!-- 数据模组互斥：后端只保留了加载顺序最前的那一个，其余强制跳过 -->
          <div v-if="result.skippedDataMods > 0" class="preset-datamod-warn">
            {{ t("preset.dataModSkipped", { n: result.skippedDataMods, list: result.skippedDataModTitles.join(", ") }) }}
          </div>
          <ul class="preset-detail">
            <li>
              {{
                t("preset.restoreNote", {
                  requested: result.requested,
                  restored: result.restored,
                  disabled: result.disabled,
                  alreadyEnabled: result.alreadyEnabled,
                })
              }}
            </li>
            <li v-if="result.totalEnabledAfter">
              {{ t("preset.totalEnabledAfter", { n: result.totalEnabledAfter }) }}
            </li>
            <li v-if="result.backupPath" class="mono">
              {{ t("preset.backupPath", { path: result.backupPath }) }}
            </li>
            <li v-else>{{ t("preset.noBackup") }}</li>
            <li v-if="result.notInStatus.length">
              {{
                t("preset.notInStatus", {
                  n: result.notInStatus.length,
                  list: result.notInStatus.map((i) => i.title || i.path).join(", "),
                })
              }}
            </li>
            <li>{{ t("preset.verifyHint") }}</li>
          </ul>
        </section>

        <section class="preset-list">
          <div class="preset-list-head">
            <h3>{{ t("preset.listTitle") }}</h3>
            <span class="note">{{ t("preset.listCount", { n: presets.length }) }}</span>
          </div>

          <div v-if="loading" class="preset-empty">{{ t("preset.loading") }}</div>
          <div v-else-if="!presets.length" class="preset-empty">{{ t("preset.emptyList") }}</div>

          <div v-for="preset in presets" :key="preset.id" class="preset-row">
            <div class="preset-info">
              <div class="preset-name">{{ preset.name }}</div>
              <div class="preset-meta">
                {{
                  t("preset.items", {
                    n: preset.items.length,
                    date: formatDateTime(preset.updatedAtMs),
                  })
                }}
                <span v-if="preset.updatedAtMs !== preset.createdAtMs">
                  {{ t("preset.created", { date: formatDateTime(preset.createdAtMs) }) }}
                </span>
              </div>
            </div>
            <div class="preset-actions">
              <button
                type="button"
                class="primary"
                :class="{ applied: props.appliedId === preset.id }"
                :disabled="busy !== '' || props.appliedId === preset.id"
                @click="doApply(preset)"
              >
                {{
                  props.appliedId === preset.id
                    ? t("preset.applied")
                    : busy === "apply"
                      ? t("preset.applying")
                      : t("preset.apply")
                }}
              </button>
              <button
                type="button"
                :class="{ danger: pendingDelete === preset.id }"
                :disabled="busy !== ''"
                @click="doDelete(preset)"
              >
                {{ pendingDelete === preset.id ? t("preset.deleteConfirm") : t("preset.delete") }}
              </button>
            </div>
          </div>
        </section>

        <section class="preset-safety">
          <h3>{{ t("preset.safetyTitle") }}</h3>
          <ul>
            <li>{{ t("preset.safetyOverwrite") }}</li>
            <li>{{ t("preset.safetyBackup") }}</li>
            <li>{{ t("preset.safetyFields") }}</li>
            <li>{{ t("preset.safetyProcess") }}</li>
          </ul>
        </section>
      </div>
    </div>

    <!-- 覆盖式应用的二次确认 -->
    <ConfirmDialog
      v-if="pendingApply"
      :title="t('preset.confirmTitle')"
      :message="t('preset.confirmMessage')"
      :detail="pendingApply.name"
      :confirm-label="t('preset.confirmApply')"
      :busy="busy === 'apply'"
      :error="applyError"
      @confirm="confirmApply"
      @cancel="cancelApply"
    />
  </div>
</template>

<style scoped>
/* 数据模组被跳过：琥珀色警告条（不是错误，但必须一眼看到） */
.preset-datamod-warn {
  margin: 8px 0 2px;
  padding: 7px 10px;
  border: 1px solid rgba(var(--accent-rgb), 0.6);
  border-radius: 4px;
  background: rgba(var(--badge-tool-rgb), 0.55);
  color: var(--gold-bright);
  font-size: calc(12px * var(--global-scale));
  line-height: 1.55;
  letter-spacing: 0.3px;
}
</style>
