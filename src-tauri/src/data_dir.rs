//! v1.x：统一「数据与缓存总目录」+ 一键安全迁移。
//!
//! 心智模型：整个应用的持久化数据（图片缓存、在线缓存、索引、译文、收藏、预设、
//! 下载队列、DPAPI 会话凭证）共用一个根目录。默认是 `%APPDATA%\com.aoe2.modmanager`，
//! 用户可以把它整个搬到别的磁盘来释放 C 盘空间。
//!
//! 两条硬约束：
//! 1. `settings.json` **永远留在默认位置**——它就是"总目录在哪"的锚点，
//!    跟着搬会变成「要读配置才知道配置在哪」的死循环。
//! 2. 迁移必须「先校验 → 再移动 → 失败全量回滚」，任何一步失败都不能留下半套数据
//!    （半套 = 图片在新盘、索引在旧盘，用户看到的是空列表 + 全部重新下载）。
//!
//! 关于 session.bin（Windows DPAPI）：blob 里不含文件路径，密钥由当前用户 SID 派生，
//! 所以搬迁**不需要**重新加解密。但跨卷不能 rename，且复制必须「临时名 → 校验 → 原子改名」，
//! 否则半截 blob 会让 `secure::load` 判定损坏并当场删文件（用户表现为静默掉登录）。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

/// 迁移白名单：只搬这些顶层条目（目录 / 文件混排）。
/// 新增持久化文件时必须显式加进来——白名单制，绝不遍历整个配置目录
/// （用户可能往配置目录里丢过自己的杂物，不能一起搬走）。
const MOVABLE: &[&str] = &[
    "image_cache",            // images::DIR_NAME
    "backups",                // presets::BACKUP_DIR
    "online_cache.json",      // cache::FILE_NAME
    "online_index.json",      // online_index::FILE_NAME
    "translation_cache.json", // translator::FILE_NAME
    "online_titles_zh.json",  // translator::TITLE_FILE_NAME
    "translate_config.json",  // translator::CONFIG_FILE
    "mod_metadata.json",      // metadata::FILE_NAME
    "user_data.json",         // user_data::FILE_NAME
    "presets.json",           // presets::FILE_NAME
    "download_queue.json",    // download_queue::FILE_NAME
    "session.bin",            // settings::session_cache_for（DPAPI 加密）
];

/// 进程内的「总目录」快照。
/// 外层 `None` = 还没从 settings.json 载入过；内层 `None` = 用户没自定义（用默认）。
/// 为什么要快照：cache.rs 的命中是微秒级内存查找，每次读写都读一遍 settings.json
/// 会把「内存优先」退化成磁盘 IO。
static DATA_DIR_OVERRIDE: Mutex<Option<Option<String>>> = Mutex::new(None);

/// 迁移进行中的标记：为 true 时缓存写入不落盘（内存态照常），
/// 避免「文件已经搬到新盘、写入又落回旧盘」产生双写脏数据。
static MIGRATING: Mutex<bool> = Mutex::new(false);

/// 迁移是否正在进行（cache.rs / translator.rs 等写入方可以据此跳过落盘）
pub fn is_migrating() -> bool {
    *MIGRATING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_migrating(flag: bool) {
    let mut guard = MIGRATING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = flag;
}

/// 目录「能不能用」：必须真实存在且是文件夹。
/// 配置里写坏的路径、被手动删掉的目录、没插上的移动硬盘，一律当作「没配」。
fn usable(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn path_text(path: &Path) -> String {
    let mut text = path.display().to_string().replace('/', "\\");
    // 保留盘符根的 "D:\"，只去掉多余的分隔符
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    text
}

fn same_path(a: &Path, b: &Path) -> bool {
    path_text(a).eq_ignore_ascii_case(&path_text(b))
}

/// child 是否是 parent 的真子目录（防「迁到自己里面」导致无限复制）
fn is_inside(child: &Path, parent: &Path) -> bool {
    let child = path_text(child).to_ascii_lowercase();
    let parent = path_text(parent).to_ascii_lowercase();
    if child == parent {
        return false;
    }
    let prefix = if parent.ends_with('\\') {
        parent
    } else {
        format!("{parent}\\")
    };
    child.starts_with(&prefix)
}

/// 默认位置：`%APPDATA%\<bundleId>`（Tauri 的 app_config_dir）
pub fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

fn configured(app: &tauri::AppHandle) -> Option<String> {
    let mut guard = DATA_DIR_OVERRIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(crate::settings::load_for_app(app).data_dir);
    }
    guard.clone().flatten()
}

/// 从 settings.json 重新载入快照（迁移成功后 / 设置变更后调用）
pub fn refresh(app: &tauri::AppHandle) {
    let fresh = crate::settings::load_for_app(app).data_dir;
    let mut guard = DATA_DIR_OVERRIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(fresh);
}

/// 用户是否真的设了可用总目录（配了但目录不存在 = false）
pub fn is_configured(app: &tauri::AppHandle) -> bool {
    configured(app).and_then(|raw| usable(&raw)).is_some()
}

/// **数据目录的唯一入口**：读配置优先，回退默认。
/// 所有持久化路径都必须经过这里，禁止再直接调 `app_config_dir()`
/// （`settings.json` 本身是唯一例外，它就是锚点）。
pub fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(raw) = configured(app) {
        if let Some(dir) = usable(&raw) {
            return Ok(dir);
        }
        log::warn!(
            target: "data-dir",
            "配置的数据目录不可用（{raw}），本次回退默认位置"
        );
    }
    default_root(app)
}

