import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 代理来源事实单例回归（A 级代码级验证）。
 *
 * 覆盖：独立读取成功写入四种来源、读取失败保留旧事实不置空、未知取值不落成默认直连、
 * 诊断回包喂入只写事实不改认证态、时间戳随成功写入更新、重置清空。
 */

const serviceMock = vi.hoisted(() => ({
  getNetworkSettings: vi.fn(),
}));

vi.mock("../service", () => ({
  getNetworkSettings: serviceMock.getNetworkSettings,
}));

import {
  applyDiagnosisProxy,
  applyProxySource,
  proxySource,
  proxySourceUpdatedAtMs,
  refreshProxySource,
  resetProxySource,
} from "../proxySourceStore";

beforeEach(() => {
  vi.clearAllMocks();
  resetProxySource();
});

describe("proxySourceStore 代理来源事实", () => {
  it("独立读取成功：四种合法来源都写入事实并打时间戳", async () => {
    const cases = ["manual", "system", "env", "direct"] as const;
    for (const source of cases) {
      serviceMock.getNetworkSettings.mockResolvedValueOnce({ source });
      const result = await refreshProxySource();
      expect(result).toBe(source);
      expect(proxySource.value).toBe(source);
      expect(proxySourceUpdatedAtMs.value).toBeGreaterThan(0);
      resetProxySource();
    }
  });

  it("读取失败：保留上一次成功事实；从未成功则保持 null，不编造 direct", async () => {
    serviceMock.getNetworkSettings.mockResolvedValueOnce({ source: "system" });
    await refreshProxySource();
    serviceMock.getNetworkSettings.mockRejectedValueOnce(new Error("settings boom"));
    const result = await refreshProxySource();
    expect(result).toBe("system");
    expect(proxySource.value).toBe("system");

    resetProxySource();
    serviceMock.getNetworkSettings.mockRejectedValueOnce(new Error("settings boom"));
    const empty = await refreshProxySource();
    expect(empty).toBeNull();
    expect(proxySource.value).toBeNull();
  });

  it("未知取值被忽略，不落成默认直连", async () => {
    serviceMock.getNetworkSettings.mockResolvedValueOnce({ source: "weird" });
    await refreshProxySource();
    expect(proxySource.value).toBeNull();

    applyProxySource("unknown-source");
    expect(proxySource.value).toBeNull();
  });

  it("诊断回包喂入：只写链路事实，不触碰其他状态", async () => {
    applyDiagnosisProxy("env");
    expect(proxySource.value).toBe("env");
    expect(proxySourceUpdatedAtMs.value).toBeGreaterThan(0);
  });

  it("重置：清空来源事实与时间戳", () => {
    applyProxySource("manual");
    resetProxySource();
    expect(proxySource.value).toBeNull();
    expect(proxySourceUpdatedAtMs.value).toBeNull();
  });
});
