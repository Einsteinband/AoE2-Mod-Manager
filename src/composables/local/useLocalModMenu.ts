/**
 * 本地卡片右键菜单的条目构建（纯函数，便于单测可用性矩阵）。
 *
 * 页面装配层负责取状态与执行动作；这里只根据 Mod 与已解析的状态计算：
 * 可见性、禁用态、分组分隔线、危险标记与文案。规则与 ModDetail 现有口径一致。
 */
import type { ModEntry } from "../../types";
import type { ContextMenuItem } from "../../components/common/contextMenuTypes";

export interface LocalMenuState {
  favorited: boolean;
  hasTranslation: boolean;
  canText: boolean;
  translating: boolean;
  queued: boolean;
  showingOriginal: boolean;
  offline: boolean;
}

export interface LocalMenuLabels {
  enable: string;
  disable: string;
  favorite: string;
  favorited: string;
  rename: string;
  translateBusy: string;
  translateQueued: string;
  translateTrigger: string;
  translateShowTranslated: string;
  translateShowOriginal: string;
  openFolder: string;
  browseSite: string;
  deleteMod: string;
  downloadInstall: string;
  offlineHint: string;
  notRegisteredHint: string;
}

export function buildLocalMenuItems(
  mod: ModEntry,
  state: LocalMenuState,
  labels: LocalMenuLabels,
): ContextMenuItem[] {
  const id = mod.workshopId ?? 0;
  const uninstalled = mod.uninstalled === true;
  const items: ContextMenuItem[] = [];

  // ① 启用 / 禁用：幽灵条目无 mod-status 记录，整项隐藏
  if (!uninstalled) {
    const registered = mod.enabled !== null;
    items.push({
      id: "toggle",
      label: mod.enabled === true ? labels.disable : labels.enable,
      disabled: !registered,
      hint: registered ? undefined : labels.notRegisteredHint,
    });
  }

  // ② 幽灵条目：只提供下载安装（与详情面板「下载安装」入口一致）
  if (uninstalled) {
    items.push({
      id: "install",
      icon: "⬇️",
      label: labels.downloadInstall,
      disabled: id <= 0 || state.offline,
      hint: state.offline ? labels.offlineHint : undefined,
    });
  }

  // ③ 收藏 / 翻译 / 备注（无 WorkshopID 不可用；顺序：收藏 → 翻译 → 备注）
  items.push({
    id: "favorite",
    icon: state.favorited ? "⭐" : "☆",
    label: state.favorited ? labels.favorited : labels.favorite,
    disabled: id <= 0,
    dividerBefore: !uninstalled,
  });

  let translateLabel = labels.translateTrigger;
  if (state.translating) translateLabel = labels.translateBusy;
  else if (state.queued) translateLabel = labels.translateQueued;
  else if (state.hasTranslation) {
    translateLabel = state.showingOriginal ? labels.translateShowTranslated : labels.translateShowOriginal;
  }
  items.push({
    id: "translate",
    icon: "🌐",
    label: translateLabel,
    disabled: id <= 0 || state.translating || state.queued || (!state.hasTranslation && !state.canText),
  });

  items.push({
    id: "rename",
    icon: "📝",
    label: labels.rename,
    disabled: id <= 0,
  });

  // ④ 目录 / 官网：幽灵条目无本地目录，只保留官网入口
  if (!uninstalled) {
    items.push({
      id: "folder",
      icon: "📁",
      label: labels.openFolder,
      disabled: !mod.path,
    });
  }
  items.push({
    id: "website",
    icon: "🌐",
    label: labels.browseSite,
    disabled: id <= 0,
  });

  // ⑤ 危险分组：卸载（幽灵条目隐藏）
  if (!uninstalled) {
    items.push({ id: "delete", danger: true, label: labels.deleteMod, dividerBefore: true });
  }

  return items;
}
