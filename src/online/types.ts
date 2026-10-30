/** 官方模组服务（api.ageofempires.com/api/v4/mods）相关类型。
 *  字段名来自官网列表模板实际使用的键；详情接口的完整 schema 未经认证验证，
 *  因此详情统一用 `Record<string, unknown>` + 原始的已知字段兜底展示。 */

import { i18n } from "../i18n";

export interface OnlineMod {
  modId: number;
  title: string;
  creator: string | null;
  thumbnail: string | null;
  installs: number | null;
  installsTruncated: boolean;
  rating: number | null;
  modStatus: string | null;
  userInstalled: boolean;
  userDownloaded: boolean;
  updateAvailable: boolean;
  gameTitleId: number | null;
  /** 官方分类 id（对应 ModTag.modTypeId） */
  tagIds: number[];
  /** 官方分类名，与 tagIds 一一对应 */
  tagNames: string[];
  /** 列表若带 modFileSize（字节）则透传，否则为 null，由详情/下载补全 */
  fileSize: number | null;
  raw: Record<string, unknown>;
}

/** `GET /api/v4/mods/Tags` 的单项（官方分类字典，已按 gameTitleId=2 过滤） */
export interface ModTag {
  modTypeId: number;
  modTypeName: string;
  gameTitleId: number | null;
}

/** AoE II: DE 的 17 个官方分类（实测自 /api/v4/mods/Tags 的 gameTitleId=2 部分），
 *  仅在接口请求失败时作为离线兜底。 */
export const FALLBACK_TAGS: ModTag[] = [
  { modTypeId: 9, modTypeName: "Artificial Intelligence", gameTitleId: 2 },
  { modTypeId: 10, modTypeName: "Campaign", gameTitleId: 2 },
  { modTypeId: 11, modTypeName: "Data Mod", gameTitleId: 2 },
  { modTypeId: 12, modTypeName: "Graphics", gameTitleId: 2 },
  { modTypeId: 13, modTypeName: "Movie", gameTitleId: 2 },
  { modTypeId: 14, modTypeName: "Music", gameTitleId: 2 },
  { modTypeId: 15, modTypeName: "Random Maps", gameTitleId: 2 },
  { modTypeId: 16, modTypeName: "Scenarios", gameTitleId: 2 },
  { modTypeId: 17, modTypeName: "Sounds", gameTitleId: 2 },
  { modTypeId: 18, modTypeName: "Speech", gameTitleId: 2 },
  { modTypeId: 19, modTypeName: "Taunt", gameTitleId: 2 },
  { modTypeId: 20, modTypeName: "Terrain", gameTitleId: 2 },
  { modTypeId: 21, modTypeName: "Menu Background", gameTitleId: 2 },
  { modTypeId: 22, modTypeName: "User Interface", gameTitleId: 2 },
  { modTypeId: 23, modTypeName: "Text", gameTitleId: 2 },
  { modTypeId: 26, modTypeName: "Other", gameTitleId: 2 },
  { modTypeId: 30, modTypeName: "Return of Rome", gameTitleId: 2 },
];

/** 官方分类的中文名（仅用于展示，id 已对官方字典逐一核对） */
export const TAG_ZH: Record<number, string> = {
  9: "人工智能",
  10: "战役",
  11: "数据模组",
  12: "图像",
  13: "影片",
  14: "音乐",
  15: "随机地图",
  16: "场景",
  17: "音效",
  18: "语音",
  19: "嘲讽音",
  20: "地形",
  21: "菜单背景",
  22: "用户界面",
  23: "文本",
  26: "其他",
  30: "罗马复兴",
};

export function tagLabel(tag: { modTypeId: number; modTypeName: string }): string {
  return localizedTagName(TAG_ZH[tag.modTypeId] ?? tag.modTypeName);
}

/**
 * 分类名本地化：官方 API / mod_metadata.json 里存的是**中文名**（游戏客户端语言），
 * 英文界面必须自己映射；反向（接口偶尔回英文名、界面是中文）也一并处理。
 * 未知名字原样返回，绝不吞掉数据。
 */
