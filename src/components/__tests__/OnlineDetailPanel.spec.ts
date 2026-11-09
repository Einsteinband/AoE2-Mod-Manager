import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import OnlineDetailPanel from "../online/OnlineDetailPanel.vue";
import type { OnlineMod, DownloadProgress } from "../../online/types";
import type { InstalledIndexEntry } from "../../types";

// ---- Mock external dependencies ----

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../format", () => ({
  sourceLabel: vi.fn((s: string) => `source:${s}`),
}));

// ---- Helper: build a valid mock OnlineMod ----
function makeMod(overrides: Partial<OnlineMod> = {}): OnlineMod {
  return {
    modId: 12345,
    title: "Test Online Mod",
    creator: "Tester",
    thumbnail: null,
    installs: 1000,
    installsTruncated: false,
    rating: 4.5,
    modStatus: "available",
    userInstalled: false,
    userDownloaded: false,
    updateAvailable: false,
    gameTitleId: 2,
    tagIds: [12],
    tagNames: ["Graphics"],
    fileSize: 5242880,
    raw: {},
    ...overrides,
  };
}

const mockLocalEntry: InstalledIndexEntry = {
  workshopId: 12345,
  kind: "local",
  folderName: "test_mod_12345",
  source: "tool",
};

const mockProgress: DownloadProgress = {
  modId: 12345,
  phase: "downloading",
  received: 1048576,
  total: 5242880,
  percent: 20,
};

