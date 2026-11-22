import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ModCard from "../ModCard.vue";
import OnlineModCard from "../OnlineModCard.vue";
import type { ModEntry } from "../../types";
import type { OnlineMod } from "../../online/types";
import { CARD_TOGGLE_DEFAULTS, setCardTogglePrefs } from "../../composables/local/cardTogglePrefs";

const css = readFileSync(join("src", "style.css"), "utf8");
const baseCard = readFileSync(join("src", "components", "base", "BaseModCard.vue"), "utf8");

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
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: null,
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

/** 显式打开启用控件，才能验证它在列表模式里没有被 CSS 吃掉 */
beforeEach(() => {
  setCardTogglePrefs({ ...CARD_TOGGLE_DEFAULTS, show: true });
});

/** 去掉注释后的 CSS：注释里会提到旧选择器写法，不能参与结构断言 */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
/** 列表模式整段 CSS（从 `.card-grid.list-mode` 第一条规则到紧凑阶段收紧规则之前） */
const listModeSection = cssCode.slice(
  cssCode.indexOf(".card-grid.list-mode {"),
  cssCode.indexOf(".app-layout.is-compact .card-grid {"),
);

describe("列表模式：ID/作者行隐藏范围（只隐藏 WorkshopID）", () => {
  it("旧宽泛选择器（按 DOM 顺序取 span）已彻底移除", () => {
    expect(listModeSection.length).toBeGreaterThan(1000);
    expect(listModeSection).not.toContain("span:first-child");
    expect(listModeSection).not.toContain(":not(.status-row)");
    expect(listModeSection).not.toContain("!important");
  });

  it("隐藏规则只命中 ID 本身：`.card-meta.meta-info .card-id`", () => {
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toContain(".card-grid.list-mode .card-meta.meta-info .card-id { display: none; }");
  });

  it("列表模式的排序规则只作用于两个具名行（meta-info / meta-top），仍把标题留在最左", () => {
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toContain(
      ".card-grid.list-mode .card-meta.meta-info, .card-grid.list-mode .card-meta.meta-top {",
    );
    expect(css).toContain(".card-grid.list-mode .card-title {");
  });

  it("卡片底座：信息行带 meta-info，ID 单独带 card-id", () => {
    expect(baseCard).toContain('<div class="card-meta meta-info">');
    expect(baseCard).toContain('<span class="card-id">{{ displayId }}</span>');
  });

  it("保持列表模式原有设计：56px 行高 + 标题单行省略号", () => {
    expect(css).toContain("height: 56px;");
    expect(css).toContain("text-overflow: ellipsis;");
    expect(css).toMatch(/\.card-grid\.list-mode \.card-title \{[\s\S]*?white-space: nowrap;/);
  });
});

describe("列表模式下三类卡片的行内元素不被误伤", () => {
  it("数据模组：⚙️ 与本机启用控件都在底部操作行，不在会被隐藏的 ID 行", () => {
    const wrapper = mount(ModCard, {
      props: { mod: makeMod({ isDataMod: true, workshopId: 0 }), active: false },
    });
    const metaTop = wrapper.find(".card-meta.meta-top");
    expect(metaTop.exists()).toBe(true);
    expect(metaTop.find(".data-mark").exists()).toBe(true);
    expect(metaTop.find(".card-toggle").exists()).toBe(true);
    // 启用控件不是 meta-top 的第一个子元素也不能被隐藏：这里断言它确实存在于行内
    expect(metaTop.find(".card-toggle").attributes("role")).toBe("switch");
    // ID / 作者行只承载 ID 与作者，被隐藏的只有 .card-id
    const info = wrapper.find(".card-meta.meta-info");
    expect(info.exists()).toBe(true);
    expect(info.find(".card-id").exists()).toBe(true);
    expect(info.find(".card-toggle").exists()).toBe(false);
    expect(info.find(".data-mark").exists()).toBe(false);
  });

  it("普通本地模组：圆形按钮与 Apple 开关都渲染在底部操作行", async () => {
    const circle = mount(ModCard, { props: { mod: makeMod(), active: false } });
    expect(circle.find(".card-meta.meta-top .card-toggle").exists()).toBe(true);

    setCardTogglePrefs({ ...CARD_TOGGLE_DEFAULTS, show: true, style: "switch" });
    const apple = mount(ModCard, { props: { mod: makeMod(), active: false } });
    expect(apple.find(".card-meta.meta-top .card-switch").exists()).toBe(true);
    expect(apple.find(".card-meta.meta-top .card-toggle").exists()).toBe(false);
  });

  it("隐藏按钮设置仍有效：控件不渲染，但底部操作行与安装时间保留", () => {
    setCardTogglePrefs({ ...CARD_TOGGLE_DEFAULTS, show: false });
    const wrapper = mount(ModCard, { props: { mod: makeMod(), active: false } });
    expect(wrapper.find(".card-toggle").exists()).toBe(false);
    expect(wrapper.find(".card-meta.meta-top").exists()).toBe(true);
    expect(wrapper.find(".card-meta.meta-top .card-installed-time").exists()).toBe(true);
  });

  it("在线卡片：状态徽章与安装数都在底部操作行，ID 仍带 card-id", () => {
    const wrapper = mount(OnlineModCard, {
      props: { mod: makeOnlineMod({ updateAvailable: true }), active: false, installed: false },
    });
    const metaTop = wrapper.find(".card-meta.meta-top");
    expect(metaTop.exists()).toBe(true);
    expect(metaTop.find(".badge.warn").exists()).toBe(true);
    expect(metaTop.findAll("span").length).toBe(2);
    expect(wrapper.find(".card-meta.meta-info .card-id").exists()).toBe(true);
    expect(wrapper.find(".card-meta.meta-info .author").exists()).toBe(true);
  });
});
