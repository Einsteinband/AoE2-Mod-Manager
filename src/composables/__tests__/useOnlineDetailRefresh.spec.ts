/**
 * 「刷新 Mod 信息」的数据层测试（`useOnlineDetail.refreshDetail`）。
 *
 * 覆盖用户可感知的三件事：
 * 1. 绕过详情缓存与 3 秒冷却，强制重取一次官方 Detail；
 * 2. 刷新期间 `infoRefreshing=true`（面板据此禁用按钮），结束后复位；
 * 3. 失败保留已显示详情、成功写入新详情；切走模组后到达的响应被丢弃。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computed, ref } from "vue";
import type { OnlineMod } from "../../online/types";

// 只替换 useI18n：`online/types` 在运行时还会用到 i18n 单例（createI18n 必须保留）
vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) };
});

vi.mock("../../online/cache", () => ({
  readDetailCache: vi.fn(async () => ({ value: { description: "cached" }, expired: false, savedAtMs: 0 })),
  usableDetailCache: vi.fn(() => true),
}));

vi.mock("../../online/errors", () => ({
  messageOf: vi.fn((e: unknown) => (e as Error)?.message ?? "err"),
  rawMessageOf: vi.fn((e: unknown) => (e as Error)?.message ?? "aoe2mm:err:common.unknownError"),
}));

vi.mock("../../format", () => ({
  translateBackendMessage: vi.fn((text: string) => `translated:${text}`),
}));

vi.mock("../../online/networkError", async () => {
  const { ref } = await vi.importActual<typeof import("vue")>("vue");
  return {
    isNetworkError: ref(false),
    isNetworkFailure: vi.fn(() => false),
    noteRequestFailure: vi.fn(),
  };
});

vi.mock("../../online/service", () => ({ modDetail: vi.fn() }));

vi.mock("../../online/translation", () => ({
  activeTranslation: vi.fn(() => null),
  canTranslateDescription: vi.fn(() => true),
  hasTranslatableText: vi.fn(() => true),
  currentTargetLanguageName: vi.fn(() => "Chinese"),
  ensureTranslation: vi.fn(),
  isQueued: vi.fn(() => false),
  isShowingOriginal: vi.fn(() => false),
  isTranslating: vi.fn(() => false),
  toggleOriginal: vi.fn(),
  translationErrorKind: vi.fn(() => "generic"),
  translationOf: vi.fn(() => null),
  translatedTitleOf: vi.fn(() => null),
}));

vi.mock("../../sessionState", async () => {
  const { ref } = await vi.importActual<typeof import("vue")>("vue");
  return { sessionPhase: ref("online") };
});

vi.mock("../../userData", () => ({ customNameOf: vi.fn(() => null) }));

import { modDetail } from "../../online/service";
import { useOnlineDetail } from "../online/useOnlineDetail";

function makeMod(modId = 12345): OnlineMod {
  return {
    modId,
    title: `Mod ${modId}`,
    creator: "Tester",
    thumbnail: null,
    installs: 10,
    installsTruncated: false,
    rating: 4.5,
    modStatus: "available",
    userInstalled: false,
    userDownloaded: false,
    updateAvailable: false,
    gameTitleId: 2,
    tagIds: [],
    tagNames: [],
    fileSize: null,
    raw: {},
  };
}

function setup(mod: OnlineMod | null = makeMod()) {
  const selected = ref<OnlineMod | null>(mod);
  const selection = {
    selected,
    selectedId: computed(() => selected.value?.modId ?? null),
    select: (next: OnlineMod | null) => {
      selected.value = next;
    },
  };
  const showToast = vi.fn();
  const detail = useOnlineDetail({ selection, showToast });
  return { selection, detail, showToast, selected };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useOnlineDetail: 刷新 Mod 信息", () => {
  it("绕过缓存与冷却，强制重取官方详情并写入；期间 infoRefreshing=true", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    vi.mocked(modDetail).mockImplementation(
      () => new Promise<Record<string, unknown>>((res) => { resolve = res; }),
    );
    const { detail, showToast } = setup();

    // 先按正常链路加载（缓存命中，不发请求）
    await detail.loadDetail(makeMod());
    expect(modDetail).not.toHaveBeenCalled();

    const pending = detail.refreshDetail();
    expect(detail.infoRefreshing.value).toBe(true);
    expect(vi.mocked(modDetail)).toHaveBeenCalledWith(12345);

    resolve({ description: "fresh", modVersion: "2.0" });
    await pending;

    expect(detail.infoRefreshing.value).toBe(false);
    expect(detail.detail.value).toMatchObject({ modVersion: "2.0" });
    expect(showToast).toHaveBeenCalledWith("detail.infoRefreshed", "ok");
  });

  it("刷新失败保留已显示详情，只提示不刷新内容", async () => {
    vi.mocked(modDetail).mockRejectedValue(new Error("network down"));
    const { detail, showToast } = setup();
    await detail.loadDetail(makeMod());

    await detail.refreshDetail();

    expect(detail.detail.value).toMatchObject({ description: "cached" });
    expect(detail.detailError.value).toBeNull();
    expect(showToast.mock.calls.at(-1)?.[1]).toBe("error");
    expect(detail.infoRefreshing.value).toBe(false);
  });

  it("刷新期间用户切到别的模组：返回的旧详情直接丢弃", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    vi.mocked(modDetail).mockImplementation(
      () => new Promise<Record<string, unknown>>((res) => { resolve = res; }),
    );
    const { detail, selection, selected } = setup();
    await detail.loadDetail(makeMod());

    const pending = detail.refreshDetail();
    selection.select(makeMod(999));
    selected.value = makeMod(999);
    resolve({ description: "stale" });
    await pending;

    expect(detail.detail.value).toMatchObject({ description: "cached" });
    expect(detail.infoRefreshing.value).toBe(false);
  });

  it("连续点击只发一次请求（进行中直接返回）", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    vi.mocked(modDetail).mockImplementation(
      () => new Promise<Record<string, unknown>>((res) => { resolve = res; }),
    );
    const { detail } = setup();
    await detail.loadDetail(makeMod());

    const first = detail.refreshDetail();
    void detail.refreshDetail();
    expect(vi.mocked(modDetail)).toHaveBeenCalledTimes(1);

    resolve({ description: "x" });
    await first;
  });
});
