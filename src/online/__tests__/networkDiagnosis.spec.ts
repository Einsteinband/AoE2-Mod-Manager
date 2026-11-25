import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 网络 / 代理诊断回归（A 级代码级验证，Tauri invoke 与会话窗口全部 mock）。
 *
 * 覆盖：DNS / timeout / refused / TLS 细分、代理存在不报警、401 只改认证态、
 * 5xx 归官方异常、官网可达 API 不可达分叉、旧结果不覆盖新结果、
 * 成功 / 失败都落日志、敏感信息脱敏、不创建登录窗口、不改 SessionAuthState、
 * 通知去重与恢复单条。
 */

const controllerState = vi.hoisted(() => ({
  auth: { value: "anonymous" },
  flow: { value: "idle" },
}));

vi.mock("../../session/controller", () => ({
  authState: controllerState.auth,
  flowState: controllerState.flow,
}));

const serviceMock = vi.hoisted(() => ({
  networkDiagnosis: vi.fn(),
  getNetworkSettings: vi.fn(),
  sessionStatus: vi.fn(),
  startupSession: vi.fn(),
  installedMods: vi.fn(),
  uiLog: vi.fn((_level: string, _message: string) => Promise.resolve(undefined)),
}));

vi.mock("../service", () => ({
  networkDiagnosis: serviceMock.networkDiagnosis,
  getNetworkSettings: serviceMock.getNetworkSettings,
  sessionStatus: serviceMock.sessionStatus,
  startupSession: serviceMock.startupSession,
  installedMods: serviceMock.installedMods,
  uiLog: serviceMock.uiLog,
}));

import {
  classifyDiagnosis,
  decideNotification,
  diagnosisPayload,
  diagnosisRounds,
  diagnosisRunning,
  diagnosisVerdict,
  resolveDiagnosisLabelKey,
  resolveDiagnosisDetailLabelKey,
  resetDiagnosis,
  runNetworkDiagnosis,
} from "../networkDiagnosis";
import { resetDiagnosisNotify, subscribeDiagnosisNotify } from "../diagnosisNotify";
import { proxySource, applyProxySource, resetProxySource } from "../proxySourceStore";
import type {
  DiagnosisProbeOutcome,
  DiagnosisProxyOutcome,
  NetworkDiagnosisOutcome,
} from "../types";

function probe(overrides: Partial<DiagnosisProbeOutcome> = {}): DiagnosisProbeOutcome {
  return {
    reachable: true,
    status: 200,
    latencyMs: 0,
    category: "ok",
    errorKind: null,
    ...overrides,
  };
}

function proxy(overrides: Partial<DiagnosisProxyOutcome> = {}): DiagnosisProxyOutcome {
  return {
    enabled: false,
    source: "direct",
    proxyUrl: null,
    pacDetected: false,
    hasExplicitServer: false,
    webviewFollowsSystem: true,
    webviewArgs: null,
    envProxyDetected: false,
    pathMismatch: false,
    ...overrides,
  };
}

function outcome(overrides: {
  website?: Partial<DiagnosisProbeOutcome>;
  api?: Partial<DiagnosisProbeOutcome>;
  proxy?: Partial<DiagnosisProxyOutcome>;
}): NetworkDiagnosisOutcome {
  return {
    proxy: proxy(overrides.proxy),
    website: probe(overrides.website),
    api: probe(overrides.api),
    note: null,
  };
}

const proxyOn: Partial<DiagnosisProxyOutcome> = {
  enabled: true,
  source: "system",
  proxyUrl: "http://127.0.0.1:7897",
  hasExplicitServer: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetDiagnosis();
  resetProxySource();
  resetDiagnosisNotify();
  diagnosisRounds.value = [];
  diagnosisPayload.value = null;
  controllerState.auth.value = "anonymous";
  controllerState.flow.value = "idle";
});

