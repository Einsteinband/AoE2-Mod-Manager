import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ApplyReport,
  AppSettings,
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
 * 批量检查本地模组是否有新版本。
 * 后端只用官方 /Installed（每页 50 条）翻页比对，绝不逐个请求 Detail，
 * 需要已登录《帝国时代》账号。
 */
export function checkModUpdates(): Promise<ModUpdateReport> {
  return invoke<ModUpdateReport>("check_mod_updates");
}

/** 保存界面语言（en / zh；空字符串 = 跟随系统） */
export function setLocale(locale: string): Promise<string> {
  return invoke<string>("set_locale", { locale });
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

// ---------------- v0.5：模组收藏与自定义备注 ----------------

/** 读取 %APPDATA%\com.aoe2.modmanager\user_data.json（不存在时返回空表） */
export function loadUserData(): Promise<UserDataStore> {
  return invoke<UserDataStore>("load_user_data");
}

/** 覆盖写入整份 user_data.json；Rust 侧写前会备份旧文件 */
export function saveUserData(data: UserDataStore): Promise<SaveUserDataReport> {
  return invoke<SaveUserDataReport>("save_user_data", { data });
}
