import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

/**
 * 设置 → 网络：保存代理配置后，底栏代理胶囊来源事实必须及时刷新。
 *
 * 组件级验证（B 级）：只证明保存成功链路把回包 source 写进来源单例；
 * 真实 Rust 解析 / 探针可达性仍需 C 级实机验证。
 */
vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}(${Object.values(params).join(",")})` : key,
    }),
  };
});

const serviceMock = vi.hoisted(() => ({
  getNetworkSettings: vi.fn(),
  setNetworkSettings: vi.fn(),
  setRememberLogin: vi.fn(async (enabled: boolean) => enabled),
}));

vi.mock("../../../online/service", () => ({
  getNetworkSettings: serviceMock.getNetworkSettings,
  setNetworkSettings: serviceMock.setNetworkSettings,
  setRememberLogin: serviceMock.setRememberLogin,
}));

const monitorMock = vi.hoisted(() => ({
  requestDiagnosis: vi.fn(),
}));

vi.mock("../../../online/networkMonitor", () => ({
  requestDiagnosis: monitorMock.requestDiagnosis,
}));

vi.mock("../../../format", () => ({
  msgText: (m: unknown) => String((m as { key?: string })?.key ?? ""),
  normalizeBackendError: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

import NetworkTab from "../NetworkTab.vue";
import { applyProxySource, proxySource, resetProxySource } from "../../../online/proxySourceStore";
import { setNetworkSettings } from "../../../online/service";

function view(overrides: Record<string, unknown> = {}) {
  return {
    auto: true,
    proxyUrl: null,
    rememberLogin: true,
    source: "direct",
    effectiveProxy: "",
    note: "",
    webviewArgs: null,
    dataDir: "",
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProxySource();
  serviceMock.getNetworkSettings.mockResolvedValue(view());
});

describe("NetworkTab 保存后刷新代理来源", () => {
  it("保存成功：回包 source 立即写入来源单例，并触发补一轮诊断", async () => {
    serviceMock.setNetworkSettings.mockResolvedValue(
      view({ source: "manual", auto: false, proxyUrl: "http://127.0.0.1:7897", effectiveProxy: "http://127.0.0.1:7897" }),
    );
    const wrapper = mount(NetworkTab);
    await flushPromises();

    const save = wrapper.findAll("button")[0];
    await save.trigger("click");
    await flushPromises();

    expect(vi.mocked(setNetworkSettings)).toHaveBeenCalledTimes(1);
    expect(proxySource.value).toBe("manual");
    expect(monitorMock.requestDiagnosis).toHaveBeenCalledWith("settings");
  });

  it("保存返回系统代理事实：来源单例同步为 system", async () => {
    serviceMock.setNetworkSettings.mockResolvedValue(view({ source: "system", effectiveProxy: "http://127.0.0.1:10808" }));
    const wrapper = mount(NetworkTab);
    await flushPromises();

    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();

    expect(proxySource.value).toBe("system");
  });

  it("保存命令失败：不写入虚构来源，保留读取阶段事实", async () => {
    applyProxySource("env");
    serviceMock.setNetworkSettings.mockRejectedValue(new Error("save boom"));
    const wrapper = mount(NetworkTab);
    await flushPromises();

    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();

    expect(proxySource.value).toBe("env");
  });
});