// ---------------- 体积统计 ----------------

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0; // 不跟链接，避免目录环
    }
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            total = total.saturating_add(size_of(&entry.path()));
        }
    }
    total
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DataDirView {
    /// 当前实际生效的目录（配置可用就是配置的，否则是默认的）
    pub path: String,
    /// 默认目录（`%APPDATA%\<bundleId>`）
    pub default_path: String,
    /// true = 用户自定义且正在生效
    pub is_custom: bool,
    pub exists: bool,
    /// 总占用（白名单条目合计）
    pub total_bytes: u64,
    /// 其中图片缓存占用
    pub images_bytes: u64,
    /// true = settings.json 里还留着旧版「三类分目录」配置（迁移后会被清空）
    pub legacy: bool,
}

pub fn empty_view() -> DataDirView {
    DataDirView {
        path: String::new(),
        default_path: String::new(),
        is_custom: false,
        exists: false,
        total_bytes: 0,
        images_bytes: 0,
        legacy: false,
    }
}

pub fn view(app: &tauri::AppHandle) -> DataDirView {
    let default_path = default_root(app).map(|p| path_text(&p)).unwrap_or_default();
    let root = data_root(app).unwrap_or_else(|_| PathBuf::from(&default_path));
    let is_custom = is_configured(app);
    let exists = root.is_dir();

    let mut total = 0u64;
    if exists {
        for name in MOVABLE {
            total = total.saturating_add(size_of(&root.join(name)));
        }
    }
    let settings = crate::settings::load_for_app(app);
    let legacy = settings.image_cache_dir.is_some()
        || settings.mod_info_cache_dir.is_some()
        || settings.translation_cache_dir.is_some();

    DataDirView {
        path: path_text(&root),
        default_path,
        is_custom,
        exists,
        total_bytes: total,
        images_bytes: size_of(&root.join("image_cache")),
        legacy,
    }
}

// ---------------- 迁移 ----------------

/// 目标目录体检：绝对路径、不是文件、能建、实测可写。
/// 只读盘、exFAT 只读挂载、无权限目录（Program Files 根、系统盘根）都能当场测出来，
/// 不会等用户写了几百条缓存之后才失败。
fn prepare_target(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("目录路径不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("请选择完整路径（如 D:\\AoE2Data）：{trimmed}"));
    }
    if path.is_file() {
        return Err(format!("这个路径是一个文件，不是文件夹：{trimmed}"));
    }
    fs::create_dir_all(&path).map_err(|e| format!("无法创建目录 {trimmed}：{e}"))?;

    let probe = path.join(format!(".aoe2mm-write-test-{}.tmp", std::process::id()));
    let written = fs::write(&probe, b"ok");
    let _ = fs::remove_file(&probe);
    written.map_err(|e| format!("目标目录不可写（{trimmed}）：{e}"))?;
    Ok(path)
}

fn tmp_path_for(to: &Path) -> Result<PathBuf, String> {
    let name = to
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("目标路径没有文件名：{}", to.display()))?;
    Ok(to.with_file_name(format!(".{name}.aoe2mm-migrating")))
}

fn remove_any(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("创建目录失败 {}：{e}", to.display()))?;
    let entries = fs::read_dir(from).map_err(|e| format!("读取目录失败 {}：{e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("枚举目录失败 {}：{e}", from.display()))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let meta =
            fs::symlink_metadata(&src).map_err(|e| format!("读取 {} 信息失败：{e}", src.display()))?;
        if meta.file_type().is_symlink() {
            // 缓存目录里不该有符号链接；遇到就跳过，绝不跟随（否则可能递归成环）
            log::warn!(target: "data-dir", "跳过符号链接：{}", src.display());
            continue;
        }
        if meta.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败：{e}", src.display()))?;
        }
    }
    Ok(())
}

