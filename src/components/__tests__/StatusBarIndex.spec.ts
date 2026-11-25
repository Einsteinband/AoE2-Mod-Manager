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

const manualActiveMock = vi.hoisted(() => ({ value: false }));

vi.mock("../sessionState", () => ({
  authState: ref("unknown"),
  ensureSession: vi.fn(async () => true),
  lastCheckedMs: ref(0),
  logout: vi.fn(async () => undefined),
  manualActive: manualActiveMock,
  startLogin: vi.fn(),
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
  isNetworkFailure: vi.fn(() => false),
  networkFailureKind: ref("other"),
  noteRequestFailure: vi.fn(),
}));

vi.mock("../../format", () => ({
  translateBackendMessage: (message: string) => message,
}));

vi.mock("../../api", () => ({
  openExternalUrl: vi.fn(async () => undefined),
  openLogsDir: vi.fn(async () => ""),
}));

vi.mock("../../online/service", () => ({
  findMods: vi.fn(),
  getNetworkSettings: vi.fn(async () => ({ source: "direct" })),
  openLogin: vi.fn(async () => undefined),
  indexStatus: vi.fn(async () => null),
  indexSync: vi.fn(),
  indexPause: vi.fn(),
  onIndexProgress: vi.fn(async () => () => undefined),
  uiLog: vi.fn(async () => undefined),
  networkDiagnosis: vi.fn(async () => ({
    proxy: {
      enabled: false,
      source: "direct",
      proxyUrl: null,
      pacDetected: false,
      hasExplicitServer: false,
      webviewFollowsSystem: true,
      webviewArgs: null,
      envProxyDetected: false,
      pathMismatch: false,
    },
    website: { reachable: true, status: 200, latencyMs: 1, category: "ok", errorKind: null },
    api: { reachable: true, status: 200, latencyMs: 1, category: "ok", errorKind: null },
    note: null,
  })),
}));

import StatusBar from "../StatusBar.vue";
import {
  indexBar,
  startIndexStatusWatch,
  stopIndexStatusWatch,
} from "../../online/indexStatusStore";
import { indexPause, indexStatus as fetchIndexStatus, indexSync, networkDiagnosis, getNetworkSettings } from "../../online/service";
import { isNetworkError } from "../../online/networkError";
import { resetDiagnosis, runNetworkDiagnosis } from "../../online/networkDiagnosis";
import { proxySource, resetProxySource } from "../../online/proxySourceStore";
import type { NetworkDiagnosisOutcome, NetworkSettingsView } from "../../online/types";

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
    lastSyncAdded: 0,
    lastSyncUpdated: 0,
    lastSyncFailed: 0,
    lastSyncAtMs: 0,
    lastSyncReason: "",
    lastSyncComplete: false,
    lastSyncOk: false,
    ...overrides,
  };
}

function outcome(source: string): NetworkDiagnosisOutcome {
  return {
    proxy: {
      enabled: source !== "direct",
      source,
      proxyUrl: null,
      pacDetected: false,
      hasExplicitServer: false,
      webviewFollowsSystem: true,
      webviewArgs: null,
      envProxyDetected: source === "env",
      pathMismatch: false,
    },
    website: { reachable: true, status: 200, latencyMs: 1, category: "ok", errorKind: null },
    api: { reachable: true, status: 200, latencyMs: 1, category: "ok", errorKind: null },
    note: null,
  };
}

