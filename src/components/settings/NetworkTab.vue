<script setup lang="ts">
/**
 * 网络设置 Tab：代理（自动/手动）+ 记住登录
 *
 * 自包含：自己加载、保存、校验，SettingsModal 只负责 Tab 切换。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getNetworkSettings, setNetworkSettings, setRememberLogin } from "../../online/service";
import type { NetworkSettingsView } from "../../online/types";
import { msgText, normalizeBackendError, type Msg } from "../../format";

const { t } = useI18n();

// ---------------- 状态 ----------------
const netView = ref<NetworkSettingsView | null>(null);
const netAuto = ref(true);
const netUrl = ref("");
const netRemember = ref(false);
const netSaving = ref(false);
const netError = ref<string | null>(null);
const netMessage = ref<Msg | null>(null);
const netLoading = ref(false);

// ---------------- 消息格式化（含 online.netSaved 直连文案注入） ----------------
function formatNetMsg(m: Msg | null | undefined): string {
  if (!m || typeof m !== "object") return msgText(m);
  const params: Record<string, unknown> = { ...(m.params ?? {}) };
  if (m.key === "online.netSaved" && !params.proxy) params.proxy = t("online.netDirectWord");
  return String(t(m.key, params));
}

// ---------------- 展示文案 ----------------
const netSummary = computed(() => {
  const view = netView.value;
  if (!view) return t("online.netReading");
  if (view.error) return t("online.netConfigError");
  const proxy = view.effectiveProxy;
  switch (view.source) {
    case "manual":
      return t("online.netManual", { proxy: proxy ?? t("online.netNotSet") });
    case "system":
      return t("online.netSystem", { proxy: proxy ?? t("online.netDirectWord") });
    case "env":
      return t("online.netEnv", { proxy: proxy ?? t("online.netUnknownWord") });
    default:
      return t("online.netDirect");
  }
});

// ---------------- 加载 / 保存 ----------------
async function loadNetwork(): Promise<void> {
  netLoading.value = true;
  netError.value = null;
  try {
    const view = await getNetworkSettings();
    netView.value = view;
    netAuto.value = view.auto;
    netRemember.value = view.rememberLogin;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? view.effectiveProxy ?? "");
    if (view.error) netError.value = view.error;
  } catch (e) {
    netError.value = normalizeBackendError(e);
  } finally {
    netLoading.value = false;
  }
}

/**
 * 「记住登录 7 天」开关：改动立即落库（set_remember_login 只写配置，
 * 真正的 Cookie 门控在 Rust 侧），不依赖后面的「保存」按钮。
 */
async function applyRememberLogin(): Promise<void> {
  if (netSaving.value) return;
  netError.value = null;
  netMessage.value = null;
  try {
    const enabled = await setRememberLogin(netRemember.value);
    netRemember.value = enabled;
    netMessage.value = { key: enabled ? "online.rememberOn" : "online.rememberOff" };
  } catch (e) {
    netError.value = normalizeBackendError(e);
  }
}

async function saveNetwork(): Promise<void> {
  if (netSaving.value) return;
  netSaving.value = true;
  netError.value = null;
  netMessage.value = null;
  try {
    const view = await setNetworkSettings({
      auto: netAuto.value,
      proxyUrl: netAuto.value ? null : netUrl.value.trim(),
      rememberLogin: netRemember.value,
    });
    netView.value = view;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? "");
    if (view.error) {
      netError.value = view.error;
    } else {
      netMessage.value = {
        key: "online.netSaved",
        params: { proxy: view.effectiveProxy ?? "" },
      };
    }
  } catch (e) {
    netError.value = normalizeBackendError(e);
  } finally {
    netSaving.value = false;
  }
}

onMounted(() => {
  void loadNetwork();
});
</script>

<template>
  <section class="settings-card">
    <p class="settings-summary">{{ netSummary }}</p>

    <label class="settings-check-line">
      <input
        :checked="netAuto"
        type="checkbox"
        :disabled="netSaving"
        @change="netAuto = ($event.target as HTMLInputElement).checked"
      />
      {{ t("online.followSystem") }}
    </label>

    <input
      v-if="!netAuto"
      :value="netUrl"
      class="settings-input"
      type="text"
      placeholder="http://127.0.0.1:7897"
      spellcheck="false"
      :disabled="netSaving"
      @input="netUrl = ($event.target as HTMLInputElement).value"
    />

    <label class="settings-check-line">
      <input
        :checked="netRemember"
        type="checkbox"
        :disabled="netSaving"
        @change="netRemember = ($event.target as HTMLInputElement).checked; void applyRememberLogin()"
      />
      {{ t("online.rememberLogin") }}
    </label>
    <p class="settings-hint">{{ t("online.rememberLoginHint") }}</p>

    <div class="settings-actions">
      <button type="button" :disabled="netSaving" @click="void saveNetwork()">
        {{ netSaving ? t("online.saving") : t("online.save") }}
      </button>
      <button type="button" :disabled="netSaving || netLoading" @click="void loadNetwork()">
        {{ t("online.detect") }}
      </button>
    </div>

    <div v-if="netError" class="settings-msg error">{{ netError }}</div>
    <div v-else-if="netMessage" class="settings-msg">{{ formatNetMsg(netMessage) }}</div>
  </section>
</template>

<style scoped>
.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-summary {
  margin: 0;
  font-size: 0.9em;
  opacity: 0.8;
}
.settings-check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.settings-input {
  padding: 6px 10px;
  border-radius: 6px;
}
.settings-hint {
  font-size: 0.85em;
  opacity: 0.7;
  margin: 0;
}
.settings-actions {
  display: flex;
  gap: 8px;
}
.settings-actions button {
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
}
.settings-msg {
  font-size: 0.9em;
}
.settings-msg.error {
  color: #e74c3c;
}
</style>
