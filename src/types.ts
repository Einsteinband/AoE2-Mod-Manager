export type ModKind = "local" | "subscribed";

/** 精准分类：来自官方 Tag，缺失时由本地特征扫描兜底 */
export type ModCategory = "ui" | "audio" | "map" | "data";

/**
 * 模组来源（Rust 侧 ModSource::classify 是唯一判定入口）：
 * tool = 本工具安装（有元数据记录，或 local 且 WorkshopID > 0）
 * official = 官方订阅（无记录，但 subscribed 且 WorkshopID > 0）
 * unknown = 无法确定（无记录且无 WorkshopID：手动放入）
 */
export type ModSource = "tool" | "official" | "imported" | "unknown";

export interface ModEntry {
  id: string;
  folderName: string;
  path: string;
  kind: ModKind;
  workshopId: number | null;
  nameFromFolder: string;
  displayName: string;
  displayNameSource: "info.json" | "folder";
  author: string | null;
  description: string | null;
  thumbnail: string | null;
  enabled: boolean | null;
  priority: number | null;
  lastUpdateMs: number | null;
  /** 软件记录的安装时间（ms epoch）；老模组 / 手动放入的模组为 null */
  installedAtMs: number | null;
  checksum: string | null;
  /** 详情页内容类型：有官方标签时是官方中文名 */
  contentTags: string[];
  /** 左侧筛选用分类，至少一项 */
  categories: ModCategory[];
  /** "official" = 软件记录过的官方 Tag；"heuristic" = 本地特征扫描 */
  categorySource: "official" | "heuristic";
  /** 官方 Tag 中文名，无元数据时为空 */
  officialTags: string[];
  /** 来源判定：本工具安装 / 官方订阅 / 无法确定 */
  source: ModSource;
  /** mod_metadata.json 里是否有该模组的记录（source=tool 的可追溯依据） */
  metadataRecorded: boolean;
  issues: string[];
  infoJsonPresent: boolean;
  /** 数据模组：模组内含游戏核心数据库文件（如 empires2_x2_p1.dat），同一时间只能启用一个 */
  isDataMod: boolean;
  /** 列表扫描统计到的普通文件字节总量；不完整或不可读时为 null */
  sizeBytes: number | null;
  /** 大小统计是否完整；false 时不得按真实字节参与排序 */
  sizeComplete: boolean;
  /**
   * v0.6：占位条目 —— 只存在于「我的收藏」里的已卸载 / 未安装模组。
   * true 时 path / folderName 为空，enabled 恒为 null，点击卡片走“下载并安装”，不打开本地详情。
   */
  uninstalled?: boolean;
  /**
   * v0.6：已经转换好的封面 URL（占位条目走图片缓存 asset URL）。
   * 有值时优先于 thumbnail（thumbnail 是磁盘绝对路径，卸载后失效）。
   */
  coverUrl?: string | null;
}

export interface ScanReport {
  root: string | null;
  rootExists: boolean;
  scannedAtMs: number;
  localDir: string;
  subscribedDir: string;
  localExists: boolean;
  subscribedExists: boolean;
  mods: ModEntry[];
  warnings: string[];
}

export interface ModStats {
  sizeBytes: number;
  fileCount: number;
  truncated: boolean;
}

/** 首次启动引导：Rust 侧探测到的一个候选模组根目录 */
export interface RootCandidate {
  /** 绝对路径（已去掉末尾反斜杠） */
  path: string;
  /** 探测来源：Steam 注册表 / Steam 库 / 用户目录 / 本机扫描 等 */
  source: string;
  hasLocal: boolean;
  hasSubscribed: boolean;
  /** 是否是游戏安装目录本身（local/subscribed 可能尚未生成） */
  looksLikeGame: boolean;
}

/** 在线页用：本机已安装索引（只读目录名 + 元数据，不做特征扫描） */
export interface InstalledIndexEntry {
  workshopId: number;
  kind: ModKind;
  folderName: string;
  source: ModSource;
}

