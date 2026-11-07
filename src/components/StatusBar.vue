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
import { getNetworkSettings, openLogin } from "../online/service";
import { isNetworkError, networkFailureKind, noteRequestFailure } from "../online/networkError";
import { openExternalUrl } from "../api";
import { translateBackendMessage } from "../format";
import {
  ensureSession,
  lastCheckedMs,
  probeNetwork,
  requestManualRefresh,
  sessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
  setStatusMessageKey,
  statusMessage,
} from "../sessionState";

const props = defineProps<{ localCount: number; mode: "local" | "online" }>();
const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const loggingIn = ref(false);
const proxySourceKey = ref<string | null>(null);
/** 代理来源原始值（manual / system / env / direct）：决定断网提示该怪网络还是怪代理 */
const proxySource = ref<string | null>(null);
/** 测网中（防连点） */
const networkProbing = ref(false);
/** 最近一次测网是否成功；null = 还没测过 */
const networkProbeOk = ref<boolean | null>(null);
/**
 * 代理胶囊：只存「来源的 i18n key」，渲染时才拼文案。
 * 之前是一枚 ref("") 快照，切换语言后仍停在旧语言（英文界面出现「代理：直连」），
 * 改成 computed 后随 locale 重新求值。
 */
const proxyText = computed(() =>
  proxySourceKey.value ? t("statusbar.proxyLabel", { src: t(proxySourceKey.value) }) : "",
);
/** 登录轮询的节拍与次数：2.5s × 24 ≈ 60s，超时就把 🟡 放回 ⚪ */
const POLL_INTERVAL_MS = 2500;
const POLL_TRIES = 24;

const dot = computed(() => {
  // 网络层失败优先于登录态：Cookie 还在但网断了，不能继续显示绿灯
  if (isNetworkError.value) return "🔴";
  if (sessionPhase.value === "online") return "🟢";
  if (sessionPhase.value === "checking") return "🟡";
  return "⚪";
});

/** 当前是否真的配了代理（direct = 没配） */
const usingProxy = computed(
  () =>
    proxySource.value === "manual" ||
    proxySource.value === "system" ||
    proxySource.value === "env",
);

/**
 * 断网提示分级（v0.4.7）：以前一律说「网络已断开」，但三种情况该修的东西完全不同。
 * - TLS 握手被中途掐断 + 已配代理 → 代理节点/规则的问题
 * - TLS 握手被中途掐断 + 直连   → 直连被拦截，需要开代理
 * - 超时 / DNS / 其他           → 网络本身不可用
 */
const networkDownLabel = computed(() => {
  if (!isNetworkError.value) return "";
  if (networkFailureKind.value === "tls") {
    return usingProxy.value ? t("statusbar.proxyDown") : t("statusbar.tlsDown");
  }
  if (networkFailureKind.value === "timeout") return t("statusbar.timeoutDown");
  return t("statusbar.networkDown");
});

const networkDownHint = computed(() => {
  if (!isNetworkError.value) return "";
  if (networkFailureKind.value === "tls") {
    return usingProxy.value ? t("statusbar.proxyDownHint") : t("statusbar.tlsDownHint");
  }
  if (networkFailureKind.value === "timeout") return t("statusbar.timeoutDownHint");
  return t("statusbar.networkDownHint");
});

const accountText = computed(() => {
  if (isNetworkError.value) return networkDownLabel.value;
  if (sessionPhase.value === "online") return t("statusbar.onlineShort");
  if (sessionPhase.value === "checking") return t("statusbar.checkingShort");
  return t("statusbar.offline");
});

/** 悬停显示来源 + Cookie 数（按需求不抓 Xbox 名字，避免官网改版失效） */
const accountTitle = computed(() => {
  if (isNetworkError.value) return networkDownHint.value || t("statusbar.networkDownTitle");
  const info = sessionInfo.value;
  if (sessionPhase.value !== "online" || !info) return t("statusbar.loginHint");
  return t("statusbar.source", {
    src: info.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview"),
    n: info.cookieCount,
  });
});

