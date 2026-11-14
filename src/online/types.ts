/** 官方模组服务（api.ageofempires.com/api/v4/mods）相关类型。
 *  字段名来自官网列表模板实际使用的键；详情接口的完整 schema 未经认证验证，
 *  因此详情统一用 `Record<string, unknown>` + 原始的已知字段兜底展示。 */

import { translate } from "../i18n";
import { translateBackendMessage } from "../format";

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

/**
 * 分类的「身份」与「显示」彻底分离：
 * - 身份 = 官方 modTypeId，或数据层里的那个原始名称（中文名 / 英文名 / scan.rs 兜底名）。
 *   筛选、排序、mod_metadata.json 持久化都用身份，绝不翻译。
 * - 显示 = 语言包 `tagNames.*`，随界面语言切换，三语齐全。
 *
 * 以前只有「中文 ↔ 英文」二值映射，西班牙语界面会退化成英文或中文原文，
 * 新增第三种语言时必须再补两套映射表；现在只补语言包即可。
 */

/** 官方 17 项：id + 官方英文名（FALLBACK_TAGS 的 modTypeName）+ 数据层中文名 + tagNames.* 后缀 */
const OFFICIAL_TAGS: { id: number; name: string; zh: string; key: string }[] = [
  { id: 9, name: "Artificial Intelligence", zh: "人工智能", key: "artificialIntelligence" },
  { id: 10, name: "Campaign", zh: "战役", key: "campaign" },
  { id: 11, name: "Data Mod", zh: "数据模组", key: "dataMod" },
  { id: 12, name: "Graphics", zh: "图像", key: "graphics" },
  { id: 13, name: "Movie", zh: "影片", key: "movie" },
  { id: 14, name: "Music", zh: "音乐", key: "music" },
  { id: 15, name: "Random Maps", zh: "随机地图", key: "randomMaps" },
  { id: 16, name: "Scenarios", zh: "场景", key: "scenarios" },
  { id: 17, name: "Sounds", zh: "音效", key: "sounds" },
  { id: 18, name: "Speech", zh: "语音", key: "speech" },
  { id: 19, name: "Taunt", zh: "嘲讽音", key: "taunt" },
  { id: 20, name: "Terrain", zh: "地形", key: "terrain" },
  { id: 21, name: "Menu Background", zh: "菜单背景", key: "menuBackground" },
  { id: 22, name: "User Interface", zh: "用户界面", key: "userInterface" },
  { id: 23, name: "Text", zh: "文本", key: "text" },
  { id: 26, name: "Other", zh: "其他", key: "other" },
  { id: 30, name: "Return of Rome", zh: "罗马复兴", key: "returnOfRome" },
];

/** 官方分类 id → tagNames.* 后缀 */
export const TAG_KEY_BY_ID: Record<number, string> = OFFICIAL_TAGS.reduce(
  (acc, item) => {
    acc[item.id] = item.key;
    return acc;
  },
  {} as Record<number, string>,
);

/**
 * 原始分类名 → tagNames.* 后缀。
 * 覆盖：官方中文名、官方英文名、历史别名（美术贴图 / 界面 UI / 界面 …）、
 * 以及 scan.rs 本地特征推断出的兜底分类名。未知名字不做猜测，原样显示。
 */
export const TAG_KEY_BY_NAME: Record<string, string> = {
  // 官方中文名
  人工智能: "artificialIntelligence",
  战役: "campaign",
  数据模组: "dataMod",
  图像: "graphics",
  影片: "movie",
  音乐: "music",
  随机地图: "randomMaps",
  场景: "scenarios",
  音效: "sounds",
  语音: "speech",
  嘲讽音: "taunt",
  地形: "terrain",
  菜单背景: "menuBackground",
  用户界面: "userInterface",
  文本: "text",
  其他: "other",
  罗马复兴: "returnOfRome",
  // 官方英文名（接口偶尔回英文，界面是中文/西语时也要能显示）
  "Artificial Intelligence": "artificialIntelligence",
  Campaign: "campaign",
  "Data Mod": "dataMod",
  Graphics: "graphics",
  Movie: "movie",
  Music: "music",
  "Random Maps": "randomMaps",
  Scenarios: "scenarios",
  Sounds: "sounds",
  Speech: "speech",
  Taunt: "taunt",
  Terrain: "terrain",
  "Menu Background": "menuBackground",
  "User Interface": "userInterface",
  Text: "text",
  Other: "other",
  "Return of Rome": "returnOfRome",
  // 历史别名 / scan.rs 兜底分类名
  美术贴图: "textures",
  材质: "materials",
  音频: "audio",
  地图: "maps",
  数据: "data",
  "数据/其他": "dataOther",
  "数据 / 其他": "dataOther",
  数据表: "dataTables",
  历史条目: "historyEntries",
  本地化: "localization",
  "界面 UI": "userInterface",
  界面: "userInterface",
};

/**
 * 本地侧栏分类的固定顺序：只给官方 17 项排位（原始中文名 → 序号），
 * 其它兜底分类不排位，排序时统一落到末尾（与改造前行为一致）。
 * 注意：这里只是「排序权重」，不参与显示，也不改变筛选身份。
 */
