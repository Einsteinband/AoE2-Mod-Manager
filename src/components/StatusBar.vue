<script setup lang="ts">
/**
 * v0.6 全局底部状态栏（始终显示，不参与三栏布局）。
 *
 * 左侧：账号灯（⚪离线 / 🟡验证中 / 🟢已登录），点击弹出登录入口与「立即重新校验」。
 * 中间：动态提示（已从缓存加载 / 正在请求网络数据… / 上次校验时间）。
 * 右侧：扫描警告 + 本地索引状态 + 代理链路。
 *
 * 所有登录态都来自 src/sessionState.ts（与在线页共用同一个探测 Promise），
 * 这里绝不做自己的阻塞式检查。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { isNetworkError, networkFailureKind, noteRequestFailure } from "../online/networkError";
import {
  resolveDiagnosisLabelKey,
  diagnosisPayload,
  diagnosisPrimaryError,
  diagnosisRunning,
  diagnosisVerdict,
  runNetworkDiagnosis,
} from "../online/networkDiagnosis";
import { proxySource, refreshProxySource } from "../online/proxySourceStore";
import { openExternalUrl } from "../api";
import { translateBackendMessage } from "../format";
import {
  authState,
  closeLoginAfterSuccess,
  ensureSession,
  flowState,
  lastCheckedMs,
  logout,
  manualActive,
  probeNetwork,
  requestManualRefresh,
  sessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
  setStatusMessageKey,
  startLogin,
  statusMessage,
} from "../sessionState";
import { deriveIndexBar, indexBar, retryIndexSync } from "../online/indexStatusStore";

/**
 * 右侧状态区（原顶部 rootbar，2026-11-13 迁移到底栏，2026-11-15 收缩）：
 * 本地模式下只保留「扫描警告」按钮；根目录 / 已订阅 / 扫描时间 / 本地数 / 显示数
 * 已按用户要求全部撤出底栏，右侧空间留给索引状态与代理胶囊。
 * 数据全部由 App.vue 从 LocalBrowser expose 透传，这里不重复建统计状态。
 */
defineProps<{
  mode: "local" | "online" | "favorites";
  warningCount?: number;
}>();
const emit = defineEmits<{
  (event: "toggle-warnings"): void;
}>();
const { t } = useI18n();

const menuOpen = ref(false);
/** 校验连接进行中（防连点） */
const networkProbing = ref(false);
/** 最近一次探测结果；并发调用时复用它，避免连点第二次误报「不通」 */
const lastProbeOk = ref<boolean | null>(null);
/** 退出登录进行中 / 上一次失败原因（失败必须如实显示，不能假装成功） */
const loggingOut = ref(false);
const logoutError = ref<string | null>(null);

/** 手动登录是否已成功并保留窗口：此阶段不再转圈，提供「关闭登录窗口」入口 */
const loginSucceeded = computed(() => manualActive.value && flowState.value === "success");
const loginButtonLabel = computed(() => {
  if (!manualActive.value) return t("statusbar.loginOpen");
  switch (flowState.value) {
    case "openingWindow":
      return t("statusbar.loginOpening");
    case "waitingBrowser":
      return t("statusbar.loginWaitingBrowser");
    case "checking":
      return t("statusbar.loginVerifying");
    case "success":
      return t("statusbar.loginSuccess");
    default:
      return t("statusbar.loginWait");
  }
});

async function onCloseLoginWindow(): Promise<void> {
  await closeLoginAfterSuccess();
}
const dot = computed(() => {
  // 网络层失败优先于登录态：Cookie 还在但网断了，不能继续显示绿灯
  if (stickyActive.value || diagnosisFailed.value) return "🔴";
  if (authState.value === "authenticated") return "🟢";
  if (authState.value === "expired" || authState.value === "serverError") return "🔴";
  if (sessionPhase.value === "checking") return "🟡";
  return "⚪";
});

/** 当前是否真的配了代理（direct = 没配）；链路事实来自独立来源单例，与探针健康结论解耦 */
const usingProxy = computed(() => {
  const source = proxySource.value;
  return source === "manual" || source === "system" || source === "env";
});

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

