import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ApplyReport,
  AppSettings,
  BatchTarget,
  BatchToggleReport,
  DeleteReport,
  InstalledIndexEntry,
  ModStats,
  ModUpdateReport,
  Preset,
  PriorityOutcome,
  PresetItem,
  RootCandidate,
  ScanReport,
  SaveUserDataReport,
  ToggleOutcome,
  UiFontFamily,
  UpdateInfo,
  UserDataStore,
} from "./types";

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

// ---- v0.4：软件更新检测 ----

/** 当前软件版本（编译期 CARGO_PKG_VERSION，唯一来源 tauri.conf.json） */
export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

/**
 * 检查 GitHub 最新 Release。
 * 走 Rust（ureq）而不是前端 fetch：这样能复用用户设置的手动代理。
 * 返回 hasUpdate 为 true 时，releaseUrl 是可以直接交给系统浏览器打开的页面。
 */
export function checkUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_update");
}

/**
 * 启动时的静默检查：24 小时内自动查过就直接跳过，一个请求都不发。
 * 返回 null 表示被时间锁跳过（此时终端不会有任何 [update] 日志）。
 */
export function checkUpdateAuto(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_update_auto");
}

/**
 * 批量检查本地模组是否有新版本。
 * 后端只用官方 /Installed（每页 50 条）翻页比对，绝不逐个请求 Detail，
 * 需要已登录《帝国时代》账号。
 */
export function checkModUpdates(): Promise<ModUpdateReport> {
  return invoke<ModUpdateReport>("check_mod_updates");
}

// ---- v3.1：GitHub Releases（更新历史 / 首启「新版本特性」） ----

/**
 * 一条 GitHub Release（Rust 端 fetch_github_releases 抓取后返回）。
 * 前端绝不直接 fetch api.github.com：WebView 会被 CORS 拦，也拿不到用户设的手动代理。
 */
export interface GithubRelease {
  /** 原始 tag（如 v0.3.3） */
  tagName: string;
  /** 去掉 v 前缀的版本号（如 0.3.3） */
  version: string;
  /** Release 标题 */
  name: string;
  /** 更新说明（Markdown 原文，可能为空） */
  body: string;
  /** ISO8601 发布时间 */
  publishedAt: string;
  /** Release 页面地址 */
  htmlUrl: string;
  /** 是否就是当前运行版本 */
  isCurrent: boolean;
}

/** 拉取 Releases 列表（Rust 侧已按发布时间倒序，带 User-Agent 并复用代理链路） */
export function fetchGithubReleases(): Promise<GithubRelease[]> {
  return invoke<GithubRelease[]>("fetch_github_releases");
}

/** 版本号归一化：v0.3.3 / 0.3.3 视为同一个版本 */
export function normalizeVersion(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^[vV]/, "")
    .trim()
    .toLowerCase();
}

/** 先转义再拼标签：下面产出的 HTML 不可能被 Release 原文注入 */
function escapeReleaseHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内标记（粗体 / 行内代码 / 链接）：统一在已转义的文本上做替换 */
function inlineReleaseMarkup(line: string): string {
  return escapeReleaseHtml(line)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // [文字](链接)：WebView 内点击链接可控性差，降级成「文字（链接）」纯文本
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1（$2）");
}

/**
 * 更新日志的轻量 Markdown → HTML（标题 / 列表 / 粗体 / 行内代码 / 段落 / 分隔线）。
 * 只给 v-html 用，所以每个分支都基于已转义文本，不引入任何未转义内容。
 */
