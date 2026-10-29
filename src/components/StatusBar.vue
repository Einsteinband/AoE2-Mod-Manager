<script setup lang="ts">
/**
 * v0.6 全局底部状态栏（始终显示，不参与三栏布局）。
 *
 * 左侧：账号灯（⚪离线 / 🟡验证中 / 🟢已登录），点击弹出登录入口与「立即重新校验」。
 * 中间：动态提示（已从缓存加载 / 正在请求网络数据… / 上次校验时间）。
 * 右侧：代理链路 + 本地模组数 + 当前模式。
 *
 * 所有登录态都来自 src/sessionState.ts（与在线页共用同一个探测 Promise），
 * 这里绝不做自己的阻塞式检查。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getNetworkSettings, loginTargets, openLogin } from "../online/service";
import {
  ensureSession,
  lastCheckedMs,
  sessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
  statusMessage,
} from "../sessionState";
import type { LoginTarget } from "../online/types";

const props = defineProps<{ localCount: number; mode: "local" | "online" }>();
const { t, te } = useI18n();

const root = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const platforms = ref<LoginTarget[]>([]);
const platform = ref("microsoft");
const loggingIn = ref(false);
const proxyText = ref("");
/** 登录轮询的节拍与次数：2.5s × 24 ≈ 60s，超时就把 🟡 放回 ⚪ */
const POLL_INTERVAL_MS = 2500;
const POLL_TRIES = 24;

const dot = computed(() => {
  if (sessionPhase.value === "online") return "🟢";
  if (sessionPhase.value === "checking") return "🟡";
  return "⚪";
});

const accountText = computed(() => {
  if (sessionPhase.value === "online") return t("statusbar.onlineShort");
  if (sessionPhase.value === "checking") return t("statusbar.checkingShort");
  return t("statusbar.offline");
});

/** 悬停显示来源 + Cookie 数（按需求不抓 Xbox 名字，避免官网改版失效） */
const accountTitle = computed(() => {
  const info = sessionInfo.value;
  if (sessionPhase.value !== "online" || !info) return t("statusbar.loginHint");
  return t("statusbar.source", {
    src: info.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview"),
    n: info.cookieCount,
  });
});

const middleText = computed(() => {
  if (statusMessage.value) return statusMessage.value;
  if (sessionPhase.value === "checking") return t("statusbar.checking");
  const ms = lastCheckedMs.value;
  return ms ? t("statusbar.lastCheck", { time: clock(ms) }) : t("statusbar.idle");
});

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function labelFor(target: LoginTarget): string {
  const key = `online.login.${target.key}.label`;
  return te(key) ? t(key) : target.label;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 代理链路只读一次：底栏不轮询网络设置（保存后由设置弹窗自己提示） */
async function loadProxy() {
  try {
    const view = await getNetworkSettings();
    const source =
      view.source === "manual"
        ? t("statusbar.proxyManual")
        : view.source === "system"
          ? t("statusbar.proxySystem")
          : view.source === "env"
            ? t("statusbar.proxyEnv")
            : t("statusbar.proxyDirect");
    proxyText.value = t("statusbar.proxyLabel", { src: source });
  } catch {
    proxyText.value = "";
  }
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value || platforms.value.length) return;
  try {
    platforms.value = await loginTargets();
    if (!platforms.value.some((item) => item.key === platform.value)) {
      platform.value = platforms.value[0]?.key ?? "microsoft";
    }
  } catch {
    /* 后端不可用时仍保留「重新校验」按钮 */
  }
}

/** 用户点击「重新校验」：强制再探一次（会 bump epoch，在线页自动刷新） */
async function recheck() {
  menuOpen.value = false;
  const ok = await ensureSession(true);
  if (ok) setStatusMessage(t("statusbar.loginDone"));
}

/**
 * 打开登录窗口并轮询等待完成。
 * 成功后 ensureSession 会 bump epoch，在线页收到信号自己刷新，这里不做任何 reload。
 */
async function startLogin() {
  if (loggingIn.value) return;
  loggingIn.value = true;
  menuOpen.value = false;
  setStatusMessage(t("statusbar.loginWait"));
  try {
    await openLogin(platform.value);
  } catch (e) {
    setStatusMessage(typeof e === "string" ? e : t("statusbar.loginFailed"));
    loggingIn.value = false;
    return;
  }
  for (let tick = 0; tick < POLL_TRIES; tick += 1) {
    await sleep(POLL_INTERVAL_MS);
    const ok = await ensureSession(true);
    if (ok) {
      setStatusMessage(t("statusbar.loginDone"));
      loggingIn.value = false;
      return;
    }
  }
  setStatusMessage(t("statusbar.loginTimeout"));
  loggingIn.value = false;
}

/** 点空白处 / Esc 关闭弹层 */
function onDocumentClick(event: MouseEvent) {
  if (!menuOpen.value) return;
  const el = root.value;
  if (el && event.target instanceof Node && el.contains(event.target)) return;
  menuOpen.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") menuOpen.value = false;
}