/** 删除本地模组的真实结果（Rust 侧已做完整安全校验，只删那一个目录） */
export interface DeleteReport {
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

/**
 * v3.0 界面字体种类：黑体（出厂默认）/ 幼圆 / 跟随系统 / 衬线（v3.3 新增）。
 * 对应 CSS 变量 --app-font-family（真字体栈写在 style.css 的 --font-* 里）。
 * v2.4 的旧值 "sans-serif" / "system-ui" 静默归一化为这里；"serif" 自 v3.3 起是独立档位。
 */
export type UiFontFamily = "hei" | "youyuan" | "system" | "serif";

export interface AppSettings {
  modRoot: string | null;
  lastScanMs: number | null;
  /** 界面语言："en" | "zh" | ""（尚未选择，前端按系统语言推断） */
  locale: string;
  /** 最后一次自动检查软件更新的毫秒时间戳；0 = 从未检查过（启动检查的 24 小时时间锁） */
  lastAutoUpdateCheckMs: number;
  /** 是否允许后台静默建本地索引（设置 → 通用，默认关闭） */
  enableIndexing: boolean;
  /** 是否在在线页显示本地搜索框（设置 → 通用，默认关闭） */
  enableLocalSearch: boolean;
  /** v1.6 本地列表视图：“grid” 大图网格 | “list” 紧凑列表 */
  viewMode: string;
  /** v1.6 网格模式卡片最小宽度（px，160..=320，步长 20） */
  cardSize: number;
  /** v2.2 界面主题："dark" 深色羊皮纸（默认）| "light" 明亮米白 */
  theme: string;
  /** v3.6 强调色主题：ID 由前端注册表定义，默认 gold；与明暗模式正交 */
  accent: string;
  /**
   * v3.0 三层排版 —— 界面层：字体种类（"hei" | "youyuan" | "system" | "serif"，v3.3 加衬线）
   * 对应 CSS 变量 --app-font-family
   */
  uiFontFamily: UiFontFamily;
  /** v3.0 界面层：字重（400 常规 / 700 加粗，默认 400）—— 对应 CSS 变量 --ui-font-weight */
  uiFontWeight: number;
  /** v2.4 界面层：全局缩放百分比（80..=150，默认 100）—— 对应 --global-scale（值 ÷ 100） */
  globalFontScale: number;
  /** v2.4 正文阅读层：基准字号（px，12..=24，默认 14）—— 对应 --reader-font-size */
  readerFontSize: number;
  /** v2.4 正文阅读层：行距（1.4 / 1.6 / 1.8，默认 1.6）—— 对应 --reader-line-height */
  readerLineHeight: number;
  /** v3.0 正文阅读层：字重（400 常规 / 700 加粗，默认 400）—— 对应 --reader-font-weight */
  readerFontWeight: number;
  /** v2.4 卡片列表层：字号（px，10..=16，默认 12）—— 对应 --card-font-size */
  cardFontSize: number;
  /** v3.3 卡片列表层：字重（400 常规 / 700 加粗，默认 400）—— 对应 --card-font-weight */
  cardFontWeight: number;
  /**
   * v3.5：英文界面是否使用「西文专用字体栈」（Segoe UI 打头，再接用户选的中文字体做 fallback）。
   * 只在英文界面生效，中文界面忽略；默认 true。
   */
  latinFont: boolean;
  /** 已安装卡片：强调色信息区背景开关，默认 true */
  installedCardBgEnabled?: boolean;
  /** 已安装卡片：左侧主题色标识条开关，默认 true */
  installedCardBarEnabled?: boolean;
  /** 已安装卡片：右下角斜线装饰开关，默认 true */
  installedCardStripesEnabled?: boolean;
  /** v3.2：图片缓存目录（null / 缺省 = 默认 AppData 位置） */
  imageCacheDir?: string | null;
  /** v3.2：在线模组信息缓存（online_cache.json）目录；null = 应用配置目录 */
  modInfoCacheDir?: string | null;
  /** v3.2：译文缓存（translation_cache.json / online_titles_zh.json）目录；null = 应用配置目录 */
  translationCacheDir?: string | null;
  /**
   * v1.x：**数据与缓存总目录**——图片/在线数据/索引/译文/收藏/预设/队列/登录凭证
   * 共用的根目录；null / 缺省 = 默认的 %APPDATA%\<bundleId>。
   */
  dataDir?: string | null;

