import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧栏分组折叠箭头约定：
 * - 列表展开 → 三角箭头向下
 * - 列表收起 → 三角箭头向右
 *
 * 三角图形本身画成朝右（`M2 2 L6 4 L2 6 Z`），因此展开态必须顺时针旋转 90°，
 * 收起态不旋转。两侧栏共用同一套视觉，两处都必须一致。
 */
const sidebars = [
  join("src", "components", "local", "LocalSidebar.vue"),
  join("src", "components", "online", "OnlineSidebar.vue"),
];

function source(file: string): string {
  return readFileSync(file, "utf8");
}

describe("sidebar caret direction contract", () => {
  for (const file of sidebars) {
    it(`${file} points the caret down when the list is expanded`, () => {
      const text = source(file);
      const base = text.match(/\.side-caret\s*\{([\s\S]*?)\}/)?.[1] ?? "";
      expect(base).toContain("transform: rotate(90deg);");
    });

    it(`${file} points the caret right when the list is collapsed`, () => {
      const text = source(file);
      const collapsed = text.match(/\.side-title\.collapsed \.side-caret\s*\{([\s\S]*?)\}/)?.[1] ?? "";
      expect(collapsed).toContain("transform: rotate(0deg);");
      expect(text).not.toContain("rotate(-90deg)");
    });

    it(`${file} keeps the triangle glyph pointing right as the rotation origin`, () => {
      expect(source(file)).toContain('d="M2 2 L6 4 L2 6 Z"');
    });
  }
});