export const TAG_EN_BY_ZH: Record<string, string> = {
  // 官方网站字典（TAG_ZH）
  人工智能: "Artificial Intelligence",
  战役: "Campaign",
  数据模组: "Data Mod",
  图像: "Graphics",
  美术贴图: "Graphics",
  影片: "Movie",
  音乐: "Music",
  随机地图: "Random Maps",
  场景: "Scenarios",
  音效: "Sounds",
  音频: "Audio",
  语音: "Speech",
  嘲讽音: "Taunt",
  地形: "Terrain",
  材质: "Materials",
  菜单背景: "Menu Background",
  用户界面: "User Interface",
  "界面 UI": "User Interface",
  界面: "User Interface",
  文本: "Text",
  其他: "Other",
  罗马复兴: "Return of Rome",
  // 本地特征推断可能出现的名字（scan.rs 兜底分类）
  地图: "Maps",
  数据: "Data",
  "数据/其他": "Data / Other",
};

const TAG_ZH_BY_EN: Record<string, string> = Object.entries(TAG_EN_BY_ZH).reduce(
  (acc, [zh, en]) => {
    // 多个中文名指向同一个英文名时，保留第一个（官方字典的写法优先）
    if (!acc[en]) acc[en] = zh;
    return acc;
  },
  {} as Record<string, string>,
);

export function localizedTagName(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw) return raw;
  if (i18n.global.locale.value === "zh") return TAG_ZH_BY_EN[raw] ?? raw;
  return TAG_EN_BY_ZH[raw] ?? raw;
}

export interface FindResult {
  totalCount: number | null;
  isLoggedOn: boolean;
  items: OnlineMod[];
  serverMessage: string | null;
}

export interface ApiFailure {
  kind: string;
  message: string;
  status: number | null;
}

// ---------------- v0.6：离线缓存（%APPDATA%\com.aoe2.modmanager\online_cache.json） ----------------

/** 一条缓存命中（Rust cache::CacheHit）。v0.7 起**不再有过期**，expired 恒为 false。 */
export interface CacheHit<T> {
  /** find | installed | detail */
  kind: string;
  /** 由 Rust 侧统一计算的 key，前端只用于排查 */
  key: string;
  value: T;
  savedAtMs: number;
  usedAtMs: number;
  /** 恒为 false（无 TTL）；保留字段兼容旧判断 */
  expired: boolean;
}

/** 一页缓存（online_cache_pages 的返回项）：一次 invoke 可以拿回好几页 */
export interface CachedPage {
  start: number;
  totalCount: number | null;
  items: OnlineMod[];
  /** 这一页的写入时间：前端据此判断缓存有多新，决定要不要联网刷新 */
  savedAtMs: number;
}

