import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

/**
 * SessionController 生命周期回归：身份态 / 流程态 / generation+attempt /
 * manual-silent 互斥 / 401·网络·5xx 分类 / 窗口关闭 / 旧回调不污染新状态。
 *
 * 这里是 A 级（代码级）验证：Tauri invoke 与 WebView 均被 mock，不替代实机 C 级验收。
 */

const { isNetworkFailureMock, listenEvents, listenHandlers } = vi.hoisted(() => ({
  isNetworkFailureMock: vi.fn(() => false),
  listenEvents: [] as string[],
  listenHandlers: [] as Array<(payload: unknown) => void>,
}));

vi.mock("../../online/service", () => ({
  clearLoginCache: vi.fn(async () => "ok"),
  closeLoginWindow: vi.fn(async () => undefined),
  installedMods: vi.fn(async () => ({
    totalCount: 1,
    isLoggedOn: true,
    items: [],
    serverMessage: null,
  })),
  modTags: vi.fn(async () => []),
  openLogin: vi.fn(async () => undefined),
  openLoginSilent: vi.fn(async () => undefined),
  sessionStatus: vi.fn(async () => loggedOutStatus()),
  startupSession: vi.fn(async () => loggedOutStatus()),
  uiLog: vi.fn(async () => undefined),
}));

vi.mock("../../i18n", () => ({ translate: (key: string) => key }));
vi.mock("../../format", () => ({ translateBackendMessage: (msg: string) => msg }));
vi.mock("../../online/networkError", () => ({
  isNetworkError: vi.fn(() => false),
  isNetworkFailure: isNetworkFailureMock,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    listenEvents.push(event);
    listenHandlers.push((payload) => handler({ payload }));
    return () => undefined;
  }),
}));

import {
  authState,
  closeLoginAfterSuccess,
  flowState,
  getState,
  handleAuthFailure,
  logout,
  manualActive,
  sessionGeneration,
  silentActive,
  startLogin,
  startSilentReauth,
  ensureSession,
  ensureStartupSession,
  verifyAuthenticated,
} from "../controller";
import { installedMods, openLogin, sessionStatus, startupSession } from "../../online/service";
import type { FindResult } from "../../online/types";

function loggedOutStatus() {
  return {
    loggedIn: false,
    cookieCount: 0,
    windowReady: false,
    storage: "",
    cookieSource: null,
    error: null,
  };
}

function loggedInStatus() {
  return {
    loggedIn: true,
    cookieCount: 2,
    windowReady: true,
    storage: "webview",
    cookieSource: "webview",
    error: null,
  };
}

beforeEach(async () => {
  isNetworkFailureMock.mockReturnValue(false);
  vi.clearAllMocks();
  vi.mocked(installedMods).mockResolvedValue({
    totalCount: 1,
    isLoggedOn: true,
    items: [],
    serverMessage: null,
  });
  // 每个用例前回到匿名 / idle，避免上一个用例的残留 attempt 污染断言
  if (getState().attemptId !== null || authState.value !== "anonymous") {
    await logout();
  }
  await flushPromises();
});

describe("会话代际与尝试隔离", () => {
  it("logout 打断 waitingBrowser：流程回 idle，身份回 anonymous，手动活动态清除", async () => {
    startLogin("manual");
    await flushPromises();
    expect(getState().flowState).toBe("waitingBrowser");
    expect(manualActive.value).toBe(true);

    await logout();
    expect(getState().flowState).toBe("idle");
    expect(authState.value).toBe("anonymous");
    expect(manualActive.value).toBe(false);
  });

  it("logout 后在飞探针的旧代际结果被丢弃，不能写回 authenticated；随后可立即重登", async () => {
    let resolveProbe!: (value: FindResult) => void;
    vi.mocked(installedMods).mockImplementation(
      () =>
        new Promise<FindResult>((res) => {
          resolveProbe = res;
        }),
    );
    const probe = verifyAuthenticated();

    await logout();
    const generationAfterLogout = sessionGeneration.value;

    // 旧代际的探针在 logout 后才回包：generation 已推进，结果必须被丢弃
    resolveProbe({ totalCount: 1, isLoggedOn: true, items: [], serverMessage: null });
    const ok = await probe;
    expect(ok).toBe(false);
    expect(authState.value).toBe("anonymous");
    expect(sessionGeneration.value).toBe(generationAfterLogout);

    // 立即发起全新登录尝试
    startLogin("manual");
    await flushPromises();
    expect(manualActive.value).toBe(true);
    expect(authState.value).not.toBe("authenticated");
  });

  it("manual 抢占 silent：silent 被取消，只有 manual 活动", async () => {
    startSilentReauth("startup");
    await flushPromises();
    expect(silentActive.value).toBe(true);

    startLogin("manual");
    await flushPromises();
    expect(manualActive.value).toBe(true);
    expect(silentActive.value).toBe(false);
  });

  it("manual 活动期间 startup 校验不能抢占手动流程", async () => {
    startLogin("manual");
    await flushPromises();
    await ensureSession(false);
    expect(manualActive.value).toBe(true);
  });

  it("旧 attempt 的探针在同代际被新流程抢占后晚到，结果必须丢弃（attemptId 校验）", async () => {
    let resolveProbe!: (value: FindResult) => void;
    vi.mocked(installedMods).mockImplementation(
      () =>
        new Promise<FindResult>((res) => {
          resolveProbe = res;
        }),
    );

    // attempt 1：静默重登活动中，探针挂起
    startSilentReauth("startup");
    await flushPromises();
    expect(silentActive.value).toBe(true);
    const probe = verifyAuthenticated();
    const attemptBefore = getState().attemptId;

    // attempt 2：手动登录抢占静默，同属一代际
    startLogin("manual");
    await flushPromises();
    expect(manualActive.value).toBe(true);
    expect(getState().attemptId).not.toBe(attemptBefore);

    // attempt 1 的探针此刻才回包：attemptId 已不符，结果必须被丢弃
    resolveProbe({ totalCount: 1, isLoggedOn: true, items: [], serverMessage: null });
    const ok = await probe;
    expect(ok).toBe(false);
    expect(authState.value).not.toBe("authenticated");
    expect(manualActive.value).toBe(true);
    expect(silentActive.value).toBe(false);
  });
});