export function renderReleaseMarkdown(text: string): string {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const openList = (tag: "ul" | "ol") => {
    if (listTag !== tag) {
      closeList();
      out.push(`<${tag}>`);
      listTag = tag;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      // GitHub Release 正文的层级普遍偏低，整体下移两级更贴近弹窗排版
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inlineReleaseMarkup(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inlineReleaseMarkup(bullet[1])}</li>`);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      openList("ol");
      out.push(`<li>${inlineReleaseMarkup(ordered[1])}</li>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    closeList();
    // 引用标记（>）直接剥掉，保留文字
    out.push(`<p>${inlineReleaseMarkup(line.replace(/^>\s?/, ""))}</p>`);
  }
  closeList();
  return out.join("");
}

/** 保存界面语言（en / zh；空字符串 = 跟随系统） */
export function setLocale(locale: string): Promise<string> {
  return invoke<string>("set_locale", { locale });
}

/**
 * v1.2：开关「本地中文搜索与自动索引」（settings.json 的 enable_indexing）。
 * 开启 = Rust 立即在后台补建一次索引；关闭 = 本轮爬取立刻停下。
 */
export function setEnableIndexing(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_enable_indexing", { enabled });
}

/**
 * v1.2：开关「在线页的本地搜索框」（settings.json 的 enable_local_search）。
 * 纯界面开关：只影响入口是否显示，不碰索引数据。
 */
export function setEnableLocalSearch(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_enable_local_search", { enabled });
}

/**
 * v1.6：本地列表的视图偏好（"grid" 大图 / "list" 紧凑 + 卡片宽度）。
 * 后端只写 settings.json：viewMode 非法值当成 grid，cardSize 取整到 20 的倍数并夹进 160..=320。
 * 不触发重扫、不影响扫描结果，拖滑块时可以放心高频调用。
 */
export function setViewPrefs(viewMode: string, cardSize: number): Promise<AppSettings> {
  return invoke<AppSettings>("set_view_prefs", { viewMode, cardSize });
}

// ---------------- v2.2 / v2.3：界面主题与全局排版（前端 invoke 的唯一出口） ----------------

/** 界面主题："dark" 深色羊皮纸（默认）| "light" 明亮米白 */
export type UiTheme = "dark" | "light";

/**
 * 保存界面主题。后端只认 light，其余一律归一化成 dark，因此这里不做校验。
 * 调用时机：App.vue 里确认主题变化后写盘（写失败只提示，不回滚界面）。
 */
export function setTheme(theme: UiTheme): Promise<AppSettings> {
  return invoke<AppSettings>("set_theme", { theme });
}

/* ================= v2.4：三层排版（界面 / 正文阅读 / 卡片列表） =================
   三个层级各自的取值范围与 Rust 侧 models.rs 的常量一一对应；
   前端只负责把归一化后的值写到 <html> 的 CSS 变量上，settings.json 是唯一真源。 */

/** 界面字体种类：黑体（默认）/ 幼圆 / 跟随系统（v3.0 起不再提供微软雅黑与宋体） */
export type { UiFontFamily };

/** 字体种类可选项（顺序即下拉框顺序） */
export const UI_FONT_FAMILY_OPTIONS: readonly UiFontFamily[] = [
  "hei",
  "youyuan",
  "system",
] as const;
export const UI_FONT_FAMILY_DEFAULT: UiFontFamily = "hei";

/**
 * 字体种类 → CSS 变量引用（真正的字体栈定义在 style.css 的 --font-* 里）。
 * 这样 JS 只切换“用哪一套栈”，不需要在前端硬写字体名。
 */
export const FONT_FAMILY_VARS: Record<UiFontFamily, string> = {
  hei: "var(--font-hei)",
  youyuan: "var(--font-youyuan)",
  system: "var(--font-system)",
};

/** 全局缩放（百分比，80..=150，默认 100）—— 对应 CSS 变量 --global-scale */
export const GLOBAL_SCALE_MIN = 80;
export const GLOBAL_SCALE_MAX = 150;
export const GLOBAL_SCALE_STEP = 5;
export const GLOBAL_SCALE_DEFAULT = 100;

/** 正文基准字号（px，12..=24，默认 14）—— 对应 --reader-font-size */
export const READER_FONT_SIZE_MIN = 12;
export const READER_FONT_SIZE_MAX = 24;
export const READER_FONT_SIZE_DEFAULT = 14;

/** 正文行距三档：紧凑 / 标准 / 宽松 —— 对应 --reader-line-height */
export const READER_LINE_HEIGHT_OPTIONS = [1.4, 1.6, 1.8] as const;
export const READER_LINE_HEIGHT_DEFAULT = 1.6;

/** 正文字重两档：常规 / 加粗 —— 对应 --reader-font-weight（v3.0 起 500 改为真加粗 700） */
export const READER_FONT_WEIGHT_OPTIONS = [400, 700] as const;
export const READER_FONT_WEIGHT_DEFAULT = 400;

/** 界面字重两档：常规 / 加粗 —— 对应 --ui-font-weight */
export const UI_FONT_WEIGHT_OPTIONS = [400, 700] as const;
export const UI_FONT_WEIGHT_DEFAULT = 400;

/** 卡片列表字号（px，10..=16，默认 12）—— 对应 --card-font-size */
export const CARD_FONT_SIZE_MIN = 10;
export const CARD_FONT_SIZE_MAX = 16;
export const CARD_FONT_SIZE_DEFAULT = 12;

/**
 * 字体种类归一化：只认 hei / youyuan / system。
 * v2.4 旧值静默改写："sans-serif" / "serif" → hei；"system-ui" → system（语义不变）。
 * 其余（含空串 / null）一律回黑体（默认）。
 */
export function normalizeUiFontFamily(value: unknown): UiFontFamily {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "youyuan") return "youyuan";
  if (raw === "system" || raw === "system-ui") return "system";
  return UI_FONT_FAMILY_DEFAULT;
}

