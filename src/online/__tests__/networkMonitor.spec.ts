import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 网络监听回归：online/offline 事件触发诊断、防抖合并、低频兜底、
 * 登录流程变化补一轮、停止时清理监听器与定时器。A 级代码级验证。
 */

const diag = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  running: { value: false },
}));

vi.mock("../networkDiagnosis", () => ({
  runNetworkDiagnosis: diag.run,
  diagnosisRunning: diag.running,
}));

vi.mock("../../session/controller", async () => {
  const { ref } = await import("vue");
  return { flowState: ref("idle") };
});

import { flowState } from "../../session/controller";

import {
  DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  requestDiagnosis,
  startNetworkMonitoring,
  stopNetworkMonitoring,
} from "../networkMonitor";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  flowState.value = "idle";
  diag.running.value = false;
});

afterEach(() => {
  stopNetworkMonitoring();
  vi.useRealTimers();
});

describe("networkMonitor", () => {
  it("启动时注册 online / offline 监听，停止时移除", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    startNetworkMonitoring();
    expect(addSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("offline", expect.any(Function));
    stopNetworkMonitoring();
    expect(removeSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("offline", expect.any(Function));
  });

  it("断网事件触发一轮 event 诊断（防抖后）", () => {
    startNetworkMonitoring();
    window.dispatchEvent(new Event("offline"));
    expect(diag.run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(diag.run).toHaveBeenCalledWith("event");
  });

  it("恢复事件触发一轮 event 诊断", () => {
    startNetworkMonitoring();
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(diag.run).toHaveBeenCalledWith("event");
  });

  it("快速连续网络事件合并为一轮（防抖单飞）", () => {
    startNetworkMonitoring();
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(diag.run).toHaveBeenCalledTimes(1);
  });

  it("低频兜底复查按固定间隔触发 poll，不打断在途诊断", () => {
    startNetworkMonitoring();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(diag.run).toHaveBeenCalledWith("poll");

    diag.running.value = true;
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    // 在途诊断期间复查轮不重复发起
    expect(diag.run).toHaveBeenCalledTimes(1);
  });

  it("requestDiagnosis 按指定触发原因调度（settings）", () => {
    requestDiagnosis("settings");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(diag.run).toHaveBeenCalledWith("settings");
  });

  it("登录流程进入 waitingBrowser / checking 时补一轮 login 诊断", () => {
    startNetworkMonitoring();
    flowState.value = "waitingBrowser";
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(diag.run).toHaveBeenCalledWith("login");
  });

  it("停止后定时器与监听不再触发诊断", () => {
    startNetworkMonitoring();
    stopNetworkMonitoring();
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(diag.run).not.toHaveBeenCalled();
  });
});