describe("认证失败分类", () => {
  async function signIn() {
    const ok = await verifyAuthenticated();
    expect(ok).toBe(true);
    expect(authState.value).toBe("authenticated");
  }

  it("401 → expired（不是 anonymous，也不是 serverError）", async () => {
    await signIn();
    handleAuthFailure({ kind: "http", message: "401", status: 401 });
    expect(authState.value).toBe("expired");
  });

  it("网络故障 → networkUnreachable，不得降级成 anonymous", async () => {
    await signIn();
    isNetworkFailureMock.mockReturnValue(true);
    handleAuthFailure(new Error("network timeout"));
    expect(authState.value).toBe("networkUnreachable");
    expect(authState.value).not.toBe("anonymous");
  });

  it("5xx → serverError", async () => {
    await signIn();
    handleAuthFailure({ kind: "http", message: "503", status: 503 });
    expect(authState.value).toBe("serverError");
  });
});

describe("登录窗口生命周期", () => {
  it("窗口被用户关闭：当前等待中的尝试正确结束，流程回 idle", async () => {
    startLogin("manual");
    await flushPromises();
    expect(manualActive.value).toBe(true);

    const closedHandler = listenHandlers[listenHandlers.length - 1];
    expect(closedHandler).toBeDefined();
    closedHandler({ reason: "user" });

    expect(flowState.value).toBe("idle");
    expect(manualActive.value).toBe(false);
  });
});

describe("退出后的旧定时器", () => {
  it("logout 后旧轮询定时器不再把状态写回 checking / waiting", async () => {
    startLogin("manual");
    await flushPromises();
    await logout();
    // 不推进虚拟定时器：logout 已清空 poll/silent timer，残留回调也会被代际校验丢弃
    expect(flowState.value).toBe("idle");
    expect(authState.value).toBe("anonymous");
  });
});

describe("事件分离：索引中止不复位会话", () => {
  it("不再监听 index-cancelled；会话复位只走 session-invalidated", () => {
    expect(listenEvents).not.toContain("online://index-cancelled");
    expect(listenEvents).toContain("online://session-invalidated");
  });

  it("已 authenticated 时打开登录窗口，身份态保持 authenticated，不被清成 anonymous", async () => {
    await verifyAuthenticated();
    expect(authState.value).toBe("authenticated");
    startLogin("manual");
    await flushPromises();
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("waitingBrowser");
  });

  it("session-invalidated 事件：anonymous + idle，代际 +1", async () => {
    await verifyAuthenticated();
    const gen = sessionGeneration.value;
    const handler = listenHandlers[listenEvents.indexOf("online://session-invalidated")];
    expect(handler).toBeDefined();
    handler!({ reason: "invalidated" });
    expect(authState.value).toBe("anonymous");
    expect(flowState.value).toBe("idle");
    expect(sessionGeneration.value).toBe(gen + 1);
  });
});

describe("手动登录成功：保留窗口与身份态", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runManualLoginSuccess(): Promise<void> {
    vi.mocked(sessionStatus).mockResolvedValue(loggedInStatus());
    startLogin("manual");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_500);
    await flushPromises();
  }

  it("探针 200 → authenticated + success，窗口保留不强制关闭", async () => {
    await runManualLoginSuccess();
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("success");
    expect(manualActive.value).toBe(true);
  });

  it("success 后旧轮询回调不再回写状态", async () => {
    await runManualLoginSuccess();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("success");
  });

  it("成功后窗口被手动关闭：流程回 idle，身份保持 authenticated", async () => {
    await runManualLoginSuccess();
    const closedHandler = listenHandlers[listenEvents.indexOf("online://account-window-closed")];
    closedHandler({ reason: "user" });
    expect(flowState.value).toBe("idle");
    expect(manualActive.value).toBe(false);
    expect(authState.value).toBe("authenticated");
  });

  it("closeLoginAfterSuccess：关窗回 idle，身份保持 authenticated", async () => {
    await runManualLoginSuccess();
    await closeLoginAfterSuccess();
    expect(flowState.value).toBe("idle");
    expect(manualActive.value).toBe(false);
    expect(authState.value).toBe("authenticated");
  });
});

