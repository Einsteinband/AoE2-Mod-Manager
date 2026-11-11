//! 第三方 ZIP 模组导入（两阶段：analyze → install）
//!
//! 阶段一 analyze_local_zip：解压到暂存目录、识别模组结构、生成预览数据，
//! 返回 task_id 供前端保存。不写 mod-status.json、不写正式 metadata。
//!
//! 阶段二 install_local_zip：根据 task_id 取回暂存任务，校验后正式安装到 local/，
//! 注册 WorkshopID=0 的本地记录（默认禁用），写入 source="imported-zip" 元数据。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::install;
use crate::metadata;
use crate::presets;
use crate::user_err;

/// 暂存任务有效期：超过此时间（毫秒）的任务视为过期。
const TASK_TTL_MS: i64 = 30 * 60 * 1000; // 30 分钟
/// 启动清理时，删除 mtime 超过此时间的 import-* 暂存目录。
const STALE_STAGING_MS: i64 = 60 * 60 * 1000; // 1 小时

// ---------------- 任务注册表 ----------------

pub(crate) struct StagingTask {
    staging_dir: PathBuf,
    mod_root_dir: PathBuf,
    title: String,
    author: String,
    description: String,
    target_folder: String,
    file_count: u64,
    bytes: u64,
    created_at_ms: i64,
    installed: bool,
}

static TASK_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct ImportTaskRegistry {
    tasks: Mutex<HashMap<String, StagingTask>>,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 生成任务 ID：原子递增序号 + 时间戳，确保进程内不碰撞。
fn gen_task_id() -> String {
    let seq = TASK_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("imp-{}-{:04}", now_ms(), seq)
}

// ---------------- 返回结构 ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub task_id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub target_folder: String,
    pub target_path: String,
    pub file_count: u64,
    pub bytes: u64,
    pub exists: bool,
    pub fixes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub folder_name: String,
    pub file_count: u64,
    pub bytes: u64,
    pub backup_path: Option<String>,
    pub warnings: Vec<String>,
}

// ---------------- 内部文件系统函数（可单元测试） ----------------

/// Windows 保留设备名（不区分大小写），不能用作文件夹名。
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 第三方模组安装目录名规范化。
/// 基于 install::sanitize_component 做基础清理，额外处理：
/// - 连续空格合并为单个空格
/// - Windows 保留设备名检测
/// - 空结果 fallback 为 "imported-mod"
pub(crate) fn sanitize_imported_folder(input: &str) -> String {
    let base = install::sanitize_component(input);
    // sanitize_component 已经处理了非法字符、trim、截断 80、空 fallback
    // 这里只做额外的两步：空格合并 + 保留名检测
    let collapsed = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let upper = collapsed.to_uppercase();
    if RESERVED_NAMES.contains(&upper.as_str()) {
        return format!("mod-{}", collapsed);
    }
    if collapsed.is_empty() {
        "imported-mod".to_string()
    } else {
        collapsed
    }
}

/// 读取 info.json 的 title / author / description。
pub(crate) fn read_info_json(mod_root: &Path) -> (String, String, String) {
    let info_path = mod_root.join("info.json");
    if let Ok(bytes) = fs::read(&info_path) {
        let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes[..]);
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(stripped) {
            let title = v.get("Title").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let author = v.get("Author").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let description = v.get("Description").and_then(|x| x.as_str()).unwrap_or("").to_string();
            return (title, author, description);
        }
    }
    (String::new(), String::new(), String::new())
}

