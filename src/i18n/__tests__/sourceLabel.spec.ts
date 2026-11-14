import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyLocale } from "../index";
import { sourceLabel, sourceHint } from "../../format";

/**
 * 回归：来源徽章不能把「外部导入」的两种情况混成一句模糊的「本地未知」。
 *
 * Rust 侧 `ModSource::classify` 有四个值：
 * - tool      本工具在线安装（有 metadata 记录，或 local 且 WorkshopID > 0）
 * - official  官方订阅（无记录，subscribed 且 WorkshopID > 0）
 * - imported  本工具的 ZIP 导入功能安装（metadata.source = imported-zip）
 * - unknown   无记录且无 WorkshopID（以文件夹形式手动放进 local）
 *
 * imported 与 unknown 都属于「外部导入」，徽章文案相同，但要靠悬停解释区分；
 * 曾经 imported 落到 unknown 分支，「有导入记录」的模组被当成「无记录」展示。
 */
describe("来源徽章文案：四种来源互不混淆", () => {
  beforeEach(() => applyLocale("zh"));
  afterEach(() => applyLocale("zh"));

  it("imported 与 unknown 都显示「外部导入」，但解释不同且各有判定依据", () => {
    expect(sourceLabel("imported")).toBe("外部导入");
    expect(sourceLabel("unknown")).toBe("外部导入");
    expect(sourceLabel("imported")).not.toBe(sourceLabel("tool"));
    expect(sourceLabel("imported")).not.toBe(sourceLabel("official"));

    expect(sourceHint("imported")).toContain("ZIP");
    expect(sourceHint("unknown")).toContain("文件夹");
    expect(sourceHint("imported")).not.toBe(sourceHint("unknown"));
  });

  it("tool / official 口径保持原样", () => {
    expect(sourceLabel("tool")).toBe("本工具安装");
    expect(sourceLabel("official")).toBe("官方订阅");
    expect(sourceHint("tool")).toContain("安装记录");
    expect(sourceHint("official")).toContain("subscribed");
  });

  it("五种语言都有非空文案，且外部导入与 tool/official 不重复", () => {
    for (const loc of ["zh", "en", "es", "de", "ru"] as const) {
      applyLocale(loc);
      for (const s of ["tool", "official", "imported", "unknown"] as const) {
        expect(sourceLabel(s).length).toBeGreaterThan(0);
        expect(sourceHint(s).length).toBeGreaterThan(0);
      }
      expect(sourceLabel("imported")).not.toBe(sourceLabel("tool"));
      expect(sourceLabel("imported")).not.toBe(sourceLabel("official"));
      expect(sourceHint("imported")).not.toBe(sourceHint("unknown"));
    }
    applyLocale("zh");
  });
});
