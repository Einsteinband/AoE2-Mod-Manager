<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { detectRootCandidates, pickFolder, setModRoot } from "../api";
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

function normalizeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return t("labels.unknown");
  }
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
                <span class="chip" :class="{ on: candidate.hasLocal }">local</span>
                <span class="chip" :class="{ on: candidate.hasSubscribed }">subscribed</span>
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

        <div v-if="error" class="preset-alert error">{{ error }}</div>

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
