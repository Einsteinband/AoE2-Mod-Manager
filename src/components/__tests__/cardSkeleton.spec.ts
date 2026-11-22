import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join("src", "style.css"), "utf8");
const baseCard = readFileSync(join("src", "components", "base", "BaseModCard.vue"), "utf8");
const modCard = readFileSync(join("src", "components", "ModCard.vue"), "utf8");
const onlineCard = readFileSync(join("src", "components", "OnlineModCard.vue"), "utf8");
const modGrid = readFileSync(join("src", "components", "common", "ModGrid.vue"), "utf8");

/** 取以 `selector` 开头的规则块正文（平铺空白后匹配，允许选择器内换行） */
function ruleBlock(selector: string): string {
  const normalizedCss = css.replace(/\s+/g, " ");
  const pattern = new RegExp(
    `${selector.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`,
  );
  const match = pattern.exec(normalizedCss);
  if (!match) return "";
  const open = normalizedCss.indexOf("{", match.index);
  const close = normalizedCss.indexOf("}", open);
  return normalizedCss.slice(open, close + 1);
}

/** 只取「行首就是这个选择器」的规则块：避开 `.card-grid.list-mode .card-thumb` 这类同名前缀 */
function ownRule(selector: string): string {
  const match = new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[\\s\\S]*?\\}`).exec(css);
  return match?.[0] ?? "";
}

describe("卡片骨架：区域高度规则（本地 / 在线 / 收藏共用）", () => {
  it("封面区：16:9 等比，宽度由网格列决定", () => {
    const thumb = ownRule(".card-thumb");
    expect(thumb).toContain("aspect-ratio: 16 / 9;");
  });

  it("标题区：固定两行高度，短标题不塌、长标题不撑高、超两行省略号截断", () => {
    const title = ownRule(".card-title");
    expect(title).toContain("height: 2.88em;");
    expect(title).toContain("max-height: 2.88em;");
    expect(title).toContain("-webkit-line-clamp: 2;");
    expect(title).toContain("overflow: hidden;");
    // 2.88em = 2 行 × line-height 1.44
    expect(title).toContain("line-height: 1.44;");
  });

  it("底部操作区：定高，且不允许可选内容另外撑高", () => {
    // 用行首锚定的 ownRule：列表模式的 `.card-meta.meta-info, .card-meta.meta-top` 组合规则
    // 先于全局定高规则出现，平铺匹配会命中前者
    const row = ownRule(".card-meta.meta-top");
    expect(row).toContain("min-height: var(--card-action-row-height);");
    expect(css).toContain("--card-action-row-height: 20px;");
  });

  it("信息区填充满 Grid 行拉伸留下的高度（不得退回 flex: 0 1 auto）", () => {
    const body = css.match(/\n\.card-body \{[\s\S]*?\}/)?.[0] ?? "";
    expect(body).toContain("flex: 1 1 auto;");
    expect(body).not.toContain("flex: 0 1 auto;");
  });

  it("禁止用 align-items: start 解决高度问题（会破坏同行底边对齐）", () => {
    expect(modGrid).not.toContain("align-items: start");
    expect(ruleBlock(".card-grid")).not.toContain("align-items: start");
  });

  it("可选字段不得在标题与信息行之间插一行（.card-sub 已彻底移除）", () => {
    expect(baseCard).not.toContain("card-sub");
    expect(css).not.toContain(".card-sub {");
    expect(modCard).not.toContain("card-sub");
    expect(onlineCard).not.toContain("card-sub");
    // 卡片底座不再有副标题 prop，模板里标题与底部操作行直接相邻
    expect(baseCard).not.toContain("sub?: string");
    expect(baseCard).not.toMatch(/:sub=/);
  });
});

describe("卡片名称：备注名替换原名（不再叠加）", () => {
  it("两张卡片都把原名作为标题 tooltip 传入，且不再传副标题", () => {
    expect(modCard).toContain(':title-hint="titleHint"');
    expect(onlineCard).toContain(':title-hint="titleHint"');
    expect(modCard).toContain("const titleHint = computed(() => (custom.value ? props.mod.displayName : null));");
    expect(onlineCard).toContain("const titleHint = computed(() => (custom.value ? props.mod.title : null));");
    expect(modCard).not.toContain(":sub=");
    expect(onlineCard).not.toContain(":sub=");
  });

  it("底座标题在无备注名时用标题本身做 tooltip，有备注名时优先用原名", () => {
    expect(baseCard).toContain(':title="titleHint || title"');
  });
});