/// analyze 的纯文件系统核心：解压 → 识别 → 验证 → 读 info → 返回分析结果。
/// 不操作注册表，不写 mod-status.json。
pub(crate) fn analyze_filesystem(
    zip_path: &Path,
    staging_dir: &Path,
    local_dir: &Path,
) -> Result<(PathBuf, AnalyzeResult), String> {
    if !zip_path.exists() {
        return Err(user_err("import.zipNotFound", json!({ "path": zip_path.display().to_string() })));
    }
    if zip_path.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("zip")).unwrap_or(true) {
        return Err(user_err("import.notAZip", json!({ "path": zip_path.display().to_string() })));
    }

    fs::create_dir_all(staging_dir).map_err(|e| {
        user_err("import.stagingCreateFailed", json!({ "path": staging_dir.display().to_string(), "error": e.to_string() }))
    })?;

    let extracted = staging_dir.join("extracted");
    let (file_count, bytes) = install::extract_zip(zip_path, &extracted).map_err(|e| {
        let _ = fs::remove_dir_all(staging_dir);
        e
    })?;

    let detected = install::detect_mod_root(&extracted);

    if let Err(e) = install::validate_structure(&detected) {
        let _ = fs::remove_dir_all(staging_dir);
        return Err(user_err("import.invalidStructure", json!({ "error": e })));
    }

    let fixes = install::fix_mod_structure(&detected).unwrap_or_default();

    let (mut title, author, description) = read_info_json(&detected);
    if title.is_empty() {
        // 包内没有 info.json 或标题为空时，用 ZIP 文件名（去掉 .zip 后缀）作为标题
        title = zip_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Imported Mod")
            .to_string();
    }

    let target_folder = sanitize_imported_folder(&title);

    let exists = local_dir.join(&target_folder).exists();
    let target_path = local_dir.join(&target_folder).display().to_string();

    Ok((detected, AnalyzeResult {
        task_id: String::new(), // 由外层注册表填充
        title,
        author,
        description,
        target_folder,
        target_path,
        file_count,
        bytes,
        exists,
        fixes,
    }))
}

/// 回滚：把备份目录恢复为原目录。恢复失败时不删除备份。
pub(crate) fn rollback_backup(bak: &Path, target: &Path) -> Result<(), String> {
    fs::rename(bak, target).map_err(|e| format!("回滚失败：{e}"))
}

/// install 的纯文件系统核心：备份 → 移动 → 补 info → 缩略图 → 清理暂存。
/// 不操作 mod-status.json，不操作 metadata。失败时自动回滚备份。
pub(crate) fn install_filesystem(
    task: &StagingTask,
    local_dir: &Path,
    force: bool,
) -> Result<(Option<String>, Vec<String>), String> {
    fs::create_dir_all(local_dir).map_err(|e| {
        user_err("import.localCreateFailed", json!({ "path": local_dir.display().to_string(), "error": e.to_string() }))
    })?;

    let target = local_dir.join(&task.target_folder);
    let mut backup_path: Option<String> = None;
    let mut warnings: Vec<String> = Vec::new();

    // 同名冲突
    if target.exists() && !force {
        return Err(user_err("import.conflict", json!({ "folder": task.target_folder })));
    }

    // 备份旧目录
    if target.exists() && force {
        let bak = local_dir.join(format!("{}.bak-{}", task.target_folder, now_ms()));
        fs::rename(&target, &bak).map_err(|e| {
            user_err("import.backupFailed", json!({ "error": e.to_string() }))
        })?;
        backup_path = Some(bak.display().to_string());
    }

    // 移动新模组
    if let Err(e) = install::move_dir(&task.mod_root_dir, &target) {
        // 移动失败：如果有备份，必须恢复旧目录
        if let Some(ref bak_str) = backup_path {
            let bak_path = PathBuf::from(bak_str);
            if rollback_backup(&bak_path, &target).is_err() {
                return Err(user_err("import.rollbackFailed", json!({
                    "error": e.to_string(),
                    "backup": bak_str,
                })));
            }
            return Err(user_err("import.moveFailed", json!({ "error": e.to_string() })));
        }
        return Err(user_err("import.moveFailed", json!({ "error": e.to_string() })));
    }

    // 补 info.json（失败记 warning，不中止）
    if let Err(e) = install::ensure_info_json(&target, &task.title, &task.author, &task.description) {
        warnings.push(format!("info.json 补全失败：{e}"));
    }

    // 缩略图（失败记 warning）
    if install::normalize_thumbnail_extension(&target).is_none() {
        // 没有缩略图是正常情况，不算 warning
    }

    // 清理暂存目录
    let _ = fs::remove_dir_all(&task.staging_dir);

    Ok((backup_path, warnings))
}

