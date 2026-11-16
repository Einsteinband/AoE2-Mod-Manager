import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ModInfoFields from "../common/ModInfoFields.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function mountFields(props: Record<string, unknown>) {
  return mount(ModInfoFields, { props });
}

describe("ModInfoFields: 三处详情共用的「更多信息」字段组", () => {
 it("字段顺序固定：作者 → 发布时间 → 最后更新 → 版本 → 订阅数", () => {
    const wrapper = mountFields({
      author: "PoisonousSnakes",
      createdText: "2026-08-22 13:43",
      updatedText: "2026-09-10 06:18",
      versionText: "2.7",
      installs: 1281,
    });
    const labels = wrapper.findAll(".field .k").map((n) => n.text());
    expect(labels).toEqual([
      "online.author",
      "online.created",
      "online.updated",
      "online.version",
      "online.installs",
    ]);
    const values = wrapper.findAll(".field .v").map((n) => n.text());
    expect(values).toEqual(["PoisonousSnakes", "2026-08-22 13:43", "2026-09-10 06:18", "2.7", "1281"]);
  });

  it("缺失值统一走 labels.notProvided + .missing，不按来源换一套文案", () => {
    const wrapper = mountFields({ author: null, createdText: null, updatedText: null, versionText: null, installs: null });
    const values = wrapper.findAll(".field .v");
    for (const node of values) {
      expect(node.text()).toBe("labels.notProvided");
      expect(node.classes()).toContain("missing");
    }
  });

  it("空白字符串（本地 info.json 的占位作者）也算缺失", () => {
    const wrapper = mountFields({ author: "   " });
    const authorValue = wrapper.findAll(".field .v")[0];
    expect(authorValue.text()).toBe("labels.notProvided");
    expect(authorValue.classes()).toContain("missing");
  });

  it("订阅数被服务端截断时附加提示，不影响本地面板（不传即不显示）", () => {
    const truncated = mountFields({ installs: 99999, installsTruncated: true });
    expect(truncated.findAll(".field .v")[4].text()).toContain("online.installsTruncated");

    const plain = mountFields({ installs: 99999 });
    expect(plain.findAll(".field .v")[4].text()).not.toContain("online.installsTruncated");
  });

  it("评分只在在线面板出现（ratingText 为 undefined 时整行省略）", () => {
    const local = mountFields({ author: "a" });
    expect(local.findAll(".field")).toHaveLength(5);

    const online = mountFields({ author: "a", ratingText: "4.5", ratingMissing: false });
    expect(online.findAll(".field")).toHaveLength(6);
    expect(online.findAll(".field .k").at(-1)!.text()).toBe("online.rating");
  });
});
