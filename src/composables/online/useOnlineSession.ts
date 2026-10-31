/**
 * 在线页的「账号 / 登录态」：登录窗口、轮询、静默免密登录、退出登录、分类字典。
 *
 * 登录态本身是全局单例（`sessionState`），本文件只做两件事：
 * 1. 把 `sessionInfo` 镜像成组件内可读的 `session`（底栏与在线页同源，绝不再发第二份探测）；
 * 2. 承载登录流程的**临时**状态（等待中 / 探测结果 / 提示文案）与定时器，
 *    这些随组件卸载即可丢弃，不需要跨页面共享。
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { messageOf } from "../../online/errors";
import {
  clearLoginCache,
  closeLoginWindow,
  findMods,
  loginTargets,
  modTags,
  openLogin,
  openLoginSilent,
  probeAccountWindow,
  sessionStatus,
  uiLog,
} from "../../online/service";
import {
  FALLBACK_TAGS,
  SORT_OPTIONS,
  type LoginTarget,
  type ModTag,
  type SessionStatus,
} from "../../online/types";
import {
  ensureSession,
  markOnline,
  markUnauthenticated,
  sessionError as sharedSessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
} from "../../sessionState";

/** 分类字典请求上限：官方接口偶尔很慢，不能把界面卡在“加载中” */
const TAGS_TIMEOUT_MS = 20_000;