/** 诊断分类结果（粗结论 + 细分类别），供标签 / 悬停 / 菜单消费 */
const diagnosisClassified = computed(() => ({
  verdict: diagnosisVerdict.value,
  primaryError: diagnosisPrimaryError.value,
}));

/** 是否已拿到一轮有效诊断结论（null = 尚未诊断 / 命令失败，此时旧粘滞标志才可兜底） */
const diagnosisHasResult = computed(() => diagnosisPayload.value !== null);

/** 诊断结论 → 底栏主标签 key；无有效回包（命令失败 / 尚未诊断）时返回 null，交给旧标志兜底 */
const diagnosisLabelKey = computed(() =>
  diagnosisHasResult.value ? resolveDiagnosisLabelKey(diagnosisClassified.value) : null,
);

/** 诊断是否为故障类结论（失败集合：不含 unauthenticated，认证问题走身份态表达） */
const diagnosisFailed = computed(() => {
  const v = diagnosisVerdict.value;
  return (
    v === "networkUnavailable" ||
    v === "proxySuspected" ||
    v === "proxyFailed" ||
    v === "officialServerError" ||
    v === "websiteUnreachable" ||
    v === "apiUnreachable" ||
    v === "pathMismatch"
  );
});

/**
 * 旧粘滞断网标志：只作为「尚无有效诊断结论」时的辅助证据。
 * 一旦本轮诊断已有结论，粘滞标志不得覆盖诊断判断（避免上一次请求失败的旧状态误报）。
 */
const stickyActive = computed(() => isNetworkError.value && !diagnosisHasResult.value);

/** 代理来源 → i18n key（manual / system / env / direct） */
function proxySourceKey(source: string): string {
  switch (source) {
    case "manual":
      return "statusbar.proxyManual";
    case "system":
      return "statusbar.proxySystem";
    case "env":
      return "statusbar.proxyEnv";
    default:
      return "statusbar.proxyDirect";
  }
}

/** 代理来源 → 悬停补充文案 */
function proxySourceLabel(source: string): string {
  return t("statusbar.proxyLabel", { src: t(proxySourceKey(source)) });
}

/**
 * 右下角代理胶囊：来源事实来自独立单例 `proxySourceStore`，与诊断回包解耦。
 * 启动先经 `getNetworkSettings()` 兜底读取；诊断成功用最新 proxy_info 覆盖；
 * 诊断失败 / 探针不可达不清空已取得的事实。direct 也作为事实展示，不把「直连」表述为代理故障。
 */
const proxyText = computed(() => {
  const source = proxySource.value;
  if (!source) return "";
  return proxySourceLabel(source);
});

const accountText = computed(() => {
  // 检测中：显示检查中，不继续展示过期诊断结果
  if (diagnosisRunning.value || sessionPhase.value === "checking") return t("statusbar.checkingShort");
  // 诊断分层结论优先：官网 / API / 代理 / 分叉各自给出可操作提示
  if (diagnosisLabelKey.value) return t(diagnosisLabelKey.value);
  // 旧粘滞断网标志仅在没有有效诊断结论时兜底（真实请求成功才会清零）
  if (stickyActive.value) return networkDownLabel.value;
  switch (authState.value) {
    case "authenticated":
      return t("statusbar.onlineShort");
    case "expired":
      return t("statusbar.expiredShort");
    case "serverError":
      return t("statusbar.serverError");
    case "networkUnreachable":
      return networkDownLabel.value || t("statusbar.networkDown");
    default:
      break;
  }
  // 未登录：不管网络通不通，只显示"离线 · 未登录"，不再提网络问题（误导用户）
  return t("statusbar.offlineNotLoggedIn");
});

/** 悬停：只放补充详情（来源 / Cookie / 代理事实 / 探针状态），不重复主状态文案 */
const accountTitle = computed(() => {
  const info = sessionInfo.value;
  const probe = diagnosisPayload.value;
  const supplements: string[] = [];
  if (authState.value === "authenticated" && info) {
    supplements.push(
      t("statusbar.source", {
        src: info.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview"),
        n: info.cookieCount,
      }),
    );
  }
  if (probe) {
    supplements.push(proxySourceLabel(probe.proxy.source));
    if (probe.proxy.pathMismatch) supplements.push(t("statusbar.diagPathMismatch"));
    supplements.push(
      t("statusbar.diagProbeTitle", {
        website: probe.website.reachable ? String(probe.website.status ?? 200) : t("statusbar.diagProbeFailedWord"),
        api: probe.api.reachable ? String(probe.api.status ?? 200) : t("statusbar.diagProbeFailedWord"),
      }),
    );
  }
  if (authState.value === "expired") supplements.push(t("statusbar.sessionExpired"));
  if (authState.value === "serverError") supplements.push(t("statusbar.serverErrorHint"));
  if (supplements.length > 0) return supplements.join(" · ");
  return t("statusbar.loginHint");
});

