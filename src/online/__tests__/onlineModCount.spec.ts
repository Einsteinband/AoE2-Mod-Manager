import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

/**
 * 底栏「在线模组总数」的每日检测规则：
 * - 同一天只成功检测一次；
 * - 跨天重新检测；
 * - 离线 / 未登录不发请求，保留上次结果；
 * - 失败不清掉上次成功值。
 */
vi.mock("../service", () => ({
  findMods: vi.fn(),
}));

vi.mock("../../sessionState", () => ({
  sessionPhase: ref("online"),
}));

import { findMods } from "../service";
import { sessionPhase } from "../../sessionState";
import {
  localDayKey,
  onlineModCount,
  onlineModCountDay,
  refreshOnlineModCountIfDue,
} from "../onlineModCount";

const STORAGE_KEY = "aoe2mm.onlineModCount.v1";

function cache(value: { count: number; day: string }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function day(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 12, 0, 0);
}

beforeEach(() => {
  localStorage.clear();
  onlineModCount.value = null;
  onlineModCountDay.value = "";
  sessionPhase.value = "online";
  vi.mocked(findMods).mockReset();
  vi.mocked(findMods).mockResolvedValue({
    totalCount: 51234,
    isLoggedOn: true,
    items: [],
    serverMessage: null,
  });
});

describe("在线模组总数每日检测", () => {
  it("当天没有缓存时请求一次官方总量并写入缓存", async () => {
    const today = day(2026, 11, 16);
    await expect(refreshOnlineModCountIfDue(today)).resolves.toBe(51234);
    expect(vi.mocked(findMods)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findMods).mock.calls[0][0]).toMatchObject({
      start: 1,
      count: 1,
      query: "",
      tags: [],
    });
    expect(onlineModCount.value).toBe(51234);
    expect(onlineModCountDay.value).toBe("2026-11-16");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      count: 51234,
      day: "2026-11-16",
    });
  });

  it("同一天第二次调用直接复用，不再发请求", async () => {
    const today = day(2026, 11, 17);
    await refreshOnlineModCountIfDue(today);
    await refreshOnlineModCountIfDue(today);
    expect(vi.mocked(findMods)).toHaveBeenCalledTimes(1);
    expect(onlineModCount.value).toBe(51234);
  });

  it("缓存已经是今天的结果 → 启动时一个请求都不发", async () => {
    cache({ count: 48000, day: "2026-11-18" });
    const value = await refreshOnlineModCountIfDue(day(2026, 11, 18));
    expect(value).toBe(48000);
    expect(vi.mocked(findMods)).not.toHaveBeenCalled();
  });

  it("跨天重新检测并覆盖缓存", async () => {
    cache({ count: 48000, day: "2026-11-19" });
    const value = await refreshOnlineModCountIfDue(day(2026, 11, 20));
    expect(vi.mocked(findMods)).toHaveBeenCalledTimes(1);
    expect(value).toBe(51234);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      count: 51234,
      day: "2026-11-20",
    });
  });

  it("未登录 / 校验中不消耗当天检测机会，只沿用缓存", async () => {
    cache({ count: 48000, day: "2026-11-21" });
    sessionPhase.value = "offline";
    const value = await refreshOnlineModCountIfDue(day(2026, 11, 22));
    expect(value).toBe(48000);
    expect(vi.mocked(findMods)).not.toHaveBeenCalled();
    expect(onlineModCountDay.value).toBe("2026-11-21");
  });

  it("检测失败保留上一次成功数量", async () => {
    cache({ count: 48000, day: "2026-11-23" });
    vi.mocked(findMods).mockRejectedValue(new Error("network down"));
    const value = await refreshOnlineModCountIfDue(day(2026, 11, 24));
    expect(value).toBe(48000);
    expect(onlineModCount.value).toBe(48000);
    expect(onlineModCountDay.value).toBe("2026-11-23");
  });

  it("localDayKey 使用本地自然日", () => {
    expect(localDayKey(day(2026, 1, 5))).toBe("2026-01-05");
  });
});
