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
      paused: false,
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
      infoRefreshing: false,
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

  it("localEntry 存在时也不再显示「重新安装到本地」按钮（入口已隐藏）", () => {
    const wrapper = mountPanel({ localEntry: mockLocalEntry });
    const glyphs = wrapper.findAll("button.dv-btn-ghost").map((b) => b.text());
    expect(glyphs.some((text) => text.includes("online.reinstallLocal"))).toBe(false);
    expect(glyphs.some((text) => text.includes("online.updateLocal"))).toBe(false);
    expect(wrapper.text()).not.toContain("🔄");
    expect(wrapper.emitted("reinstall")).toBeUndefined();
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

  it("点击备注名图标按钮发出 rename 事件", async () => {
    const wrapper = mountPanel();
    const renameBtn = wrapper
      .findAll("button.dv-btn-ghost")
      .find((b) => b.text().includes("favorites.rename"));
    expect(renameBtn).toBeTruthy();
    await renameBtn!.trigger("click");
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

// ============================================================
// 刷新 Mod 信息：与本地 / 收藏详情同一入口
// ============================================================
describe("OnlineDetailPanel: 刷新 Mod 信息", () => {
  it("渲染与本地详情同款的刷新按钮（同一 icon / 文案 / tooltip），点击发出 refresh-info", async () => {
    const wrapper = mountPanel();
    const btn = wrapper.find("button.info-refresh-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.classes()).toContain("dv-btn-ghost");
    expect(btn.find(".info-refresh-glyph").text()).toBe("⟳");
    expect(btn.text()).toContain("detail.refreshInfo");
    expect(btn.attributes("title")).toBe("detail.refreshInfoTitle");
    expect(btn.attributes("aria-label")).toBe("detail.refreshInfo");

    await btn.trigger("click");
    expect(wrapper.emitted("refresh-info")).toHaveLength(1);
  });

  it("刷新中按钮 disabled 且文案 / aria-label 切换为 refreshingInfo", () => {
    const wrapper = mountPanel({ infoRefreshing: true });
    const btn = wrapper.find("button.info-refresh-btn");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.text()).toContain("detail.refreshingInfo");
    expect(btn.attributes("aria-label")).toBe("detail.refreshingInfo");
  });

  it("刷新按钮位于辅助操作区之后，不额外新增操作栏标题", () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".dv-action-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].find("button.info-refresh-btn").exists()).toBe(true);
  });
});

// ============================================================
// 在线封面大图预览
// ============================================================
describe("OnlineDetailPanel: 封面大图预览", () => {
  it("点击在线封面后，预览层复用当前 thumb URL", async () => {
    const wrapper = mountPanel({ thumb: "asset://localhost/online-cover.png" });

    const cover = wrapper.find("img.detail-cover");
    expect(cover.exists()).toBe(true);
    const hover = wrapper.find(".cover-hover");
    expect(hover.exists()).toBe(true);
    expect(hover.text()).toBe("detail.imagePreviewHover");
    await cover.trigger("click");

    const preview = wrapper.find(".image-preview");
    expect(preview.exists()).toBe(true);
    expect(preview.find("img").attributes("src")).toBe("asset://localhost/online-cover.png");
  });

  it("封面加载失败后不打开预览", async () => {
    const wrapper = mountPanel({ thumb: "asset://localhost/bad-cover.png" });
    const cover = wrapper.find("img.detail-cover");

    await cover.trigger("error");
    await cover.trigger("click");

    expect(wrapper.find(".cover-hover").exists()).toBe(false);
    expect(wrapper.find(".image-preview").exists()).toBe(false);
  });
});