describe("开窗清理意图：已登录不清理有效 Cookie", () => {
  it("authenticated 时打开登录窗口，openLogin(purge=false)，身份态不被复位", async () => {
    await verifyAuthenticated();
    expect(authState.value).toBe("authenticated");
    vi.mocked(openLogin).mockClear();

    startLogin("manual");
    await flushPromises();

    expect(vi.mocked(openLogin)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openLogin).mock.calls[0][0]).toBe(false);
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("waitingBrowser");
  });

  it("anonymous 时打开登录窗口，openLogin(purge=true)", async () => {
    vi.mocked(openLogin).mockClear();
    startLogin("manual");
    await flushPromises();

    expect(vi.mocked(openLogin)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openLogin).mock.calls[0][0]).toBe(true);
  });
});

describe("manual 成功幂等：重叠节拍不重复提交 success", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("探针在飞期间第二个节拍跳过：installedMods 只调一次，success 只完成一次", async () => {
    let resolveProbe!: (value: FindResult) => void;
    vi.mocked(installedMods).mockImplementation(
      () =>
        new Promise<FindResult>((res) => {
          resolveProbe = res;
        }),
    );
    vi.mocked(sessionStatus).mockResolvedValue(loggedInStatus());

    startLogin("manual");
    await flushPromises();

    // 第一个节拍：sessionStatus 已登录，认证探针挂起
    await vi.advanceTimersByTimeAsync(2_500);
    await flushPromises();
    expect(vi.mocked(installedMods)).toHaveBeenCalledTimes(1);
    expect(getState().attemptVerifying).toBe(true);

    // 第二个节拍：探针仍在飞，必须跳过，不得发起第二次探针
    await vi.advanceTimersByTimeAsync(2_500);
    await flushPromises();
    expect(vi.mocked(installedMods)).toHaveBeenCalledTimes(1);

    resolveProbe({ totalCount: 1, isLoggedOn: true, items: [], serverMessage: null });
    await flushPromises();
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("success");
    expect(getState().attemptSucceeded).toBe(true);

    // 成功后再推进节拍：定时器已清，状态不被旧回调回写
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(authState.value).toBe("authenticated");
    expect(flowState.value).toBe("success");
    expect(vi.mocked(installedMods)).toHaveBeenCalledTimes(1);
  });
});

describe("manual 等待期间后台校验避让", () => {
  it("waitingBrowser 期间 ensureSession / ensureStartupSession 不发起后台探针、不改写流程态", async () => {
    startLogin("manual");
    await flushPromises();
    expect(flowState.value).toBe("waitingBrowser");

    vi.mocked(sessionStatus).mockClear();
    vi.mocked(startupSession).mockClear();

    const online = await ensureSession(true);
    await ensureStartupSession();

    expect(sessionStatus).not.toHaveBeenCalled();
    expect(startupSession).not.toHaveBeenCalled();
    expect(flowState.value).toBe("waitingBrowser");
    expect(manualActive.value).toBe(true);
    expect(online).toBe(false);
  });

  it("后台检查在飞期间 manual 抢占：晚到回包不翻转流程态、不写回身份", async () => {
    let resolveStatus!: (value: ReturnType<typeof loggedOutStatus>) => void;
    vi.mocked(sessionStatus).mockImplementation(
      () =>
        new Promise((res) => {
          resolveStatus = res;
        }),
    );

    // 先发起一次后台校验，探针挂起
    const background = ensureSession(false);
    await flushPromises();
    expect(flowState.value).toBe("checking");

    // manual 流程抢占：后台探针回包前进入 waitingBrowser
    startLogin("manual");
    await flushPromises();
    expect(flowState.value).toBe("waitingBrowser");

    // 后台探针此刻才回包（未登录）：continuation 必须被 manual 守卫拦截
    resolveStatus(loggedOutStatus());
    await background;
    await flushPromises();

    expect(flowState.value).toBe("waitingBrowser");
    expect(authState.value).toBe("anonymous");
    expect(manualActive.value).toBe(true);
  });

  it("manual 自有 /Installed 200 探针仍能完成登录，success 只落地一次", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sessionStatus).mockResolvedValue(loggedInStatus());
      startLogin("manual");
      await flushPromises();
      await vi.advanceTimersByTimeAsync(2_500);
      await flushPromises();

      expect(authState.value).toBe("authenticated");
      expect(flowState.value).toBe("success");
      expect(vi.mocked(installedMods)).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(flowState.value).toBe("success");
      expect(vi.mocked(installedMods)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
