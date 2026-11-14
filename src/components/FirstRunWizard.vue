<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { detectRootCandidates, pickFolder, setModRoot } from "../api";
import { normalizeError, translateBackendMessage } from "../format";
import type { RootCandidate, ScanReport } from "../types";

const emit = defineEmits<{
  (e: "done", report: ScanReport): void;
  (e: "close"): void;
}>();

const { t, te } = useI18n();

const candidates = ref<RootCandidate[]>([]);
const detecting = ref(true);
const busyPath = ref<string | null>(null);
const browseBusy = ref(false);
const error = ref<string | null>(null);

/** 只在“已生成 local 或 subscribed”的候选上标注完整度，避免误导 */
const best = computed(() => candidates.value.filter((c) => c.hasLocal && c.hasSubscribed));

/** 后端只返回来源码（env / registry / steam_library ...），这里映射成当前语言 */
function sourceLabel(code: string): string {
  const key = `wizard.source.${code}`;
  return te(key) ? t(key) : code;
}

async function detect() {
  if (detecting.value && candidates.value.length) return;
  detecting.value = true;
  error.value = null;
  try {
    candidates.value = await detectRootCandidates();
  } catch (e) {
    error.value = normalizeError(e);
    candidates.value = [];
  } finally {
    detecting.value = false;
  }
}

/** 选择后立刻交给后端校验 + 扫描：路径不存在 / 缺少 local 与 subscribed 都会在这里被拒绝 */
async function apply(path: string) {
  if (busyPath.value || browseBusy.value) return;
  busyPath.value = path;
  error.value = null;
  try {
    emit("done", await setModRoot(path));
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    busyPath.value = null;
  }
}

async function browse() {
  if (browseBusy.value || busyPath.value) return;
  browseBusy.value = true;
  error.value = null;
  try {
    const picked = await pickFolder(candidates.value[0]?.path ?? null);
    if (!picked) return;
    emit("done", await setModRoot(picked));
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    browseBusy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  void detect();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal wizard-modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2>{{ t("wizard.title") }}</h2>
        <span class="modal-sub">{{ t("wizard.subtitle") }}</span>
        <button class="modal-x" type="button" :title="t('wizard.closeTitle')" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="modal-body">
        <section class="wizard-intro">
          <p>{{ t("wizard.intro") }}</p>
          <p class="note">{{ t("wizard.introNote") }}</p>
        </section>

        <div v-if="detecting" class="wizard-state">
          <span class="spinner"></span>
          {{ t("wizard.detecting") }}
        </div>

        <div v-else-if="candidates.length" class="wizard-list">
          <div class="wizard-list-head">
            <h3>{{ t("wizard.found", { n: candidates.length }) }}</h3>
            <button type="button" :disabled="detecting" @click="detect">{{ t("wizard.rescan") }}</button>
          </div>
          <div
            v-for="candidate in candidates"
            :key="candidate.path"
            class="wizard-card"
            :class="{ recommended: candidate.hasLocal && candidate.hasSubscribed }"
          >
            <div class="wizard-card-main">
              <div class="wizard-path" :title="candidate.path">{{ candidate.path }}</div>
              <div class="wizard-meta">
                <span class="badge">{{ sourceLabel(candidate.source) }}</span>
                <span class="chip" :class="{ on: candidate.hasLocal }">{{ t("wizard.chipLocal") }}</span>
                <span class="chip" :class="{ on: candidate.hasSubscribed }">{{ t("wizard.chipSubscribed") }}</span>
                <span v-if="candidate.looksLikeGame" class="badge ghost">{{ t("wizard.badgeGame") }}</span>
              </div>
            </div>
            <button
              type="button"
              class="primary"
              :disabled="busyPath !== null || browseBusy"
              @click="apply(candidate.path)"
            >
              {{ busyPath === candidate.path ? t("wizard.validating") : t("wizard.use") }}
            </button>
          </div>
        </div>

        <div v-else class="wizard-state">
          {{ t("wizard.none") }}
          <div class="actions">
            <button type="button" :disabled="detecting" @click="detect">{{ t("wizard.rescan") }}</button>
          </div>
        </div>

        <div v-if="error" class="preset-alert error">{{ translateBackendMessage(error) }}</div>

        <div class="wizard-actions">
          <button type="button" class="primary" :disabled="browseBusy || busyPath !== null" @click="browse">
            {{ browseBusy ? t("wizard.validating") : t("wizard.browse") }}
          </button>
          <button type="button" :disabled="browseBusy || busyPath !== null" @click="emit('close')">
            {{ t("wizard.later") }}
          </button>
          <span v-if="best.length" class="note">{{ t("wizard.recommended", { n: best.length }) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.wizard-modal {
  width: min(720px, 100%);
}
.wizard-intro {
  border: 1px solid var(--line);
  border-left: 2px solid var(--gold-dim);
  border-radius: 4px;
  padding: 10px 14px;
  background: var(--panel-lo);
}
.wizard-intro p {
  margin: 0 0 6px;
  font-size: calc(12.5px * var(--global-scale));
  line-height: 1.8;
  color: var(--parch-dim);
}
.wizard-intro p:last-child {
  margin-bottom: 0;
}
.wizard-intro strong {
  color: var(--gold-text);
  font-weight: var(--ui-font-weight-strong);
}
.wizard-intro code,
.wizard-state code {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--global-scale));
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--text-soft);
}

.wizard-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: 4px;
  font-size: calc(12px * var(--global-scale));
  line-height: 1.8;
  color: var(--muted);
}
.wizard-state .actions {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
}

.wizard-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wizard-list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.wizard-list-head h3 {
  margin: 0;
  font-size: calc(13px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--gold);
  font-weight: var(--ui-font-weight-strong);
}

.wizard-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom));
  transition: border-color 0.12s ease, background 0.12s ease;
}
.wizard-card:hover {
  border-color: var(--gold-dim);
}
.wizard-card.recommended {
  border-color: rgba(var(--accent-rgb), 0.42);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.08);
}
.wizard-card-main {
  min-width: 0;
  flex: 1 1 auto;
}
.wizard-path {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--global-scale));
  color: var(--parch);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
}
.wizard-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.wizard-card > button {
  flex: 0 0 auto;
  white-space: nowrap;
}
.chip {
  font-family: var(--app-font-family);
  font-size: calc(10px * var(--global-scale));
  padding: 1px 7px;
  border-radius: 9px;
  border: 1px solid var(--line);
  color: var(--text-dim);
}
.chip.on {
  border-color: var(--ok-border);
  color: var(--ok-text);
  background: rgba(var(--ok-rgb), 0.12);
}

.wizard-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--line-soft);
}
.wizard-actions .note {
  margin-left: auto;
}
</style>
