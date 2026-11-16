/**
 * 侧栏导航桥：把「本地页的普通分类」以只读快照 + 导航意图的方式共享给其他工作区。
 *
 * 收藏工作区不是“收藏专用 Sidebar”：它的左侧仍是固定导航骨架，
 * 收藏入口下面必须继续显示本地页原本的分类（数据仍由本地页的 useLocalFilters 提供，
 * 这里只做镜像，不复制、不重算业务口径）。
 *
 * 点击这些分类 = 切到本地模组并应用同一个筛选：
 *   页面侧只登记意图（queue），本地页在 activated 时消费（consume），
 *   真正的筛选仍走 useLocalFilters 的 pick* 函数。
 */
import { reactive } from "vue";
import type { SourceFilter, StatusFilter } from "../../types";

export interface LocalNavTagOption {
  name: string;
  count: number;
}

export interface LocalNavSnapshot {
  source: SourceFilter;
  status: StatusFilter;
  updatesOnly: boolean;
  updatesAvailableCount: number;
  activeTag: string | null;
  officialTagList: LocalNavTagOption[];
  inferredTagList: LocalNavTagOption[];
  sourceCounts: { all: number; local: number; subscribed: number; imported: number };
  statusCounts: { enabled: number; disabled: number; unknown: number };
}

export interface LocalNavIntent {
  source?: SourceFilter;
  status?: StatusFilter;
  tag?: string | null;
  updatesOnly?: boolean;
}

const emptySnapshot = (): LocalNavSnapshot => ({
  source: "all",
  status: "all",
  updatesOnly: false,
  updatesAvailableCount: 0,
  activeTag: null,
  officialTagList: [],
  inferredTagList: [],
  sourceCounts: { all: 0, local: 0, subscribed: 0, imported: 0 },
  statusCounts: { enabled: 0, disabled: 0, unknown: 0 },
});

const snapshot = reactive<LocalNavSnapshot>(emptySnapshot());
let pending: LocalNavIntent | null = null;

/** 本地页把当前筛选快照同步过来；其他工作区只读消费 */
export function publishLocalNav(patch: Partial<LocalNavSnapshot>): void {
  Object.assign(snapshot, patch);
}

export function useLocalNav(): LocalNavSnapshot {
  return snapshot;
}

/** 收藏页点击普通分类：登记导航意图，由本地页激活时消费 */
export function queueLocalNavIntent(intent: LocalNavIntent): void {
  pending = intent;
}

export function consumeLocalNavIntent(): LocalNavIntent | null {
  const next = pending;
  pending = null;
  return next;
}
