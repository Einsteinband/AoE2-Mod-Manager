import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(
  join("src", "components", "common", "ModToolbar.vue"),
  "utf8",
);
const localBrowser = readFileSync(
  join("src", "components", "local", "LocalBrowser.vue"),
  "utf8",
);
const onlineBrowser = readFileSync(
  join("src", "components", "OnlineBrowser.vue"),
  "utf8",
);

function scopedStyleBlock(source: string): string {
  const block = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? "";
  return block.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("shared toolbar panel width contract", () => {
  it("gives local and online the same middle-column flex allocation", () => {
    const panelBlock = toolbarSource.match(/\.mod-toolbar\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(panelBlock).toContain("flex: 1 1 auto;");
    expect(panelBlock).toContain("gap: 8px;");
    expect(panelBlock).toContain("min-width: 0;");
  });

  it("keeps the control group fixed so the search box absorbs remaining panel space", () => {
    const controlsBlock = toolbarSource.match(/\.mod-toolbar \.toolbar\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const searchBlock = toolbarSource.match(/\.mod-toolbar \.search-box\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(controlsBlock).toContain("flex: 0 0 auto;");
    expect(controlsBlock).toContain("gap: 6px;");
    expect(searchBlock).toContain("flex: 1 1 180px;");
  });

  it("does not add page-specific toolbar panel rules", () => {
    expect(scopedStyleBlock(localBrowser)).not.toContain(".mod-toolbar");
    expect(scopedStyleBlock(onlineBrowser)).not.toContain(".mod-toolbar");
    expect(scopedStyleBlock(localBrowser)).not.toContain(".search-box");
    expect(scopedStyleBlock(onlineBrowser)).not.toContain(".search-box");
  });
});