export const TAG_RANK_BY_NAME: Record<string, number> = OFFICIAL_TAGS.reduce(
  (acc, item, index) => {
    acc[item.zh] = index;
    return acc;
  },
  {} as Record<string, number>,
);

/** 取某名字对应的 tagNames.* 后缀（无匹配返回 null） */
export function tagKeyOfName(name: string): string | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  return TAG_KEY_BY_NAME[raw] ?? null;
}

/**
 * 分类名本地化：优先按 tagNames.* 显示；未知名字（含 Rust 抛来的分类协议串）原样返回，
 * 绝不吞掉数据。
 */
export function localizedTagName(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw) return raw;
  // 数据层偶尔把分类名也走了 aoe2mm:err: 协议串，交给后端错误翻译统一处理
  if (raw.startsWith("aoe2mm:err:")) return translateBackendMessage(raw);
  const key = tagKeyOfName(raw);
  if (key) {
    const text = translate(`tagNames.${key}`);
    // 语言包缺这个 key 时 translate 会原样返回 key，此时退回原始名字
    if (text && text !== `tagNames.${key}`) return text;
  }
  return raw;
}

export function tagLabel(tag: { modTypeId: number; modTypeName: string }): string {
  const key = TAG_KEY_BY_ID[tag.modTypeId];
  if (key) {
    const text = translate(`tagNames.${key}`);
    if (text && text !== `tagNames.${key}`) return text;
  }
  return localizedTagName(tag.modTypeName);
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
  { value: "fileSize", labelKey: "online.sortFileSize" },
];

export function isApiFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiFailure).kind === "string" &&
    typeof (value as ApiFailure).message === "string"
  );
}

// ---------------- v1.0：在线全量索引（中文搜索的底座） ----------------

/** 本地索引状态（Rust online_index::IndexStatus） */
/** 批量标题翻译任务状态（Rust translator::TitleJobStatus） */
export interface TitleJobStatus {
  running: boolean;
  /** 目标语言（小写） */
  lang: string;
  /** 索引里可翻译（英文标题）的候选条数 */
  total: number;
  /** 已有可用译文（titleHash 与当前标题一致）的条数 */
  done: number;
  /** 本轮失败次数 */
  failed: number;
  remaining: number;
  /** Rust 侧的一行状态（只用于日志排查，界面不直接展示） */
  message: string;
  startedAtMs: number;
  finishedAtMs: number;
  path: string;
  /** false = 在线索引还没建立，没有可翻译的标题 */
  indexReady: boolean;
}

export interface IndexStatus {
  /** 已收录条数 */
  indexed: number;
  /** 服务端总量（0 = 还没拿到） */
  totalCount: number;
  /** 已顺序消费的条数 */
  scanned: number;
  /** 是否已完整扫描过一遍 */
  done: boolean;
  syncing: boolean;
  /** 是否已开启「本地中文搜索与自动索引」（关闭时一个爬取请求都不发） */
  indexingEnabled: boolean;
  /** idle | checking | syncing | done | paused | disabled | needLogin | error */
  phase: string;
  /** 一行可读状态（直接展示，不含底层术语） */
  message: string;
  updatedAtMs: number;
  fullSyncedAtMs: number;
  cooldownUntilMs: number;
  path: string;
  maxItems: number;
  /** 用户已暂停（按钮显示「继续索引」） */
  paused: boolean;
  /** 上一次中断原因（空 = 无） */
  lastError: string;
  /** 还有断点可继续（未完成 / 暂停中 / 中断过） */
  resumable: boolean;
}

/** 本地索引搜索命中的一条：与 OnlineMod 同形，另带中文标题与命中字段 */
export interface IndexSearchItem extends OnlineMod {
  /** 本地译文标题（中文命中时非空） */
  zhTitle: string | null;
  /** zhTitle | title | creator | tag | modId */
  matchedBy: string;
}

export interface IndexSearchResult {
  query: string;
  /** 命中总数（用于分页与「共 N 条」） */
  total: number;
  offset: number;
  limit: number;
  /** 索引当前条数 */
  indexed: number;
  /** 服务端总量（0 = 未知） */
  totalCount: number;
  indexDone: boolean;
  /** 索引尚未建完：前端据此提示「后台仍在努力同步」 */
  indexPending: boolean;
  /** 本次检索额外并入了多少条缓存池条目（online_cache.json） */
  cached: number;
  /** 查询里是否含汉字 */
  hasCjk: boolean;
  lang: string;
  items: IndexSearchItem[];
}

export interface IndexSyncReport {
  fetched: number;
  pages: number;
  scanned: number;
  totalCount: number;
  indexed: number;
  done: boolean;
  /** true = 因新鲜度闸门跳过，一个请求都没发 */
  skipped: boolean;
  capped: boolean;
  message: string;
}

export interface IndexClearReport {
  removed: boolean;
  path: string;
  itemsBefore: number;
}