/** 全局缩放夹进 80..=150 并取整（与 Rust 侧 clamp_global_font_scale 一致） */
export function clampGlobalScale(scale: number): number {
  if (!Number.isFinite(scale)) return GLOBAL_SCALE_DEFAULT;
  return Math.min(GLOBAL_SCALE_MAX, Math.max(GLOBAL_SCALE_MIN, Math.round(scale)));
}

/** 正文字号夹进 12..=24（与 Rust 侧 clamp_reader_font_size 一致） */
export function clampReaderFontSize(size: number): number {
  if (!Number.isFinite(size)) return READER_FONT_SIZE_DEFAULT;
  return Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, Math.round(size)));
}

/** 卡片字号夹进 10..=16（与 Rust 侧 clamp_card_font_size 一致） */
export function clampCardFontSize(size: number): number {
  if (!Number.isFinite(size)) return CARD_FONT_SIZE_DEFAULT;
  return Math.min(CARD_FONT_SIZE_MAX, Math.max(CARD_FONT_SIZE_MIN, Math.round(size)));
}

/** 正文行距取最近一档；非法值回默认（与 Rust 侧 normalize_reader_line_height 一致） */
export function normalizeReaderLineHeight(value: number): number {
  if (!Number.isFinite(value)) return READER_LINE_HEIGHT_DEFAULT;
  let best: number = READER_LINE_HEIGHT_DEFAULT;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of READER_LINE_HEIGHT_OPTIONS) {
    const diff = Math.abs(value - candidate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

/**
 * 正文字重归一化：只保留两档 400 / 700。
 * 阈值 600 —— v2.4 的 500（“偏粗”）会落回 400，避免老用户升级后界面突然变粗。
 */
export function normalizeReaderFontWeight(value: number): number {
  return Number(value) >= 600 ? 700 : 400;
}

/** 界面字重归一化：同样两档 400 / 700，阈值 600（见 normalizeReaderFontWeight） */
export function normalizeUiFontWeight(value: number): number {
  return Number(value) >= 600 ? 700 : 400;
}

/** 三层排版的完整快照（App.vue 持有，SettingsModal 双向绑定） */
export interface TypographyPrefs {
  fontFamily: UiFontFamily;
  uiFontWeight: number;
  globalScale: number;
  readerFontSize: number;
  readerLineHeight: number;
  readerFontWeight: number;
  cardFontSize: number;
}

/** 出厂默认值（与 Rust 侧 Settings::default()、style.css :root 完全一致） */
export const TYPOGRAPHY_DEFAULTS: TypographyPrefs = {
  fontFamily: UI_FONT_FAMILY_DEFAULT,
  uiFontWeight: UI_FONT_WEIGHT_DEFAULT,
  globalScale: GLOBAL_SCALE_DEFAULT,
  readerFontSize: READER_FONT_SIZE_DEFAULT,
  readerLineHeight: READER_LINE_HEIGHT_DEFAULT,
  readerFontWeight: READER_FONT_WEIGHT_DEFAULT,
  cardFontSize: CARD_FONT_SIZE_DEFAULT,
};

/** 把任意来源（settings.json / localStorage / 局部对象）归一化成合法快照 */
export function normalizeTypography(
  input: Partial<Record<keyof TypographyPrefs, unknown>> | null | undefined,
): TypographyPrefs {
  return {
    fontFamily: normalizeUiFontFamily(input?.fontFamily),
    uiFontWeight: normalizeUiFontWeight(Number(input?.uiFontWeight)),
    globalScale: clampGlobalScale(Number(input?.globalScale)),
    readerFontSize: clampReaderFontSize(Number(input?.readerFontSize)),
    readerLineHeight: normalizeReaderLineHeight(Number(input?.readerLineHeight)),
    readerFontWeight: normalizeReaderFontWeight(Number(input?.readerFontWeight)),
    cardFontSize: clampCardFontSize(Number(input?.cardFontSize)),
  };
}

/**
 * v2.4：批量保存三层排版。
 * 后端会把每个值再归一化一次（字体种类 / 缩放 / 正文 / 卡片 / 行距 / 字重），
 * 所以这里直接传当前值即可。调用时机：App.vue 在 300ms 无新操作后落盘。
 */
export function saveTypographyPrefs(prefs: TypographyPrefs): Promise<AppSettings> {
  return invoke<AppSettings>("save_typography_prefs", {
    uiFontFamily: prefs.fontFamily,
    uiFontWeight: prefs.uiFontWeight,
    globalFontScale: prefs.globalScale,
    readerFontSize: prefs.readerFontSize,
    readerLineHeight: prefs.readerLineHeight,
    readerFontWeight: prefs.readerFontWeight,
    cardFontSize: prefs.cardFontSize,
  });
}

export function candidateRoots(): Promise<string[]> {
  return invoke<string[]>("candidate_roots");
}

/** 首次启动引导：带来源说明的候选目录（注册表 / Steam 库 / 用户目录 / 全盘扫描） */
export function detectRootCandidates(): Promise<RootCandidate[]> {
  return invoke<RootCandidate[]>("detect_root_candidates");
}

export function scanMods(root?: string | null): Promise<ScanReport> {
  return invoke<ScanReport>("scan_mods", { root: root ?? null });
}

export function setModRoot(root: string): Promise<ScanReport> {
  return invoke<ScanReport>("set_mod_root", { root });
}

export function modStats(path: string): Promise<ModStats> {
  return invoke<ModStats>("mod_stats", { path });
}

export async function pickFolder(defaultPath?: string | null): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "选择 AoE2DE 模组根目录（应包含 local 与 subscribed）",
    defaultPath: defaultPath ?? undefined,
  });
  return typeof picked === "string" ? picked : null;
}

