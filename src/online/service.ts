import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { noteRequestFailure, noteRequestSuccess } from "./networkError";
import type {
  DownloadProgress,
  FindResult,
  InstallOutcome,
  LoginTarget,
  ModTag,
  NetworkSettingsView,
  SessionStatus,
  UninstallReport,
} from "./types";

export function sessionStatus(): Promise<SessionStatus> {
  return invoke<SessionStatus>("online_session_status");
}

/** 诊断：显式创建隐藏会话窗口并回读 Cookie 数量（返回文本，不含任何令牌） */
export function probeAccountWindow(): Promise<string> {
  return invoke<string>("online_probe_account_window");
}

/** 把前端关键判断写进同一份终端日志（Rust 侧 target="ui"） */
export function uiLog(level: "info" | "warn" | "error", message: string): Promise<void> {
  return invoke<void>("ui_log", { level, message });
}

export function openLogin(platform: string): Promise<void> {
  return invoke<void>("online_open_login", { platform });
}

/** 后台静默登录：隐藏窗口走一遍 SSO，用于启动时自动恢复会话（不清缓存） */
export function openLoginSilent(platform: string): Promise<void> {
  return invoke<void>("online_open_login_silent", { platform });
}

/** 登录入口清单（Steam / 微软 Xbox / PSN），URL 由 Rust 侧维护 */
export function loginTargets(): Promise<LoginTarget[]> {
  return invoke<LoginTarget[]>("online_login_targets");
}

/** 高级网络设置：自动跟随系统 / 手动代理 / 记住登录 */
export function getNetworkSettings(): Promise<NetworkSettingsView> {
  return invoke<NetworkSettingsView>("get_network_settings");
}

export function setNetworkSettings(params: {
  auto: boolean;
  proxyUrl: string | null;
  rememberLogin: boolean;
}): Promise<NetworkSettingsView> {
  return invoke<NetworkSettingsView>("set_network_settings", {
    auto: params.auto,
    proxyUrl: params.proxyUrl,
    rememberLogin: params.rememberLogin,
  });
}

/** 退出登录：只在用户点击时清空 WebView2 数据目录与加密会话缓存 */
export function clearLoginCache(): Promise<string> {
  return invoke<string>("online_clear_login_cache");
}

export function closeLoginWindow(): Promise<void> {
  return invoke<void>("online_close_login_window");
}

export function resetLoginView(): Promise<void> {
  return invoke<void>("online_reset_login_view");
}

/**
 * 所有「真网络」请求的统一出口：
 * - 成功 → 自动清除全局断网标志（网络恢复）
 * - 失败 → 若是 DNS / 传输层 / 超时，点亮全局断网标志（底栏变 🔴）
 */
function tracked<T>(promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => {
      noteRequestSuccess();
      return value;
    },
    (error) => {
      noteRequestFailure(error);
      throw error;
    },
  );
}

export interface FindParams {
  query: string;
  start: number;
  count: number;
  sort: string;
  order: string;
  tags?: number[];
}

export function findMods(params: FindParams): Promise<FindResult> {
  return tracked(
    invoke<FindResult>("online_find", {
      query: params.query,
      start: params.start,
      count: params.count,
      sort: params.sort,
      order: params.order,
      tags: params.tags ?? [],
    }),
  );
}

export function installedMods(start: number, count: number): Promise<FindResult> {
  return tracked(invoke<FindResult>("online_installed", { start, count }));
}

export function modDetail(modId: number): Promise<Record<string, unknown>> {
  return tracked(invoke<Record<string, unknown>>("online_detail", { modId }));
}

/** 官方分类字典（Rust 侧 GET /api/v4/mods/Tags，已按 gameTitleId=2 过滤） */
export function modTags(): Promise<ModTag[]> {
  return tracked(invoke<ModTag[]>("online_tags"));
}

export function installMod(
  modId: number,
  title: string,
  force: boolean,
  tagIds: number[] = [],
  tagNames: string[] = [],
  author: string | null = null,
  description: string | null = null,
  thumbnailUrl: string | null = null,
): Promise<InstallOutcome> {
  return invoke<InstallOutcome>("online_install", {
    modId,
    title,
    force,
    tagIds,
    tagNames,
    author,
    description,
    thumbnailUrl,
  });
}

export function cancelInstall(): Promise<void> {
  return invoke<void>("online_cancel_install");
}

/**
 * 卸载本地模组（不向官方发任何请求）。
 * 后端先确认游戏未运行，再校验目标只能是 `<root>/<kind>/<modId>_*` 的真实目录，
 * 然后只删那一个目录、清 mod-status.json 记录与分类元数据。
 * 服务器订阅状态不会被修改：取消订阅请到官网操作。
 */
export function uninstallMod(
  modId: number,
  folderName: string | null = null,
): Promise<UninstallReport> {
  return invoke<UninstallReport>("online_uninstall", { modId, folderName });
}

/** 用系统默认浏览器打开 https://www.ageofempires.com/mods/details/{modId}/ */
export function openModWebpage(modId: number): Promise<string> {
  return invoke<string>("open_mod_webpage", { modId });
}

export function onDownloadProgress(
  handler: (payload: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("online://download-progress", (event) => handler(event.payload));
}