/// (文件数, 总字节)：跨卷复制后的完整性核对依据
fn tree_stat(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return (0, 0);
    };
    if meta.file_type().is_symlink() {
        return (0, 0);
    }
    if meta.is_file() {
        return (1, meta.len());
    }
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let (f, b) = tree_stat(&entry.path());
            files += f;
            bytes = bytes.saturating_add(b);
        }
    }
    (files, bytes)
}

/// 移动一个顶层条目。
///
/// 同卷：`rename` 是原子操作，一步到位，不产生第二份数据。
/// 跨卷：Windows 的 `rename` 会以 `ERROR_NOT_SAME_DEVICE(17)` 失败，只能
/// `copy → 校验 → 原子改名 → 删旧`。**绝不能直接 copy 到正式文件名**：
/// 中途失败（磁盘满 / 拔盘）会在目标留下半截文件，对 session.bin 是致命的
/// （半截 DPAPI blob 解不开，`secure::load` 会当场把文件删掉）。
fn move_entry(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    // 快路径：同一个卷
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }

    let tmp = tmp_path_for(to)?;
    let _ = remove_any(&tmp);

    if from.is_dir() {
        copy_dir(from, &tmp)?;
        let src = tree_stat(from);
        let dst = tree_stat(&tmp);
        if src != dst {
            let _ = remove_any(&tmp);
            return Err(format!(
                "复制后目录内容不一致（{} 个文件 / {} 字节 → {} 个文件 / {} 字节），已放弃",
                src.0, src.1, dst.0, dst.1
            ));
        }
    } else {
        fs::copy(from, &tmp).map_err(|e| format!("复制到新目录失败：{e}"))?;
        let src = fs::metadata(from)
            .map_err(|e| format!("读取源文件信息失败：{e}"))?
            .len();
        let dst = fs::metadata(&tmp)
            .map_err(|e| format!("读取目标文件信息失败：{e}"))?
            .len();
        if src != dst {
            let _ = remove_any(&tmp);
            return Err(format!("复制后大小不一致（{src} → {dst}），已放弃"));
        }
    }

    fs::rename(&tmp, to).map_err(|e| {
        let _ = remove_any(&tmp);
        format!("目标目录改名失败：{e}")
    })?;

    // 旧副本删不掉不算迁移失败：数据已经完整落在新目录，只是多占一份空间。
    if let Err(e) = remove_any(from) {
        log::warn!(
            target: "data-dir",
            "旧副本删除失败（{}）：{e}，可手动删除",
            from.display()
        );
    }
    Ok(())
}

/// 反向把已移动的条目搬回去；返回回滚失败的条目名（空 = 全部回滚成功）
fn rollback(moved: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut failed = Vec::new();
    for (from, to) in moved.iter().rev() {
        if let Err(e) = move_entry(to, from) {
            log::error!(
                target: "data-dir",
                "回滚失败：{} → {}：{e}",
                to.display(),
                from.display()
            );
            let name = to
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| to.display().to_string());
            failed.push(format!("{name}（{e}）"));
        }
    }
    failed
}

fn migration_error(step: &str, err: &str, rollback_failed: &[String]) -> String {
    if rollback_failed.is_empty() {
        format!("迁移失败，已回滚（{step}）：{err}")
    } else {
        format!(
            "迁移失败，部分回滚未完成（{step}）：{err}。以下条目仍留在新目录，请手动移回：{}",
            rollback_failed.join("、")
        )
    }
}

/// 把新的图片目录加进 asset 协议白名单。
///
/// 病灶：tauri.conf.json 的 `assetProtocol.scope` 是空的，白名单只能在运行时放行；
/// 迁移换了目录后如果还指着旧的 image_cache，前端所有 `asset:` 封面图会全部裂开。
/// 这里显式补一次（`images::allow_scope` 内部也会做，双保险）。
fn allow_images_scope(app: &tauri::AppHandle, dir: &Path) {
    let _ = fs::create_dir_all(dir);
    match app.asset_protocol_scope().allow_directory(dir, true) {
        Ok(()) => log::info!(
            target: "image-cache",
            "asset 协议已放行新图片目录：{}",
            dir.display()
        ),
        Err(e) => log::warn!(
            target: "image-cache",
            "放行新图片目录失败（{}）：{e}",
            dir.display()
        ),
    }
}