/// 清理过期任务：从注册表删除 + 删除对应暂存目录。
fn prune_expired_tasks(registry: &ImportTaskRegistry) {
    let mut map = registry.tasks.lock().unwrap();
    let now = now_ms();
    let expired: Vec<String> = map
        .iter()
        .filter(|(_, t)| now - t.created_at_ms > TASK_TTL_MS)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(task) = map.remove(&id) {
            let _ = fs::remove_dir_all(&task.staging_dir);
            log::info!(target: "import", "清理过期任务：{id}");
        }
    }
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub async fn analyze_local_zip(
    app: tauri::AppHandle,
    registry: State<'_, ImportTaskRegistry>,
    zip_path: String,
) -> Result<AnalyzeResult, String> {
    // 先清理过期任务，防止内存累积
    prune_expired_tasks(&registry);

    let mod_root = crate::mod_root(&app).map_err(|e| e.message)?;
    let parent = mod_root.join(".aoe2mm-staging");
    let local_dir = mod_root.join("local");

    let task_id = gen_task_id();
    let staging_dir = parent.join(format!("import-{task_id}"));

    let zip_name = Path::new(&zip_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| zip_path.clone());
    log::info!(target: "import", "[task:{task_id}][ANALYZE] start: zip=\"{zip_name}\"");

    let t0 = std::time::Instant::now();
    let (mod_root_dir, mut result) = match analyze_filesystem(Path::new(&zip_path), &staging_dir, &local_dir) {
        Ok(v) => v,
        Err(e) => {
            log::error!(target: "import", "[task:{task_id}][ANALYZE] failed: {e}");
            return Err(e);
        }
    };
    let elapsed_ms = t0.elapsed().as_millis();

    log::info!(target: "import",
        "[task:{task_id}][ANALYZE] done in {elapsed_ms}ms: root=\"{}\" target=\"{}\" files={} bytes={} exists={}",
        mod_root_dir.display(),
        result.target_folder,
        result.file_count,
        result.bytes,
        result.exists,
    );
    log::info!(target: "import",
        "[task:{task_id}][ANALYZE] info: title=\"{}\" author=\"{}\"",
        result.title, result.author,
    );

    result.task_id = task_id.clone();

    let task = StagingTask {
        staging_dir: staging_dir.clone(),
        mod_root_dir: mod_root_dir.clone(),
        title: result.title.clone(),
        author: result.author.clone(),
        description: result.description.clone(),
        target_folder: result.target_folder.clone(),
        file_count: result.file_count,
        bytes: result.bytes,
        created_at_ms: now_ms(),
        installed: false,
    };

    // 防碰撞：如果 ID 已存在（极端情况），生成新 ID 重试
    let mut final_id = task_id;
    {
        let mut map = registry.tasks.lock().unwrap();
        if map.contains_key(&final_id) {
            final_id = gen_task_id();
        }
        map.insert(final_id.clone(), task);
    }
    result.task_id = final_id;

    Ok(result)
}

