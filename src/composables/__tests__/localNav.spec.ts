import { describe, it, expect, beforeEach } from "vitest";
import {
  consumeLocalNavIntent,
  publishLocalNav,
  queueLocalNavIntent,
  useLocalNav,
} from "../local/localNav";

describe("localNav：侧栏普通分类的共享快照与导航意图", () => {
  beforeEach(() => {
    publishLocalNav({
      source: "all",
      status: "all",
      activeTag: null,
      sourceCounts: { all: 0, local: 0, subscribed: 0, imported: 0 },
      statusCounts: { enabled: 0, disabled: 0, unknown: 0 },
    });
    consumeLocalNavIntent();
  });

  it("本地页发布快照后，收藏页能读到同一份分类数据", () => {
    publishLocalNav({
      source: "subscribed",
      activeTag: "UI",
      sourceCounts: { all: 57, local: 12, subscribed: 45, imported: 0 },
      statusCounts: { enabled: 40, disabled: 17, unknown: 0 },
    });
    const nav = useLocalNav();
    expect(nav.source).toBe("subscribed");
    expect(nav.activeTag).toBe("UI");
    expect(nav.sourceCounts.subscribed).toBe(45);
    expect(nav.statusCounts.disabled).toBe(17);
  });

  it("收藏页点击普通分类只登记意图，不直接改快照（业务口径仍归本地页）", () => {
    queueLocalNavIntent({ tag: "UI" });
    queueLocalNavIntent({ source: "local" });
    expect(consumeLocalNavIntent()).toEqual({ source: "local" });
    expect(consumeLocalNavIntent()).toBeNull();
    expect(useLocalNav().source).toBe("all");
  });

  it("意图区分「全部内容」（tag=null）与「不处理 tag」", () => {
    queueLocalNavIntent({ tag: null });
    expect(consumeLocalNavIntent()).toEqual({ tag: null });
    queueLocalNavIntent({ updatesOnly: true });
    expect(consumeLocalNavIntent()).toEqual({ updatesOnly: true });
  });
});