function settingsView(source: string): NetworkSettingsView {
  return {
    auto: true,
    proxyUrl: null,
    rememberLogin: true,
    source,
    effectiveProxy: null,
    note: null,
    webviewArgs: null,
    dataDir: null,
    error: null,
  };
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const x = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${x}`;
}

function syncResult(overrides: Partial<NonNullable<typeof indexBar.lastSync>> = {}) {
  return {
    added: 0,
    updated: 0,
    failed: 0,
    atMs: Date.now(),
    reason: "login",
    auto: true,
    complete: true,
    ok: true,
    day: todayKey(),
    ...overrides,
  };
}

function mountBar(warningCount = 0) {
  return mount(StatusBar, {
    props: { mode: "local", warningCount },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  isNetworkError.value = false;
  manualActiveMock.value = false;
  resetDiagnosis();
  resetProxySource();
  vi.mocked(getNetworkSettings).mockReset();
  vi.mocked(getNetworkSettings).mockResolvedValue(settingsView("direct"));
  indexBar.status = null;
  indexBar.failure = "";
  indexBar.needLogin = false;
  indexBar.retrying = false;
  indexBar.lastSync = null;
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
    indexBar.lastSync = syncResult({ ok: false, failed: 1 });
    vi.mocked(indexSync).mockResolvedValue({
      fetched: 7,
      added: 3,
      updated: 4,
      failed: 0,
      pages: 1,
      scanned: 7,
      totalCount: 200,
      indexed: 107,
      done: true,
      skipped: false,
      capped: false,
      message: "",
    });
    const wrapper = mountBar();
    await flushPromises();
    const retry = wrapper.find(".sb-index-retry");
    expect(retry.exists()).toBe(true);
    expect(retry.text()).toBe("statusbar.indexRetry");
    expect(wrapper.find(".sb-index").text()).toContain(
      "statusbar.indexReady(100) · statusbar.indexSyncTodayFailed",
    );

    // 重试成功后 Rust 状态里的 lastError 会被清空
    vi.mocked(fetchIndexStatus).mockResolvedValue(status({ phase: "done", done: true, indexed: 107 }));
    await retry.trigger("click");
    await flushPromises();
    expect(vi.mocked(indexSync)).toHaveBeenCalledWith("manual");
    // 成功后重试入口消失，底栏用本轮真实 added=3，而不是 fetched=7
    expect(wrapper.find(".sb-index-retry").exists()).toBe(false);
    expect(indexBar.lastSync?.added).toBe(3);
    expect(wrapper.find(".sb-index").text()).toContain(
      "statusbar.indexReady(107) · statusbar.indexSyncManualAdded(3)",
    );
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

  it("索引状态位于右侧状态区，代理胶囊排在索引之后、占据最右侧", async () => {
    indexBar.status = status({ syncing: true, phase: "syncing", indexed: 120, totalCount: 200 });
    const wrapper = mountBar();
    await flushPromises();
    const right = wrapper.find(".sb-right");
    expect(right.exists()).toBe(true);
    const index = wrapper.find(".sb-index");
    expect(index.exists()).toBe(true);
    // 必须挂在 .sb-right 里，而不是夹在账号状态与中间提示之间
    expect(right.find(".sb-index").exists()).toBe(true);
    // 代理胶囊恢复为右侧独立状态位，且在索引块之后（最右一项）
    const pill = right.find(".sb-pill");
    expect(pill.exists()).toBe(true);
    const cells = right.element.children;
    expect((cells[cells.length - 1] as HTMLElement).className).toContain("sb-pill");
  });

  it("代理胶囊按诊断回传来源渲染：manual / system / env / direct 都显示为事实标签，直连不表述为故障", async () => {
    const cases: Array<[string, string]> = [
      ["manual", "statusbar.proxyManual"],
      ["system", "statusbar.proxySystem"],
      ["env", "statusbar.proxyEnv"],
      ["direct", "statusbar.proxyDirect"],
    ];
    for (const [source, sourceKey] of cases) {
      vi.mocked(networkDiagnosis).mockResolvedValueOnce(outcome(source));
      vi.mocked(getNetworkSettings).mockResolvedValueOnce(settingsView(source));
      const wrapper = mountBar();
      await flushPromises();
      const pill = wrapper.find(".sb-right .sb-pill");
      expect(pill.exists()).toBe(true);
      expect(pill.text()).toContain("statusbar.proxyLabel");
      expect(pill.text()).toContain(sourceKey);
    }
  });

  it("诊断命令失败但设置读取成功：胶囊仍显示链路事实，不被诊断结果清空", async () => {
    vi.mocked(networkDiagnosis).mockRejectedValueOnce(new Error("diagnosis boom"));
    vi.mocked(getNetworkSettings).mockResolvedValueOnce(settingsView("system"));
    const wrapper = mountBar();
    await flushPromises();
    const pill = wrapper.find(".sb-right .sb-pill");
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toContain("statusbar.proxySystem");
  });

  it("启动时诊断尚未回包：来源仍可经 getNetworkSettings 独立读到", async () => {
    let resolveDiagnosis: (value: NetworkDiagnosisOutcome) => void = () => undefined;
    const pending = new Promise<NetworkDiagnosisOutcome>((res) => {
      resolveDiagnosis = res;
    });
    vi.mocked(networkDiagnosis).mockReturnValueOnce(pending);
    vi.mocked(getNetworkSettings).mockResolvedValueOnce(settingsView("env"));
    const wrapper = mountBar();
    await flushPromises();
    const pill = () => wrapper.find(".sb-right .sb-pill");
    expect(pill().exists()).toBe(true);
    expect(pill().text()).toContain("statusbar.proxyEnv");

    // 诊断稍后回包：回包来源与兜底一致，胶囊保留
    resolveDiagnosis(outcome("env"));
    await flushPromises();
    expect(pill().exists()).toBe(true);
  });

  it("诊断成功后最新 proxy_info 覆盖启动兜底来源", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValueOnce(settingsView("system"));
    vi.mocked(networkDiagnosis).mockResolvedValueOnce(outcome("manual"));
    const wrapper = mountBar();
    await flushPromises();
    const pill = wrapper.find(".sb-right .sb-pill");
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toContain("statusbar.proxyManual");
  });

  it("官网 / API 探针失败但代理事实获取成功：胶囊仍正常显示", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValueOnce(settingsView("env"));
    vi.mocked(networkDiagnosis).mockResolvedValueOnce({
      ...outcome("env"),
      website: { reachable: false, status: null, latencyMs: 1, category: "network", errorKind: "timeout" },
      api: { reachable: false, status: null, latencyMs: 1, category: "network", errorKind: "timeout" },
    });
    const wrapper = mountBar();
    await flushPromises();
    const pill = wrapper.find(".sb-right .sb-pill");
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toContain("statusbar.proxyEnv");
  });

  it("来源读取失败且诊断无回包：不显示胶囊，也不编造直连状态", async () => {
    vi.mocked(networkDiagnosis).mockRejectedValueOnce(new Error("diagnosis boom"));
    vi.mocked(getNetworkSettings).mockRejectedValueOnce(new Error("settings boom"));
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-right .sb-pill").exists()).toBe(false);
    expect(proxySource.value).toBeNull();
  });

  it("诊断结果二次更新、登录窗开关（manualActive 切换）都不会使代理胶囊消失", async () => {
    vi.mocked(networkDiagnosis).mockResolvedValueOnce(outcome("system"));
    const wrapper = mountBar();
    await flushPromises();
    const pill = () => wrapper.find(".sb-right .sb-pill");
    expect(pill().exists()).toBe(true);
    expect(pill().text()).toContain("statusbar.proxySystem");

    // 登录窗口打开：manualActive 置真；期间诊断再跑一轮，胶囊仍在
    manualActiveMock.value = true;
    vi.mocked(networkDiagnosis).mockResolvedValueOnce(outcome("env"));
    await runNetworkDiagnosis("poll");
    expect(pill().exists()).toBe(true);
    expect(pill().text()).toContain("statusbar.proxyEnv");

    // 登录窗口关闭：manualActive 复位，胶囊保留
    manualActiveMock.value = false;
    expect(pill().exists()).toBe(true);
  });

  it("底栏不再显示在线 Mod 总数", async () => {
    indexBar.status = status({ done: true, indexed: 41357, totalCount: 41327, phase: "done" });
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-online").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("statusbar.onlineMods");
    expect(wrapper.find(".sb-index").text()).toContain("statusbar.indexReady(41357)");
  });

  it("自动同步成功：本地索引 + 今日已同步，新增真实 added", async () => {
    indexBar.status = status({ done: true, indexed: 41357, phase: "done" });
    indexBar.lastSync = syncResult({ added: 15, updated: 35 });
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-index").text()).toContain(
      "statusbar.indexReady(41357) · statusbar.indexSyncAutoAdded(15)",
    );
  });

  it("自动同步成功但无新增：显示无新增 Mod", async () => {
    indexBar.status = status({ done: true, indexed: 41357, phase: "done" });
    indexBar.lastSync = syncResult({ added: 0 });
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-index").text()).toContain(
      "statusbar.indexReady(41357) · statusbar.indexSyncAutoNone",
    );
  });

  it("悬停提示只显示当前完整索引文案，不暴露索引文件路径", async () => {
    indexBar.status = status({
      done: true,
      indexed: 41357,
      phase: "done",
      path: "C:\\Users\\Libohan\\AppData\\Roaming\\com.aoe2.modmanager\\online_index.json",
    });
    indexBar.lastSync = syncResult({ added: 15 });
    const wrapper = mountBar();
    await flushPromises();
    const cell = wrapper.find(".sb-index");
    const title = cell.attributes("title");
    expect(title).toBe(cell.find(".sb-index-text").text());
    expect(title).not.toContain("online_index.json");
    expect(title).not.toContain("C:\\Users");
  });

  it("同步中不会提前显示今日已同步", async () => {
    indexBar.status = status({ syncing: true, phase: "syncing", indexed: 41357, totalCount: 41327 });
    indexBar.lastSync = syncResult({ added: 15 });
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-index").text()).toContain("statusbar.indexProgressBare(41357)");
    expect(wrapper.find(".sb-index").text()).not.toContain("statusbar.indexSyncAutoAdded");
  });

  it("旧版本残留的「暂停」标记会在启动观察时清掉（否则自动任务永久跳过）", async () => {
    vi.mocked(fetchIndexStatus).mockResolvedValue(status({ paused: true, phase: "paused" }));
    vi.mocked(indexPause).mockResolvedValue(status({ paused: false, phase: "syncing", syncing: true }));
    await startIndexStatusWatch();
    await flushPromises();
    expect(vi.mocked(indexPause)).toHaveBeenCalledWith(false);
    stopIndexStatusWatch();
  });

  it("已有有效诊断结论时，旧粘滞断网标志不覆盖诊断结果（不误报断网）", async () => {
    isNetworkError.value = true;
    const wrapper = mountBar();
    await flushPromises();
    const state = wrapper.find(".sb-state");
    expect(state.exists()).toBe(true);
    expect(state.text()).not.toContain("statusbar.networkDown");
    expect(state.text()).not.toContain("statusbar.timeoutDown");
    expect(state.text()).not.toContain("statusbar.proxyDown");
    expect(state.text()).not.toContain("statusbar.tlsDown");
  });

  it("诊断命令失败、无有效结论时，旧粘滞标志作为兜底证据显示断网", async () => {
    vi.mocked(networkDiagnosis).mockRejectedValueOnce(new Error("diagnosis boom"));
    isNetworkError.value = true;
    const wrapper = mountBar();
    await flushPromises();
    expect(wrapper.find(".sb-state").text()).toContain("statusbar.networkDown");
  });

  it("诊断结论为故障类时，状态文字进入 error 态且不亮 online（不被粘滞标志门控）", async () => {
    vi.mocked(networkDiagnosis).mockResolvedValueOnce({
      proxy: {
        enabled: false,
        source: "direct",
        proxyUrl: null,
        pacDetected: false,
        hasExplicitServer: false,
        webviewFollowsSystem: true,
        webviewArgs: null,
        envProxyDetected: false,
        pathMismatch: false,
      },
      website: { reachable: false, status: null, latencyMs: 1, category: "network", errorKind: "timeout" },
      api: { reachable: false, status: null, latencyMs: 1, category: "network", errorKind: "timeout" },
      note: null,
    });
    const wrapper = mountBar();
    await flushPromises();
    const state = wrapper.find(".sb-state");
    expect(state.classes()).toContain("error");
    expect(state.classes()).not.toContain("online");
  });
});

describe("账号菜单开合：仅账号按钮切换", () => {
  it("点击账号按钮打开菜单，再次点击收起", async () => {
    const wrapper = mountBar();
    await flushPromises();
    const account = wrapper.find(".sb-account");
    await account.trigger("click");
    expect(wrapper.find(".sb-menu").exists()).toBe(true);
    await account.trigger("click");
    expect(wrapper.find(".sb-menu").exists()).toBe(false);
  });

  it("菜单头部关闭按钮：有无障碍名称，点击后收起菜单", async () => {
    const wrapper = mountBar();
    await flushPromises();
    await wrapper.find(".sb-account").trigger("click");
    const close = wrapper.find(".sb-menu-close");
    expect(close.exists()).toBe(true);
    expect(close.attributes("aria-label")).toBe("common.close");
    await close.trigger("click");
    expect(wrapper.find(".sb-menu").exists()).toBe(false);
  });

  it("菜单内点击操作项（校验连接）后菜单保持打开，不会自动收起", async () => {
    const wrapper = mountBar();
    await flushPromises();
    await wrapper.find(".sb-account").trigger("click");
    const actions = wrapper.findAll(".sb-menu-actions");
    const recheckBtn = actions[1].find("button");
    await recheckBtn.trigger("click");
    await flushPromises();
    expect(wrapper.find(".sb-menu").exists()).toBe(true);
  });

  it("点击菜单外区域与按 Esc 都不收起菜单", async () => {
    const wrapper = mountBar();
    await flushPromises();
    await wrapper.find(".sb-account").trigger("click");
    expect(wrapper.find(".sb-menu").exists()).toBe(true);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find(".sb-menu").exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find(".sb-menu").exists()).toBe(true);
  });
});

describe("账号菜单：诊断摘要块不再展示", () => {
  it("菜单内不渲染最近诊断摘要行与日志文件夹入口", async () => {
    const wrapper = mountBar();
    await flushPromises();
    await wrapper.find(".sb-account").trigger("click");
    expect(wrapper.find(".sb-menu-diag").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("statusbar.diagDetailTitle");
    expect(wrapper.text()).not.toContain("statusbar.diagOpenLogs");
  });
});
