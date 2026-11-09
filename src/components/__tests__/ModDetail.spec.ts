import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ModDetail from "../ModDetail.vue";
import type { ModEntry } from "../../types";

// ---- Hoisted mocks (vi.mock factories run before imports) ----
const mocks = vi.hoisted(() => ({
  mockIsTranslating: vi.fn(() => false),
  mockTranslationOf: vi.fn(() => null),
  mockEnsureTranslation: vi.fn(),
  mockLoadCachedTranslation: vi.fn(() => Promise.resolve()),
}));

// ---- Mock external dependencies (paths resolved from __tests__/) ----

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../api", () => ({
  toggleModEnabled: vi.fn(),
  deleteModFiles: vi.fn(),
  revealModFolder: vi.fn(),
  fileUrl: vi.fn((p: string) => p),
}));

vi.mock("../../online/downloadQueue", () => ({
  activeTaskOfMod: vi.fn(() => null),
  latestTaskOfMod: vi.fn(() => null),
}));

vi.mock("../../online/translation", () => ({
  activeTranslation: vi.fn(() => null),
  canTranslateText: vi.fn(() => true),
  currentTargetLanguageName: vi.fn(() => "中文"),
  ensureTranslation: mocks.mockEnsureTranslation,
  isQueued: vi.fn(() => false),
  isShowingOriginal: vi.fn(() => false),
  isTranslating: mocks.mockIsTranslating,
  loadCachedTranslation: mocks.mockLoadCachedTranslation,
  toggleOriginal: vi.fn(),
  translationErrorKind: vi.fn(() => "generic"),
  translationLangEpoch: vi.fn(() => 0),
  translationOf: mocks.mockTranslationOf,
}));

vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  isFavorite: vi.fn(() => false),
  setCustomName: vi.fn(() => Promise.resolve()),
  setFavorite: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../../online/service", () => ({
  openModWebpage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../format", () => ({
  formatBytes: vi.fn(() => "0 B"),
  formatDateTime: vi.fn(() => ""),
  kindLabel: vi.fn(() => "local"),
  sourceLabel: vi.fn(() => "tool"),
  statusLabel: vi.fn(() => "Enabled"),
  translateBackendMessage: vi.fn((m: string) => m),
}));

vi.mock("../../online/types", () => ({
  localizedTagName: vi.fn((t: string) => t),
}));

// ---- Import mocked fns for assertions ----
import { toggleModEnabled, deleteModFiles } from "../../api";

// ---- Helper: build a valid mock mod ----
function makeMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "local/test_mod_12345",
    folderName: "test_mod_12345",
    path: "C:/AoE2DE/mods/local/test_mod_12345",
    kind: "local",
    workshopId: 12345,
    nameFromFolder: "test_mod_12345",
    displayName: "Test Mod",
    displayNameSource: "info.json",
    author: "Tester",
    description: "A test mod description long enough to be translatable.",
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: 1700000000000,
    installedAtMs: 1700000000000,
    checksum: null,
    contentTags: ["ui"],
    categories: ["ui"],
    categorySource: "official",
    officialTags: ["ui"],
    source: "tool",
    metadataRecorded: true,
    issues: [],
    infoJsonPresent: true,
    isDataMod: false,
    uninstalled: false,
    ...overrides,
  };
}

