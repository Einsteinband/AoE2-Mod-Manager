import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { flushPromises } from "@vue/test-utils";

/**
 * 在线页会话适配层回归（A 级代码级验证）：
 * manual 登录流程活动期间，诊断探针 runProbe 必须避让——
 * 不得把正在进行 OAuth 的可见登录窗口当作隐藏探测窗复用。
 */

const manualActiveMock = vi.hoisted(() => ({ value: false }));

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

vi.mock("../../online/errors", () => ({
  messageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock("../../format", () => ({
  msgText: (msg: { key: string; params?: Record<string, unknown> } | string | null) =>
    typeof msg === "string" ? msg : msg ? msg.key : "",
}));

vi.mock("../../online/service", () => ({
  modTags: vi.fn(async () => []),
  probeAccountWindow: vi.fn(async () => "probe-ok"),
}));

vi.mock("../../sessionState", () => ({
  ensureSession: vi.fn(async () => true),
  handleAuthFailure: vi.fn(),
  manualActive: manualActiveMock,
  sessionError: ref(null),
  sessionInfo: ref(null),
  sessionPhase: ref("offline"),
  silentActive: ref(false),
  silentNote: ref(null),
  flowState: ref("idle"),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  closeLoginAfterSuccess: vi.fn(async () => undefined),
}));

import { useOnlineSession } from "../online/useOnlineSession";
import { probeAccountWindow } from "../../online/service";

beforeEach(() => {
  vi.clearAllMocks();
  manualActiveMock.value = false;
  vi.mocked(probeAccountWindow).mockResolvedValue("probe-ok");
});

describe("runProbe 避让 manual 流程", () => {
  it("manual 活动期间跳过隐藏窗口探测：不调用 probeAccountWindow，不进入 probing 态", async () => {
    manualActiveMock.value = true;
    const session = useOnlineSession({ reloadAfterLogout: async () => undefined });

    await session.runProbe();
    await flushPromises();

    expect(probeAccountWindow).not.toHaveBeenCalled();
    expect(session.probing.value).toBe(false);
    expect(session.probeResult.value).toBe("");
  });

  it("manual 非活动时正常发起隐藏窗口探测并回显结果", async () => {
    const session = useOnlineSession({ reloadAfterLogout: async () => undefined });

    await session.runProbe();
    await flushPromises();

    expect(probeAccountWindow).toHaveBeenCalledTimes(1);
    expect(session.probeResult.value).toBe("probe-ok");
    expect(session.probing.value).toBe(false);
  });
});