  /**
   * v3.3：游戏根目录（含 AoE2DE_s.exe 的那一层，如 F:\Games\AoE2DE）。
   * 「启动游戏」按钮走 Steam 协议（steam://rungameid/813780），
   * 这里只用于展示与前置校验；null = 未配置。
   */
  gameRootDir?: string | null;
  /** v2.3 遗留：扁平界面字号。v2.4 起只用于一次性迁移，新数据一律为 null，前端不再读取 */
  uiFontSize?: number | null;
  /** v2.3 遗留：扁平行距（已废弃，仅迁移用） */
  uiLineHeight?: number | null;
}

/** v3.2：三类本地缓存（设置 → 缓存与存储） */
export type CacheDirKind = "image" | "modinfo" | "translation";

/** 某一类缓存目录的当前状态（Rust 的 cache_dirs / set_cache_dir / reset_cache_dir 返回） */
export interface CacheDirEntry {
  kind: CacheDirKind;
  /** 当前实际生效的目录（配置可用就是配置的，否则是默认的） */
  path: string;
  /** 默认（AppData）目录：「恢复默认」据此说明会回到哪里 */
  defaultPath: string;
  /** true = 用户自定义且正在生效 */
  isCustom: boolean;
  exists: boolean;
}

export interface CacheDirsView {
  dirs: CacheDirEntry[];
}

/** v1.x：数据与缓存总目录（Rust 的 data_dir_view / migrate_data_dir 返回） */
export interface DataDirView {
  /** 当前实际生效的目录（配置可用就是配置的，否则是默认的） */
  path: string;
  /** 默认目录（%APPDATA%\<bundleId>），迁移 / 回退时的参照点 */
  defaultPath: string;
  /** true = 用户自定义且正在生效 */
  isCustom: boolean;
  exists: boolean;
  /** 白名单条目合计占用（字节） */
  totalBytes: number;
  /** 其中图片缓存占用（字节） */
  imagesBytes: number;
  /** true = 检测到旧版「三类分目录」配置，迁移后会被清空 */
  legacy: boolean;
}

/** v0.3 预设：一条记录对应 mod-status.json 里的一条 Mods 项 */
export interface PresetItem {
  /** 文件夹名里的 Workshop ID，本地模组可能为 null 或 0 */
  workshopId: number | null;
  /** mod-status.json 的 Path，形如 subscribed//20505_xxx（WorkshopID 缺失时用它精确匹配） */
  path: string;
  title: string;
  priority: number | null;
  kind: string;
}

export interface Preset {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  items: PresetItem[];
}

/** 应用预设后的真实结果，逐项汇报，不做“全部成功”的含糊结论 */
export interface ApplyReport {
  statusPath: string;
  backupPath: string | null;
  requested: number;
  restored: number;
  /** 本次被覆盖式禁用（true → false，且不在预设中）的模组数 */
  disabled: number;
  alreadyEnabled: number;
  totalEnabledAfter: number;
  notInStatus: PresetItem[];
  /** 预设里有多个数据模组时被强制跳过的数量（游戏同一时间只能加载一个 .dat） */
  skippedDataMods: number;
  /** 被跳过的数据模组标题（可直接展示） */
  skippedDataModTitles: string[];
  wrote: boolean;
  message: string;
}

/** applyReport 之后：单条启用/禁用的真实结果（Rust 侧会先检查游戏进程、再备份、回读校验） */
export interface ToggleOutcome {
  /** 写入后的目标状态 */
  enabled: boolean;
  /** 写入前 mod-status.json 里的值；记录缺少 Enabled 字段时为 null */
  previousEnabled: boolean | null;
  /** 是否真的写了文件（已是目标状态时为 false，不会产生备份） */
  changed: boolean;
  totalEnabledAfter: number;
  statusPath: string;
  backupPath: string | null;
}

/**
 * 批量启用/禁用的单个目标：WorkshopID 优先，Path 兜底。
 * 本工具安装的 local 模组 WorkshopID 被置 0，只能靠 kind + folderName 定位。
 */
export interface BatchTarget {
  workshopId: number | null;
  kind: ModKind;
  folderName: string;
}

/** 批量启用/禁用的真实结果（未登记 / 已一致 / 真正改写 分开计数） */
export interface BatchToggleReport {
  /** 目标状态 */
  enabled: boolean;
  requested: number;
  /** 本次真正被改写的记录数 */
  updated: number;
  /** 本来就是目标状态、无需改写的记录数 */
  already: number;
  /** mod-status.json 里找不到记录的条目数（游戏还没登记） */
  notInStatus: number;
  totalEnabledAfter: number;
  statusPath: string;
  backupPath: string | null;
  /** 是否真的写了文件（全部已一致时不写盘、不产生备份） */
  wrote: boolean;
  message: string;
}

export type SourceFilter = "all" | ModKind | "imported";
/** v0.2 拖拽排序的写入结果（Rust 侧已进程检测 + 备份 + 回读校验） */
export interface PriorityOutcome {
  statusPath: string;
  backupPath: string | null;
  /** 本次真正被改写 Priority 的记录数 */
  updated: number;
  /** 参与排序的记录总数（= 写入后 Priority 的最大值） */
  total: number;
  /** mod-status.json 里有、但前端列表没有的记录（磁盘上已不存在），已被排到末尾 */
  unlisted: string[];
  wrote: boolean;
}

export type StatusFilter = "all" | "enabled" | "disabled" | "unknown";
export type SortKey = "name" | "updated" | "priority" | "folder" | "download" | "size";

/** v0.4：GitHub 最新 Release 的检测结果（Rust 侧已比对好版本号） */
export interface UpdateInfo {
  /** 当前运行版本，如 0.1.1 */
  currentVersion: string;
  /** 服务器最新版本（已去掉前缀 v），如 0.2.0 */
  latestVersion: string;
  /** latestVersion 是否高于 currentVersion */
  hasUpdate: boolean;
  /** Release 页面地址（https://github.com/...） */
  releaseUrl: string;
  releaseName: string | null;
  publishedAt: string | null;
  /** 更新说明（后端已截断） */
  notes: string | null;
}

// ---------------- v0.4：本地模组批量更新检测 ----------------

/** 单个本地模组的版本比对结果（Rust 侧用 /Installed 分页批量得出） */
export interface ModUpdateItem {
  /** 与 ModEntry.id 一致：local:文件夹 / subscribed:文件夹 */
  entryId: string;
  /** 元数据中的模组 ID（可能为 0，不用于官方匹配） */
  modId: number;
  /** 官方 WorkshopID（用于匹配 /Installed）；无官方身份时为 0 */
  workshopId?: number;
  folderName: string;
  hasUpdate: boolean;
  /** 本地 mod-status.json 里的 LastUpdate（毫秒） */
  localLastUpdateMs: number | null;
  /** 服务端 lastUpdate（已统一换算成毫秒；接口未提供时为 null） */
  serverLastUpdateMs: number | null;
  /** 服务端没返回这个模组（本地独有 / 未订阅） */
  unknown: boolean;
  /** 检测分类：matched / known_not_in_installed / no_workshop_id / data_incomplete / detail_failed */
  category: 'matched' | 'known_not_in_installed' | 'no_workshop_id' | 'data_incomplete' | 'detail_failed';
}

export interface ModUpdateReport {
  checkedAtMs: number;
  totalLocal: number;
  updateCount: number;
  unknownCount: number;
  serverTotal: number | null;
  /** 实际请求了几页（每页 50 条） */
  pages: number;
  /** Detail 补充检测：发起了多少次请求 */
  detailRequested?: number;
  /** Detail 补充检测：成功返回了多少条 */
  detailSucceeded?: number;
  /** Detail 补充检测：失败了多少条 */
  detailFailed?: number;
  /** Detail 补充检测：缓存命中数 */
  detailCacheHit?: number;
  /** Detail 补充检测：网络请求成功数 */
  detailNetworkOk?: number;
  /** Detail 补充检测：网络请求失败数 */
  detailNetworkFailed?: number;
  items: ModUpdateItem[];
}

// ---------------- v0.5：模组收藏与自定义备注（user_data.json） ----------------

/** 单个模组的用户数据；key 只用 WorkshopID，卸载模组后仍然保留 */
export interface ModUserData {
  /** 自定义备注名；null = 没有备注 */
  customName: string | null;
  isFavorite: boolean;
}

export interface UserDataStore {
  version: number;
  /** key 一定是 WorkshopID（数字字符串），与模组是否安装无关 */
  mods: Record<string, ModUserData>;
}

export interface SaveUserDataReport {
  path: string;
  /** 写前备份的文件路径；首次写入时为 null */
  backupPath: string | null;
  entryCount: number;
  favoriteCount: number;
}