const middleText = computed(() => {
  // 断网时这条信息比“已从缓存加载 / 数据已刷新”更重要
  if (isNetworkError.value) return networkDownHint.value || t("statusbar.networkDownHint");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 帝国时代官网账号中心：微软 / Xbox 登录与 Steam 绑定的唯一入口（见 Rust open_external 白名单） */
const ACCOUNT_CENTER_URL = "https://auth.ageofempires.com/";

async function openAccountCenter(): Promise<void> {
  menuOpen.value = false;
  try {
    await openExternalUrl(ACCOUNT_CENTER_URL);
  } catch (e) {
    setStatusMessage(translateBackendMessage(typeof e === "string" ? e : String(e)));
  }
}

/** 代理链路只读一次：底栏不轮询网络设置（保存后由设置弹窗自己提示） */
async function loadProxy() {
  try {
    const view = await getNetworkSettings();
    proxySource.value = view.source;
    proxySourceKey.value =
      view.source === "manual"
        ? "statusbar.proxyManual"
        : view.source === "system"
          ? "statusbar.proxySystem"
          : view.source === "env"
            ? "statusbar.proxyEnv"
            : "statusbar.proxyDirect";
  } catch {
    proxySource.value = null;
    proxySourceKey.value = null;
  }
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

/** 测网请求的超时上限：超过这个时间还没回包，按超时处理并点亮断网标志 */
const PROBE_TIMEOUT_MS = 12000;

/**
 * 测网：发一次真实请求（Tags 字典，最小的 GET）验证「本机 → 代理 → 目标站点」整条链路。
 *
 * 为什么必须联网：`isNetworkError` 是粘滞标志，只有真实请求成功才会清零。
 * 会话探测（读本地 Cookie）永远不会清它，这正是旧版「立即重新校验」失效的原因。
 *
 * 请求本身走 `sessionState.probeNetwork()` 共享去重：
 * `recheck()` 里 `markOnline` 可能已顺带启动一次自动探测，这里直接复用它，
 * 保证一次点击最多只打一个 `GET /mods/Tags`。
 */
async function probeNetworkNow(): Promise<boolean> {
  if (networkProbing.value) return networkProbeOk.value === true;
  networkProbing.value = true;
  // 代理链路可能在挂载后变化（例如用户中途才打开 Clash）：
  // 测网前刷新一次来源，否则分级会拿旧的「直连」去解释新的失败
  await loadProxy();
  try {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("__probe_timeout__")), PROBE_TIMEOUT_MS);
    });
    try {
      const ok = await Promise.race([probeNetwork(), timeout]);
      networkProbeOk.value = ok;
      return ok;
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  } catch (e) {
    // 失败已由 service 的 tracked() 记进全局标志；这里只补记超时（tracked 收不到 race 的超时）
    if (e instanceof Error && e.message === "__probe_timeout__") {
      noteRequestFailure({ kind: "timeout", message: `测网请求超时（${PROBE_TIMEOUT_MS / 1000}s）` });
    }
    networkProbeOk.value = false;
    return false;
  } finally {
    networkProbing.value = false;
  }
}

/** 左下角「测网」按钮：只测网络，不碰登录态 */
async function testNetwork(): Promise<void> {
  const ok = await probeNetworkNow();
  if (ok) {
    setStatusMessageKey("statusbar.netOk");
    return;
  }
  // 非网络类失败（HTTP 状态 / 鉴权）：网络其实是通的，不能借断网文案误导用户
  if (!isNetworkError.value) setStatusMessageKey("statusbar.netFailOther");
}

/**
 * 用户点击「立即重新校验」：
 * 1) 验登录态（读本地 Cookie，不联网）
 * 2) 再验真实网络 —— 否则按钮名不副实，断网标志永远清不掉
 */
async function recheck() {
  menuOpen.value = false;
  const loggedIn = await ensureSession(true);
  const reachable = await probeNetworkNow();
  if (loggedIn && reachable) {
    setStatusMessageKey("statusbar.loginDone");
    requestManualRefresh();
  }
}

/**
 * 打开登录窗口并轮询等待完成。
 * 成功后 ensureSession 会 bump epoch，在线页收到信号自己刷新，这里不做任何 reload。
 */