describe("classifyDiagnosis — 错误细分归类", () => {
  it("1. DNS 失败保留 dns 类别，不压成笼统 network", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "dns" },
        api: { category: "network", reachable: false, status: null, errorKind: "dns" },
      }),
    );
    expect(c.verdict).toBe("networkUnavailable");
    expect(c.primaryError).toBe("dns");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagDns");
  });

  it("2. 超时保留 timeout 类别", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "timeout" },
        api: { category: "network", reachable: false, status: null, errorKind: "timeout" },
      }),
    );
    expect(c.primaryError).toBe("timeout");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagTimeout");
  });

  it("3. 连接被拒绝保留 refused 类别（无代理不归咎代理）", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "refused" },
        api: { category: "network", reachable: false, status: null, errorKind: "refused" },
      }),
    );
    expect(c.verdict).toBe("networkUnavailable");
    expect(c.primaryError).toBe("refused");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagRefused");
  });

  it("4. TLS 错误独立分类", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "tls" },
        api: { category: "network", reachable: false, status: null, errorKind: "tls" },
      }),
    );
    expect(c.primaryError).toBe("tls");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagTls");
  });

  it("5. 代理存在 + refused/TLS 仅为间接证据 → proxySuspected（不做确定性代理故障结论）", () => {
    const c = classifyDiagnosis(
      outcome({
        proxy: proxyOn,
        website: { category: "network", reachable: false, status: null, errorKind: "refused" },
        api: { category: "network", reachable: false, status: null, errorKind: "refused" },
      }),
    );
    expect(c.verdict).toBe("proxySuspected");
    expect(c.primaryError).toBe("refused");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagProxySuspected");
  });

  it("5b. 代理存在但失败形态为 DNS/超时，证据不足 → networkUnavailable，不判代理嫌疑", () => {
    const c = classifyDiagnosis(
      outcome({
        proxy: proxyOn,
        website: { category: "network", reachable: false, status: null, errorKind: "timeout" },
        api: { category: "network", reachable: false, status: null, errorKind: "timeout" },
      }),
    );
    expect(c.verdict).toBe("networkUnavailable");
  });

  it("6. 有代理但两条链路都正常，不报警", () => {
    const c = classifyDiagnosis(outcome({ proxy: proxyOn }));
    expect(c.verdict).toBe("systemProxyDetected");
    expect(["proxyFailed", "proxySuspected", "networkUnavailable"]).not.toContain(c.verdict);
  });

  it("7. API 401 只归 unauthenticated，不写成网络失败", () => {
    const c = classifyDiagnosis(
      outcome({ api: { category: "unauthenticated", reachable: false, status: 401 } }),
    );
    expect(c.verdict).toBe("unauthenticated");
    expect(c.primaryError).toBeNull();
  });

  it("8. API 5xx 归官方服务异常，不归咎用户代理", () => {
    const c = classifyDiagnosis(
      outcome({ api: { category: "server", reachable: false, status: 502 } }),
    );
    expect(c.verdict).toBe("officialServerError");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagOfficialError");
  });

  it("9. 官网可达但 API 不可达 → 路径分叉", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "ok", reachable: true, status: 200 },
        api: { category: "network", reachable: false, status: null, errorKind: "refused" },
      }),
    );
    expect(c.verdict).toBe("pathMismatch");
  });

  it("10. 官网不可达、API 正常 → websiteUnreachable", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "timeout" },
        api: { category: "ok", reachable: true, status: 200 },
      }),
    );
    expect(c.verdict).toBe("websiteUnreachable");
  });

  it("11. 证据不足时回落到 unknown，不强行归类", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "other", reachable: false, status: null, errorKind: null },
        api: { category: "other", reachable: false, status: null, errorKind: null },
      }),
    );
    expect(c.verdict).toBe("unknown");
    expect(resolveDiagnosisLabelKey(c)).toBe("statusbar.diagUnknown");
  });
});

describe("resolveDiagnosisDetailLabelKey — 菜单详情行文案（健康态不得压成 unknown）", () => {
  it("健康态 → diagHealthy，不回退 diagUnknown", () => {
    expect(resolveDiagnosisDetailLabelKey({ verdict: "healthy", primaryError: null })).toBe(
      "statusbar.diagHealthy",
    );
  });

  it("有代理但链路正常 → diagProxyDetected", () => {
    expect(
      resolveDiagnosisDetailLabelKey({ verdict: "systemProxyDetected", primaryError: null }),
    ).toBe("statusbar.diagProxyDetected");
  });

  it("unknown（命令失败 / 分类器兜底）→ diagUnknown", () => {
    expect(resolveDiagnosisDetailLabelKey({ verdict: "unknown", primaryError: null })).toBe(
      "statusbar.diagUnknown",
    );
  });

  it("已有故障分类 → 复用真实分类文案，不统一回退 unknown", () => {
    const c = classifyDiagnosis(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "timeout" },
        api: { category: "ok", reachable: true, status: 200 },
      }),
    );
    expect(c.verdict).toBe("websiteUnreachable");
    expect(resolveDiagnosisDetailLabelKey(c)).toBe("statusbar.diagTimeout");
    expect(resolveDiagnosisDetailLabelKey(c)).not.toBe("statusbar.diagUnknown");
  });

  it("代理嫌疑故障 → diagProxySuspected", () => {
    const c = classifyDiagnosis(
      outcome({
        proxy: proxyOn,
        website: { category: "network", reachable: false, status: null, errorKind: "refused" },
        api: { category: "network", reachable: false, status: null, errorKind: "refused" },
      }),
    );
    expect(c.verdict).toBe("proxySuspected");
    expect(resolveDiagnosisDetailLabelKey(c)).toBe("statusbar.diagProxySuspected");
  });
});

