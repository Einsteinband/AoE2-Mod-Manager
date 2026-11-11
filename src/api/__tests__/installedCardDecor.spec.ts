import { describe, expect, it } from "vitest";
import {
  INSTALLED_CARD_DECOR_DEFAULTS,
  normalizeInstalledCardDecor,
} from "../../api";

describe("已安装卡片装饰开关归一化", () => {
  it("出厂默认三项全部开启，保持升级后的完整视觉", () => {
    expect(INSTALLED_CARD_DECOR_DEFAULTS).toEqual({
      cardBg: true,
      sideBar: true,
      cornerStripes: true,
    });
  });

  it("缺省、null 或非布尔值回退为 true", () => {
    expect(normalizeInstalledCardDecor(null)).toEqual(INSTALLED_CARD_DECOR_DEFAULTS);
    expect(normalizeInstalledCardDecor({})).toEqual(INSTALLED_CARD_DECOR_DEFAULTS);
    expect(
      normalizeInstalledCardDecor({ cardBg: "yes", sideBar: 1, cornerStripes: null }),
    ).toEqual(INSTALLED_CARD_DECOR_DEFAULTS);
  });

  it("三个开关相互独立，保留全部 8 种布尔组合", () => {
    const combos: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, true, false],
      [true, false, true],
      [true, false, false],
      [false, true, true],
      [false, true, false],
      [false, false, true],
      [false, false, false],
    ];

    for (const [cardBg, sideBar, cornerStripes] of combos) {
      expect(
        normalizeInstalledCardDecor({ cardBg, sideBar, cornerStripes }),
      ).toEqual({ cardBg, sideBar, cornerStripes });
    }
  });
});