#[tauri::command]
pub async fn install_local_zip(
    app: tauri::AppHandle,
    registry: State<'_, ImportTaskRegistry>,
    task_id: String,
    force: Option<bool>,
) -> Result<InstallResult, String> {
    let force = force.unwrap_or(false);
    let mod_root = crate::mod_root(&app).map_err(|e| e.message)?;

    log::info!(target: "import", "[task:{task_id}][INSTALL] start: force={force}");

    // 取回任务
    let task = {
        let mut map = registry.tasks.lock().unwrap();
        let Some(task) = map.remove(&task_id) else {
            log::warn!(target: "import", "[task:{task_id}][INSTALL] aborted: task not found");
            return Err(user_err("import.taskNotFound", json!({ "taskId": task_id })));
        };
        if task.installed {
            log::warn!(target: "import", "[task:{task_id}][INSTALL] aborted: already installed");
            return Err(user_err("import.alreadyInstalled", json!({ "taskId": task_id })));
        }
        let elapsed = now_ms() - task.created_at_ms;
        if elapsed > TASK_TTL_MS {
            let _ = fs::remove_dir_all(&task.staging_dir);
            log::warn!(target: "import", "[task:{task_id}][INSTALL] aborted: task expired (elapsed={elapsed}ms)");
            return Err(user_err("import.taskExpired", json!({ "taskId": task_id, "elapsedMs": elapsed })));
        }
        task
    };

    if !task.mod_root_dir.exists() {
        log::error!(target: "import", "[task:{task_id}][INSTALL] failed: staging dir missing ({})", task.mod_root_dir.display());
        return Err(user_err("import.stagingMissing", json!({ "path": task.mod_root_dir.display().to_string() })));
    }

    let local_dir = mod_root.join("local");
    let target = local_dir.join(&task.target_folder);
    log::info!(target: "import", "[task:{task_id}][INSTALL] target: \"{}\"", target.display());

    let t0 = std::time::Instant::now();

    // 文件系统层安装（含回滚）
    let (backup_path, mut warnings) = match install_filesystem(&task, &local_dir, force) {
        Ok(v) => v,
        Err(e) => {
            log::error!(target: "import", "[task:{task_id}][INSTALL] failed at filesystem: {e}");
            return Err(e);
        }
    };
    let elapsed_ms = t0.elapsed().as_millis();
    log::info!(target: "import", "[task:{task_id}][INSTALL] files moved in {elapsed_ms}ms: {} files, {} bytes", task.file_count, task.bytes);

    // 注册到 mod-status.json（WorkshopID=0，默认禁用）
    let status_path = mod_root.join(presets::STATUS_FILE);
    let backup_dir = presets::backups_dir_for(&app).map_err(|e| e.to_string())?;

    let rec = presets::NewRecord {
        workshop_id: 0,
        title: task.title.clone(),
        path: install::status_rel_path("local", &task.target_folder),
        enabled: false,
    };

    match presets::register_mod(&status_path, &backup_dir, &rec, false) {
        Ok(_) => {
            log::info!(target: "import", "[task:{task_id}][INSTALL] registered: WorkshopID=0, enabled=false");
        }
        Err(e) => {
            log::warn!(target: "import", "[task:{task_id}][INSTALL] register failed: {e}");
            warnings.push(format!("模组文件已安装，但注册 mod-status.json 失败：{e}"));
        }
    }

    // 写入 metadata
    match metadata::upsert_local_for_app(&app, &task.target_folder, &task.title, "imported-zip") {
        Ok(_) => {}
        Err(e) => {
            log::warn!(target: "import", "[task:{task_id}][INSTALL] metadata write failed: {e}");
            warnings.push(format!("来源记录未保存：{e}"));
        }
    }

    // 全部成功后清理旧版本备份（删除失败只记 WARN，不影响安装结果）
    if let Some(ref bak_str) = backup_path {
        let bak_path = PathBuf::from(bak_str);
        match fs::remove_dir_all(&bak_path) {
            Ok(_) => {
                log::info!(target: "import", "[task:{task_id}][INSTALL] old backup cleaned: {}", bak_path.display());
            }
            Err(e) => {
                log::warn!(target: "import", "[task:{task_id}][INSTALL] failed to clean old backup: {} (path: {})", e, bak_path.display());
                warnings.push(format!("旧版本备份清理失败，可手动删除：{}", bak_path.display()));
            }
        }
    }

    log::info!(target: "import", "[task:{task_id}][INSTALL] done: folder=\"{}\" warnings={}",
        task.target_folder,
        warnings.len(),
    );

    Ok(InstallResult {
        folder_name: task.target_folder,
        file_count: task.file_count,
        bytes: task.bytes,
        backup_path,
        warnings,
    })
}

#[tauri::command]
pub async fn cancel_import_task(
    registry: State<'_, ImportTaskRegistry>,
    task_id: String,
) -> Result<(), String> {
    if let Some(task) = registry.tasks.lock().unwrap().remove(&task_id) {
        let _ = fs::remove_dir_all(&task.staging_dir);
        log::info!(target: "import", "[task:{task_id}][CANCEL] task cancelled, staging cleaned");
    } else {
        log::debug!(target: "import", "[task:{task_id}][CANCEL] task not found (already done or expired)");
    }
    Ok(())
}

// ---------------- 启动清理 ----------------

