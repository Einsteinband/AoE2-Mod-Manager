import { describe, expect, it } from "vitest";
import {
  decideTopbarLayout,
  resolveAllowedStage,
  TOPBAR_LAYOUT_CONSTANTS,
  type TopbarLayoutMeasurements,
} from "../layout/topbarLayout";

function makeMeasurements(overrides: Partial<TopbarLayoutMeasurements> = {}): TopbarLayoutMeasurements {
  return {
    available: 1000,
    windowWidth: 1000,
    topLevelChildCount: 4,
    brandExpanded: 200,
    brandShort: 140,
    brandBadge: 40,
    tabs: 100,
    settings: 32,
    searchMin: 80,
    toolbarExpanded: 260,
    toolbarCompact: 180,
    actionsExpanded: 150,
    actionsLaunchIcon: 100,
    actionsCompact: 70,
    ...overrides,
  };
}

describe("decideTopbarLayout", () => {
  it("keeps expanded when expanded demand has the entering safety slack", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 900 }));
    expect(decision.level).toBe("expanded");
    expect(decision.safe.expanded).toBe(true);
  });

  it("first shortens the brand before touching the action controls", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 812 }));
    expect(decision.level).toBe("brand-short");
    expect(decision.safe.expanded).toBe(false);
    expect(decision.safe["brand-short"]).toBe(true);
  });

  it("keeps only the badge after the short brand still cannot fit", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 720 }));
    expect(decision.level).toBe("brand-badge");
    expect(decision.safe["brand-short"]).toBe(false);
    expect(decision.safe["brand-badge"]).toBe(true);
  });

  it("iconizes Launch before the view switch after the badge-only brand remains dangerous", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 680 }));
    expect(decision.level).toBe("launch-icon");
    expect(decision.safe["brand-badge"]).toBe(false);
    expect(decision.safe["launch-icon"]).toBe(true);
    expect(decision.safe["view-icon"]).toBe(true);
  });

  it("iconizes the view switch only after Launch has already entered its icon stage", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 640 }));
    expect(decision.level).toBe("view-icon");
    expect(decision.safe["launch-icon"]).toBe(false);
    expect(decision.safe["view-icon"]).toBe(true);
  });

  it("keeps toolbar controls in text until even the view-icon action state is dangerous", () => {
    const decision = decideTopbarLayout("expanded", makeMeasurements({ available: 560 }));
    expect(decision.level).toBe("compact");
    expect(decision.safe["view-icon"]).toBe(false);
    expect(decision.safe.compact).toBe(true);
  });

  it("recovers one stage at a time with the larger exit slack", () => {
    const nearCompact = makeMeasurements({ available: 644 });
    expect(decideTopbarLayout("compact", nearCompact).level).toBe("view-icon");

    const nearView = makeMeasurements({ available: 674 });
    expect(decideTopbarLayout("view-icon", nearView).level).toBe("launch-icon");

    const nearLaunch = makeMeasurements({ available: 724 });
    expect(decideTopbarLayout("launch-icon", nearLaunch).level).toBe("brand-badge");

    const badgeNear = makeMeasurements({ available: 824 });
    expect(decideTopbarLayout("brand-badge", badgeNear).level).toBe("brand-short");

    const shortNear = makeMeasurements({ available: 884 });
    expect(decideTopbarLayout("brand-short", shortNear).level).toBe("expanded");
  });

  it("forces compact at the Tauri minimum window width", () => {
    const decision = decideTopbarLayout(
      "expanded",
      makeMeasurements({ available: 1000, windowWidth: 800 }),
    );
    expect(decision.level).toBe("compact");
    expect(decision.fallbackActive).toBe(true);
  });

  it("forces compact inside the minimum-width fallback margin", () => {
    const decision = decideTopbarLayout(
      "expanded",
      makeMeasurements({ available: 1000, windowWidth: 824 }),
    );
    expect(decision.level).toBe("compact");
    expect(decision.fallbackActive).toBe(true);
  });

  it("keeps compact through the fallback exit hysteresis before normal recovery", () => {
    const locked = decideTopbarLayout(
      "compact",
      makeMeasurements({ available: 644, windowWidth: 830 }),
    );
    expect(locked.level).toBe("compact");
    expect(locked.fallbackActive).toBe(true);

    const released = decideTopbarLayout(
      "compact",
      makeMeasurements({ available: 644, windowWidth: 843 }),
    );
    expect(released.level).toBe("view-icon");
    expect(released.fallbackActive).toBe(false);
  });

  it("does not activate the fallback on a normal wide window", () => {
    const decision = decideTopbarLayout(
      "expanded",
      makeMeasurements({ available: 1000, windowWidth: 1000 }),
    );
    expect(decision.level).toBe("expanded");
    expect(decision.fallbackActive).toBe(false);
  });

  it("keeps the fallback boundary stable across repeated evaluations", () => {
    const measurements = makeMeasurements({ available: 1000, windowWidth: 824 });
    for (let i = 0; i < 3; i += 1) {
      expect(decideTopbarLayout("expanded", measurements).level).toBe("compact");
    }
  });

  it("keeps the previous stage until its predecessor clears the recovery slack", () => {
    const measurements = makeMeasurements({ available: 720 });
    expect(decideTopbarLayout("brand-badge", measurements).level).toBe("brand-badge");
  });

  it("blocks recovery unless a size event coincides with a real outer-width increase", () => {
    const measurements = makeMeasurements({ available: 644 });
    const decision = decideTopbarLayout("compact", measurements);
    expect(decision.level).toBe("view-icon");

    expect(
      resolveAllowedStage({
        currentLevel: "compact",
        decision,
        sizeEvent: false,
        widthIncreased: true,
      }),
    ).toBe("compact");
    expect(
      resolveAllowedStage({
        currentLevel: "compact",
        decision,
        sizeEvent: true,
        widthIncreased: false,
      }),
    ).toBe("compact");
    expect(
      resolveAllowedStage({
        currentLevel: "compact",
        decision,
        sizeEvent: true,
        widthIncreased: true,
      }),
    ).toBe("view-icon");
  });

  it("still allows a tighter stage after local content changes", () => {
    const measurements = makeMeasurements({ available: 560 });
    const decision = decideTopbarLayout("expanded", measurements);
    expect(decision.level).toBe("compact");

    expect(
      resolveAllowedStage({
        currentLevel: "expanded",
        decision,
        sizeEvent: false,
        widthIncreased: false,
      }),
    ).toBe("compact");
  });

  it("counts header, toolbar and action gaps in every predicted demand", () => {
    const measurements = makeMeasurements();
    const decision = decideTopbarLayout("expanded", measurements);
    const headerGapsExpanded =
      (measurements.topLevelChildCount - 1) * TOPBAR_LAYOUT_CONSTANTS.headerGapExpanded;
    const expectedExpanded =
      measurements.brandExpanded +
      measurements.tabs +
      measurements.settings +
      measurements.toolbarExpanded +
      TOPBAR_LAYOUT_CONSTANTS.modToolbarGap +
      measurements.searchMin +
      headerGapsExpanded +
      measurements.actionsExpanded +
      TOPBAR_LAYOUT_CONSTANTS.actionsGap;

    expect(decision.totals.expanded).toBeCloseTo(expectedExpanded);
    expect(decision.totals.compact).toBeGreaterThan(0);
  });

  it("does not shrink when a narrower container still leaves the entering safety slack", () => {
    const decision = decideTopbarLayout(
      "expanded",
      makeMeasurements({
        available: 330,
        brandExpanded: 30,
        brandShort: 24,
        brandBadge: 20,
        tabs: 20,
        settings: 20,
        searchMin: 48,
        toolbarExpanded: 80,
        toolbarCompact: 60,
        actionsExpanded: 60,
        actionsCompact: 36,
      }),
    );
    expect(decision.level).toBe("expanded");
    expect(decision.safe.expanded).toBe(true);
  });

  it("keeps the hysteresis boundary stable across repeated evaluations", () => {
    const nearBoundary = makeMeasurements({ available: 720 });
    for (let i = 0; i < 3; i += 1) {
      expect(decideTopbarLayout("brand-badge", nearBoundary).level).toBe("brand-badge");
    }

    const recovered = decideTopbarLayout("brand-badge", { ...nearBoundary, available: 900 });
    expect(recovered.level).toBe("brand-short");

    for (let i = 0; i < 3; i += 1) {
      expect(decideTopbarLayout("brand-badge", nearBoundary).level).toBe("brand-badge");
    }
  });

  it("reports compact danger when even compact demand cannot clear the safety boundary", () => {
    const decision = decideTopbarLayout(
      "compact",
      makeMeasurements({ available: 500, toolbarCompact: 260, actionsCompact: 120 }),
    );
    expect(decision.level).toBe("compact");
    expect(decision.compactDanger).toBe(true);
  });
});
