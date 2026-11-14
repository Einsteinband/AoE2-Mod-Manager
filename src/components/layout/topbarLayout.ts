/**
 * 顶栏布局等级的纯几何评估。
 *
 * 这里不直接读取 window.innerWidth、不判断语言、不写死窗口断点；
 * 窗口宽度由 TopBar 作为单一测量入参传入，只用于最小窗口兜底；
 * 其余只根据传入的真实内在需求宽度、弹性搜索框最小宽、内部间距和容器可用宽度，
 * 按固定优先级选择布局等级。
 */

export type TopbarLevel =
  | "expanded"
  | "brand-short"
  | "brand-badge"
  | "launch-icon"
  | "view-icon"
  | "compact";

/** 与 style.css / ModToolbar.vue 保持一致的固定间距与图标宽度。 */
export const TOPBAR_LAYOUT_CONSTANTS = {
  headerGapExpanded: 10,
  headerGapCompact: 8,
  modToolbarGap: 8,
  toolbarGap: 6,
  actionsGap: 6,
  launchIconWidth: 36,
  viewIconWidthFallback: 62,
  /** Tauri `src-tauri/tauri.conf.json` 的 `app.windows[0].minWidth=800`；前端兜底只复用这一处常量。 */
  minWindowWidth: 800,
  /** 最小窗口上方的预留边距：进入兜底区后直接保证最终 compact。 */
  compactFallbackMargin: 24,
  /** 进入下一收缩阶段所需提前预留的安全间距。 */
  enterSlack: 6,
  /** 退出紧凑态、恢复上一阶段所需的额外安全余量，避免临界位置来回切换。 */
  exitSlack: 18,
} as const;

export interface TopbarLayoutMeasurements {
  available: number;
  /** 当前浏览器 / WebView2 视口宽度；用于最小窗口兜底，不替代顶栏可用宽度评估。 */
  windowWidth: number;
  topLevelChildCount: number;
  brandExpanded: number;
  brandShort: number;
  brandBadge: number;
  tabs: number;
  settings: number;
  searchMin: number;
  toolbarExpanded: number;
  toolbarCompact: number;
  actionsExpanded: number;
  actionsLaunchIcon: number;
  actionsCompact: number;
}

export interface TopbarLayoutDecision {
  level: TopbarLevel;
  totals: Record<TopbarLevel, number>;
  safe: Record<TopbarLevel, boolean>;
  /** 当前评估是否处于最小窗口兜底强制 compact 区间或其退出滞回区内。 */
  fallbackActive: boolean;
  /** compact 仍低于进入安全线时的提示：当前实现不再继续隐藏核心操作。 */
  compactDanger: boolean;
}

export interface TopbarStagePolicy {
  currentLevel: TopbarLevel;
  decision: TopbarLayoutDecision;
  /** 来自 RO / window resize 的外部尺寸事件；语言、页面、DOM 内容变化为 false。 */
  sizeEvent: boolean;
  /** 顶栏外部盒子真实变宽；高度、padding、gap 或内部控件变化导致的尺寸变化为 false。 */
  widthIncreased: boolean;
}

const LEVEL_ORDER: TopbarLevel[] = [
  "expanded",
  "brand-short",
  "brand-badge",
  "launch-icon",
  "view-icon",
  "compact",
];

function withinSafety(demand: number, available: number, slack: number): boolean {
  return demand <= available - slack;
}

function stageDemand(
  level: TopbarLevel,
  measurements: TopbarLayoutMeasurements,
  constants: typeof TOPBAR_LAYOUT_CONSTANTS,
): number {
  const brand =
    level === "expanded"
      ? measurements.brandExpanded
      : level === "brand-short"
        ? measurements.brandShort
        : measurements.brandBadge;
  const toolbar = level === "compact" ? measurements.toolbarCompact : measurements.toolbarExpanded;
  const actions =
    level === "launch-icon"
      ? measurements.actionsLaunchIcon
      : level === "expanded" || level === "brand-short" || level === "brand-badge"
        ? measurements.actionsExpanded
        : measurements.actionsCompact;
  const headerGap = level === "compact" ? constants.headerGapCompact : constants.headerGapExpanded;
  const topLevelGaps = Math.max(0, measurements.topLevelChildCount - 1);

  return (
    brand +
    measurements.tabs +
    measurements.settings +
    toolbar +
    constants.modToolbarGap +
    measurements.searchMin +
    topLevelGaps * headerGap +
    actions +
    constants.actionsGap
  );
}

/**
 * 按固定优先级选择等级：
 *   1. 品牌全称；2. 品牌短名；3. 仅徽章；4. Launch 先图标化；5. ViewSwitch 再图标化；6. 工具栏按钮图标化。
 *
 * 恢复时反向回退，且上一阶段必须满足更大的恢复余量；短暂空隙不会直接回到最宽等级。
 */
export function decideTopbarLayout(
  currentLevel: TopbarLevel,
  measurements: TopbarLayoutMeasurements,
  constants = TOPBAR_LAYOUT_CONSTANTS,
): TopbarLayoutDecision {
  const totals = Object.fromEntries(
    LEVEL_ORDER.map((level) => [level, stageDemand(level, measurements, constants)]),
  ) as Record<TopbarLevel, number>;

  const safe = Object.fromEntries(
    LEVEL_ORDER.map((level) => [
      level,
      withinSafety(totals[level], measurements.available, constants.enterSlack),
    ]),
  ) as Record<TopbarLevel, boolean>;

  const currentIndex = LEVEL_ORDER.indexOf(currentLevel);
  const feasible = LEVEL_ORDER.filter((level) => safe[level]);

  let level: TopbarLevel;
  if (currentLevel === "expanded") {
    level = feasible[0] ?? "compact";
  } else {
    const predecessor = LEVEL_ORDER[Math.max(0, currentIndex - 1)];
    const predecessorSafe = withinSafety(
      totals[predecessor],
      measurements.available,
      constants.exitSlack,
    );
    if (predecessorSafe) {
      level = predecessor;
    } else {
      const currentOrWorse = LEVEL_ORDER.slice(currentIndex).filter((candidate) => safe[candidate]);
      level = currentOrWorse[0] ?? "compact";
    }
  }

  const fallbackEnterWidth = constants.minWindowWidth + constants.compactFallbackMargin;
  const fallbackExitWidth = fallbackEnterWidth + constants.exitSlack;
  const forcedFallback = measurements.windowWidth <= fallbackEnterWidth;
  const fallbackLocked = currentLevel === "compact" && measurements.windowWidth <= fallbackExitWidth;
  const fallbackActive = forcedFallback || fallbackLocked;
  if (fallbackActive) {
    level = "compact";
  }

  return {
    level,
    totals,
    safe,
    fallbackActive,
    compactDanger: level === "compact" && !safe.compact,
  };
}

/**
 * 局部内容变化只允许进入更紧凑阶段；只有外部尺寸事件且盒子真实变宽时，
 * 才允许按退出滞回阈值恢复上一阶段。返回被当前策略允许应用的阶段。
 */
export function resolveAllowedStage(policy: TopbarStagePolicy): TopbarLevel {
  const currentIndex = LEVEL_ORDER.indexOf(policy.currentLevel);
  const nextIndex = LEVEL_ORDER.indexOf(policy.decision.level);
  const recoveryEligible = policy.sizeEvent && policy.widthIncreased;
  const localRecoveryBlocked = nextIndex < currentIndex && !recoveryEligible;
  return localRecoveryBlocked ? policy.currentLevel : policy.decision.level;
}
