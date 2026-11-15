import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus } from "../types";

/**
 * 底部状态栏的索引展示规则（纯推导 + 状态机）。
 *
 * 覆盖任务验收里能自动化验证的部分：
 * - 自动更新关闭 → 什么都不显示（更没有手动入口）；
 * - 同步中 → 进度且没有手动按钮；
 * - 失败 → 失败 + 唯一「手动重试」；
 * - 跑完 → 短暂成功提示（新增条数按条数差推算，自动任务也能拿到）；
 * - 重试在飞 → 进度优先，按钮隐藏。
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
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("../indexStatusStore");
}

describe("deriveIndexBar", () => {
  it("自动更新关闭时整块隐藏（不看数据、不看失败）", async () => {
    const { deriveIndexBar } = await loadStore();
    const state = {
      status: status({ indexingEnabled: false, indexed: 42000, done: true, lastError: "boom" }),
      failure: "boom",
      needLogin: false,
      retrying: false,
      flashAdded: 5 as number | null,
    };
    expect(deriveIndexBar(state).kind).toBe("hidden");
  });

  it("读不到状态时隐藏", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: null,
      failure: "",
      needLogin: false,
      retrying: false,
      flashAdded: null,
    });
    expect(view.kind).toBe("hidden");
    expect(view.showRetry).toBe(false);
  });

  it("同步中显示进度且没有手动按钮", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: status({ syncing: true, phase: "syncing", indexed: 120 }),
      failure: "",
      needLogin: false,
      retrying: false,
      flashAdded: null,
    });
    expect(view.kind).toBe("syncing");
    expect(view.showRetry).toBe(false);
  });

  it("失败时出现唯一的手动重试入口", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: status({ phase: "paused", lastError: "network down", done: false }),
      failure: "network down",
      needLogin: false,
      retrying: false,
      flashAdded: null,
    });
    expect(view.kind).toBe("failed");
    expect(view.showRetry).toBe(true);
  });

  it("未登录类失败不给重试（重试必然再失败）", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: status({ phase: "needLogin" }),
      failure: "",
      needLogin: true,
      retrying: false,
      flashAdded: null,
    });
    expect(view.kind).toBe("needLogin");
    expect(view.showRetry).toBe(false);
  });

  it("重试在飞时优先显示进度，按钮消失", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: status({ lastError: "network down" }),
      failure: "network down",
      needLogin: false,
      retrying: true,
      flashAdded: null,
    });
    expect(view.kind).toBe("syncing");
    expect(view.showRetry).toBe(false);
  });

  it("成功提示携带新增条数", async () => {
    const { deriveIndexBar } = await loadStore();
    const view = deriveIndexBar({
      status: status({ done: true }),
      failure: "",
      needLogin: false,
      retrying: false,
      flashAdded: 12,
    });
    expect(view.kind).toBe("success");
    expect(view.added).toBe(12);
  });

  it("已就绪 / 待同步分别是 ready / idle", async () => {
    const { deriveIndexBar } = await loadStore();
    expect(
      deriveIndexBar({
        status: status({ done: true }),
        failure: "",
        needLogin: false,
        retrying: false,
        flashAdded: null,
      }).kind,
    ).toBe("ready");
    expect(
      deriveIndexBar({
        status: status(),
        failure: "",
        needLogin: false,
        retrying: false,
        flashAdded: null,
      }).kind,
    ).toBe("idle");
  });
});

describe("applyIndexStatus（自动任务的状态机）", () => {
  beforeEach(async () => {
    const { stopIndexStatusWatch, indexBar } = await loadStore();
    stopIndexStatusWatch();
    indexBar.status = null;
    indexBar.failure = "";
    indexBar.needLogin = false;
    indexBar.retrying = false;
    indexBar.flashAdded = null;
  });

  afterEach(async () => {
    const { stopIndexStatusWatch } = await loadStore();
    stopIndexStatusWatch();
  });

  it("自动任务跑完后按条数差给出成功提示", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ syncing: true, phase: "syncing", indexed: 100 }));
    store.applyIndexStatus(status({ syncing: true, phase: "syncing", indexed: 130 }));
    expect(store.indexBar.flashAdded).toBeNull();
    store.applyIndexStatus(status({ syncing: false, done: true, phase: "done", indexed: 143 }));
    expect(store.indexBar.flashAdded).toBe(43);
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("success");
  });

  it("自动任务失败时保留失败原因与重试资格", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ syncing: true, phase: "syncing", indexed: 100 }));
    store.applyIndexStatus(
      status({ syncing: false, done: false, phase: "paused", indexed: 100, lastError: "network" }),
    );
    expect(store.indexBar.failure).toBe("network");
    expect(store.indexBar.flashAdded).toBeNull();
    expect(store.deriveIndexBar(store.indexBar)).toMatchObject({ kind: "failed", showRetry: true });
  });

  it("新一轮开始会清掉上一轮的失败提示", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ phase: "paused", lastError: "network" }));
    expect(store.indexBar.failure).toBe("network");
    store.applyIndexStatus(status({ syncing: true, phase: "syncing" }));
    expect(store.indexBar.failure).toBe("");
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("syncing");
  });

  it("开关关闭后清掉失败 / 成功残留并隐藏", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ phase: "paused", lastError: "network" }));
    store.applyIndexStatus(status({ indexingEnabled: false, phase: "disabled" }));
    expect(store.indexBar.failure).toBe("");
    expect(store.deriveIndexBar(store.indexBar).kind).toBe("hidden");
  });

  it("未登录状态不再当成可重试的失败", async () => {
    const store = await loadStore();
    store.applyIndexStatus(status({ phase: "needLogin", syncing: false }));
    expect(store.indexBar.failure).toBe("");
    expect(store.indexBar.needLogin).toBe(true);
    expect(store.deriveIndexBar(store.indexBar).showRetry).toBe(false);
  });
});
