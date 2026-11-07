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
  logoutAndClearSession,
  probeNetwork,
  requestManualRefresh,
  sessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
  setStatusMessageKey,
  statusMessage,
} from "../sessionState";

/**
 * v0.4.7：右侧的「本地 N 个」与「本地/在线」两枚标签已移除 —— 当前页面本身已经说明
 * 自己在哪个模式，模组总数在顶栏也有，这里属于重复信息。
 * 仍保留声明：不改 App.vue 的调用签名，多余 prop 无害。
 */
defineProps<{ localCount: number; mode: "local" | "online" }>();
const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const loggingIn = ref(false);
const proxySourceKey = ref<string | null>(null);
/** 代理来源原始值（manual / system / env / direct）：决定断网提示该怪网络还是怪代理 */
const proxySource = ref<string | null>(null);
/** 校验连接进行中（防连点） */
const networkProbing = ref(false);
/** 最近一次探测结果；并发调用时复用它，避免连点第二次误报「不通」 */
const lastProbeOk = ref<boolean | null>(null);
/** 退出登录进行中 / 上一次失败原因（失败必须如实显示，不能假装成功） */
const loggingOut = ref(false);
const logoutError = ref<string | null>(null);
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

/** 二级菜单里的账号行（原来在线页侧栏那段已迁到这里，全应用只留这一处） */
const sessionLine = computed(() => {
  const info = sessionInfo.value;
  if (sessionPhase.value !== "online" || !info) return t("statusbar.offline");
  return t("statusbar.sessionLine", {
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
  if (networkProbing.value) return lastProbeOk.value === true;
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
      // 成功 / 失败都会写进全局断网标志（由 service 的 tracked() 负责），这里只回传结果
      const ok = await Promise.race([probeNetwork(), timeout]);
      lastProbeOk.value = ok;
      return ok;
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  } catch (e) {
    // 失败已由 service 的 tracked() 记进全局标志；这里只补记超时（tracked 收不到 race 的超时）
    if (e instanceof Error && e.message === "__probe_timeout__") {
      noteRequestFailure({ kind: "timeout", message: `校验连接超时（${PROBE_TIMEOUT_MS / 1000}s）` });
    }
    lastProbeOk.value = false;
    return false;
  } finally {
    networkProbing.value = false;
  }
}

/**
 * 二级菜单里的「校验连接」：原来的「测网」与「立即重新校验」已合并到这里。
 *
 * 两步都做（只做网络那一步等于半个功能）：
 * 1) 验登录态（读本地 Cookie，不联网）
 * 2) 向官方接口发一次真实请求验网络 —— 断网标志只有真实请求成功才会清零
 *
 * 四种组合都要给提示：旧实现只在「登录✓且网络✓」时说话，另外三种全静默，
 * 用户点了没反应，反而会以为是按钮坏了。
 */
async function recheck(): Promise<void> {
  menuOpen.value = false;
  logoutError.value = null;
  const loggedIn = await ensureSession(true);
  const reachable = await probeNetworkNow();
  if (loggedIn && reachable) {
    setStatusMessageKey("statusbar.loginDone");
    requestManualRefresh();
    return;
  }
  if (loggedIn) {
    // 网络不通：具体原因（代理失败 / 超时 / 连接被中断）由 networkDownLabel 显示
    setStatusMessageKey("statusbar.checkNetworkFailed");
    return;
  }
  setStatusMessageKey(reachable ? "statusbar.checkLoginFailed" : "statusbar.checkAllFailed");
}

/**
 * 二级菜单里的「退出登录 / 清缓存」。
 * 失败必须如实显示原因（后端可能是「文件被占用，请重启软件」），
 * 绝不能在失败时也提示「已退出登录」。
 */
async function doLogout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = null;
  try {
    await logoutAndClearSession();
    menuOpen.value = false;
    setStatusMessageKey("statusbar.logoutDone");
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // 后端「退出登录失败：文件被占用…」走独立键，避免把中文原因原样带到英文界面
    logoutError.value = /退出登录失败|退出登录未完成/.test(raw)
      ? t("online.logoutFailed")
      : translateBackendMessage(raw);
  } finally {
    loggingOut.value = false;
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
      <span class="sb-label">{{ t("statusbar.accountMenu") }}</span>
      <span v-if="loggingIn || networkProbing || loggingOut" class="spinner sb-spin"></span>
    </button>

    <!--
      状态文字从按钮内移到按钮右侧：
      按钮固定叫「账号与网络」，不再随「代理连接失败 / 未登录 / 已登录」变宽，
      底栏中间那条提示的起始位置也就不会被状态长短推着左右跳。
    -->
    <span
      class="sb-state"
      :class="{ error: isNetworkError, online: sessionPhase === 'online' && !isNetworkError }"
      :title="accountTitle"
    >{{ accountText }}</span>

    <div v-if="menuOpen" class="sb-menu">
      <div class="sb-menu-title">{{ t("statusbar.accountMenu") }}</div>
      <!-- 账号信息：原来在线页左侧栏底部那段已迁到这里，全应用只保留这一处 -->
      <div class="sb-menu-session" :title="accountTitle">{{ sessionLine }}</div>
      <div class="sb-menu-platform">
        <span class="sb-menu-label">{{ t("online.loginMicrosoftLabel") }}</span>
        <span class="sb-menu-hint">{{ t("online.loginMicrosoftHint") }}</span>
      </div>
      <p class="sb-menu-bind">
        {{ t("online.loginSteamBindNote") }}
        <button type="button" class="sb-menu-link" @click="openAccountCenter">{{ t("online.loginAccountCenter") }}</button>
      </p>
      <div class="sb-menu-actions">
        <button type="button" :disabled="loggingIn || loggingOut" @click="startLogin">
          {{ loggingIn ? t("statusbar.loginWait") : t("statusbar.loginOpen") }}
        </button>
      </div>
      <!-- 校验连接 + 退出登录：二级菜单里的操作项 -->
      <div class="sb-menu-actions">
        <button type="button" :disabled="networkProbing" :title="t('statusbar.checkHint')" @click="recheck">
          <span v-if="networkProbing" class="spinner sb-spin"></span>
          <span v-else>{{ t("statusbar.checkTitle") }}</span>
        </button>
        <button type="button" :disabled="loggingOut" :title="t('online.clearCache')" @click="doLogout">
          {{ loggingOut ? t("statusbar.loggingOut") : t("statusbar.logout") }}
        </button>
      </div>
      <div v-if="sessionError" class="sb-menu-note err">{{ sessionError }}</div>
      <div v-if="logoutError" class="sb-menu-note err">{{ logoutError }}</div>
    </div>

    <span class="sb-mid" :title="middleText">{{ middleText }}</span>

    <span class="sb-right">
      <!-- v0.4.7：只保留代理链路；「本地 N 个」与「本地/在线」两枚标签已移除 -->
      <span v-if="proxyText" class="sb-pill">{{ proxyText }}</span>
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
  font-size: calc(11px * var(--global-scale));
  line-height: 1;
  letter-spacing: calc(0.3px * var(--ui-tracking));
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
  font-size: calc(11.5px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: normal;
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
  font-size: calc(9px * var(--global-scale));
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

/* 状态文字：从按钮内搬到按钮右侧的独立元素（代理连接失败 / 网络错误 / 未登录 …） */
.sb-state {
  flex: 0 0 auto;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--parch-dim);
  font-size: calc(10.5px * var(--global-scale));
  letter-spacing: calc(0.3px * var(--ui-tracking));
}
.sb-state.online {
  color: var(--gold-dim);
}
.sb-state.error {
  color: var(--danger-text);
}

.sb-mid {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--parch-dim);
  font-size: calc(10.5px * var(--global-scale));
  letter-spacing: calc(0.2px * var(--ui-tracking));
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
  font-size: calc(10px * var(--global-scale));
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
  font-size: calc(11.5px * var(--global-scale));
  letter-spacing: calc(1.2px * var(--ui-tracking));
  text-transform: uppercase;
}
/* 二级菜单顶部的账号行：已登录 · 来源 · Cookie 数（原在线页左侧栏那段） */
.sb-menu-session {
  padding: 0 2px 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--parch-dim);
  font-size: calc(10.5px * var(--global-scale));
  line-height: 1.5;
  word-break: break-word;
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
  font-size: calc(12px * var(--global-scale));
  color: var(--gold-bright);
}
.sb-menu-hint {
  font-size: calc(10px * var(--global-scale));
  line-height: 1.5;
  color: var(--muted);
}
/* v3.3：Steam 版用户绑定微软账号的提示（可点击跳官网账号中心）。
   注意不能用 `.sb-menu-note`：那一类是状态/错误提示（金色），复用会把报错样式冲掉。 */
.sb-menu-bind {
  margin: 0 0 6px;
  font-size: calc(10px * var(--global-scale));
  line-height: 1.6;
  color: var(--muted);
}
.sb-menu-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--gold-bright);
  font-size: calc(10px * var(--global-scale));
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
  font-size: calc(11px * var(--global-scale));
}
.sb-menu-note {
  margin-top: 8px;
  font-size: calc(10.5px * var(--global-scale));
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