function mountPanel(props: Record<string, unknown> = {}) {
  const mod = (props.mod !== undefined ? props.mod : makeMod()) as OnlineMod | null;
  return mount(OnlineDetailPanel, {
    props: {
      mod,
      thumb: null,
      title: mod?.title ?? "",
      subtitle: null,
      tags: ["Graphics"],
      translateLabel: "translate.trigger",
      translateProvider: null,
      translateNote: null,
      translateDisabled: false,
      translateActive: false,
      favorited: false,
      canFavorite: true,
      favBusy: false,
      favError: null,
      renameBusy: false,
      ratingText: "4.5/5",
      sizeText: "5.0 MB",
      diskText: "5.0 MB",
      versionText: "1.0",
      createdText: "2024-01-01",
      updatedText: "2024-06-01",
      localEntry: null,
      localIndexError: null,
      primaryAction: "install",
      subscribeLabel: "Install",
      subscribeBusy: false,
      installing: false,
      queued: false,
      queuePos: null,
      cancelRequested: false,
      progress: null,
      actionMessage: null,
      installError: null,
      installNote: null,
      openingWeb: false,
      revealingFolder: false,
      descText: "This is a test mod description.",
      detailLoading: false,
      detailError: null,
      detailUncached: false,
      ...props,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// 1. 空状态与内容展示
// ============================================================
describe("OnlineDetailPanel: 内容展示", () => {
  it("mod 为 null 时显示空状态", () => {
    const wrapper = mountPanel({ mod: null });
    expect(wrapper.find(".detail-empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("online.detailEmpty");
  });

  it("标题、副标题、标签、描述正常渲染", () => {
    const wrapper = mountPanel({
      subtitle: "备注名副标题",
      descText: "Test description body.",
    });
    expect(wrapper.find(".detail-title").text()).toBe("Test Online Mod");
    expect(wrapper.find(".detail-title-orig").text()).toBe("备注名副标题");
    expect(wrapper.findAll(".detail-badges .badge").length).toBeGreaterThanOrEqual(1);
    expect(wrapper.find(".dv-desc").text()).toBe("Test description body.");
  });

  it("详情加载中状态显示 loading 文案", () => {
    const wrapper = mountPanel({ descText: null, detailLoading: true });
    expect(wrapper.text()).toContain("online.loading");
  });

  it("详情错误状态显示错误文案", () => {
    const wrapper = mountPanel({ descText: null, detailError: "Network failed" });
    expect(wrapper.text()).toContain("Network failed");
  });

  it("无本地安装记录时显示 notInstalled", () => {
    const wrapper = mountPanel({ localEntry: null });
    expect(wrapper.text()).toContain("online.notInstalled");
  });

  it("有本地安装记录时显示 localEntry 信息", () => {
    const wrapper = mountPanel({ localEntry: mockLocalEntry });
    expect(wrapper.text()).toContain("test_mod_12345");
  });
});

// ============================================================
// 2. 安装 / 卸载 / 队列事件
// ============================================================
describe("OnlineDetailPanel: 安装与更新事件", () => {
  it("primaryAction=install 时点击主按钮发出 install 事件", async () => {
    const wrapper = mountPanel({ primaryAction: "install" });
    const btn = wrapper.find("button.primary");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(wrapper.emitted("install")).toBeTruthy();
  });

  it("primaryAction=uninstall-local 时点击主按钮发出 uninstall 事件", async () => {
    const wrapper = mountPanel({ primaryAction: "uninstall-local" });
    const btn = wrapper.find("button.danger");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(wrapper.emitted("uninstall")).toBeTruthy();
  });

  it("queued=true 时点击主按钮发出 leave-queue 事件", async () => {
    const wrapper = mountPanel({ queued: true, primaryAction: "install" });
    const btn = wrapper.find("button.primary.queued");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(wrapper.emitted("leave-queue")).toBeTruthy();
  });

  it("subscribeBusy=true 时主按钮 disabled", () => {
    const wrapper = mountPanel({ subscribeBusy: true });
    expect((wrapper.find("button.primary").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("installing=true 时显示停止安装按钮，点击发出 stop-install", async () => {
    const wrapper = mountPanel({ installing: true, progress: mockProgress });
    const stopBtn = wrapper.findAll("button.dv-btn-ghost").find(b =>
      b.text().includes("online.cancelDownload") || b.text().includes("downloader.stopping")
    );
    expect(stopBtn).toBeTruthy();
    await stopBtn!.trigger("click");
    expect(wrapper.emitted("stop-install")).toBeTruthy();
  });

  it("localEntry 存在时显示重装按钮，点击发出 reinstall", async () => {
    const wrapper = mountPanel({ localEntry: mockLocalEntry });
    const reinstallBtn = wrapper.findAll("button.dv-btn-ghost").find(b =>
      b.text().includes("online.reinstallLocal") || b.text().includes("online.updateLocal")
    );
    expect(reinstallBtn).toBeTruthy();
    await reinstallBtn!.trigger("click");
    expect(wrapper.emitted("reinstall")).toBeTruthy();
  });
});

// ============================================================
// 3. 收藏和备注名
// ============================================================
describe("OnlineDetailPanel: 收藏与备注名", () => {
  it("点击收藏按钮发出 toggle-favorite 事件", async () => {
    const wrapper = mountPanel();
    const favBtn = wrapper.findAll("button.fav-btn")[0];
    await favBtn.trigger("click");
    expect(wrapper.emitted("toggle-favorite")).toBeTruthy();
  });

  it("canFavorite=false 时收藏按钮 disabled", () => {
    const wrapper = mountPanel({ canFavorite: false });
    const favBtn = wrapper.findAll("button.fav-btn")[0];
    expect((favBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("点击更多操作里的备注名按钮发出 rename 事件", async () => {
    const wrapper = mountPanel();
    const renameBtn = wrapper.find(".more-actions-menu button");
    expect(renameBtn.exists()).toBe(true);
    await renameBtn.trigger("click");
    expect(wrapper.emitted("rename")).toBeTruthy();
  });
});

// ============================================================
// 4. 翻译入口
// ============================================================
describe("OnlineDetailPanel: 翻译入口", () => {
  it("点击翻译按钮发出 translate 事件", async () => {
    const wrapper = mountPanel();
    const translateBtn = wrapper.findAll("button.fav-btn")[1];
    expect(translateBtn.exists()).toBe(true);
    await translateBtn.trigger("click");
    expect(wrapper.emitted("translate")).toBeTruthy();
  });

  it("translateDisabled=true 时翻译按钮 disabled", () => {
    const wrapper = mountPanel({ translateDisabled: true });
    const translateBtn = wrapper.findAll("button.fav-btn")[1];
    expect((translateBtn.element as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================
// 5. 其他关键操作
// ============================================================
describe("OnlineDetailPanel: 其他操作", () => {
  it("点击浏览网站按钮发出 open-webpage 事件", async () => {
    const wrapper = mountPanel();
    const webBtn = wrapper.findAll("button.dv-btn-ghost").find(b =>
      b.text().includes("online.browseSite")
    );
    expect(webBtn).toBeTruthy();
    await webBtn!.trigger("click");
    expect(wrapper.emitted("open-webpage")).toBeTruthy();
  });

  it("primaryAction=uninstall-local 时显示打开文件夹按钮，点击发出 reveal-folder", async () => {
    const wrapper = mountPanel({ primaryAction: "uninstall-local" });
    const folderBtn = wrapper.findAll("button.dv-btn-ghost").find(b =>
      b.text().includes("detail.openFolder")
    );
    expect(folderBtn).toBeTruthy();
    await folderBtn!.trigger("click");
    expect(wrapper.emitted("reveal-folder")).toBeTruthy();
  });
});