/// 迁移到新目录：校验 → 移动 → 落盘配置 → 刷新内存与 asset 白名单。
/// 任何一步失败都回滚已移动的条目，并返回可直接展示给用户的中文原因。
pub fn migrate(app: &tauri::AppHandle, new_path: &str) -> Result<DataDirView, String> {
    let old_root = data_root(app)?;
    let new_root = prepare_target(new_path)?;

    if same_path(&old_root, &new_root) {
        return Err("目标目录就是当前的数据目录，无需迁移".to_string());
    }
    if is_inside(&new_root, &old_root) || is_inside(&old_root, &new_root) {
        return Err("目标目录不能是当前数据目录的子目录或上级目录".to_string());
    }

    // ---- 1) 计划 + 预检：目标不能已存在同名条目 ----
    let mut plan: Vec<(&'static str, PathBuf, PathBuf)> = Vec::new();
    for name in MOVABLE {
        let from = old_root.join(name);
        if !from.exists() {
            continue;
        }
        let to = new_root.join(name);
        if to.exists() {
            return Err(format!(
                "目标目录里已存在同名条目：{name}。请换一个空文件夹，或先把它改名 / 删除。"
            ));
        }
        plan.push((name, from, to));
    }

    // ---- 2) 移动 + 记账 ----
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    set_migrating(true);
    for (name, from, to) in &plan {
        if let Err(e) = move_entry(from, to) {
            let failed = rollback(&moved);
            set_migrating(false);
            return Err(migration_error(name, &e, &failed));
        }
        moved.push((from.clone(), to.clone()));
    }

    // ---- 3) 落盘配置（写配置失败同样必须回滚）----
    let mut settings = crate::settings::load_for_app(app);
    settings.data_dir = Some(path_text(&new_root));
    // 旧的三类分目录会抢优先级，必须一起清掉，
    // 否则会出现「总目录显示 D 盘、图片其实还写在旧盘」的鬼状态
    settings.image_cache_dir = None;
    settings.mod_info_cache_dir = None;
    settings.translation_cache_dir = None;
    if let Err(e) = crate::settings::save_for_app(app, &settings) {
        let failed = rollback(&moved);
        set_migrating(false);
        return Err(migration_error("写入 settings.json", &e, &failed));
    }

    // ---- 4) 生效：内存快照 + asset 协议白名单 ----
    refresh(app);
    // 必须是新的图片目录：迁移后白名单还指着旧目录的话，封面会整片裂开
    let new_images_dir = new_root.join(crate::images::DIR_NAME);
    allow_images_scope(app, &new_images_dir);
    crate::images::allow_scope(app);
    set_migrating(false);

    log::info!(
        target: "data-dir",
        "数据目录已迁移：{} → {}",
        old_root.display(),
        new_root.display()
    );
    Ok(view(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aoe2mm-data-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_compare_normalizes_case_and_separator() {
        let a = Path::new(r"D:\AoE2\Cache\");
        let b = Path::new(r"d:/aoe2/cache");
        assert!(same_path(a, b));
        assert!(!same_path(Path::new(r"D:\AoE2"), Path::new(r"D:\AoE2Cache")));
        assert!(is_inside(Path::new(r"D:\AoE2\sub"), Path::new(r"D:\AoE2")));
        assert!(!is_inside(Path::new(r"D:\AoE2Cache"), Path::new(r"D:\AoE2")));
    }

    #[test]
    fn move_entry_moves_file_and_directory() {
        let root = temp_dir("move");
        let src = root.join("src");
        let dst = root.join("dst");
        fs::create_dir_all(src.join("image_cache")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("session.bin"), b"dpapi-blob").unwrap();
        fs::write(src.join("image_cache").join("1.jpg"), b"jpg").unwrap();

        move_entry(&src.join("session.bin"), &dst.join("session.bin")).unwrap();
        assert!(!src.join("session.bin").exists());
        assert_eq!(fs::read(dst.join("session.bin")).unwrap(), b"dpapi-blob");

        move_entry(&src.join("image_cache"), &dst.join("image_cache")).unwrap();
        assert!(!src.join("image_cache").exists());
        assert_eq!(tree_stat(&dst.join("image_cache")), (1, 3));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_puts_everything_back() {
        let root = temp_dir("rollback");
        let src = root.join("src");
        let dst = root.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.json"), b"1").unwrap();
        fs::write(src.join("b.bin"), b"2").unwrap();

        let mut moved = Vec::new();
        for name in ["a.json", "b.bin"] {
            move_entry(&src.join(name), &dst.join(name)).unwrap();
            moved.push((src.join(name), dst.join(name)));
        }
        assert!(rollback(&moved).is_empty());
        assert!(src.join("a.json").exists());
        assert!(src.join("b.bin").exists());
        assert!(!dst.join("a.json").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
