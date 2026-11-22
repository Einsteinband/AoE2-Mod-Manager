import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import ModCard from "../ModCard.vue";
import type { ModEntry } from "../../types";
import { CARD_TOGGLE_DEFAULTS, cardTogglePrefs, setCardTogglePrefs } from "../../composables/local/cardTogglePrefs";

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

/** 每个用例都从出厂默认（显示 + 圆形按钮）起步，避免偏好串扰 */
beforeEach(() => {
  setCardTogglePrefs(CARD_TOGGLE_DEFAULTS);
});

describe("ModCard 本地卡片", () => {
  it("真实磁盘条目使用已安装信息区背景，并在 meta 行渲染安装时间", () => {
    const wrapper = mountCard(makeMod());
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(true);
    const installedTime = wrapper.find(".card-installed-time");
    expect(installedTime.exists()).toBe(true);
    expect(installedTime.text()).toContain("2026-11-11 18:49");
  });

  it("有自定义备注名时只显示备注名，原名退到标题 tooltip，且没有副标题行", async () => {
    const userData = await import("../../userData");
    vi.mocked(userData.customNameOf).mockReturnValue("我的骑士 Mod");
    vi.mocked(userData.displayTitle).mockReturnValue("我的骑士 Mod");
    try {
      const wrapper = mountCard(makeMod());
      const title = wrapper.find(".card-title");
      expect(title.text()).toBe("我的骑士 Mod");
      // 原名不丢：仅作为 tooltip 存在，不再占一行
      expect(title.attributes("title")).toBe("Test Mod");
      expect(wrapper.find(".card-sub").exists()).toBe(false);
    } finally {
      vi.mocked(userData.customNameOf).mockReturnValue(null);
      vi.mocked(userData.displayTitle).mockImplementation((_id, t) => t);
    }
  });

  it("没有自定义备注名时显示原名，tooltip 也是原名", () => {
    const wrapper = mountCard(makeMod());
    const title = wrapper.find(".card-title");
    expect(title.text()).toBe("Test Mod");
    expect(title.attributes("title")).toBe("Test Mod");
    expect(wrapper.find(".card-sub").exists()).toBe(false);
  });

  it("旧模组缺少 installedAtMs 时不渲染安装时间", () => {
    const wrapper = mountCard(makeMod({ installedAtMs: null }));
    expect(wrapper.find(".card-installed-time").exists()).toBe(false);
  });

  it("未安装收藏占位不使用已安装背景，也不显示本地来源角标或启停开关", () => {
    setCardTogglePrefs({ show: true });
    const wrapper = mountCard(makeMod({ uninstalled: true, installedAtMs: null }));
    expect(wrapper.find(".card-body.is-installed").exists()).toBe(false);
    expect(wrapper.find(".uninstalled-badge").exists()).toBe(false);
    expect(wrapper.find(".source-badge").exists()).toBe(false);
    expect(wrapper.find(".card-switch").exists()).toBe(false);
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
    expect(wrapper.find(".card-enabled-bar").exists()).toBe(false);
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

describe("ModCard 启用状态：默认隐藏控件 + 信息区已启用侧边栏", () => {
  it("首次使用（默认配置）不渲染任何启用/禁用控件，但底部操作行与安装时间照常保留", () => {
    const wrapper = mountCard(makeMod({ enabled: true }));
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
    expect(wrapper.find(".card-switch").exists()).toBe(false);
    expect(wrapper.findAll("[role='switch']")).toHaveLength(0);
    // 行本身恒定存在（高度由 --card-action-row-height 固定），只少一个按钮元素
    const row = wrapper.find(".card-meta.meta-top");
    expect(row.exists()).toBe(true);
    expect(row.find(".card-installed-time").exists()).toBe(true);
    // 业务状态照常表达：已启用仍渲染绿色侧边条
    expect(wrapper.find(".card-enabled-bar").exists()).toBe(true);
  });

  it("三种按钮状态共用同一底部操作行：行元素与安装时间始终在，只有控件元素增减", () => {
    const rowOf = (wrapper: VueWrapper) => wrapper.find(".card-meta.meta-top");

    setCardTogglePrefs({ show: true, style: "circle" });
    const circle = mountCard(makeMod({ enabled: true }));
    expect(rowOf(circle).exists()).toBe(true);
    expect(rowOf(circle).find(".card-toggle").exists()).toBe(true);
    expect(rowOf(circle).find(".card-installed-time").exists()).toBe(true);

    setCardTogglePrefs({ show: true, style: "switch" });
    const apple = mountCard(makeMod({ enabled: true }));
    expect(rowOf(apple).find(".card-switch").exists()).toBe(true);
    expect(rowOf(apple).find(".card-installed-time").exists()).toBe(true);

    setCardTogglePrefs({ show: false });
    const hidden = mountCard(makeMod({ enabled: true }));
    expect(rowOf(hidden).find(".card-toggle").exists()).toBe(false);
    expect(rowOf(hidden).find(".card-switch").exists()).toBe(false);
    // 控件消失但行没消失：安装时间仍在同一行里（CSS 用 margin-left:auto 锚定行末）
    expect(rowOf(hidden).find(".card-installed-time").exists()).toBe(true);
    // 行内只剩安装时间时也不能给该行多加类名 / 内联样式去补偿高度
    expect(rowOf(hidden).attributes("style")).toBeUndefined();
    expect(rowOf(hidden).classes()).toEqual(["card-meta", "meta-top"]);
  });

  it("打开显示开关后使用默认圆形按钮：已启用为绿勾，aria-checked=true，并渲染绿色侧边条", () => {
    setCardTogglePrefs({ show: true });
    const wrapper = mountCard(makeMod({ enabled: true }));
    const sw = wrapper.find(".card-toggle");
    expect(sw.exists()).toBe(true);
    expect(wrapper.find(".card-switch").exists()).toBe(false);
    expect(sw.classes()).toContain("on");
    expect(sw.attributes("role")).toBe("switch");
    expect(sw.attributes("aria-checked")).toBe("true");
    // 勾线图标
    expect(sw.find("svg path").attributes("d")).toContain("9.4 3.6");

    expect(wrapper.find(".card-enabled-bar").exists()).toBe(true);
    expect(wrapper.find(".thumb-status").exists()).toBe(false);
  });

  it("圆形按钮未启用时是灰杠；未登记时是虚线样式", () => {
    setCardTogglePrefs({ show: true });
    const off = mountCard(makeMod({ enabled: false })).find(".card-toggle");
    expect(off.classes()).toContain("off");
    expect(off.attributes("aria-checked")).toBe("false");
    expect(off.find("svg path").attributes("d")).toBe("M3.2 6h5.6");

    const unknown = mountCard(makeMod({ enabled: null })).find(".card-toggle");
    expect(unknown.classes()).toContain("unknown");
    expect(unknown.find("svg circle").exists()).toBe(true);
  });

  it("未启用：信息区不显示侧边条、也不留占位", () => {
    const wrapper = mountCard(makeMod({ enabled: false }));
    expect(wrapper.find(".card-enabled-bar").exists()).toBe(false);
  });

  it("切换为 Apple 风格后只渲染 Apple 开关，原圆形按钮不出现", () => {
    setCardTogglePrefs({ show: true, style: "switch" });
    const wrapper = mountCard(makeMod({ enabled: true }));
    const sw = wrapper.find(".card-switch");
    expect(sw.exists()).toBe(true);
    expect(sw.classes()).toContain("on");
    expect(sw.attributes("role")).toBe("switch");
    expect(sw.attributes("aria-checked")).toBe("true");
    expect(sw.find(".card-switch-knob").exists()).toBe(true);
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
  });

  it("关闭显示开关后两种按钮都不渲染，也不留空白占位", () => {
    setCardTogglePrefs({ show: false });
    const wrapper = mountCard(makeMod({ enabled: true }));
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
    expect(wrapper.find(".card-switch").exists()).toBe(false);
    expect(wrapper.findAll("[role='switch']")).toHaveLength(0);
    // 业务状态不受影响：徽标区与侧边条仍按真实启用状态渲染
    expect(wrapper.find(".card-enabled-bar").exists()).toBe(true);
    expect(cardTogglePrefs.show).toBe(false);
  });

  it("隐藏按钮期间点击不会误触发写入；重新开启后恢复上次选择的样式", async () => {
    const toggleModEnabled = vi.mocked((await import("../../api")).toggleModEnabled);
    toggleModEnabled.mockClear();
    setCardTogglePrefs({ show: false, style: "switch" });
    const hidden = mountCard(makeMod({ enabled: true }));
    expect(hidden.find(".card-switch").exists()).toBe(false);

    setCardTogglePrefs({ show: true });
    const shown = mountCard(makeMod({ enabled: true }));
    expect(shown.find(".card-switch").exists()).toBe(true);

    toggleModEnabled.mockResolvedValue({ enabled: false } as never);
    await shown.find(".card-switch").trigger("click");
    expect(toggleModEnabled).toHaveBeenCalledTimes(1);
  });

  it("卡片内只有一个可点击状态入口：侧边条是纯装饰，不产生 toggle 请求", async () => {
    setCardTogglePrefs({ show: true });
    const wrapper = mountCard(makeMod({ enabled: true }));
    expect(wrapper.findAll("[role='switch']")).toHaveLength(1);
    const toggleModEnabled = vi.mocked(
      (await import("../../api")).toggleModEnabled,
    );
    toggleModEnabled.mockClear();
    await wrapper.find(".card-enabled-bar").trigger("click");
    expect(toggleModEnabled).not.toHaveBeenCalled();
  });

  it("点击圆形按钮仍走原有写入链路，并把新状态上抛给父组件", async () => {
    setCardTogglePrefs({ show: true, style: "circle" });
    const toggleModEnabled = vi.mocked((await import("../../api")).toggleModEnabled);
    toggleModEnabled.mockResolvedValue({ enabled: false } as never);
    const wrapper = mountCard(makeMod({ enabled: true }));

    await wrapper.find(".card-toggle").trigger("click");

    expect(toggleModEnabled).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("toggled")).toEqual([
      [{ id: "local/test_mod_12345", enabled: false }],
    ]);
  });

  it("「可更新」红标仍保留在封面右上角，排序序号照常渲染", () => {
    const wrapper = mount(ModCard, {
      props: { mod: makeMod({ enabled: true }), active: false, hasUpdate: true, order: 3 },
    });
    expect(wrapper.find(".update-badge").exists()).toBe(true);
    expect(wrapper.find(".order-badge").exists()).toBe(true);
  });
});

