import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ModCard from "../ModCard.vue";
import type { ModEntry } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key} ${params.date}` : key,
  }),
}));

vi.mock("../../api", () => ({
  fileUrl: vi.fn((p: string) => p),
  toggleModEnabled: vi.fn(),
}));

vi.mock("../../format", () => ({
  sourceHint: vi.fn(() => ""),
  sourceLabel: vi.fn(() => "tool"),
  translateBackendMessage: vi.fn((m: string) => m),
  formatDateTime: vi.fn(() => "2026-11-11 18:49"),
}));

vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  displayTitle: vi.fn((_id: number | null, title: string) => title),
  isFavorite: vi.fn(() => false),
}));

vi.mock("../../online/translation", () => ({
  translatedTitleOf: vi.fn(() => null),
}));

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
    description: "A test mod description.",
    thumbnail: "C:/AoE2DE/mods/local/test_mod_12345/thumbnail.jpg",
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
    sizeBytes: null,
    sizeComplete: false,
    uninstalled: false,
    ...overrides,
  };
}

function mountCard(mod: ModEntry) {
  return mount(ModCard, {
    props: { mod, active: false },
  });
}

describe("ModCard 本地卡片", () => {
  it("真实磁盘条目使用已安装信息区背景，并在 meta 行渲染安装时间", () => {
    const wrapper = mountCard(makeMod());
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(true);
    const installedTime = wrapper.find(".card-installed-time");
    expect(installedTime.exists()).toBe(true);
    expect(installedTime.text()).toContain("2026-11-11 18:49");
  });

  it("旧模组缺少 installedAtMs 时不渲染安装时间", () => {
    const wrapper = mountCard(makeMod({ installedAtMs: null }));
    expect(wrapper.find(".card-installed-time").exists()).toBe(false);
  });

  it("未安装收藏占位不使用已安装背景，也不显示本地来源角标或启停开关", () => {
    const wrapper = mountCard(makeMod({ uninstalled: true, installedAtMs: null }));
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(false);
    expect(wrapper.find(".uninstalled-badge").exists()).toBe(false);
    expect(wrapper.find(".source-badge").exists()).toBe(false);
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
  });

  it("封面解码失败时回落到占位块，不停在坏图状态", async () => {
    const wrapper = mountCard(makeMod());
    const img = wrapper.find("img");
    expect(img.exists()).toBe(true);
    await img.trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find(".placeholder").exists()).toBe(true);
  });
});
