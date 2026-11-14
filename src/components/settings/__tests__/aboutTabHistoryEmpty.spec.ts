import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

/**
 * 内置归档为空时的空状态（B 级）
 *
 * 单独成文件：需要把 releaseHistory 换成空数组，
 * 而静态 import 的 mock 是模块级的，和正常数据的用例放在一起会互相污染。
 */
vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

vi.mock("../../../releaseHistory", () => ({ releaseHistory: [] }));

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    appVersion: vi.fn(async () => "0.5.2"),
    checkUpdate: vi.fn(),
    diagnosticsInfo: vi.fn(),
    openExternalUrl: vi.fn(async () => undefined),
    openLogsDir: vi.fn(async () => "C:/logs"),
    fetchGithubReleases: vi.fn(),
  };
});

describe("关于页更新历史：空归档", () => {
  it("没有内置记录时给出空状态，而不是空白或加载中", async () => {
    const { default: AboutTab } = await import("../AboutTab.vue");
    const wrapper = mount(AboutTab);
    await flushPromises();

    const toggle = wrapper.findAll("button").find((b) => b.text().includes("settings.changelogShow"));
    if (!toggle) throw new Error("history toggle not found");
    await toggle.trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".about-history-item")).toHaveLength(0);
    expect(wrapper.text()).toContain("settings.changelogEmpty");
    expect(wrapper.text()).not.toContain("settings.changelogLoading");
  });
});