async function startLogin() {
  if (loggingIn.value) return;
  loggingIn.value = true;
  menuOpen.value = false;
  setStatusMessageKey("statusbar.loginWait");
  try {
    await openLogin();
  } catch (e) {
    setStatusMessage(translateBackendMessage(typeof e === "string" ? e : t("statusbar.loginFailed")));
    loggingIn.value = false;
    return;
  }
  for (let tick = 0; tick < POLL_TRIES; tick += 1) {
    await sleep(POLL_INTERVAL_MS);
    const ok = await ensureSession(true);
    if (ok) {
      setStatusMessageKey("statusbar.loginDone");
      loggingIn.value = false;
      return;
    }
  }
  setStatusMessageKey("statusbar.loginTimeout");
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
      :class="[sessionPhase, { 'network-error': isNetworkError }]"
      :title="accountTitle"
      @click="toggleMenu"
    >
      <span class="sb-dot">{{ dot }}</span>
      <span class="sb-label">{{ accountText }}</span>
      <span v-if="loggingIn" class="spinner sb-spin"></span>
    </button>

    <!-- 左下角测网：发一次真实请求，直接回答「现在是网络断了还是代理不通」 -->
    <button
      type="button"
      class="sb-netcheck"
      :class="{
        probing: networkProbing,
        ok: networkProbeOk === true && !isNetworkError,
        fail: networkProbeOk === false || isNetworkError,
      }"
      :title="t('statusbar.netcheckTitle')"
      :disabled="networkProbing"
      @click="testNetwork"
    >
      <span v-if="networkProbing" class="spinner sb-spin"></span>
      <span v-else>{{ t("statusbar.netcheck") }}</span>
    </button>

    <div v-if="menuOpen" class="sb-menu">
      <div class="sb-menu-title">{{ t("statusbar.loginTitle") }}</div>
      <div class="sb-menu-platform">
        <span class="sb-menu-label">{{ t("online.loginMicrosoftLabel") }}</span>
        <span class="sb-menu-hint">{{ t("online.loginMicrosoftHint") }}</span>
      </div>
      <p class="sb-menu-bind">
        {{ t("online.loginSteamBindNote") }}
        <button type="button" class="sb-menu-link" @click="openAccountCenter">{{ t("online.loginAccountCenter") }}</button>
      </p>
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
  background: linear-gradient(180deg, var(--statusbar-top), var(--statusbar-bottom));
  border-top: 1px solid var(--line-soft);
  box-shadow: inset 0 1px 0 rgba(var(--accent-rgb), 0.12);
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
  font-size: 11px;
  letter-spacing: 0.4px;
  cursor: pointer;
}
.sb-account:hover {
  color: var(--gold-bright);
  background: rgba(var(--accent-rgb), 0.1);
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
.sb-account.network-error {
  color: var(--danger-text);
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

/* 左下角「测网」：常驻的独立入口，不复用账号灯，避免测网时把登录态灯光打乱 */
.sb-netcheck {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  min-width: 34px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.3px;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.sb-netcheck:hover:not(:disabled) {
  color: var(--gold-bright);
  border-color: var(--gold-dim);
  background: rgba(var(--accent-rgb), 0.1);
}
.sb-netcheck.probing {
  cursor: progress;
  color: var(--gold-dim);
  border-color: var(--gold-dim);
}
.sb-netcheck.ok {
  color: var(--gold);
  border-color: var(--gold-dim);
}
.sb-netcheck.fail {
  color: var(--danger-text);
  border-color: var(--danger-text);
}
.sb-netcheck:disabled {
  cursor: progress;
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
  min-width: 0;
}
.sb-pill {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
  /* 英文比中文长（Proxy: direct / Environment proxy）：窄窗口下只省略，不换行不撑破底栏 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
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
  background: linear-gradient(180deg, var(--menu-top), var(--menu-bottom));
  box-shadow: 0 14px 32px rgba(var(--shadow-rgb), 0.62);
  animation: sb-menu-in 0.14s ease-out;
}
.sb-menu-title {
  padding: 2px 2px 8px;
  color: var(--gold-bright);
  font-size: 11.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}
/* v3.3：平台选项已收敛为单一微软 / Xbox 入口，所以不再需要 hover / active 态 */
.sb-menu-platform {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin-bottom: 6px;
  padding: 7px 9px;
  border: 1px solid var(--gold);
  border-radius: 3px;
  background: linear-gradient(180deg, var(--item-active-top), var(--bg-hover));
  text-align: left;
}
.sb-menu-label {
  font-size: 12px;
  color: var(--gold-bright);
}
.sb-menu-hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--muted);
}
/* v3.3：Steam 版用户绑定微软账号的提示（可点击跳官网账号中心）。
   注意不能用 `.sb-menu-note`：那一类是状态/错误提示（金色），复用会把报错样式冲掉。 */
.sb-menu-bind {
  margin: 0 0 6px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--muted);
}
.sb-menu-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--gold-bright);
  font-size: 10px;
  text-decoration: underline;
  cursor: pointer;
}
.sb-menu-link:hover {
  color: var(--gold);
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
  color: var(--danger-text);
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
