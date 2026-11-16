import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus } from "../types";
import type { IndexBarState, IndexSyncResult } from "../indexStatusStore";

/**
 * 底部状态栏的索引展示规则（纯推导 + 状态机）。
 *
 * 真实新增数只能来自 Rust 的 `lastSyncAdded`（`upsert_items().added`）；
 * 本测试刻意让 `indexed` 变化与 `added` 不相等，防止有人再退回差值推算。
 */
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

function day(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const x = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${x}`;
}

function syncResult(overrides: Partial<IndexSyncResult> = {}): IndexSyncResult {
  return {
    added: 0,
    updated: 0,
    failed: 0,
    atMs: Date.now(),
    reason: "login",
    auto: true,
    complete: true,
    ok: true,
    day: day(),
    ...overrides,
  };
}

function barState(overrides: Partial<IndexBarState> = {}): IndexBarState {
  return {
    status: status(),
    failure: "",
    needLogin: false,
    retrying: false,
    lastSync: null,
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("../indexStatusStore");
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  const { stopIndexStatusWatch } = await loadStore();
  stopIndexStatusWatch();
});

describe("deriveIndexBar", () => {
  it("自动更新关闭时整块隐藏（不看数据、不看失败）", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({
        status: status({ indexingEnabled: false, indexed: 42000, done: true, lastError: "boom" }),
        failure: "boom",
        lastSync: syncResult({ added: 5 }),
      }),
    );
    expect(view.kind).toBe("hidden");
  });

  it("读不到状态时隐藏", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(barState({ status: null }));
    expect(view.kind).toBe("hidden");
    expect(view.showRetry).toBe(false);
  });

  it("同步中显示进度且没有手动按钮，也不显示旧成功", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({
        status: status({ syncing: true, phase: "syncing", indexed: 120 }),
        lastSync: syncResult({ added: 15 }),
      }),
    );
    expect(view.kind).toBe("syncing");
    expect(view.showRetry).toBe(false);
  });

  it("失败时出现唯一的手动重试入口", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({ status: status({ phase: "paused", lastError: "network down" }), failure: "network down" }),
    );
    expect(view.kind).toBe("failed");
    expect(view.showRetry).toBe(true);
  });

  it("未登录类失败不给重试（重试必然再失败）", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(barState({ status: status({ phase: "needLogin" }), needLogin: true }));
    expect(view.kind).toBe("needLogin");
    expect(view.showRetry).toBe(false);
  });

  it("重试在飞时优先显示进度，按钮消失", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({ status: status({ lastError: "network down" }), failure: "network down", retrying: true }),
    );
    expect(view.kind).toBe("syncing");
    expect(view.showRetry).toBe(false);
  });

  it("自动成功使用真实 added，且常驻（不是 8 秒 flash）", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(barState({ status: status({ done: true }), lastSync: syncResult({ added: 12 }) }));
    expect(view.kind).toBe("success");
    expect(view.added).toBe(12);
    expect(view.auto).toBe(true);
  });

  it("自动成功但无新增", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(barState({ status: status({ done: true }), lastSync: syncResult({ added: 0 }) }));
    expect(view).toMatchObject({ kind: "success", added: 0, auto: true });
  });

  it("手动成功会标明 manual，不冒充今日自动结果", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({
        status: status({ done: true }),
        lastSync: syncResult({ added: 3, reason: "manual", auto: false }),
      }),
    );
    expect(view).toMatchObject({ kind: "success", added: 3, auto: false });
  });

  it("自动成功跨日后不再显示“今日已同步”", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({
        status: status({ done: true }),
        lastSync: syncResult({ added: 15, day: day(-1), atMs: Date.now() - 86400000 }),
      }),
    );
    expect(view.kind).toBe("ready");
    expect(view.added).toBe(0);
  });

  it("自动失败显示“今日失败”的语义（auto=true），跨日后不冒充今日失败", async () => {
    const { deriveIndexBar } = await loadStore();
    const today = deriveIndexBar(
      barState({
        status: status({ done: true }),
        failure: "network",
        lastSync: syncResult({ ok: false, added: 0, failed: 1 }),
      }),
    );
    expect(today).toMatchObject({ kind: "failed", auto: true, showRetry: true });

    const yesterday = deriveIndexBar(
      barState({
        status: status({ done: true }),
        failure: "network",
        lastSync: syncResult({ ok: false, added: 0, failed: 1, day: day(-1), atMs: Date.now() - 86400000 }),
      }),
    );
    expect(yesterday.kind).toBe("ready");
  });

  it("部分完成（complete=false）绝不当成功", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar(
      barState({
        status: status({ done: false }),
        lastSync: syncResult({ complete: false, ok: false, added: 15 }),
      }),
    );
    expect(view.kind).toBe("idle");
  });

  it("已就绪 / 待同步分别是 ready / idle", async () => {
    const { deriveIndexBar } = await loadStore();
    expect(deriveIndexBar(barState({ status: status({ done: true }) })).kind).toBe("ready");
    expect(deriveIndexBar(barState({ status: status() })).kind).toBe("idle");
  });
});

describe("applyIndexStatus（自动任务的状态机）", () => {
  beforeEach(async () => {
    const { indexBar } = await loadStore();
    indexBar.status = null;
    indexBar.failure = "";
    indexBar.needLogin = false;
    indexBar.retrying = false;
    indexBar.lastSync = null;
  });

  it("自动完成后使用 Rust 的 lastSyncAdded，不按 indexed 差值推算", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        syncing: true,
        phase: "syncing",
        indexed: 100,
        lastSyncComplete: false,
        lastSyncAdded: 0,
      }),
    );
    expect(store.indexBar.lastSync).toBeNull();

    // 差值 = 143-100 = 43；真实 added 只有 7，底栏必须显示 7。
    store.applyIndexStatus(
      status({
        syncing: false,
        done: true,
        phase: "done",
        indexed: 143,
        lastSyncAdded: 7,
        lastSyncUpdated: 36,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: true,
        lastSyncOk: true,
      }),
    );
    expect(store.indexBar.lastSync?.added).toBe(7);
    expect(store.deriveIndexBar(store.indexBar)).toMatchObject({ kind: "success", added: 7, auto: true });
  });

  it("同步中不会提前显示“今日已同步”", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        syncing: true,
        phase: "syncing",
        indexed: 40000,
        lastSyncAdded: 15,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: true,
        lastSyncOk: true,
      }),
    );
    expect(store.indexBar.lastSync).toBeNull();
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("syncing");
  });

  it("自动任务失败时保留失败原因、真实 failed 与重试资格", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        syncing: false,
        done: false,
        phase: "paused",
        indexed: 100,
        lastError: "network",
        lastSyncFailed: 1,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: true,
        lastSyncOk: false,
      }),
    );
    expect(store.indexBar.failure).toBe("network");
    expect(store.indexBar.lastSync).toMatchObject({ failed: 1, ok: false, auto: true });
    expect(store.deriveIndexBar(store.indexBar)).toMatchObject({ kind: "failed", auto: true, showRetry: true });
  });

  it("部分完成不显示成功，也不写今日缓存", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        syncing: false,
        done: false,
        phase: "paused",
        indexed: 150,
        lastSyncAdded: 50,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: false,
        lastSyncOk: false,
      }),
    );
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("idle");
    expect(window.localStorage.getItem("aoe2mm.indexSyncResult.v1")).toBeNull();
  });

  it("新一轮开始会清掉上一轮的失败 / 成功提示", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        phase: "paused",
        lastError: "network",
        lastSyncFailed: 1,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: true,
        lastSyncOk: false,
      }),
    );
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("failed");
    store.applyIndexStatus(status({ syncing: true, phase: "syncing" }));
    expect(store.indexBar.failure).toBe("");
    expect(store.indexBar.lastSync).toBeNull();
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("syncing");
  });

  it("开关关闭后清掉失败 / 成功残留并隐藏", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ phase: "paused", lastError: "network" }));
    store.applyIndexStatus(status({ indexingEnabled: false, phase: "disabled" }));
    expect(store.indexBar.failure).toBe("");
    expect(store.indexBar.lastSync).toBeNull();
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("hidden");
  });

  it("未登录状态不再当成可重试的失败", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ phase: "needLogin", syncing: false }));
    expect(store.indexBar.failure).toBe("");
    expect(store.indexBar.needLogin).toBe(true);
    expect(store.deriveIndexBar(store.indexBar).showRetry).toBe(false);
  });

  it("今日自动成功写入 localStorage，重启后仍常驻", async () => {
    const store = await loadStore();
    store.applyIndexStatus(
      status({
        syncing: false,
        done: true,
        phase: "done",
        indexed: 41357,
        lastSyncAdded: 15,
        lastSyncUpdated: 35,
        lastSyncAtMs: Date.now(),
        lastSyncReason: "startup",
        lastSyncComplete: true,
        lastSyncOk: true,
      }),
    );
    expect(store.indexBar.lastSync?.added).toBe(15);
    expect(window.localStorage.getItem("aoe2mm.indexSyncResult.v1")).not.toBeNull();

    const restarted = await loadStore();
    expect(restarted.indexBar.lastSync?.added).toBe(15);
    // 重启后 App 会先读一次 IndexStatus；这里模拟那一帧，再验证成功结果仍常驻。
    restarted.applyIndexStatus(status({ done: true, phase: "done", indexed: 41357 }));
    expect(restarted.deriveIndexBar(restarted.indexBar)).toMatchObject({ kind: "success", added: 15, auto: true });
  });
});