export function useOnlineSession(deps: {
  /** 退出登录后用缓存重绘列表（不清空 items，离线也能继续看） */
  reloadAfterLogout: () => Promise<void>;
  /** 退出登录后丢弃收藏候选池 */
  resetFavoritePool: () => void;
  /** 开始登录：清掉上一条安装提示（避免“登录前那个模组的报错”一直挂着） */
  onLoginStart?: () => void;
}) {
  const { t, te } = useI18n();

  const session = ref<SessionStatus | null>(null);
  const sessionError = ref<string | null>(null);
  const waitingLogin = ref(false);
  const probing = ref(false);
  const probeResult = ref<string | null>(null);

  /**
   * 共享会话状态的镜像：本组件绝不再发起第二份探测，只把 sessionState 的结果同步到本地 ref，
   * 原有的 session?.xxx 判断全部保持不变。
   *
   * immediate 必须为 true：本组件被 KeepAlive 缓存，用户可能在 App.vue 已完成静默校验
   * 之后才第一次切到在线页——此时 sessionInfo 早已有值，普通 watch 永远收不到。
   */
  watch(
    sessionInfo,
    (info) => {
      session.value = info;
    },
    { immediate: true },
  );

  /** 登录平台（Steam / 微软 / PSN），由 Rust 侧提供 URL */
  const platforms = ref<LoginTarget[]>([]);
  const platform = ref("microsoft");

  /** 会话 / 退出登录的临时提示（代理与登录项已迁到 SettingsModal） */
  const netClearing = ref(false);
  const netError = ref<string | null>(null);
  const netMessage = ref<string | null>(null);

  /** 左侧分类（官方 /api/v4/mods/Tags） */
  const tags = ref<ModTag[]>([]);
  const tagsError = ref<string | null>(null);

  let pollTimer: number | null = null;
  let silentTimer: number | null = null;

  /** 登录入口按钮：后端只给平台 key，文案走 i18n（后端 label/hint 作为兜底） */
  function loginLabel(target: LoginTarget): string {
    const key = `online.login.${target.key}.label`;
    return te(key) ? t(key) : target.label;
  }

  function loginHint(target: LoginTarget): string {
    const key = `online.login.${target.key}.hint`;
    return te(key) ? t(key) : target.hint;
  }

  /** 给可能卡住的 invoke 加超时，避免界面永远停在“检查中” */
  function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(t("online.timeout", { what, sec: Math.round(ms / 1000) })));
      }, ms);
      promise
        .then((value) => {
          window.clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          window.clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** 手动「重新检查登录状态」：强制再探一次；成功后由 sessionEpoch 统一触发刷新 */
  async function refreshSession(): Promise<void> {
    sessionError.value = null;
    await ensureSession(true);
    session.value = sessionInfo.value;
    sessionError.value = sharedSessionError.value;
  }

  /** 平台清单（后端本地常量，不走网络） */
  async function loadPlatforms(): Promise<void> {
    try {
      platforms.value = await loginTargets();
      if (!platforms.value.some((p) => p.key === platform.value)) {
        platform.value = platforms.value[0]?.key ?? "microsoft";
      }
    } catch (e) {
      netError.value = t("online.loginTargetsFailed", { msg: messageOf(e) });
    }
  }

  /** 分类字典：GET /api/v4/mods/Tags（匿名可读）；失败时用内置 17 项兜底 */
  async function loadTags(): Promise<void> {
    tagsError.value = null;
    // 离线 / 未登录：官方字典接口需要登录态，直接用内置 17 项兜底，不打网络
    if (sessionPhase.value !== "online") {
      tags.value = FALLBACK_TAGS;
      return;
    }
    try {
      const list = await withTimeout(modTags(), TAGS_TIMEOUT_MS, t("sidebar.officialTags"));
      if (list.length) {
        tags.value = list;
      } else {
        tags.value = FALLBACK_TAGS;
        tagsError.value = t("online.tagsEmpty");
      }
    } catch (e) {
      tags.value = FALLBACK_TAGS;
      tagsError.value = t("online.tagsFailed", { msg: messageOf(e) });
    }
  }

  /** 诊断：让后端显式创建隐藏会话窗口，把真实结果或错误显示出来 */
  async function runProbe(): Promise<void> {
    probing.value = true;
    probeResult.value = null;
    sessionError.value = null;
    try {
      probeResult.value = await withTimeout(
        probeAccountWindow(),
        25_000,
        t("online.probe"),
      );
    } catch (e) {
      probeResult.value = t("online.probeFailed", { msg: messageOf(e) });
    } finally {
      probing.value = false;
    }
  }

  async function doLogout(): Promise<void> {
    if (netClearing.value) return;
    netClearing.value = true;
    netError.value = null;
    netMessage.value = null;
    try {
      const text = await withTimeout(clearLoginCache(), 30_000, t("online.clearCache"));
      netMessage.value = text;
      session.value = null;
      deps.resetFavoritePool();
      await refreshSession();
      // 退出登录不清空列表：直接用缓存重绘，离线也能继续看
      await deps.reloadAfterLogout();
    } catch (e) {
      netError.value = messageOf(e);
    } finally {
      netClearing.value = false;
    }
  }

  function stopPoll(): void {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function startLogin(target = platform.value): Promise<void> {
    waitingLogin.value = true;
    sessionError.value = null;
    deps.onLoginStart?.();
    const chosen = platforms.value.find((p) => p.key === target);
    void uiLog("info", `用户点击登录：platform=${target} url=${chosen?.url ?? "(未加载)"}`);
    try {
      await withTimeout(openLogin(target), 25_000, t("online.openLogin"));
    } catch (e) {
      waitingLogin.value = false;
      sessionError.value = messageOf(e);
      void uiLog("error", `打开登录窗口失败：${messageOf(e)}`);
      return;
    }
    stopPoll();
    pollTimer = window.setInterval(async () => {
      try {
        const status = await withTimeout(sessionStatus(), 15_000, t("online.recheck"));
        session.value = status;
        if (status.error) sessionError.value = status.error;
        void uiLog(
          "info",
          `轮询登录状态：loggedIn=${status.loggedIn} cookieCount=${status.cookieCount} windowReady=${status.windowReady}`,
        );
        if (!status.loggedIn) return;

        // Cookie 存在不代表真有权限，先跑一次最小请求验证，通过才关闭登录窗口
        try {
          const probe = await withTimeout(
            findMods({ query: "", start: 1, count: 1, sort: SORT_OPTIONS[0].value, order: "DESC" }),
            20_000,
            t("online.probe"),
          );
          void uiLog("info", `验证通过（返回 ${probe.items.length} 条），关闭登录窗口并加载列表`);
          waitingLogin.value = false;
          stopPoll();
          await closeLoginWindow();
          // 不在这里直接 reload：bump epoch 后由 handleSessionEpoch 统一刷新，避免重复请求
          markOnline(status);
          setStatusMessage(t("statusbar.loginDone"));
        } catch (e) {
          const text = messageOf(e);
          sessionError.value = t("online.cookieButFailed", { text });
          void uiLog("warn", `Cookie 存在但接口失败，保持窗口打开：${text}`);
        }
      } catch (e) {
        sessionError.value = messageOf(e);
        void uiLog("warn", `轮询异常：${messageOf(e)}`);
      }
    }, 2500);
  }

  /** 后台静默登录：不阻塞首屏，失败也不打断用户 */
  const silentAuth = ref(false);
  const silentAuthNote = ref<string | null>(null);
  let silentTried = false;

  function stopSilentTimer(): void {
    if (silentTimer !== null) {
      window.clearInterval(silentTimer);
      silentTimer = null;
    }
  }

  /**
   * 静默免密登录：用隐藏窗口打开登录入口，靠平台 SSO 的持久 Cookie 自动跑完跳转链；
   * 每 2.5 秒查一次，拿到“Cookie 存在”就算成功，最多 6 次（约 15 秒）。
   */
  async function silentReauth(reason: string): Promise<void> {
    if (silentTried || silentAuth.value || waitingLogin.value) return;
    silentTried = true;
    silentAuth.value = true;
    silentAuthNote.value = t("online.silentNote", { reason });
    void uiLog("info", `后台免密登录开始：${reason}`);
    try {
      await withTimeout(openLoginSilent(platform.value), 15_000, t("online.openLogin"));
    } catch (e) {
      silentAuth.value = false;
      silentAuthNote.value = t("online.silentFailedStart", { msg: messageOf(e) });
      return;
    }

    let ticks = 0;
    stopSilentTimer();
    silentTimer = window.setInterval(async () => {
      ticks += 1;
      let ok = false;
      try {
        // 只查会话状态（读 Cookie，**不发任何 Find 请求**）：
        // 旧实现每次都打一次 /Find 探测，是“每 2 秒一个 POST”的罪魁祸首之一。
        const status = await withTimeout(sessionStatus(), 15_000, t("online.recheck"));
        if (status.loggedIn) {
          ok = true;
          void uiLog("info", "后台免密登录成功（会话 Cookie 已就绪）");
          stopSilentTimer();
          silentAuth.value = false;
          silentAuthNote.value = null;
          sessionError.value = null;
          await closeLoginWindow();
          // 只在 离线→在线 这一跳 bump epoch；重复探测不会反复触发列表刷新
          markOnline(status);
          setStatusMessage(t("statusbar.loginDone"));
        }
      } catch (e) {
        void uiLog("info", `后台免密登录第 ${ticks} 次未完成：${messageOf(e)}`);
      }
      if (!ok && ticks >= 6) {
        stopSilentTimer();
        silentAuth.value = false;
        silentAuthNote.value = t("online.silentFailed");
      }
    }, 2500);
  }

  async function stopWaiting(): Promise<void> {
    waitingLogin.value = false;
    stopPoll();
    void uiLog("info", "用户取消等待登录：隐藏登录窗口（前端主动 close）");
    await closeLoginWindow();
  }

  /**
   * 接口明确返回 401：立刻把底栏打回离线，并尝试一次静默重登。
   * （列表层发现 401 时通过 deps 回调转进来，避免它直接依赖登录流程。）
   */
  function reportUnauthorized(message: string): void {
    session.value = null;
    markUnauthenticated(message);
    void silentReauth(t("online.reasonUnauthorized"));
  }

  /** 组件卸载：清掉登录轮询与静默重登定时器 */
  function dispose(): void {
    stopPoll();
    stopSilentTimer();
  }

  return {
    session,
    sessionError,
    waitingLogin,
    probing,
    probeResult,
    platforms,
    platform,
    netClearing,
    netError,
    netMessage,
    tags,
    tagsError,
    silentAuth,
    silentAuthNote,
    loginLabel,
    loginHint,
    refreshSession,
    loadPlatforms,
    loadTags,
    runProbe,
    doLogout,
    startLogin,
    stopWaiting,
    silentReauth,
    reportUnauthorized,
    dispose,
  };
}

export type OnlineSession = ReturnType<typeof useOnlineSession>;