/** 把本地绝对路径转成 webview 可加载的 asset URL */
export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * 用系统默认浏览器打开外链（GitHub 主页等）。
 * 不经过 WebView，也不依赖 opener 插件：Rust 侧 explorer.exe 拉起，
 * 域名白名单（github.com / ageofempires.com）与 https 强制在 Rust 里校验。
 */
export function openExternalUrl(url: string): Promise<string> {
  return invoke<string>("open_external", { url });
}

/** 在资源管理器中定位模组文件夹（Rust 侧 explorer.exe /select，无需额外插件） */
export function revealModFolder(path: string): Promise<void> {
  return invoke<void>("reveal_mod_folder", { path });
}

/**
 * 删除本地模组文件（不论来源）。后端先确认游戏未运行，再校验目标只能是
 * `<root>/<kind>/<folderName>` 的真实目录，只删那一个目录、清 mod-status.json 记录与分类元数据。
 * 不会动服务器订阅状态（官方订阅模组下次启动游戏会被重新下载）。
 */
export function deleteModFiles(
  kind: string,
  folderName: string,
  workshopId: number | null,
): Promise<DeleteReport> {
  return invoke<DeleteReport>("delete_mod_files", {
    kind,
    folderName,
    workshopId: workshopId && workshopId > 0 ? workshopId : null,
  });
}

