import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import OnlineModCard from "../OnlineModCard.vue";
import ModCard from "../ModCard.vue";
import type { OnlineMod } from "../../online/types";
import type { ModEntry } from "../../types";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../userData", () => ({
  customNameOf: vi.fn(() => null),
  displayTitle: vi.fn((_id: number | null, title: string) => title),
  isFavorite: vi.fn(() => false),
}));

vi.mock("../../online/translation", () => ({
  translatedTitleOf: vi.fn(() => null),
}));

function makeOnlineMod(overrides: Partial<OnlineMod> = {}): OnlineMod {
  return {
    modId: 12345,
    title: "Test Online Mod",
    creator: "Tester",
    thumbnail: null,
    installs: 1200,
    installsTruncated: false,
    rating: 4.5,
    modStatus: null,
    userInstalled: false,
    userDownloaded: false,
    updateAvailable: false,
    gameTitleId: 2,
    tagIds: [],
    tagNames: [],
    fileSize: null,
    raw: {},
    ...overrides,
  };
}

function mountOnline(mod: OnlineMod, installed?: boolean) {
  return mount(OnlineModCard, {
    props: { mod, active: false, installed },
  });
}

describe("OnlineModCard 本机安装标签", () => {
  it("本机已安装时显示已安装背景与角标，不显示在线/订阅徽章", () => {
    const wrapper = mountOnline(makeOnlineMod(), true);
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(true);
    const installedBadge = wrapper.find(".badge.installed");
    expect(installedBadge.exists()).toBe(true);
    expect(installedBadge.text()).toBe("online.cardInstalled");
    expect(wrapper.find(".badge.sub").exists()).toBe(false);
    expect(wrapper.find(".badge.warn").exists()).toBe(false);
  });

  it("本机未安装且服务端未订阅时不显示冗余在线徽章", () => {
    const wrapper = mountOnline(makeOnlineMod(), false);
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(false);
    expect(wrapper.find(".badge.installed").exists()).toBe(false);
    expect(wrapper.find(".badge.sub").exists()).toBe(false);
    expect(wrapper.find(".badge.warn").exists()).toBe(false);
    expect(wrapper.find(".badge").exists()).toBe(false);
  });

  it("本机未安装但服务端已订阅时显示订阅徽章，不显示已安装背景或角标", () => {
    const wrapper = mountOnline(makeOnlineMod({ userInstalled: true }), false);
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(false);
    expect(wrapper.find(".badge.installed").exists()).toBe(false);
    expect(wrapper.find(".badge.sub").exists()).toBe(true);
  });

  it("在线收藏离线占位缺少本机安装索引时不显示已安装背景", () => {
    const wrapper = mountOnline(
      makeOnlineMod({ creator: null, thumbnail: null, installs: null, userInstalled: false }),
      false,
    );
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(false);
    expect(wrapper.find(".badge.installed").exists()).toBe(false);
  });

  it("在线收藏条目命中本机安装索引时显示已安装背景与角标", () => {
    const wrapper = mountOnline(
      makeOnlineMod({ creator: null, thumbnail: null, installs: null, userInstalled: false }),
      true,
    );
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(true);
    expect(wrapper.find(".badge.installed").exists()).toBe(true);
  });

  it("服务端订阅与本机安装同时存在时，本机已安装角标独立显示", () => {
    const wrapper = mountOnline(makeOnlineMod({ userInstalled: true }), true);
    expect(wrapper.find(".badge.installed").exists()).toBe(true);
    // 服务端订阅标记是另一事实，保留在正文状态徽章，不被本机安装角标覆盖
    expect(wrapper.find(".badge.sub").exists()).toBe(true);
  });

  it("可更新状态与本机已安装角标同时显示", () => {
    const wrapper = mountOnline(makeOnlineMod({ updateAvailable: true }), true);
    expect(wrapper.find(".badge.warn").exists()).toBe(true);
    expect(wrapper.find(".badge.installed").exists()).toBe(true);
  });
});

function makeLocalMod(overrides: Partial<ModEntry> = {}): ModEntry {
  return {
    id: "local/test_mod_12345",
    folderName: "test_mod_12345",
    path: "C:/AoE2DE/mods/local/test_mod_12345",
    kind: "local",
    workshopId: 12345,
    nameFromFolder: "test_mod_12345",
    displayName: "Test Local Mod",
    displayNameSource: "info.json",
    author: "Tester",
    description: "A local mod.",
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: 1700000000000,
    installedAtMs: null,
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
    ...overrides,
  };
}

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

describe("ModCard 本地卡片", () => {
  it("不渲染在线模组的已安装徽章", () => {
    const wrapper = mount(ModCard, { props: { mod: makeLocalMod(), active: false } });
    expect(wrapper.find(".badge.installed").exists()).toBe(false);
  });
});