describe("decideNotification — 去重 / 恢复 / 代理变化", () => {
  const healthy = { verdict: "healthy" as const, primaryError: null };
  const dnsFailure = { verdict: "networkUnavailable" as const, primaryError: "dns" as const };

  it("12. 健康 → 故障：发一条错误通知", () => {
    const d = decideNotification("healthy", dnsFailure, null, proxy());
    expect(d.shouldNotify).toBe(true);
    expect(d.kind).toBe("error");
  });

  it("13. 相同故障持续：不重复弹通知", () => {
    const first = decideNotification("healthy", dnsFailure, null, proxy());
    const second = decideNotification("networkUnavailable", dnsFailure, null, proxy());
    expect(first.shouldNotify).toBe(true);
    expect(second.shouldNotify).toBe(false);
  });

  it("14. 故障 → 恢复：只发一次恢复通知", () => {
    const d = decideNotification("networkUnavailable", healthy, null, proxy());
    expect(d.shouldNotify).toBe(true);
    expect(d.kind).toBe("ok");
    expect(d.key).toBe("statusbar.toastNetworkRecovered");
  });

  it("15. 代理事实变化（健康态）：发代理配置变化通知", () => {
    const d = decideNotification(
      "healthy",
      healthy,
      proxy({ source: "direct" }),
      proxy({ source: "system", enabled: true }),
    );
    expect(d.shouldNotify).toBe(true);
    expect(d.key).toBe("statusbar.toastProxyChanged");
  });

  it("16. 401 仅在从非失效态进入时通知一次", () => {
    const unauth = { verdict: "unauthenticated" as const, primaryError: null };
    const first = decideNotification("healthy", unauth, null, proxy());
    const second = decideNotification("unauthenticated", unauth, null, proxy());
    expect(first.shouldNotify).toBe(true);
    expect(second.shouldNotify).toBe(false);
  });
});

