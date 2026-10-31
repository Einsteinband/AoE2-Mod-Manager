import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { noteRequestFailure, noteRequestSuccess } from "./networkError";
import type {
  DownloadProgress,
  FindResult,
  IndexClearReport,
  IndexSearchResult,
  IndexStatus,
  IndexSyncReport,
  InstallOutcome,
  LoginTarget,
  TitleJobStatus,
  ModTag,
  NetworkSettingsView,
  SessionStatus,
  TranslateSettingsView,
  Translation,
  TranslationCacheStat,
  TranslationClearReport,
  UninstallReport,
} from "./types";

export function sessionStatus(): Promise<SessionStatus> {
  return invoke<SessionStatus>("online_session_status");
}

/**
 * 启动期会话检查：持久登录开关关闭时，Rust 侧探测不到有效会话会自己用隐藏窗口
 * 跑一次静默 SSO（自带 25s 上限），成功/失败都只返回状态，不抛错。
 */
export function startupSession(): Promise<SessionStatus> {
  return invoke<SessionStatus>("online_startup_session");
}

/** 记住登录 7 天开关：只写配置，Cookie 门控在 Rust 侧 */
export function setRememberLogin(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_remember_login", { enabled });
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

/**
 * 一键翻译（模组标题 + 描述 → 目标语言）。
 *
 * - `targetLang` 由前端状态层统一传入（小写：zh-cn / ja …），Rust 会给设置兼底；
 * - `description` 请传**已纯文本化**的描述（前端 `plainText()` 的结果），
 *   Rust 侧用它算 originalHash，作者改名/改描述后会自动重译；
 * - 失败返回 ApiFailure（kind: network / quota / blocked / busy / not_ready / parse …）。
 */
export function translateModText(
  modId: number,
  title: string,
  description: string,
  targetLang: string,
): Promise<Translation> {
  return tracked(
    invoke<Translation>("translate_mod_text", { modId, title, description, targetLang }),
  );
}

/**
 * **只读**译文缓存（绝不发网络，也不写盘）。
 *
 * 本地模组详情页打开时用它判断能不能直接显示译文：
 * 命中则秒开（在线页/上次会话翻过），返回 null 才需要用户自己点「翻译」。
 * 因此这个函数刻意**不走 tracked()** —— 它根本不算一次网络请求。
 */
export function cachedTranslation(
  modId: number,
  title: string,
  description: string,
  targetLang: string,
): Promise<Translation | null> {
  return invoke<Translation | null>("translation_cached", {
    modId,
    title,
    description,
    targetLang,
  });
}

export interface TranslationProbe {
  modId: number;
  title: string;
  description: string;
  /** 不传则回到设置/界面语言 */
  targetLang?: string;
}

/**
 * **批量**只读译文缓存（同样零网络）。
 *
 * 列表渲染后一次调用把整页的译文标题接回来 —— 重启软件不会变回原文，
 * 也不用为每张卡片发一次 invoke。
 */
export function cachedTranslations(items: TranslationProbe[]): Promise<Translation[]> {
  return invoke<Translation[]>("translations_cached", { items });
}

// ---------------- 设置页「翻译」页签 ----------------

export function getTranslateSettings(): Promise<TranslateSettingsView> {
  return invoke<TranslateSettingsView>("get_translate_settings");
}

/**
 * 保存翻译设置。`targetLanguage` 传空串 = 跟随界面语言；
 * `customKey` 传空串表示“不修改已保存的 key”。
 */
export function setTranslateSettings(params: {
  targetLanguage: string;
  provider: string;
  customUrl: string | null;
  customKey?: string | null;
}): Promise<TranslateSettingsView> {
  return invoke<TranslateSettingsView>("set_translate_settings", {
    targetLanguage: params.targetLanguage,
    provider: params.provider,
    customUrl: params.customUrl,
    customKey: params.customKey ?? null,
  });
}

export function translationCacheStat(): Promise<TranslationCacheStat> {
  return invoke<TranslationCacheStat>("translation_cache_stat");
}

export function translationCacheClear(): Promise<TranslationClearReport> {
  return invoke<TranslationClearReport>("translation_cache_clear");
}

export function onDownloadProgress(
  handler: (payload: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("online://download-progress", (event) => handler(event.payload));
}

// ---------------- v1.0：在线全量索引（中文搜索） ----------------

/** 索引状态：已收录条数 / 服务端总量 / 是否同步中 */
export function indexStatus(): Promise<IndexStatus> {
  return invoke<IndexStatus>("online_index_status");
}

/**
 * 手动补全索引。
 * 未登录会立刻抛 `unauthenticated`（官方 /Find 匿名 401），调用方静默处理即可；
 * 同一时刻只允许一个同步，重复调用抛 `busy`。
 */
export function indexSync(): Promise<IndexSyncReport> {
  return invoke<IndexSyncReport>("online_index_sync");
}

/**
 * 暂停 / 继续本地索引。
 *
 * - `paused = true`：只置暂停标记，同步线程在「当前这一页」完成后收手并保留分区游标；
 * - `paused = false`：清标记 + 后台线程从已落盘的游标续爬（不等它跑完，立即返回）。
 *
 * 两者都立即返回最新状态，前端直接拿返回值覆盖 `indexStatus` 即可。
 */
export function indexPause(paused: boolean): Promise<IndexStatus> {
  return invoke<IndexStatus>("online_index_pause", { paused });
}

export interface IndexSearchParams {
  query: string;
  offset?: number;
  limit?: number;
  /** 不传 = 跟随设置 / 界面语言（Rust 侧解析） */
  targetLang?: string;
}

/** 纯本地检索：索引文本 + 本地译文标题，**不发任何网络请求** */
export function indexSearch(params: IndexSearchParams): Promise<IndexSearchResult> {
  return invoke<IndexSearchResult>("online_index_search", {
    query: params.query,
    offset: params.offset ?? 0,
    limit: params.limit ?? 24,
    targetLang: params.targetLang ?? null,
  });
}

/**
 * 本地搜索（v1.1 双搜索框架）：只查本地索引 + 本地译文标题，**零网络**。
 *
 * 与官方搜索（`findMods`）彻底分开，前端两个输入框各走一条链路，
 * 结果不再互相混合。Rust 侧命令 `search_local_mods` 内部复用同一个 `search_for_app`。
 */
export function searchLocalMods(params: IndexSearchParams): Promise<IndexSearchResult> {
  return invoke<IndexSearchResult>("search_local_mods", {
    keyword: params.query,
    offset: params.offset ?? 0,
    limit: params.limit ?? 60,
    targetLang: params.targetLang ?? null,
  });
}

/** 清空索引（下次登录后会自动重建） */
export function indexClear(): Promise<IndexClearReport> {
  return invoke<IndexClearReport>("online_index_clear");
}

/**
 * 订阅索引进度事件（Rust 每成功写入一批数据 emit 一次，结束 / 失败也会 emit）。
 * 前端靠它实时刷新「🟡 索引同步中 (已收集 N / M 条)」，不再依赖轮询。
 */
export function onIndexProgress(handler: (status: IndexStatus) => void): Promise<UnlistenFn> {
  return listen<IndexStatus>("online://index-progress", (event) => {
    if (event.payload) handler(event.payload);
  });
}

// ---------------- v1.0：批量标题翻译（online_titles_zh.json） ----------------

/**
 * 开始批量翻译索引里的英文标题。
 * 后台单线程、**1 req/s**（与详情页翻译共用同一个全局 FIFO 限速器），可随时停止，
 * 断点续跑（已翻过的靠 titleHash 跳过）。已在跑时抛 `busy`。
 */
export function titleTranslateStart(targetLang?: string): Promise<TitleJobStatus> {
  return invoke<TitleJobStatus>("online_titles_translate_start", {
    targetLang: targetLang ?? null,
  });
}

/** 请求停止：当前这条请求跑完后退出 */
export function titleTranslateStop(): Promise<TitleJobStatus> {
  return invoke<TitleJobStatus>("online_titles_translate_stop");
}

/** 进度：已翻 / 待翻 / 总数 */
export function titleTranslateStatus(): Promise<TitleJobStatus> {
  return invoke<TitleJobStatus>("online_titles_translate_status");
}
