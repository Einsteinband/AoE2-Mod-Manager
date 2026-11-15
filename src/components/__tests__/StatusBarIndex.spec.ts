import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import type { IndexStatus } from "../../online/types";

/**
 * 底栏索引状态区（回归：索引进度 / 失败重试必须在底部状态栏，且自动更新关闭时不出现）。
 *
 * 组件级验证，不替代实机（C 级）：这里只证明模板条件、按钮可见性与点击链路。
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

vi.mock("../sessionState", () => ({
  ensureSession: vi.fn(async () => true),
  lastCheckedMs: ref(0),
  logoutAndClearSession: vi.fn(async () => undefined),
  probeNetwork: vi.fn(async () => true),
  requestManualRefresh: vi.fn(),
  sessionError: ref(null),
  sessionInfo: ref(null),
  sessionPhase: ref("offline"),
  setStatusMessage: vi.fn(),
  setStatusMessageKey: vi.fn(),
  statusMessage: ref(""),
}));

vi.mock("../../online/networkError", () => ({
  isNetworkError: ref(false),
  networkFailureKind: ref("other"),
  noteRequestFailure: vi.fn(),
}));

vi.mock("../../format", () => ({
  translateBackendMessage: (message: string) => message,
}));

vi.mock("../../api", () => ({
  openExternalUrl: vi.fn(async () => undefined),
}));

vi.mock("../../online/service", () => ({
  getNetworkSettings: vi.fn(async () => ({ source: "direct" })),
  openLogin: vi.fn(async () => undefined),
  indexStatus: vi.fn(async () => null),
  indexSync: vi.fn(),
  indexPause: vi.fn(),
  onIndexProgress: vi.fn(async () => () => undefined),
}));

import StatusBar from "../StatusBar.vue";
import {
  indexBar,
  startIndexStatusWatch,
  stopIndexStatusWatch,
} from "../../online/indexStatusStore";
import { indexPause, indexStatus as fetchIndexStatus, indexSync } from "../../online/service";

function status(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    indexed: 100,
    totalCount: 200,
    scanned: 100,
    done: false,
    syncing: false,
    indexingEnabled: true,
    phase: "idle",
    message: "",
    updatedAtMs: 1,
    fullSyncedAtMs: 0,
    cooldownUntilMs: 0,
    path: "",
    maxItems: 30000,
    paused: false,
    lastError: "",
    resumable: false,
    ...overrides,
  };
}

function mountBar(warningCount = 0) {
  return mount(StatusBar, {
    props: { mode: "local", warningCount },
  });
}

beforeEach(() => {
  indexBar.status = null;
  indexBar.failure = "";
  indexBar.needLogin = false;
  indexBar.retrying = false;
  indexBar.flashAdded = null;
  vi.mocked(indexSync).mockReset();
  vi.mocked(fetchIndexStatus).mockReset();
  vi.mocked(fetchIndexStatus).mockResolvedValue(status({ phase: "paused", lastError: "network down" }));
});

describe("StatusBar 索引状态区", () => {
  it("底栏不再渲染根目录 / 已订阅 / 扫描时间 / 本地数 / 显示数，只留「扫描警告」入口", async () => {
    indexBar.status = status({ indexingEnabled: false });
    const wrapper = mountBar(2);
    await flushPromises();
    const text = wrapper.text();
    expect(text).not.toContain("rootbar.root");
    expect(text).not.toContain("rootbar.subscribed");
    expect(text).not.toContain("rootbar.scannedAt");
    expect(text).not.toContain("rootbar.local");
    expect(text).not.toContain("rootbar.showing");
    // 可操作项保留：扫描警告仍可点，且会向父组件发事件
    const warn = wrapper.find(".sb-warn");
    expect(warn.exists()).toBe(true);
    expect(warn.text()).toContain("rootbar.warnings");
    await warn.trigger("click");
    expect(wrapper.emitted("toggle-warnings")).toHaveLength(1);
  });

  it("自动更新关闭时不渲染索引块，也不出现手动入口", async () => {
    indexBar.status = status({ indexingEnabled: false, indexed: 40000, done: true });
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-index").exists()).toBe(false);
  });

  it("同步中显示进度、没有手动按钮", async () => {
    indexBar.status = status({ syncing: true, phase: "syncing", indexed: 120, totalCount: 200 });
    const wrapper = mountBar();
    await flushPromises();
    const cell = wrapper.find(".sb-index");
    expect(cell.exists()).toBe(true);
    expect(cell.classes()).toContain("syncing");
    expect(cell.text()).toContain("statusbar.indexProgress(120,200)");
    expect(wrapper.find(".sb-index-retry").exists()).toBe(false);
  });

  it("失败时才出现唯一「手动重试」，点击后走同一个同步核心", async () => {
    indexBar.status = status({ phase: "paused", lastError: "network down" });
    indexBar.failure = "network down";
    vi.mocked(indexSync).mockResolvedValue({
      fetched: 7,
      pages: 1,
      scanned: 7,
      totalCount: 200,
      indexed: 107,
      done: false,
      skipped: false,
      capped: false,
      message: "",
    });
    const wrapper = mountBar();
    await flushPromises();
    const retry = wrapper.find(".sb-index-retry");
    expect(retry.exists()).toBe(true);
    expect(retry.text()).toBe("statusbar.indexRetry");
    expect(wrapper.find(".sb-index").text()).toContain("statusbar.indexFailed(network down)");

    // 重试成功后 Rust 状态里的 lastError 会被清空
    vi.mocked(fetchIndexStatus).mockResolvedValue(status({ phase: "done", done: true, indexed: 107 }));
    await retry.trigger("click");
    await flushPromises();
    expect(vi.mocked(indexSync)).toHaveBeenCalledTimes(1);
    // 成功后重试入口消失（进度 / 成功提示优先）
    expect(wrapper.find(".sb-index-retry").exists()).toBe(false);
    expect(indexBar.flashAdded).toBe(7);
  });

  it("重试失败后重试入口继续保留", async () => {
    indexBar.status = status({ phase: "paused", lastError: "network down" });
    indexBar.failure = "network down";
    vi.mocked(indexSync).mockRejectedValue(new Error("still down"));
    // 后端状态还没带出 lastError：界面用命令返回的错误兜底，不能静默
    vi.mocked(fetchIndexStatus).mockResolvedValue(status({ phase: "error", lastError: "" }));
    const wrapper = mountBar();
    await flushPromises();
    await wrapper.find(".sb-index-retry").trigger("click");
    await flushPromises();
    expect(indexBar.failure).toBe("still down");
    expect(wrapper.find(".sb-index-retry").exists()).toBe(true);
  });

  it("索引状态位于右侧状态区，且代理胶囊仍是最右一项", async () => {
    indexBar.status = status({ syncing: true, phase: "syncing", indexed: 120, totalCount: 200 });
    const wrapper = mountBar();
    await flushPromises();
    const right = wrapper.find(".sb-right");
    expect(right.exists()).toBe(true);
    const index = wrapper.find(".sb-index");
    expect(index.exists()).toBe(true);
    // 必须挂在 .sb-right 里，而不是夹在账号状态与中间提示之间
    expect(right.find(".sb-index").exists()).toBe(true);
    const cells = right.element.children;
    expect((cells[cells.length - 1] as HTMLElement).className).toContain("sb-pill");
    expect(right.html().indexOf("sb-index")).toBeLessThan(right.html().indexOf("sb-pill"));
  });

  it("旧版本残留的「暂停」标记会在启动观察时清掉（否则自动任务永久跳过）", async () => {
    vi.mocked(fetchIndexStatus).mockResolvedValue(status({ paused: true, phase: "paused" }));
    vi.mocked(indexPause).mockResolvedValue(status({ paused: false, phase: "syncing", syncing: true }));
    await startIndexStatusWatch();
    await flushPromises();
    expect(vi.mocked(indexPause)).toHaveBeenCalledWith(false);
    stopIndexStatusWatch();
  });
});
