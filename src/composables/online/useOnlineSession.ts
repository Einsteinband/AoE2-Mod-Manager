/**
 * 在线页账号 / 登录态适配层（薄封装）。
 *
 * 登录生命周期（流程、定时器、窗口、轮询、静默重登、探针）全部由
 * `src/session/controller.ts` 统一持有；本文件只做：
 * 1. 把 Controller 状态镜像成组件可读的 ref；
 * 2. 承载与登录无关的业务片段（官方分类字典、诊断探针结果）。
 *
 * 这里不再启动任何登录轮询 / silent timer，也不直接修改全局 authState。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { messageOf } from "../../online/errors";
import { msgText, type Msg } from "../../format";
import { modTags, probeAccountWindow } from "../../online/service";
import { FALLBACK_TAGS, type ModTag, type SessionStatus } from "../../online/types";
import {
  ensureSession,
  handleAuthFailure,
  manualActive,
  sessionError as sharedSessionError,
  sessionInfo,
  sessionPhase,
  silentActive,
  silentNote,
  flowState,
  startLogin as controllerStartLogin,
  cancelLogin as controllerCancelLogin,
  closeLoginAfterSuccess as controllerCloseSuccess,
} from "../../sessionState";

const TAGS_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 20_000;

export function useOnlineSession(_deps: {
  /** 退出登录后用缓存重绘列表；由 Controller logout 流程外部触发保留位 */
  reloadAfterLogout: () => Promise<void>;
  /** 开始登录：清掉上一条安装提示 */
  onLoginStart?: () => void;
}) {
  const { t } = useI18n();

  // ---------------- Controller 状态镜像 ----------------

  const session = ref<SessionStatus | null>(null);
  const sessionErrorState = ref<Msg | null>(null);
  const sessionError = computed(() => msgText(sessionErrorState.value));

  /** 手动登录流程是否活动（派生自 Controller） */
  const waitingLogin = computed(() => manualActive.value);
  /** 当前登录流程阶段（openingWindow / waitingBrowser / checking / success / …） */
  const loginFlowState = computed(() => flowState.value);
  const silentAuth = computed(() => silentActive.value);
  const silentAuthNote = computed(() => silentNote.value);

  watch(
    sessionInfo,
    (info) => {
      session.value = info;
    },
    { immediate: true },
  );

  // ---------------- 诊断探针（业务片段，非登录生命周期） ----------------

  const probing = ref(false);
  const probeResultState = ref<Msg | null>(null);
  const probeResult = computed(() => msgText(probeResultState.value));

  /** 旧退出链路残留的提示位；Controller logout 接管后保持空态 */
  const netClearing = ref(false);
  const netError = ref<string | null>(null);
  const netMessage = ref<string | null>(null);

  // ---------------- 官方分类字典（匿名可读，失败用内置兜底） ----------------

  const tags = ref<ModTag[]>([]);
  const tagsErrorState = ref<Msg | null>(null);
  const tagsError = computed(() => msgText(tagsErrorState.value));

  async function loadTags(): Promise<void> {
    tagsErrorState.value = null;
    if (sessionPhase.value !== "online") {
      tags.value = FALLBACK_TAGS;
      return;
    }
    try {
      const list = await withTimeoutMsg(modTags(), TAGS_TIMEOUT_MS, t("sidebar.officialTags"));
      if (list.length) {
        tags.value = list;
      } else {
        tags.value = FALLBACK_TAGS;
        tagsErrorState.value = { key: "online.tagsEmpty" };
      }
    } catch (e) {
      tags.value = FALLBACK_TAGS;
      tagsErrorState.value = { key: "online.tagsFailed" };
    }
  }

  /** 诊断：让后端显式创建隐藏会话窗口，把真实结果或错误显示出来。
   *  manual 登录流程活动期间跳过：不得把正在 OAuth 的可见登录窗口当作隐藏探测窗复用。 */
  async function runProbe(): Promise<void> {
    if (manualActive.value) return;
    probing.value = true;
    probeResultState.value = null;
    sessionErrorState.value = null;
    try {
      probeResultState.value = await withTimeoutMsg(
        probeAccountWindow(),
        PROBE_TIMEOUT_MS,
        t("online.probe"),
      );
    } catch (e) {
      probeResultState.value = { key: "online.probeFailed", params: { msg: messageOf(e) } };
    } finally {
      probing.value = false;
    }
  }

  async function withTimeoutMsg<T>(
    promise: Promise<T>,
    ms: number,
    what: string,
  ): Promise<T> {
    const timer = window.setTimeout(() => {
      throw new Error(t("online.timeout", { what, sec: Math.round(ms / 1000) }));
    }, ms);
    try {
      return await promise;
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------------- Controller 动作薄封装 ----------------

  async function refreshSession(): Promise<void> {
    sessionErrorState.value = null;
    await ensureSession(true);
    session.value = sessionInfo.value;
    sessionErrorState.value = sharedSessionError.value;
  }

  function startLogin(): void {
    _deps.onLoginStart?.();
    controllerStartLogin("manual");
  }

  function stopWaiting(): void {
    controllerCancelLogin("user-cancelled");
  }

  /** 登录成功后手动关闭登录窗口：身份态保持不变 */
  async function closeLoginWindow(): Promise<void> {
    await controllerCloseSuccess();
  }

  /** 401 统一入口：把结构化错误透传给 Controller 分类身份态，并按策略触发静默恢复 */
  function reportUnauthorized(error: unknown, message: string): void {
    session.value = null;
    handleAuthFailure(error, message);
  }

  /** 兼容旧装配层：Controller 为全局单例，组件卸载无需回收生命周期 */
  function dispose(): void {}

  return {
    session,
    sessionError,
    waitingLogin,
    loginFlowState,
    probing,
    probeResult,
    netClearing,
    netError,
    netMessage,
    tags,
    tagsError,
    silentAuth,
    silentAuthNote,
    refreshSession,
    runProbe,
    startLogin,
    stopWaiting,
    closeLoginWindow,
    loadTags,
    reportUnauthorized,
    dispose,
  };
}
