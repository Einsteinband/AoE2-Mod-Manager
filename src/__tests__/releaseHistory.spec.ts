import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { parseReleaseHistory, releaseHistory } from "../releaseHistory";
import { renderReleaseMarkdown } from "../api";

/**
 * 内置更新历史的数据契约（A/B 级：真实读取仓库里的 RELEASE_NOTES.md）
 *
 * 背景：设置 → 关于的更新历史原来在运行时请求 GitHub Releases，断网/限流就空掉。
 * 现在数据随包构建（`RELEASE_NOTES.md?raw`），这里验证的是「真的本地文件」，
 * 没有 mock 任何网络响应。
 */

/** 真实文件内容（Vite ?raw 读盘，和运行时打进产物的那份是同一个来源） */
const RAW = import.meta.glob("../../RELEASE_NOTES.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 少数需要单独断言源码的组件 */
const SOURCES = import.meta.glob("../components/settings/AboutTab.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const rawNotes = RAW["../../RELEASE_NOTES.md"];

/** 归档里所有版本头："# vX.Y.Z — YYYY-MM-DD ..." */
function headerLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#\s+v\d/.test(line) && /—\s+\d{4}-\d{2}-\d{2}/.test(line));
}

describe("RELEASE_NOTES.md → 内置更新历史", () => {
  it("每个版本头都被解析成条目，没有漏掉的版本", () => {
    expect(rawNotes, "构建内嵌的 RELEASE_NOTES.md 读不到").toBeTruthy();
    expect(releaseHistory.length).toBe(headerLines(rawNotes).length);
    // 历史不能被裁成只剩最新几条
    expect(releaseHistory.length).toBeGreaterThanOrEqual(20);
  });

  it("版本号、日期、标题、正文都在", () => {
    for (const entry of releaseHistory) {
      expect(entry.tagName, "缺 tag").toMatch(/^v\d+\.\d+/);
      expect(entry.version).toBe(entry.tagName.replace(/^v/, ""));
      expect(entry.publishedAt, `${entry.tagName} 缺日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.name, `${entry.tagName} 缺标题`).toBeTruthy();
      expect(entry.body.trim(), `${entry.tagName} 正文为空`).not.toBe("");
    }
  });

  it("最新一条就是当前发版版本（不然就是发版时忘了在顶部加一节）", () => {
    expect(releaseHistory[0]?.tagName).toBe(`v${pkg.version}`);
    const newestDate = releaseHistory
      .map((entry) => entry.publishedAt)
      .reduce((max, date) => (date > max ? date : max), "");
    expect(releaseHistory[0]?.publishedAt).toBe(newestDate);
    // 日期严格从新到旧
    for (let i = 1; i < releaseHistory.length; i += 1) {
      expect(releaseHistory[i - 1].publishedAt >= releaseHistory[i].publishedAt).toBe(true);
    }
  });

  it("Release 自带标题的版本没有被退化成 tag", () => {
    const v020 = releaseHistory.find((entry) => entry.tagName === "v0.2.0");
    expect(v020?.name).toContain("Drag & Drop Sorting");
    const v023 = releaseHistory.find((entry) => entry.tagName === "v0.2.3");
    expect(v023?.name).toContain("Update");
    // 没有单独标题的版本：标题即 tag，和原来的展示口径一致
    const v052 = releaseHistory.find((entry) => entry.tagName === "v0.5.2");
    expect(v052?.name).toBe("v0.5.2");
  });

  it("正文里不再残留与版本头重复的 H1", () => {
    for (const entry of releaseHistory) {
      const firstLine = entry.body.split("\n")[0]?.trim() ?? "";
      expect(firstLine.toLowerCase()).not.toBe(`# ${entry.tagName}`.toLowerCase());
    }
  });

  it("历史真的覆盖到最早版本，不是只有最近的几个", () => {
    const tags = releaseHistory.map((entry) => entry.tagName);
    expect(tags).toContain("v0.5.0");
    expect(tags).toContain("v0.4.9");
    expect(tags).toContain("v0.4.0");
    expect(tags).toContain("v0.1.0");
  });

  it("正文载着原来的 Markdown 内容（抽样中英两段）", () => {
    const v052 = releaseHistory.find((entry) => entry.tagName === "v0.5.2");
    expect(v052?.body).toContain("新增德语");
    expect(v052?.body).toContain("Online Size Sorting");
    const v049 = releaseHistory.find((entry) => entry.tagName === "v0.4.9");
    expect(v049?.body).toContain("底层升级");
  });
});

describe("解析器边界", () => {
  it("空内容 / 无版本头都返回空数组（由「关于」页显示空状态）", () => {
    expect(parseReleaseHistory("")).toEqual([]);
    expect(parseReleaseHistory("这里没有任何版本记录。\n")).toEqual([]);
  });

  it("只有 tag、没有日期的旧式标题不当作条目", () => {
    expect(parseReleaseHistory("# v1.0.0\n\n正文\n")).toEqual([]);
  });

  it("多条记录按日期倒序返回，正文各自独立、结尾分隔线不混入正文", () => {
    const raw = [
      "# v0.2.0 — 2026-11-09",
      "",
      "- 第二条正文",
      "",
      "---",
      "",
      "# v0.3.0 — 2026-11-10 — v0.3.0 - Beta",
      "",
      "- 第一条正文",
      "",
      "---",
      "",
    ].join("\n");
    const parsed = parseReleaseHistory(raw);
    expect(parsed.map((entry) => entry.tagName)).toEqual(["v0.3.0", "v0.2.0"]);
    expect(parsed[0].name).toBe("v0.3.0 - Beta");
    expect(parsed[0].body).toBe("- 第一条正文");
    expect(parsed[1].body).toBe("- 第二条正文");
    expect(parsed[1].name).toBe("v0.2.0");
  });
});

describe("正文渲染管线", () => {
  it("本地正文能渲染成列表/粗体，且不会带出协议串", () => {
    const html = renderReleaseMarkdown(releaseHistory[0].body);
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("aoe2mm:err:");
  });
});

describe("源码契约：关于页不再自己拉 Releases", () => {
  const about = SOURCES["../components/settings/AboutTab.vue"] ?? "";

  it("展示链路里没有 fetchGithubReleases", () => {
    expect(about).not.toContain("fetchGithubReleases");
    expect(about).not.toContain("loadHistory");
    expect(about).not.toContain("historyLoading");
    expect(about).not.toContain("historyError");
  });

  it("历史来自内置模块 releaseHistory", () => {
    expect(about).toContain("releaseHistory");
    expect(about).toContain("renderReleaseMarkdown");
  });

  it("在线检查更新与外部链接没有被拆掉", () => {
    expect(about).toContain("checkUpdate");
    expect(about).toContain("openExternalUrl");
    expect(about).toContain("appVersion");
  });
});
