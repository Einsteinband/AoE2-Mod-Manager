import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join("src", "style.css"), "utf8");
const appShell = readFileSync(join("src", "components", "layout", "AppShell.vue"), "utf8");
const pageShell = readFileSync(join("src", "components", "layout", "PageShell.vue"), "utf8");

describe("compact fallback layout contract", () => {
  it("propagates view-icon and compact stage variables to the three-column layout", () => {
    const block = css.match(
      /\.app-layout\.is-view-icon,\s*\.app-layout\.is-compact\s*\{([\s\S]*?)\}/,
    )?.[1] ?? "";
    expect(block).toContain("--layout-sidebar-width: var(--layout-sidebar-min-width, 150px);");
    expect(block).toContain("--layout-detail-width: var(--layout-detail-min-width, 260px);");
    expect(block).toContain("--layout-content-min-width: 260px;");
    expect(block).toContain("--layout-page-pad-x: 12px;");
  });

  it("keeps compact grid and list row final contraction rules under the propagated stage class", () => {
    expect(css).toContain(".app-layout.is-compact .card-grid {");
    expect(css).toContain(".app-layout.is-compact .card-grid.list-mode {");
    expect(css).toContain(".app-layout.is-compact .card-grid.list-mode .card-body {");
    expect(css).toContain(".app-layout.is-compact .card-grid.list-mode .card-body .card-meta .author {");
  });

  it("three columns consume the stage-provided layout variables", () => {
    expect(pageShell).toContain("var(--layout-sidebar-width, 216px)");
    expect(pageShell).toContain("minmax(var(--layout-content-min-width, 320px), 1fr)");
    expect(pageShell).toContain("var(--layout-detail-width, 372px)");
  });

  it("AppShell consumes TopBar stage changes instead of owning another resize observer", () => {
    expect(appShell).toContain('@stage-change="topbarStage = $event"');
    expect(appShell).not.toContain('addEventListener("resize"');
    expect(appShell).not.toContain("ResizeObserver");
  });
});