/** 二级菜单里的账号行（原来在线页侧栏那段已迁到这里，全应用只留这一处） */
const sessionLine = computed(() => {
  const info = sessionInfo.value;
  if (authState.value === "authenticated" && info) {
    return t("statusbar.sessionLine", {
      src: info.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview"),
      n: info.cookieCount,
    });
  }
  if (authState.value === "expired") return t("statusbar.sessionExpired");
  return t("statusbar.offline");
});

const middleText = computed(() => {
  // 断网时这条信息比“已从缓存加载 / 数据已刷新”更重要；仅在无有效诊断结论时由旧标志兜底
  if (stickyActive.value) return networkDownHint.value || t("statusbar.networkDownHint");
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

// ---------------- 官方 Mod 本地索引（底栏唯一状态出口） ----------------

/**
 * 索引进度不再常驻在线页，而是统一在这里展示：
 * - 自动更新关闭 → 整块隐藏（不显示任何索引字样，也不显示手动入口）；
 * - 同步中 → 真实已处理条数 / 可靠总量（拿不到总量时不带百分比）；
 * - 完整成功 → 本地条数 + 本轮真实新增（自动：今日已同步；手动：已同步），常驻到下一轮结果；
 * - 失败 → 本地条数 + 失败状态 + 唯一「手动重试」按钮（复用同一个同步核心）。
 */
const indexView = computed(() => deriveIndexBar(indexBar));

function indexBaseText(): string {
  return t("statusbar.indexReady", { n: indexBar.status?.indexed ?? 0 });
}

const indexText = computed(() => {
  const st = indexBar.status;
  switch (indexView.value.kind) {
    case "hidden":
      return "";
    case "syncing": {
      const n = st?.indexed ?? 0;
      // 总量拿不到 / 比已处理还小（官方接口总量会波动）→ 只说进度，不给比例
      const total = st?.totalCount ?? 0;
      return total > n
        ? t("statusbar.indexProgress", { n, total })
        : t("statusbar.indexProgressBare", { n });
    }
    case "success": {
      const n = indexView.value.added;
      const suffix = indexView.value.auto
        ? n > 0
          ? t("statusbar.indexSyncAutoAdded", { n })
          : t("statusbar.indexSyncAutoNone")
        : n > 0
          ? t("statusbar.indexSyncManualAdded", { n })
          : t("statusbar.indexSyncManualNone");
      return `${indexBaseText()} · ${suffix}`;
    }
    case "ready":
      return indexBaseText();
    case "failed": {
      const suffix = indexView.value.auto
        ? t("statusbar.indexSyncTodayFailed")
        : t("statusbar.indexSyncManualFailed");
      return `${indexBaseText()} · ${suffix}`;
    }
    case "needLogin":
      return t("statusbar.indexNeedLogin");
    default:
      return t("statusbar.indexIdle");
  }
});

const indexTitle = computed(() => indexText.value);

async function retryIndex(): Promise<void> {
  if (indexBar.retrying) return;
  await retryIndexSync();
}

/** 帝国时代官网账号中心：微软 / Xbox 登录与 Steam 绑定的唯一入口（见 Rust open_external 白名单） */
const ACCOUNT_CENTER_URL = "https://auth.ageofempires.com/";

async function openAccountCenter(): Promise<void> {
  try {
    await openExternalUrl(ACCOUNT_CENTER_URL);
  } catch (e) {
    setStatusMessage(translateBackendMessage(typeof e === "string" ? e : String(e)));
  }
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function closeMenu() {
  menuOpen.value = false;
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
      noteRequestFailure({ kind: "timeout", message: t("statusbar.probeTimeout", { seconds: PROBE_TIMEOUT_MS / 1000 }) });
    }
    lastProbeOk.value = false;
    return false;
  } finally {
    networkProbing.value = false;
    // 测网结束后顺手跑一次独立诊断：区分官网/API/代理/路径分叉，不改动会话状态
    void runNetworkDiagnosis("manual");
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
    await logout();
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

/** 点击登录：只发意图，流程 / 轮询 / 窗口全部由 SessionController 接管；菜单保持打开 */
function onStartLogin(): void {
  startLogin("manual");
}

/**
 * 弹层开合只由「账号与网络」按钮的 toggleMenu 控制：
 * 菜单内操作（开窗登录 / 校验 / 退出 / 关窗 / 账号中心）后保持打开；
 * 点击菜单外区域与 Esc 均不关闭弹层。
 */

onMounted(() => {
  // 启动先独立读取链路来源事实，不等官网 / API 探针回包；诊断成功后由最新 proxy_info 覆盖
  void refreshProxySource();
  void runNetworkDiagnosis("startup");
});
</script>

<template>
  <footer class="statusbar">
    <button
      type="button"
      class="sb-account"
      :class="[
        sessionPhase,
        {
          'network-error':
            stickyActive || diagnosisFailed || authState === 'expired' || authState === 'serverError',
        },
      ]"
      :title="accountTitle"
      @click="toggleMenu"
    >
      <span class="sb-dot">{{ dot }}</span>
      <span class="sb-label">{{ t("statusbar.accountMenu") }}</span>
      <span v-if="(manualActive && !loginSucceeded) || networkProbing || loggingOut" class="spinner sb-spin"></span>
    </button>

    <!--
      状态文字从按钮内移到按钮右侧：
      按钮固定叫「账号与网络」，不再随「代理连接失败 / 未登录 / 已登录」变宽，
      底栏中间那条提示的起始位置也就不会被状态长短推着左右跳。
    -->
    <span
      class="sb-state"
      :class="{
        error: stickyActive || diagnosisFailed || authState === 'expired' || authState === 'serverError',
        online: authState === 'authenticated' && !stickyActive && !diagnosisFailed,
      }"
      :title="accountTitle"
    >{{ accountText }}</span>

    <div v-if="menuOpen" class="sb-menu">
      <div class="sb-menu-head">
        <div class="sb-menu-title">{{ t("statusbar.accountMenu") }}</div>
        <button
          type="button"
          class="sb-menu-close"
          :aria-label="t('common.close')"
          @click="closeMenu"
        >✕</button>
      </div>
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
        <button v-if="loginSucceeded" type="button" class="primary" @click="onCloseLoginWindow">
          {{ t("statusbar.loginCloseWindow") }}
        </button>
        <button v-else type="button" :disabled="manualActive || loggingOut" @click="onStartLogin">
          {{ loginButtonLabel }}
        </button>
      </div>
      <p v-if="loginSucceeded" class="sb-menu-note">{{ t("statusbar.loginSuccessHint") }}</p>
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
      <!-- 本地页统计组：2026-11-15 按用户要求把根目录 / 已订阅 / 扫描时间 / 本地数 / 显示数
           全部撤出底栏（右侧留给索引状态与代理胶囊），只保留「扫描警告」这类可操作项 -->
      <span v-if="mode === 'local' && (warningCount ?? 0) > 0" class="sb-stats">
        <button type="button" class="sb-stat sb-warn" @click="emit('toggle-warnings')">
          ⚠ {{ t("rootbar.warnings", { n: warningCount ?? 0 }) }}
        </button>
      </span>
      <!-- 官方 Mod 本地索引（右侧状态区）：自动更新关闭时整块不渲染；失败时这里是唯一「手动重试」入口。
           放在代理胶囊之前：代理链路始终占据最右侧 -->
      <span
        v-if="indexView.kind !== 'hidden'"
        class="sb-index"
        :class="indexView.kind"
        :title="indexTitle"
      >
        <span v-if="indexView.kind === 'syncing'" class="spinner sb-index-spin"></span>
        <span class="sb-index-text">{{ indexText }}</span>
        <button
          v-if="indexView.showRetry"
          type="button"
          class="sb-index-retry"
          :disabled="indexBar.retrying"
          @click="retryIndex"
        >
          {{ indexBar.retrying ? t("statusbar.indexRetrying") : t("statusbar.indexRetry") }}
        </button>
      </span>
      <!-- 代理来源胶囊：只表达当前链路事实（手动 / 系统 / 环境变量 / 直连），不附带故障判定 -->
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
  user-select: none;
  /* 去掉原来 12% 强调色的顶部内高光：底栏是中性信息区，不随 Accent Color 变色 */
}

