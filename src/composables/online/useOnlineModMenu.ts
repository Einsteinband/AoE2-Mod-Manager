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
import { canTranslateDescription } from "../../online/translation";

export type OnlineTaskStatus = "installing" | "downloading" | "queued" | null;

/**
 * 右键菜单可用的描述文本（与详情面板共用同一份判断）。
 *
 * 根因背景：列表接口给的 `raw.description` 经常是空的（官方详情只在 `mod_detail` 里），
 * 而详情面板读的是详情接口 / 详情缓存，于是同一个模组会出现「详情能翻译、右键菜单不能」。
 * 这里按优先级挑一份能翻译的描述：
 * 1. 列表项自带的描述（能翻就用它，行为与原来一致）；
 * 2. **只属于当前右键这个 modId** 的详情缓存文本（`cached.modId === targetId` 才采信，
 *    绝不串用其它模组的状态）；
 * 3. 详情面板当前选中的正是这个模组时，面板已拿到的描述文本。
 * 三者都不可用时返回列表原文（通常是空串），由调用方继续置灰 + 显示等待提示。
 */
export interface MenuDescriptionSources {
  targetId: number;
  listText: string;
  cached: { modId: number; text: string } | null;
  selectedId: number | null;
  selectedText: string | null;
}

export function resolveMenuDescription(sources: MenuDescriptionSources): string {
  const { targetId, listText, cached, selectedId, selectedText } = sources;
  // 只看「有没有内容」：列表里只有 "🙂" 也算有描述，不能因为短就退回空串
  if (canTranslateDescription(listText)) return listText;
  if (cached && cached.modId === targetId && canTranslateDescription(cached.text)) {
    return cached.text;
  }
  if (selectedId === targetId && canTranslateDescription(selectedText)) return selectedText ?? "";
  return listText;
}

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