/** 缓存概览（设置页展示） */
export interface CacheStat {
  path: string;
  entries: number;
  bytes: number;
  oldestMs: number | null;
  newestMs: number | null;
  /** 0 = 永久保存 */
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

/** JSON 缓存 + 图片缓存的总览 */
export interface CacheOverview extends CacheStat {
  imageDir: string;
  imageEntries: number;
  imageBytes: number;
  imageMaxBytes: number;
}

/** 清理结果：同时清理 online_cache.json 与 image_cache */
export interface ClearCacheReport {
  removed: boolean;
  path: string;
  entriesRemoved: number;
  imagesRemoved: number;
  imagesBytes: number;
}

// ---------------- v0.2.4：一键翻译（%APPDATA%\com.aoe2.modmanager\translation_cache.json） ----------------

/**
 * 一个模组的译文（Rust translator::Translation）。
 * `cached=true` 表示直接命中本地 translation_cache.json，一个 HTTP 都没发。
 */
export interface Translation {
  modId: number;
  /** 目标语言（小写：zh-cn / ja …） */
  lang: string;
  /** FNV-1a 64 的 16 位 hex（title + description），用于判断原文是否变了 */
  originalHash: string;
  /** 译文标题（不再叫 zhTitle：目标语言可以是任意语言） */
  title: string;
  /** 译文描述 */
  desc: string;
  /** google | mymemory */
  provider: string;
  charCount: number;
  savedAtMs: number;
  cached: boolean;
  /** 描述过长被截断（只翻译了前 6000 字符） */
  truncated: boolean;
}

/** 设置页「翻译」页签的视图（Rust translator::TranslateSettingsView） */
export interface TranslateSettingsView {
  /** 用户存下的值；空串 = 跟随界面语言 */
  targetLanguage: string;
  /** 实际生效的语言（小写） */
  resolvedLanguage: string;
  /** auto | google | mymemory | custom */
  provider: string;
  customUrl: string | null;
  /** 只告诉前端“有没有存 key”，密钥本体永不回传 */
  customKeySet: boolean;
  supportedLanguages: string[];
}

/** 单个语言的缓存条数 */
export interface LangCount {
  lang: string;
  count: number;
}

/** 翻译缓存总览 */
export interface TranslationCacheStat {
  path: string;
  /** 条目总数（模组 × 语言） */
  entries: number;
  /** 涉及多少个模组 */
  mods: number;
  bytes: number;
  byLanguage: LangCount[];
  oldestMs: number | null;
  newestMs: number | null;
}

/** 清理翻译缓存的结果 */
export interface TranslationClearReport {
  removed: boolean;
  path: string;
  entriesRemoved: number;
}

export interface SessionStatus {
  loggedIn: boolean;
  cookieCount: number;
  windowReady: boolean;
  storage: string;
  /** 登录态来源：webview = WebView2 实时 Cookie；cache = DPAPI 加密缓存 */
  cookieSource: string | null;
  /** 窗口创建/读取 Cookie 失败时的具体原因（不再静默吞掉） */
  error: string | null;
}

/** 登录入口（由 Rust 侧提供，前端不自己拼 URL） */
export interface LoginTarget {
  key: string;
  label: string;
  url: string;
  hint: string;
}

/** 高级网络设置视图：同时返回"实际生效的链路"，避免用户不知道自己在走什么 */
export interface NetworkSettingsView {
  auto: boolean;
  proxyUrl: string | null;
  rememberLogin: boolean;
  /** manual | system | env | direct */
  source: string;
  effectiveProxy: string | null;
  note: string | null;
  webviewArgs: string | null;
  dataDir: string | null;
  error: string | null;
}

export interface InstallReport {
  targetDir: string;
  fileCount: number;
  bytes: number;
  backupDir: string | null;
  updated: boolean;
}

/**
 * 安装结果：本工具**总是**把模组落到 local/（可直接在游戏内启用），
 * `localized=false` 只会在“转 local 失败”时出现，此时记录写的是 subscribed//。
 */
export interface InstallOutcome {
  install: InstallReport;
  downloadedBytes: number;
  /** info.json / 缩略图的补全结果（游戏识别模组依赖这两个文件） */
  assets: InstallAssets;
  /** 是否已成功转入 local（本工具的最终形态） */
  localized: boolean;
  /** 最终所在目录（local 或 subscribed） */
  finalDir: string;
  /** 最终写入 mod-status.json 的 Path（local//… 或 subscribed//…） */
  finalPath: string;
  /** mod-status.json 的写入结果说明 */
  statusNote: string;
  statusBackupPath: string | null;
  note: string;
}

/** 安装后补全的游戏资源文件结果 */
export interface InstallAssets {
  /** 是否新写了 info.json（原本就有 = false，绝不覆盖） */
  infoJsonWritten: boolean;
  infoJsonPath: string | null;
  /** 最终可用的缩略图文件名（jpg / png）；null = 没有缩略图 */
  thumbnailName: string | null;
  message: string;
}

/** 卸载结果：Rust 侧已做完整安全校验（只删那一个目录），不向官方发任何请求 */
export interface UninstallReport {
  modId: number;
  folderName: string;
  removedDir: string;
  fileCount: number;
  bytes: number;
  statusRecordRemoved: boolean;
  statusBackupPath: string | null;
  metadataRemoved: boolean;
  /** 保留的旧版本备份目录（.bak-*），不会删除 */
  versionBackups: string[];
  message: string;
}

export interface DownloadProgress {
  modId: number;
  phase: string;
  received: number;
  total: number;
  percent: number;
}

/** 官网 mods 页 data-sort 的真实取值（labelKey 指向 i18n，界面不再硬编码中文） */
export const SORT_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "recentpopular", labelKey: "online.sortRecentPopular" },
  { value: "popular", labelKey: "online.sortPopular" },
  { value: "rating", labelKey: "online.sortRating" },
  { value: "lastUpdate", labelKey: "online.sortLastUpdate" },
  { value: "createDate", labelKey: "online.sortCreateDate" },
  { value: "modName", labelKey: "online.sortModName" },
  { value: "creatorName", labelKey: "online.sortCreatorName" },
];

export function isApiFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiFailure).kind === "string" &&
    typeof (value as ApiFailure).message === "string"
  );
}