/* 账号与网络区不继承强调色：正文用常规文字色，状态用语义色，其余一律中性 */
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
  color: var(--parch);
  font-size: calc(11.5px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: normal;
  cursor: pointer;
}
.sb-account:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.sb-account:active {
  background: var(--bg-panel-hi);
}
/* 全局 focus-visible 用的是 --accent-dim（会随强调色变），这里改回中性描边 */
.sb-account:focus-visible {
  outline-color: var(--text-soft);
}
.sb-account.online {
  color: var(--ok-text);
}
.sb-account.checking {
  color: var(--muted);
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
  color: var(--ok-text);
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

/* 索引状态块（右侧状态区）：中性信息区，放在代理胶囊之前；
   宽屏尽量完整显示，窄屏由省略号截断；重试按钮始终可见 */
.sb-index {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(560px, 42vw);
  overflow: hidden;
  white-space: nowrap;
  color: var(--parch-dim);
  font-size: calc(10.5px * var(--global-scale));
}
.sb-index.syncing {
  color: var(--gold-dim);
}
.sb-index.success,
.sb-index.ready {
  color: var(--ok-text);
}
.sb-index.failed {
  color: var(--danger-text);
}
.sb-index.needLogin {
  color: var(--danger-text);
}
.sb-index-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-index-spin {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-width: 1.5px;
}
.sb-index-retry {
  flex: 0 0 auto;
  padding: 1px 8px;
  border: 1px solid rgba(var(--danger-rgb), 0.55);
  border-radius: 999px;
  background: transparent;
  color: var(--danger-text);
  font-size: calc(10px * var(--global-scale));
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.sb-index-retry:hover {
  background: rgba(var(--danger-rgb), 0.12);
}
.sb-index-retry:focus-visible {
  outline-color: var(--text-soft);
}

/* 代理来源胶囊：中性事实标签，窄窗口只省略不换行、不撑破底栏 */
.sb-pill {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40vw;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--parch-dim);
  font-size: calc(10px * var(--global-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-right {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 右侧统计组（原顶部 rootbar）：紧凑横排，只留本地数与显示数 */
.sb-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
.sb-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  color: var(--parch-dim);
  font-size: calc(10.5px * var(--global-scale));
  white-space: nowrap;
}
.sb-warn {
  padding: 1px 8px;
  border: 1px solid rgba(var(--danger-rgb), 0.55);
  border-radius: 999px;
  background: rgba(var(--danger-rgb), 0.1);
  color: var(--danger-text);
  font-size: calc(10px * var(--global-scale));
  cursor: pointer;
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
.sb-menu-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.sb-menu-title {
  padding: 2px 2px 8px;
  color: var(--gold-bright);
  font-size: calc(11.5px * var(--global-scale));
  letter-spacing: calc(1.2px * var(--ui-tracking));
  text-transform: uppercase;
}
/* 菜单关闭按钮：中性 ghost，不抢标题视觉（辅助信息区不用 accent / gold 强调） */
.sb-menu-close {
  padding: 2px 6px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: calc(11px * var(--global-scale));
  line-height: 1;
  cursor: pointer;
}
.sb-menu-close:hover {
  color: var(--parch);
  background: var(--bg-hover);
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
/* v3.3：平台选项已收敛为单一微软 / Xbox 入口，所以不再需要 hover / active 态。
   这里只是账号来源说明，不是强调控件，故走中性边框与中性文字。 */
.sb-menu-platform {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin-bottom: 6px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel);
  text-align: left;
}
.sb-menu-label {
  font-size: calc(12px * var(--global-scale));
  color: var(--parch);
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
/* 普通状态说明走中性；错误态由 `.err` 覆盖为语义红 */
.sb-menu-note {
  margin-top: 8px;
  font-size: calc(10.5px * var(--global-scale));
  line-height: 1.6;
  color: var(--parch-dim);
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
