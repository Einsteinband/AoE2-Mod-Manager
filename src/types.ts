export type ModKind = "local" | "subscribed";

/** 精准分类：来自官方 Tag，缺失时由本地特征扫描兜底 */
export type ModCategory = "ui" | "audio" | "map" | "data";

/**
 * 模组来源（Rust 侧 ModSource::classify 是唯一判定入口）：
 * tool = 本工具安装（有元数据记录，或 local 且 WorkshopID > 0）
 * official = 官方订阅（无记录，但 subscribed 且 WorkshopID > 0）
 * unknown = 无法确定（无记录且无 WorkshopID：手动放入）
 */
export type ModSource = "tool" | "official" | "unknown";

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

export interface AppSettings {
  modRoot: string | null;
  lastScanMs: number | null;
  /** 界面语言："en" | "zh" | ""（尚未选择，前端按系统语言推断） */
  locale: string;
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

export type SourceFilter = "all" | ModKind;
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
export type SortKey = "name" | "updated" | "priority" | "folder";

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
  /** 官方 WorkshopID（工具安装的模组也能拿到，来自 mod_metadata.json） */
  modId: number;
  folderName: string;
  hasUpdate: boolean;
  /** 本地 mod-status.json 里的 LastUpdate（毫秒） */
  localLastUpdateMs: number | null;
  /** 服务端 lastUpdate（已统一换算成毫秒；接口未提供时为 null） */
  serverLastUpdateMs: number | null;
  /** 服务端没返回这个模组（本地独有 / 未订阅） */
  unknown: boolean;
}

export interface ModUpdateReport {
  checkedAtMs: number;
  totalLocal: number;
  updateCount: number;
  unknownCount: number;
  serverTotal: number | null;
  /** 实际请求了几页（每页 50 条） */
  pages: number;
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
