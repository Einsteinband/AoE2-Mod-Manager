import { describe, it, expect } from "vitest";
import zh from "../locales/zh";
import en from "../locales/en";
import es from "../locales/es";
import de from "../locales/de";
import ru from "../locales/ru";
import { SORT_OPTIONS, TAG_KEY_BY_ID, TAG_KEY_BY_NAME } from "../../online/types";
import { ACCENT_THEMES } from "../../config/accentThemes";

/**
 * T3 动态 key 盲区（运行时拼装 key）的有限域断言。
 *
 * T3 只能静态识别「字面量 key」，这些站点用模板串/变量拼 key，永远进不了静态清单：
 *   `wizard.source.${code}`、`translate.langName.${code}`、`tagNames.${key}`、
 *   `t(theme.labelKey)`、`t(opt.labelKey)`、`t(proxySourceKey)`、`batch.done*`。
 * 本文件的职责不是让它们「静态可查」，而是**把每个站点的取值域钉死**：
 * 域内每个取值 × 五种语言都必须存在且非空文案。
 *
 * 域一律从代码里的常量表推导（SORT_OPTIONS / ACCENT_THEMES / TAG_KEY_BY_* / 语言包自身），
 * 只有 Rust 才能给出的 `wizard.source` 6 个来源码需要显式列出（见下方注释）。
 * 不新增白名单，不改变任何业务代码。
 */

type LocaleTree = Record<string, unknown>;

const LOCALES: Array<[string, LocaleTree]> = [
  ["zh", zh as unknown as LocaleTree],
  ["en", en as unknown as LocaleTree],
  ["es", es as unknown as LocaleTree],
  ["de", de as unknown as LocaleTree],
  ["ru", ru as unknown as LocaleTree],
];

/** 取点分 key 的叶子值（不存在返回 undefined） */
function leaf(tree: LocaleTree, dotted: string): unknown {
  let cur: unknown = tree;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 域内 key 必须在五语都存在且为非空字符串 */
function assertDomain(domainName: string, keys: readonly string[]): void {
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    for (const [loc, tree] of LOCALES) {
      const value = leaf(tree, key);
      if (typeof value !== "string" || value.length === 0) missing.push(`${loc}:${key}`);
    }
  }
  expect(missing, `${domainName} 缺失文案：${missing.join(", ")}`).toEqual([]);
}

describe("T3 动态 key 有限域：五语完整性", () => {
  it("wizard.source：Rust settings.rs 的 6 个来源码", () => {
    // settings.rs:421 env / :439 registry / :449 steam_library / :457-459 user_dir、documents / :480 drive_scan
    const codes = ["env", "registry", "steam_library", "user_dir", "documents", "drive_scan"];
    assertDomain("wizard.source", codes.map((code) => `wizard.source.${code}`));
  });

  it("translate.langName：语言包声明的全部目标语言", () => {
    const names = leaf(zh as unknown as LocaleTree, "translate.langName");
    expect(names && typeof names === "object").toBe(true);
    const codes = Object.keys(names as Record<string, unknown>);
    expect(codes.length).toBeGreaterThan(0);
    assertDomain("translate.langName", codes.map((code) => `translate.langName.${code}`));
  });

  it("statusbar.proxy*：StatusBar 的四条代理链路", () => {
    // StatusBar.vue 的 loadProxy：manual / system / env / 其它→direct
    assertDomain("statusbar.proxy", [
      "statusbar.proxyManual",
      "statusbar.proxySystem",
      "statusbar.proxyEnv",
      "statusbar.proxyDirect",
    ]);
  });

  it("SORT_OPTIONS：每个排序项都有 labelKey 文案", () => {
    expect(SORT_OPTIONS.length).toBeGreaterThan(0);
    assertDomain("SORT_OPTIONS", SORT_OPTIONS.map((opt) => opt.labelKey));
  });

  it("accentThemes：每个主题都有 labelKey 文案", () => {
    expect(ACCENT_THEMES.length).toBeGreaterThan(0);
    assertDomain("accentThemes", ACCENT_THEMES.map((theme) => theme.labelKey));
  });

  it("tagNames：id 映射与名称映射的全部 key", () => {
    const keys = [
      ...Object.values(TAG_KEY_BY_ID),
      ...Object.values(TAG_KEY_BY_NAME),
    ];
    expect(keys.length).toBeGreaterThan(0);
    assertDomain("tagNames", keys.map((key) => `tagNames.${key}`));
  });

  it("batch：批量启停的二选一 key", () => {
    assertDomain("batch", ["batch.doneEnable", "batch.doneDisable"]);
  });
});

describe("T3 有限域：域大小不发生无声漂移", () => {
  it("wizard.source 的 6 个码在语言包里都有独立条目（防手工删键）", () => {
    const source = leaf(zh as unknown as LocaleTree, "wizard.source") as Record<string, unknown>;
    expect(source && typeof source === "object").toBe(true);
    expect(Object.keys(source)).toHaveLength(6);
  });

  it("translate.langName 在 en/es/de/ru 与 zh 的 key 集合一致（新增语言必须同步）", () => {
    const zhNames = leaf(zh as unknown as LocaleTree, "translate.langName") as Record<string, unknown>;
    const zhKeys = Object.keys(zhNames).sort();
    for (const [loc, tree] of LOCALES.filter(([l]) => l !== "zh")) {
      const names = leaf(tree, "translate.langName") as Record<string, unknown>;
      expect(Object.keys(names).sort(), `${loc} 的语言名集合与 zh 不一致`).toEqual(zhKeys);
    }
  });
});