function mountDetail(mod?: ModEntry) {
  return mount(ModDetail, {
    props: {
      mod: mod ?? makeMod(),
      stats: null,
      statsLoading: false,
      statsError: null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockIsTranslating.mockReturnValue(false);
  mocks.mockTranslationOf.mockReturnValue(null);
  mocks.mockLoadCachedTranslation.mockResolvedValue(undefined);
});

// ============================================================
// Test 1: Enable/disable toggle
// ============================================================
describe("ModDetail: 启停按钮事件链", () => {
  it("点击启停按钮后发出 toggled 事件，payload.enabled 为 false", async () => {
    vi.mocked(toggleModEnabled).mockResolvedValue({ enabled: false } as any);

    const wrapper = mountDetail(makeMod({ enabled: true }));
    const toggleBtn = wrapper.find("button.toggle.dv-toggle");
    expect(toggleBtn.exists()).toBe(true);

    await toggleBtn.trigger("click");
    await flushPromises();

    expect(toggleModEnabled).toHaveBeenCalledWith(12345, "local", "test_mod_12345", false);
    const emitted = wrapper.emitted("toggled");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([{ enabled: false }]);
  });

  it("toggleModEnabled 失败时不发出 toggled 事件", async () => {
    vi.mocked(toggleModEnabled).mockRejectedValue(new Error("boom"));

    const wrapper = mountDetail(makeMod({ enabled: true }));
    await wrapper.find("button.toggle.dv-toggle").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("toggled")).toBeFalsy();
  });
});

// ============================================================
// Test 2: Delete / uninstall confirmation
// ============================================================
describe("ModDetail: 卸载确认弹窗", () => {
  it("点击卸载→确认弹窗出现→确认→发出 removed 事件", async () => {
    vi.mocked(deleteModFiles).mockResolvedValue(undefined as any);

    const wrapper = mountDetail();
    const deleteBtn = wrapper.find("button.danger.delete-btn");
    expect(deleteBtn.exists()).toBe(true);

    // 点击卸载按钮
    await deleteBtn.trigger("click");
    await flushPromises();

    // ConfirmDialog 应出现
    expect(wrapper.find(".confirm-modal").exists()).toBe(true);

    // 点击确认按钮（红色 danger 按钮）
    const confirmBtn = wrapper.find(".confirm-actions button.danger, .confirm-actions button.primary");
    expect(confirmBtn.exists()).toBe(true);
    await confirmBtn.trigger("click");
    await flushPromises();

    expect(deleteModFiles).toHaveBeenCalledWith("local", "test_mod_12345", 12345);
    const emitted = wrapper.emitted("removed");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([{ id: "local/test_mod_12345" }]);
  });

  it("点击卸载→取消→不发出 removed 事件", async () => {
    const wrapper = mountDetail();
    await wrapper.find("button.danger.delete-btn").trigger("click");
    await flushPromises();

    expect(wrapper.find(".confirm-modal").exists()).toBe(true);

    // 点击取消按钮（第一个 button）
    const cancelBtn = wrapper.findAll(".confirm-actions button")[0];
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(wrapper.emitted("removed")).toBeFalsy();
    expect(deleteModFiles).not.toHaveBeenCalled();
  });
});

// ============================================================
// Test 3: Translation button
// ============================================================
describe("ModDetail: 翻译按钮事件链", () => {
  it("点击翻译按钮触发 ensureTranslation，成功后按钮恢复可点击", async () => {
    mocks.mockEnsureTranslation.mockResolvedValue({ truncated: false, cached: false });

    const wrapper = mountDetail();
    // 翻译按钮是第二个 .fav-btn（第一个是收藏按钮）
    const favBtns = wrapper.findAll("button.fav-btn");
    expect(favBtns.length).toBeGreaterThanOrEqual(2);
    const translateBtn = favBtns[1];
    expect(translateBtn.exists()).toBe(true);

    await translateBtn.trigger("click");
    await flushPromises();

    expect(mocks.mockEnsureTranslation).toHaveBeenCalledWith(
      { modId: 12345, title: "Test Mod" },
      "A test mod description long enough to be translatable.",
    );
    // 按钮应恢复可点击
    expect((translateBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("翻译失败时 ensureTranslation reject，按钮仍可再次点击", async () => {
    mocks.mockEnsureTranslation.mockRejectedValue(new Error("network error"));

    const wrapper = mountDetail();
    const translateBtn = wrapper.findAll("button.fav-btn")[1];

    await translateBtn.trigger("click");
    await flushPromises();

    expect(mocks.mockEnsureTranslation).toHaveBeenCalled();
    // 失败后按钮不应永久 disabled
    expect((translateBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("翻译进行中（isTranslating=true）时按钮 disabled", async () => {
    mocks.mockIsTranslating.mockReturnValue(true);
    mocks.mockEnsureTranslation.mockReturnValue(new Promise(() => {})); // never resolves

    const wrapper = mountDetail();
    const translateBtn = wrapper.findAll("button.fav-btn")[1];

    await flushPromises();
    expect((translateBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("已有译文时点击按钮走 toggleOriginal 路径，不调用 ensureTranslation", async () => {
    mocks.mockTranslationOf.mockReturnValue({
      title: "测试模组",
      desc: "测试描述",
      provider: "google",
      cached: true,
    } as any);

    const wrapper = mountDetail();
    const translateBtn = wrapper.findAll("button.fav-btn")[1];

    await translateBtn.trigger("click");
    await flushPromises();

    expect(mocks.mockEnsureTranslation).not.toHaveBeenCalled();
  });
});