describe("runNetworkDiagnosis — 执行链路 / 日志 / 不变量", () => {
  it("17. 成功诊断也落持久化日志（start + 两条 probe + end），并登记轮次", async () => {
    serviceMock.networkDiagnosis.mockResolvedValue(outcome({}));
    await runNetworkDiagnosis("startup");

    expect(diagnosisVerdict.value).toBe("healthy");
    expect(diagnosisRounds.value).toHaveLength(1);
    const round = diagnosisRounds.value[0];
    expect(round.trigger).toBe("startup");
    expect(round.finishedAtMs).not.toBeNull();
    expect(round.durationMs).not.toBeNull();

    const logs = serviceMock.uiLog.mock.calls.map((c) => String(c[1]));
    expect(logs.some((l) => l.includes("[Diagnosis] start"))).toBe(true);
    expect(logs.some((l) => l.includes("[Diagnosis] probe website"))).toBe(true);
    expect(logs.some((l) => l.includes("[Diagnosis] probe api"))).toBe(true);
    expect(logs.some((l) => l.includes("[Diagnosis] end"))).toBe(true);
  });

  it("18. 诊断命令失败也记录完整错误，结论回 unknown", async () => {
    serviceMock.networkDiagnosis.mockRejectedValue(new Error("boom"));
    await runNetworkDiagnosis("manual");
    expect(diagnosisVerdict.value).toBe("unknown");
    expect(serviceMock.uiLog).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("[Diagnosis] command failed"),
    );
  });

  it("18a. 诊断成功：把回包 proxy_info 写进独立来源单例", async () => {
    serviceMock.networkDiagnosis.mockResolvedValue(outcome({ proxy: { source: "system" } }));
    await runNetworkDiagnosis("startup");
    expect(proxySource.value).toBe("system");
  });

  it("18b. 诊断命令失败：不清空已取得的链路来源事实，也不写认证态", async () => {
    applyProxySource("manual");
    serviceMock.networkDiagnosis.mockRejectedValue(new Error("diagnosis boom"));
    await runNetworkDiagnosis("startup");
    expect(proxySource.value).toBe("manual");
  });

  it("18c. 官网 / API 探针不可达但回包带来链路事实：来源事实仍保留", async () => {
    serviceMock.networkDiagnosis.mockResolvedValue(
      outcome({
        proxy: { source: "env" },
        website: { reachable: false, category: "network", errorKind: "timeout" },
        api: { reachable: false, category: "network", errorKind: "timeout" },
      }),
    );
    await runNetworkDiagnosis("startup");
    expect(proxySource.value).toBe("env");
  });

  it("19. 日志敏感信息脱敏：凭证与 URL query 不落地", async () => {
    serviceMock.networkDiagnosis.mockResolvedValue(
      outcome({
        proxy: { proxyUrl: "http://user:secret@127.0.0.1:7897" },
        api: { category: "network", reachable: false, status: null, errorKind: "dns" },
        website: { category: "network", reachable: false, status: null, errorKind: "dns" },
      }),
    );
    await runNetworkDiagnosis("poll");
    const logs = serviceMock.uiLog.mock.calls.map((c) => String(c[1]));
    expect(logs.some((l) => l.includes("user:secret"))).toBe(false);
    expect(logs.some((l) => l.includes("secret@"))).toBe(false);
  });

  it("20. 旧一轮结果不能覆盖新一轮（generation 丢弃陈旧回包）", async () => {
    let resolveFirst: (value: NetworkDiagnosisOutcome) => void = () => undefined;
    const firstPromise = new Promise<NetworkDiagnosisOutcome>((res) => {
      resolveFirst = res;
    });
    serviceMock.networkDiagnosis.mockReturnValueOnce(firstPromise);
    const p1 = runNetworkDiagnosis("event");

    serviceMock.networkDiagnosis.mockResolvedValue(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "dns" },
        api: { category: "network", reachable: false, status: null, errorKind: "dns" },
      }),
    );
    const p2 = runNetworkDiagnosis("poll");
    await p2;

    // 旧一轮晚到的官方 5xx 回包必须被丢弃，不能覆盖新一轮的 DNS 结论
    resolveFirst(outcome({ api: { category: "server", reachable: false, status: 503 } }));
    await p1;

    expect(diagnosisVerdict.value).toBe("networkUnavailable");
    expect(diagnosisVerdict.value).not.toBe("officialServerError");
    // 旧一轮 stale 返回不得把新一轮的 running 状态提前清掉；两轮都结束后 running 应为 false
    expect(diagnosisRunning.value).toBe(false);
  });

  it("20b. 旧一轮 stale 回包不能覆盖新一轮写入的来源事实", async () => {
    let resolveFirst: (value: NetworkDiagnosisOutcome) => void = () => undefined;
    const firstPromise = new Promise<NetworkDiagnosisOutcome>((res) => {
      resolveFirst = res;
    });
    serviceMock.networkDiagnosis.mockReturnValueOnce(firstPromise);
    const p1 = runNetworkDiagnosis("event");

    serviceMock.networkDiagnosis.mockResolvedValue(
      outcome({ proxy: { source: "manual" } }),
    );
    const p2 = runNetworkDiagnosis("poll");
    await p2;
    expect(proxySource.value).toBe("manual");

    // 旧一轮晚到的 system 回包属于 stale 代际，必须被丢弃，不能覆盖 manual
    resolveFirst(outcome({ proxy: { source: "system" } }));
    await p1;
    expect(proxySource.value).toBe("manual");
  });

  it("21. 诊断不修改 SessionAuthState / LoginFlowState", async () => {
    controllerState.auth.value = "authenticated";
    controllerState.flow.value = "success";
    serviceMock.networkDiagnosis.mockResolvedValue(outcome({}));
    await runNetworkDiagnosis("event");
    expect(controllerState.auth.value).toBe("authenticated");
    expect(controllerState.flow.value).toBe("success");
  });

  it("22. 诊断不创建隐藏登录窗口、不触发账号会话探针（只调用网络诊断命令）", async () => {
    serviceMock.networkDiagnosis.mockResolvedValue(outcome({}));
    await runNetworkDiagnosis("startup");
    // 诊断链路只走 ureq 官网 / API 双链路探针：不碰 Cookie，不调会话状态 / 启动会话 / /Installed 背书
    expect(serviceMock.networkDiagnosis).toHaveBeenCalledTimes(1);
    expect(serviceMock.sessionStatus).not.toHaveBeenCalled();
    expect(serviceMock.startupSession).not.toHaveBeenCalled();
    expect(serviceMock.installedMods).not.toHaveBeenCalled();
  });

  it("23. 故障通知 → 同故障不重复 → 恢复单条，且旧代际通知不覆盖新通知", async () => {
    const received: Array<{ key: string; kind: string; generation: number }> = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));

    serviceMock.networkDiagnosis.mockResolvedValue(outcome({}));
    await runNetworkDiagnosis("poll");

    serviceMock.networkDiagnosis.mockResolvedValue(
      outcome({
        website: { category: "network", reachable: false, status: null, errorKind: "dns" },
        api: { category: "network", reachable: false, status: null, errorKind: "dns" },
      }),
    );
    await runNetworkDiagnosis("poll");
    await runNetworkDiagnosis("poll"); // 同故障第二轮：不应再弹

    serviceMock.networkDiagnosis.mockResolvedValue(outcome({}));
    await runNetworkDiagnosis("poll");

    const errors = received.filter((r) => r.kind === "error");
    expect(errors).toHaveLength(1);
    expect(received.some((r) => r.key === "statusbar.toastNetworkRecovered")).toBe(true);
    off();
  });
});