onMounted(() => {
  window.addEventListener("click", onDocumentClick, true);
  window.addEventListener("keydown", onKeydown);
  void loadProxy();
});

onBeforeUnmount(() => {
  window.removeEventListener("click", onDocumentClick, true);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <footer ref="root" class="statusbar">
    <button
      type="button"
      class="sb-account"
      :class="sessionPhase"
      :title="accountTitle"
      @click="toggleMenu"
    >
      <span class="sb-dot">{{ dot }}</span>
      <span class="sb-label">{{ accountText }}</span>
      <span v-if="loggingIn" class="spinner sb-spin"></span>
    </button>

    <div v-if="menuOpen" class="sb-menu">
      <div class="sb-menu-title">{{ t("statusbar.loginTitle") }}</div>
      <button
        v-for="item in platforms"
        :key="item.key"
        type="button"
        class="sb-menu-item"
        :class="{ active: platform === item.key }"
        :disabled="loggingIn"
        @click="platform = item.key"
      >
        <span class="sb-menu-label">{{ labelFor(item) }}</span>
        <span class="sb-menu-hint">{{ item.hint }}</span>
      </button>
      <div class="sb-menu-actions">
        <button type="button" :disabled="loggingIn" @click="startLogin">
          {{ loggingIn ? t("statusbar.loginWait") : t("statusbar.loginOpen") }}
        </button>
        <button type="button" :disabled="loggingIn" @click="recheck">
          {{ t("statusbar.recheck") }}
        </button>
      </div>
      <div v-if="sessionError" class="sb-menu-note err">{{ sessionError }}</div>
    </div>

    <span class="sb-mid" :title="middleText">{{ middleText }}</span>

    <span class="sb-right">
      <span v-if="proxyText" class="sb-pill">{{ proxyText }}</span>
      <span class="sb-pill">{{ t("statusbar.localCount", { n: props.localCount }) }}</span>
      <span class="sb-pill sb-mode">{{ props.mode === "online" ? t("nav.online") : t("nav.local") }}</span>
    </span>
  </footer>
</template>

<style scoped>
.statusbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 24px;
  padding: 0 12px;
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.3px;
  color: var(--muted);
  background: linear-gradient(180deg, #14100b, #0b0806);
  border-top: 1px solid var(--line-soft);
  box-shadow: inset 0 1px 0 rgba(201, 162, 77, 0.12);
  user-select: none;
}

.sb-account {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--parch-dim);
  font-family: var(--serif);
  font-size: 11px;
  letter-spacing: 0.4px;
  cursor: pointer;
}
.sb-account:hover {
  color: var(--gold-bright);
  background: rgba(201, 162, 77, 0.1);
}
.sb-account.online {
  color: var(--gold);
}
.sb-account.checking {
  color: var(--gold-dim);
}
.sb-account.offline {
  color: var(--muted);
}
.sb-dot {
  font-size: 9px;
  line-height: 1;
}
.sb-label {
  white-space: nowrap;
}
.sb-spin {
  width: 9px;
  height: 9px;
  border-width: 1.5px;
}

.sb-mid {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--parch-dim);
  font-size: 10.5px;
  letter-spacing: 0.2px;
}

.sb-right {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.sb-pill {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #14100c;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.sb-pill.sb-mode {
  border-color: var(--gold-dim);
  color: var(--gold-dim);
}

/* 登录弹层：向上弹出，不挤压布局 */
.sb-menu {
  position: fixed;
  left: 12px;
  bottom: 28px;
  z-index: 70;
  width: 300px;
  padding: 10px;
  border: 1px solid var(--gold-dim);
  border-radius: 4px;
  background: linear-gradient(180deg, #221a10, #120d08);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.62);
  animation: sb-menu-in 0.14s ease-out;
}
.sb-menu-title {
  padding: 2px 2px 8px;
  color: var(--gold-bright);
  font-family: var(--serif);
  font-size: 11.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}
.sb-menu-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin-bottom: 6px;
  padding: 7px 9px;
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: #14100b;
  color: var(--parch);
  cursor: pointer;
}
.sb-menu-item:hover {
  border-color: var(--gold-dim);
}
.sb-menu-item.active {
  border-color: var(--gold);
  background: linear-gradient(180deg, #2a2118, #1c1610);
}
.sb-menu-label {
  font-family: var(--serif);
  font-size: 12px;
  color: var(--parch);
}
.sb-menu-item.active .sb-menu-label {
  color: var(--gold-bright);
}
.sb-menu-hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--muted);
}
.sb-menu-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.sb-menu-actions button {
  flex: 1 1 0;
  padding: 6px 8px;
  font-size: 11px;
}
.sb-menu-note {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--gold);
  word-break: break-all;
}
.sb-menu-note.err {
  color: #d98a72;
}
@keyframes sb-menu-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
