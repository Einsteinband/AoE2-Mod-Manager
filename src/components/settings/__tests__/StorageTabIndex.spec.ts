import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { IndexStatus } from "../../../online/types";

/**
 * 设置 → 缓存与存储：在线模组索引。
 *
 * 这里验证的是设置页入口：状态复用 indexStatusStore、按钮进入 busy/disabled、
 * 点击走 retryIndexSync（真实同步入口）。实际 Tauri 同步与底栏结果仍需 C 级实机验证。
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "data_dir_view"
      ? {
          path: "C:/AoE2Cache",
          exists: true,
          isCustom: false,
          totalBytes: 0,
          imagesBytes: 0,
          legacy: false,
        }
      : null,
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

vi.mock("../../../online/indexStatusStore", async () => {
  const { reactive } = await import("vue");
  return {
    indexBar: reactive({
      status: null,
      failure: "",
      needLogin: false,
      retrying: false,
      lastSync: null,
    }),
    retryIndexSync: vi.fn(async () => true),
    refreshIndexStatus: vi.fn(async () => null),
  };
});

import StorageTab from "../StorageTab.vue";
import { indexBar, retryIndexSync } from "../../../online/indexStatusStore";

function status(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    indexed: 41357,
    totalCount: 41327,
    scanned: 41327,
    done: true,
    syncing: false,
    indexingEnabled: true,
    phase: "done",
    message: "",
    updatedAtMs: 1,
    fullSyncedAtMs: 1,
    cooldownUntilMs: 0,
    path: "C:/AoE2Cache/online_index.json",
    maxItems: 100000,
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

function indexButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper
    .findAll("button")
    .find((b) => b.text().includes("settings.onlineIndexUpdate") || b.text().includes("settings.onlineIndexUpdating"));
  if (!button) throw new Error("online index button not found");
  return button;
}

describe("StorageTab 在线模组索引", () => {
  beforeEach(() => {
    vi.mocked(retryIndexSync).mockClear();
    vi.mocked(retryIndexSync).mockResolvedValue(true);
    indexBar.status = null;
    indexBar.failure = "";
    indexBar.needLogin = false;
    indexBar.retrying = false;
    indexBar.lastSync = null;
  });

  it("复用 IndexStatus 展示本地索引、最近同步与今天真实新增", async () => {
    indexBar.status = status({
      lastSyncAtMs: Date.now() - 60_000,
      lastSyncAdded: 15,
      lastSyncUpdated: 35,
      lastSyncReason: "manual",
      lastSyncComplete: true,
      lastSyncOk: true,
    });

    const wrapper = mount(StorageTab);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("settings.onlineIndexTitle");
    expect(text).toContain("settings.onlineIndexNote");
    expect(text).toContain("settings.onlineIndexCount(41357)");
    expect(text).toContain("settings.onlineIndexLastToday(");
    expect(text).toContain("settings.onlineIndexAddedToday(15)");
    expect(indexButton(wrapper).text()).toContain("settings.onlineIndexUpdate");
  });

  it("冷启动无 lastSync 时用索引持久更新时间，且不伪造今日新增", async () => {
    indexBar.status = status({
      lastSyncAtMs: 0,
      updatedAtMs: Date.now() - 60_000,
      lastSyncComplete: false,
      lastSyncOk: false,
    });

    const wrapper = mount(StorageTab);
    await flushPromises();

    expect(wrapper.text()).toContain("settings.onlineIndexLastToday(");
    expect(wrapper.text()).not.toContain("settings.onlineIndexAddedToday(");
  });

  it("点击按钮走 retryIndexSync（manual 同步入口）", async () => {
    indexBar.status = status();

    const wrapper = mount(StorageTab);
    await flushPromises();
    await indexButton(wrapper).trigger("click");
    await flushPromises();

    expect(retryIndexSync).toHaveBeenCalledTimes(1);
  });

  it("同步中按钮显示正在更新且禁用，不会重复触发", async () => {
    indexBar.status = status({ syncing: true });

    const wrapper = mount(StorageTab);
    await flushPromises();
    const button = indexButton(wrapper);

    expect(button.text()).toContain("settings.onlineIndexUpdating");
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    await button.trigger("click");
    expect(retryIndexSync).not.toHaveBeenCalled();
  });

  it("失败 / 部分完成不显示为今日新增", async () => {
    indexBar.status = status({
      lastSyncAtMs: Date.now() - 60_000,
      lastSyncComplete: true,
      lastSyncOk: false,
    });
    const failed = mount(StorageTab);
    await flushPromises();
    expect(failed.text()).toContain("settings.onlineIndexLastFailed");
    expect(failed.text()).not.toContain("settings.onlineIndexAddedToday(");

    indexBar.status = status({
      lastSyncAtMs: Date.now() - 60_000,
      lastSyncComplete: false,
      lastSyncOk: false,
    });
    const partial = mount(StorageTab);
    await flushPromises();
    expect(partial.text()).toContain("settings.onlineIndexLastPartial");
    expect(partial.text()).not.toContain("settings.onlineIndexAddedToday(");
  });
});
