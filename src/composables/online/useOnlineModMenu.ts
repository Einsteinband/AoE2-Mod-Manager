/**
 * 在线卡片右键菜单的条目构建（纯函数，便于单测可用性矩阵）。
 *
 * 口径边界（与 useOnlineInstall 注释一致）：
 * - 下载 / 重装只看磁盘事实 localEntry；服务端订阅状态 userInstalled 不在此切换；
 * - 本工具没有服务端退订接口，在线菜单不提供本地删除 / 启停；
 * - 翻译口径与详情面板一致：已有缓存译文 → 原文 / 译文切换；无缓存但描述可译 → 触发翻译；
 *   忙碌 / 排队 / 描述缺失则置灰。
 */
import type { InstalledIndexEntry } from "../../types";
import type { ContextMenuItem } from "../../components/common/contextMenuTypes";

export type OnlineTaskStatus = "installing" | "downloading" | "queued" | null;

export interface OnlineMenuState {
  entry: InstalledIndexEntry | null;
  taskStatus: OnlineTaskStatus;
  favorited: boolean;
  offline: boolean;
  cachedTranslation: boolean;
  showingOriginal: boolean;
  translating: boolean;
  queued: boolean;
  canText: boolean;
}

export interface OnlineMenuLabels {
  installLocal: string;
  reinstallLocal: string;
  installing: string;
  downloading: string;
  enqueued: string;
  favorite: string;
  favorited: string;
  rename: string;
  translateBusy: string;
  translateQueued: string;
  translateTrigger: string;
  translateShowTranslated: string;
  translateShowOriginal: string;
  waitingHint: string;
  openFolder: string;
  browseSite: string;
  offlineHint: string;
}

export function buildOnlineMenuItems(
  modId: number,
  state: OnlineMenuState,
  labels: OnlineMenuLabels,
): ContextMenuItem[] {
  const busy = state.taskStatus === "installing" || state.taskStatus === "downloading";
  const items: ContextMenuItem[] = [];

  let installLabel: string;
  if (state.taskStatus === "installing") installLabel = labels.installing;
  else if (state.taskStatus === "downloading") installLabel = labels.downloading;
  else if (state.taskStatus === "queued") installLabel = labels.enqueued;
  else installLabel = state.entry ? labels.reinstallLocal : labels.installLocal;

  items.push({
    id: "install",
    icon: "⬇️",
    label: installLabel,
    disabled: busy || modId <= 0 || state.offline,
    hint: state.offline ? labels.offlineHint : undefined,
  });

  items.push({
    id: "favorite",
    icon: state.favorited ? "⭐" : "☆",
    label: state.favorited ? labels.favorited : labels.favorite,
    disabled: modId <= 0,
    dividerBefore: true,
  });

  // 翻译紧跟收藏；备注之前（与本地菜单顺序一致）
  let translateLabel: string;
  if (state.translating) translateLabel = labels.translateBusy;
  else if (state.queued) translateLabel = labels.translateQueued;
  else if (state.cachedTranslation) {
    translateLabel = state.showingOriginal ? labels.translateShowTranslated : labels.translateShowOriginal;
  } else {
    translateLabel = labels.translateTrigger;
  }
  const translateDisabled =
    modId <= 0 ||
    state.translating ||
    state.queued ||
    (!state.cachedTranslation && !state.canText);
  items.push({
    id: "translate",
    icon: "🌐",
    label: translateLabel,
    disabled: translateDisabled,
    hint: translateDisabled && !state.cachedTranslation && !state.canText ? labels.waitingHint : undefined,
  });

  items.push({
    id: "rename",
    icon: "📝",
    label: labels.rename,
    disabled: modId <= 0,
  });

  items.push({
    id: "folder",
    icon: "📁",
    label: labels.openFolder,
    disabled: !state.entry,
  });
  items.push({
    id: "website",
    icon: "🌐",
    label: labels.browseSite,
    disabled: modId <= 0,
  });

  return items;
}
