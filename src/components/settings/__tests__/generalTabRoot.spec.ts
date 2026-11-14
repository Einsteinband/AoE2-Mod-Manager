import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { ScanReport } from "../../../types";
import { pickFolder, setModRoot } from "../../../api";
import GeneralTab from "../GeneralTab.vue";

/**
 * 回归背景：设置 → 通用「更换根目录」原来只 emit 一个 change-root，
 * App 侧把它接到「打开设置 + 闪烁游戏根目录」，而按钮本身就在设置页里，
 * 结果点下去没有任何可见反应，也没有真的改 settings.mod_root。
 * 现在该按钮必须：选目录 → set_mod_root → 抛 root-changed（后端已重扫）。
 */
vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  };
});

vi.mock("../../../api", () => ({
  detectGameRoot: vi.fn(),
  getSettings: vi.fn(async () => ({ gameRootDir: null })),
  setGameRootDir: vi.fn(),
  setLocale: vi.fn(),
  pickFolder: vi.fn(),
  setModRoot: vi.fn(),
}));

function report(root: string): ScanReport {
  return {
    root,
    rootExists: true,
    scannedAtMs: 1700000000000,
    localDir: `${root}/local`,
    subscribedDir: `${root}/subscribed`,
    localExists: true,
    subscribedExists: true,
    mods: [],
    warnings: [],
  };
}

function findChangeRootButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper
    .findAll("button")
    .find((b) => b.text().includes("settingsUi.changeRoot"));
  if (!button) throw new Error("change-root button not found");
  return button;
}

describe("GeneralTab 模组根目录", () => {
  beforeEach(() => {
    vi.mocked(pickFolder).mockReset();
    vi.mocked(setModRoot).mockReset();
  });

  it("选中目录后调用 set_mod_root，并把扫描结果抛给上层", async () => {
    vi.mocked(pickFolder).mockResolvedValue("F:/Games/AoE2DE2");
    const next = report("F:/Games/AoE2DE2");
    vi.mocked(setModRoot).mockResolvedValue(next);

    const wrapper = mount(GeneralTab, { props: { rootPath: "F:/Games/AoE2DE" } });
    await flushPromises();

    await findChangeRootButton(wrapper).trigger("click");
    await flushPromises();

    expect(pickFolder).toHaveBeenCalledWith("F:/Games/AoE2DE");
    expect(setModRoot).toHaveBeenCalledWith("F:/Games/AoE2DE2");

    const emitted = wrapper.emitted("root-changed");
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toEqual(next);

    // 旧的错误接线（只发 change-root、交给 App 去开设置）必须不存在
    expect(wrapper.emitted("change-root")).toBeUndefined();
    // 成功提示落在模组根目录行
    expect(wrapper.find(".game-root-ok").exists()).toBe(true);
  });

  it("取消选择时不写入配置，也不抛事件", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);

    const wrapper = mount(GeneralTab, { props: { rootPath: "F:/Games/AoE2DE" } });
    await flushPromises();

    await findChangeRootButton(wrapper).trigger("click");
    await flushPromises();

    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(setModRoot).not.toHaveBeenCalled();
    expect(wrapper.emitted("root-changed")).toBeUndefined();
    expect(wrapper.find(".game-root-ok").exists()).toBe(false);
  });

  it("后端拒绝该目录时展示错误，且不接管扫描结果", async () => {
    vi.mocked(pickFolder).mockResolvedValue("F:/NotAModRoot");
    vi.mocked(setModRoot).mockRejectedValue(new Error("aoe2mm:err:lib.modRootNotSet"));

    const wrapper = mount(GeneralTab, { props: { rootPath: "F:/Games/AoE2DE" } });
    await flushPromises();

    await findChangeRootButton(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.emitted("root-changed")).toBeUndefined();
    expect(wrapper.find(".game-root-warn").exists()).toBe(true);
  });
});