/** 在线页用：本机已安装索引（WorkshopID → 目录/来源），不触发特征扫描 */
export function installedLocalIndex(): Promise<InstalledIndexEntry[]> {
  return invoke<InstalledIndexEntry[]>("installed_local_index");
}

// ---------------- v0.3 预设与批量恢复 ----------------

/** 读取预设列表（%APPDATA%\com.aoe2.modmanager\presets.json） */
export function listPresets(): Promise<Preset[]> {
  return invoke<Preset[]>("presets_list");
}

/** 保存当前启用状态；同名（忽略大小写）覆盖更新 */
export function savePreset(name: string, items: PresetItem[]): Promise<Preset> {
  return invoke<Preset>("preset_save", { name, items });
}

export function deletePreset(id: string): Promise<Preset[]> {
  return invoke<Preset[]>("preset_delete", { id });
}

/** 批量恢复：后端会检测游戏进程、备份 mod-status.json、只改 Enabled 并回读校验 */
export function applyPreset(id: string): Promise<ApplyReport> {
  return invoke<ApplyReport>("preset_apply", { id });
}

/**
 * 单条启用 / 禁用。后端先确认 AoE2DE_s.exe 未运行，再备份 → 只改 Enabled → 原子替换 → 回读校验。
 * kind 只能是 local / subscribed，folderName 必须是根目录下真实存在的模组文件夹。
 */
// ---------------- v0.2：手动拖拽排序 ----------------

/**
 * 把拖拽后的顺序写进 mod-status.json 的 Priority（1..n 连续、不重复）。
 * `ordered` 是 ModEntry.id 数组（`local:目录名`），不是 WorkshopID——本地模组的 WorkshopID 常为 0。
 * 后端依次：游戏进程检测 → 备份 → 只改 Priority → 原子替换 → 回读校验（失败自动回滚）。
 */
export function updateModPriority(ordered: string[]): Promise<PriorityOutcome> {
  return invoke<PriorityOutcome>("update_mod_priority", { ordered });
}

export function toggleModEnabled(
  workshopId: number | null,
  kind: string,
  folderName: string,
  enabled: boolean,
): Promise<ToggleOutcome> {
  return invoke<ToggleOutcome>("toggle_mod_enabled", {
    workshopId: workshopId && workshopId > 0 ? workshopId : null,
    kind,
    folderName,
    enabled,
  });
}

/**
 * 批量启用 / 禁用当前筛选出的列表。
 * 后端整个批次只写一次盘（一次进程检测 → 一份备份 → 一次原子替换 → 一次回读校验），
 * 因此不会出现“前面改了、后面没改”的部分成功；未在 mod-status.json 登记的条目
 * 会被跳过并计入 notInStatus，而不是让整批失败。
 */
export function batchToggleMods(
  enable: boolean,
  targets: BatchTarget[],
): Promise<BatchToggleReport> {
  return invoke<BatchToggleReport>("batch_toggle_mods", { enable, targets });
}

// ---------------- v0.5：模组收藏与自定义备注 ----------------

/** 读取 %APPDATA%\com.aoe2.modmanager\user_data.json（不存在时返回空表） */
export function loadUserData(): Promise<UserDataStore> {
  return invoke<UserDataStore>("load_user_data");
}

/** 覆盖写入整份 user_data.json；Rust 侧写前会备份旧文件 */
export function saveUserData(data: UserDataStore): Promise<SaveUserDataReport> {
  return invoke<SaveUserDataReport>("save_user_data", { data });
}
