import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { checkUpdate, fetchGithubReleases, openExternalUrl } from "../../../api";
import { releaseHistory } from "../../../releaseHistory";
import AboutTab from "../AboutTab.vue";

/**
 * 关于页「更新历史」改为内置数据后的行为测试（B 级）
 *
 * 这里刻意用真实的 RELEASE_NOTES.md（经 Vite ?raw 进入模块），只把网络类 API 换成桩：
 * 断言的是「展开后看到的是本地归档」+「全程没有调用 GitHub 接口」，
 * 不是用 mock 出来的 Release 列表伪造成功。
 */
vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

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

function historyToggle(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll("button").find((b) => b.text().includes("settings.changelogShow"));
  if (!button) throw new Error("history toggle not found");
  return button;
}

async function mountWithHistoryOpen() {
  const wrapper = mount(AboutTab);
  await flushPromises();
  await historyToggle(wrapper).trigger("click");
  await flushPromises();
  return wrapper;
}

describe("关于页更新历史（内置数据）", () => {
  beforeEach(() => {
    vi.mocked(fetchGithubReleases).mockClear();
    vi.mocked(openExternalUrl).mockClear();
  });

  it("展开即显示随包构建的归档，不请求 GitHub", async () => {
    const wrapper = await mountWithHistoryOpen();

    expect(fetchGithubReleases).not.toHaveBeenCalled();

    const items = wrapper.findAll(".about-history-item");
    expect(items.length).toBe(releaseHistory.length);
    expect(items[0].text()).toContain(releaseHistory[0].tagName);
    expect(items[0].text()).toContain(releaseHistory[0].publishedAt);
    // 正文按原 Markdown 渲染成 HTML，而不是纯文本堆在一起
    expect(items[0].find(".release-notes").html()).toContain("<ul>");
    expect(items[0].find(".release-notes").html()).toContain("<strong>");
  });

  it("多个版本按从新到旧排列，版本号/日期/正文都在", async () => {
    const wrapper = await mountWithHistoryOpen();
    const items = wrapper.findAll(".about-history-item");

    const shownVersions = items.map((item) => item.find(".about-history-version").text());
    expect(shownVersions).toEqual(releaseHistory.map((entry) => `v${entry.version}`));

    items.forEach((item, index) => {
      expect(item.find(".about-history-date").text()).toBe(releaseHistory[index].publishedAt);
      expect(item.find(".release-notes").exists()).toBe(true);
    });

    // 最早的版本也在，历史没有被截断成最近几条
    expect(shownVersions).toContain("v0.1.0");
    expect(shownVersions.length).toBeGreaterThanOrEqual(20);
  });

  it("断网状态下仍然完整显示（展开不依赖网络）", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      const wrapper = await mountWithHistoryOpen();
      expect(fetchGithubReleases).not.toHaveBeenCalled();
      expect(wrapper.findAll(".about-history-item").length).toBeGreaterThanOrEqual(20);
    } finally {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    }
  });

  it("再次点击可以收起", async () => {
    const wrapper = await mountWithHistoryOpen();
    const toggle = wrapper
      .findAll("button")
      .find((b) => b.text().includes("settings.changelogHide"));
    if (!toggle) throw new Error("collapse button not found");
    await toggle.trigger("click");
    await flushPromises();
    expect(wrapper.find(".about-history").exists()).toBe(false);
    expect(wrapper.findAll(".about-history-item")).toHaveLength(0);
  });

  it("仓库与 Issues 等外部链接仍然走 openExternalUrl", async () => {
    const wrapper = mount(AboutTab);
    await flushPromises();

    const links = wrapper.findAll(".about-link").filter((b) => b.text().includes("github.com"));
    expect(links.length).toBeGreaterThan(0);
    await links[0].trigger("click");
    await flushPromises();
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/Einsteinband/AoE2-Mod-Manager");
  });

  it("在线检查更新仍然可用，并在有更新时跳到 Release 页面", async () => {
    vi.mocked(checkUpdate).mockResolvedValue({
      currentVersion: "0.5.2",
      latestVersion: "0.6.0",
      hasUpdate: true,
      releaseUrl: "https://github.com/Einsteinband/AoE2-Mod-Manager/releases/tag/v0.6.0",
      releaseName: "v0.6.0",
      publishedAt: "2026-12-01T00:00:00Z",
      notes: null,
    });

    const wrapper = mount(AboutTab);
    await flushPromises();

    const checkButton = wrapper.findAll("button").find((b) => b.text().includes("settings.checkUpdate"));
    if (!checkButton) throw new Error("check button not found");
    await checkButton.trigger("click");
    await flushPromises();

    expect(checkUpdate).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/Einsteinband/AoE2-Mod-Manager/releases/tag/v0.6.0",
    );
    expect(wrapper.text()).toContain("settings.found");
    // 更新历史与这条路互不影响：本地归档仍在
    expect(releaseHistory.length).toBeGreaterThan(0);
  });
});