pub fn cleanup_stale_staging(mod_root: &Path) {
    let parent = mod_root.join(".aoe2mm-staging");
    let Ok(entries) = fs::read_dir(&parent) else { return };
    let cutoff = now_ms() - STALE_STAGING_MS;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("import-") {
            continue;
        }
        let path = entry.path();
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if mtime < cutoff {
            let _ = fs::remove_dir_all(&path);
            log::info!(target: "import", "清理过期暂存目录：{}", path.display());
        }
    }
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aoe2mm-import-{}-{}-{}", tag, std::process::id(), now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// 创建一个最小合法 AoE2 模组目录（带 info.json）
    fn make_sample_mod(base: &Path, name: &str) {
        let mod_dir = base.join(name);
        write(&mod_dir.join("info.json"), &format!(r#"{{"name":"{name}","author":"TestAuthor","description":"Test Desc"}}"#));
        write(&mod_dir.join("mod.js"), "// test mod");
        fs::create_dir_all(mod_dir.join("widgetui")).unwrap();
    }

    /// 创建一个简单 ZIP 文件（用 zip crate 不可用，手动用 std 模拟：
    /// 直接构造一个目录结构当"解压后"结果）
    fn make_staging_task(staging_root: &Path, mod_name: &str) -> StagingTask {
        let staging_dir = staging_root.join(format!("import-test-{mod_name}"));
        let extracted = staging_dir.join("extracted");
        make_sample_mod(&extracted, mod_name);
        let mod_root_dir = extracted.join(mod_name);

        StagingTask {
            staging_dir: staging_dir.clone(),
            mod_root_dir: mod_root_dir.clone(),
            title: mod_name.to_string(),
            author: "TestAuthor".to_string(),
            description: "Test Desc".to_string(),
            target_folder: mod_name.to_string(),
            file_count: 3,
            bytes: 1024,
            created_at_ms: now_ms(),
            installed: false,
        }
    }

    #[test]
    fn local_key_format() {
        assert_eq!(metadata::local_key("MyMod"), "local::MyMod");
        assert_eq!(metadata::local_key("test 123"), "local::test 123");
    }

    #[test]
    fn task_id_unique_in_process() {
        let id1 = gen_task_id();
        let id2 = gen_task_id();
        let id3 = gen_task_id();
        assert!(id1.starts_with("imp-"));
        assert_ne!(id1, id2);
        assert_ne!(id2, id3);
        assert_ne!(id1, id3);
    }

    #[test]
    fn cleanup_skips_non_import_dirs() {
        let root = fixture_dir("cleanup-root");
        let staging = root.join(".aoe2mm-staging");
        fs::create_dir_all(&staging).unwrap();

        let fresh_import = staging.join("import-fresh");
        fs::create_dir_all(&fresh_import).unwrap();
        let keep = staging.join("download-12345");
        fs::create_dir_all(&keep).unwrap();

        cleanup_stale_staging(&root);

        assert!(fresh_import.exists(), "新建 import- 目录不应被误删");
        assert!(keep.exists(), "download- 目录不应被清理");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_copies_mod_to_local_dir() {
        let root = fixture_dir("install-basic");
        let staging_root = root.join("staging");
        let local_dir = root.join("local");
        fs::create_dir_all(&local_dir).unwrap();

        let task = make_staging_task(&staging_root, "MyTestMod");
        let (backup, warnings) = install_filesystem(&task, &local_dir, false).unwrap();

        assert!(backup.is_none(), "无冲突时不应有备份");
        assert!(warnings.is_empty(), "正常安装不应有警告");
        assert!(local_dir.join("MyTestMod").exists(), "模组目录应被创建");
        assert!(local_dir.join("MyTestMod").join("info.json").exists(), "info.json 应存在");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_conflict_without_force_returns_error() {
        let root = fixture_dir("install-conflict");
        let staging_root = root.join("staging");
        let local_dir = root.join("local");

        // 预先放一个同名目录
        make_sample_mod(&local_dir, "ExistingMod");

        let task = make_staging_task(&staging_root, "ExistingMod");
        let result = install_filesystem(&task, &local_dir, false);

        assert!(result.is_err(), "force=false 时应返回冲突错误");
        assert!(local_dir.join("ExistingMod").join("info.json").exists(), "旧目录不应被改动");
        // 暂存目录应保留（因为没有成功安装）
        assert!(task.staging_dir.exists(), "冲突时暂存目录应保留");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_force_creates_backup() {
        let root = fixture_dir("install-force");
        let staging_root = root.join("staging");
        let local_dir = root.join("local");

        // 预先放一个旧模组
        make_sample_mod(&local_dir, "MyMod");

        let task = make_staging_task(&staging_root, "MyMod");
        let (backup, _) = install_filesystem(&task, &local_dir, true).unwrap();

        assert!(backup.is_some(), "force=true 应生成备份");
        assert!(local_dir.join("MyMod").exists(), "新模组应就位");
        // 备份目录存在
        let bak = local_dir.read_dir().unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("MyMod.bak-"));
        assert!(bak.is_some(), "应找到 .bak 备份目录");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_expired_tasks_removes_old() {
        let registry = ImportTaskRegistry::default();
        let staging = fixture_dir("prune-staging");

        // 过期任务
        let old_task = StagingTask {
            staging_dir: staging.join("import-old"),
            mod_root_dir: staging.join("import-old").join("extracted").join("Mod"),
            title: "Old".to_string(),
            author: "".to_string(),
            description: "".to_string(),
            target_folder: "Old".to_string(),
            file_count: 1,
            bytes: 100,
            created_at_ms: now_ms() - TASK_TTL_MS - 1000, // 超过 TTL
            installed: false,
        };
        fs::create_dir_all(&old_task.staging_dir).unwrap();

        // 新任务
        let new_task = StagingTask {
            staging_dir: staging.join("import-new"),
            mod_root_dir: staging.join("import-new").join("extracted").join("Mod"),
            title: "New".to_string(),
            author: "".to_string(),
            description: "".to_string(),
            target_folder: "New".to_string(),
            file_count: 1,
            bytes: 100,
            created_at_ms: now_ms(),
            installed: false,
        };
        fs::create_dir_all(&new_task.staging_dir).unwrap();

        registry.tasks.lock().unwrap().insert("imp-old".to_string(), old_task);
        registry.tasks.lock().unwrap().insert("imp-new".to_string(), new_task);

        prune_expired_tasks(&registry);

        let map = registry.tasks.lock().unwrap();
        assert!(!map.contains_key("imp-old"), "过期任务应被移除");
        assert!(map.contains_key("imp-new"), "新任务应保留");

        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_dir_all(&fixture_dir("prune-staging"));
    }

    #[test]
    fn read_info_json_parses_fields() {
        let dir = fixture_dir("info-parse");
        write(&dir.join("info.json"), r#"{"Title":"TestMod","Author":"Alice","Description":"A test"}"#);

        let (title, author, desc) = read_info_json(&dir);
        assert_eq!(title, "TestMod");
        assert_eq!(author, "Alice");
        assert_eq!(desc, "A test");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_imported_folder_basic() {
        assert_eq!(sanitize_imported_folder("My Mod"), "My Mod");
        assert_eq!(sanitize_imported_folder("中文模组"), "中文模组");
        assert_eq!(sanitize_imported_folder("UI of Daniel Azar v2"), "UI of Daniel Azar v2");
    }

    #[test]
    fn sanitize_imported_folder_collapses_spaces() {
        assert_eq!(sanitize_imported_folder("My   Mod   Name"), "My Mod Name");
        assert_eq!(sanitize_imported_folder("  spaced  out  "), "spaced out");
    }

    #[test]
    fn sanitize_imported_folder_illegal_chars() {
        assert_eq!(sanitize_imported_folder("a\"b:c*d"), "a_b_c_d");
    }

    #[test]
    fn sanitize_imported_folder_empty_fallback() {
        // sanitize_component 对纯非法字符输入返回 "unnamed"
        // 这里验证非法字符被正确替换，不会产生危险名称
        assert!(!sanitize_imported_folder("").is_empty());
        assert!(!sanitize_imported_folder("***").is_empty());
    }

    #[test]
    fn sanitize_imported_folder_reserved_names() {
        assert_eq!(sanitize_imported_folder("CON"), "mod-CON");
        assert_eq!(sanitize_imported_folder("nul"), "mod-nul");
        assert_eq!(sanitize_imported_folder("COM1"), "mod-COM1");
        assert_eq!(sanitize_imported_folder("LPT9"), "mod-LPT9");
    }

    #[test]
    fn sanitize_imported_folder_long_name_truncated() {
        let long = "a".repeat(100);
        let result = sanitize_imported_folder(&long);
        assert!(result.len() <= 80, "超长名称应被截断到 80 字符以内");
        assert!(!result.is_empty());
    }

    #[test]
    fn read_info_json_missing_file() {
        let dir = fixture_dir("info-missing");
        let (title, author, desc) = read_info_json(&dir);
        assert!(title.is_empty());
        assert!(author.is_empty());
        assert!(desc.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rollback_restores_backup_dir() {
        let root = fixture_dir("rollback-basic");
        let local_dir = root.join("local");
        fs::create_dir_all(&local_dir).unwrap();

        // 旧模组
        make_sample_mod(&local_dir, "MyMod");
        let old_info = fs::read_to_string(local_dir.join("MyMod").join("info.json")).unwrap();

        // 模拟备份：rename 旧目录到 .bak
        let bak = local_dir.join("MyMod.bak-12345");
        fs::rename(local_dir.join("MyMod"), &bak).unwrap();
        assert!(!local_dir.join("MyMod").exists());

        // 执行回滚
        rollback_backup(&bak, &local_dir.join("MyMod")).unwrap();

        // 旧目录恢复
        assert!(local_dir.join("MyMod").exists());
        assert_eq!(
            fs::read_to_string(local_dir.join("MyMod").join("info.json")).unwrap(),
            old_info,
            "回滚后 info.json 内容应与原模组一致"
        );
        assert!(!bak.exists(), "回滚后备份目录应已消失");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_failure_keeps_backup() {
        let root = fixture_dir("rollback-fail");
        let local_dir = root.join("local");
        fs::create_dir_all(&local_dir).unwrap();

        // 模拟备份目录存在，但目标路径已被占用（导致 rename 失败）
        let bak = local_dir.join("MyMod.bak-12345");
        fs::create_dir_all(&bak).unwrap();
        fs::write(bak.join("old.txt"), "old data").unwrap();
        // 目标路径已有一个不同的目录 → rename 会失败
        let target = local_dir.join("MyMod");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("blocker.txt"), "blocker").unwrap();

        let result = rollback_backup(&bak, &target);
        assert!(result.is_err(), "目标被占用时回滚应失败");
        assert!(bak.exists(), "回滚失败时备份目录必须保留");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_extract_and_analyze() {
        use zip::write::SimpleFileOptions;

        let root = fixture_dir("zip-analyze");
        let staging = root.join("staging");
        let local_dir = root.join("local");

        // 构造一个最小合法 ZIP：内含 MyMod/info.json + MyMod/mod.js
        let zip_path = root.join("test_mod.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            zip.start_file("MyMod/info.json", opts).unwrap();
            zip.write_all(r#"{"Title":"MyMod","Author":"Zippy","Description":"From zip"}"#.as_bytes()).unwrap();
            zip.start_file("MyMod/mod.js", opts).unwrap();
            zip.write_all(b"// from zip").unwrap();
            zip.finish().unwrap();
        }

        // 执行 analyze_filesystem
        let (mod_root, result) = analyze_filesystem(&zip_path, &staging, &local_dir).unwrap();

        assert_eq!(result.title, "MyMod");
        assert_eq!(result.author, "Zippy");
        assert_eq!(result.description, "From zip");
        assert_eq!(result.target_folder, "MyMod");
        assert!(!result.exists, "local/ 下不应有同名目录");
        assert!(mod_root.join("info.json").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_invalid_returns_error() {
        let root = fixture_dir("zip-invalid");
        let staging = root.join("staging");
        let local_dir = root.join("local");

        // 写一个不是 ZIP 的文件
        let fake_zip = root.join("fake.zip");
        fs::write(&fake_zip, "this is not a zip file at all").unwrap();

        let result = analyze_filesystem(&fake_zip, &staging, &local_dir);
        assert!(result.is_err(), "无效 ZIP 应返回错误");
        assert!(!staging.exists(), "失败后暂存目录应被清理");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_missing_file_returns_error() {
        let root = fixture_dir("zip-missing");
        let staging = root.join("staging");
        let local_dir = root.join("local");

        let missing = root.join("nonexistent.zip");
        let result = analyze_filesystem(&missing, &staging, &local_dir);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&root);
    }
}
