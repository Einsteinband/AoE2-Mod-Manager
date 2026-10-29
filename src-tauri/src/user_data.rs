use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::scan::now_ms;

/// 与 settings.json / mod_metadata.json / presets.json 同目录：
/// %APPDATA%\com.aoe2.modmanager\user_data.json
/// 独立文件，绝不写进游戏目录，也不与 settings / metadata 混存。
pub const FILE_NAME: &str = "user_data.json";
/// 自定义备注名上限（超出截断，避免一行字撑爆侧栏）
const MAX_NAME_LEN: usize = 60;
/// 历史备份上限：收藏切换很频繁，必须限量，否则 backups 目录会无限膨胀
const MAX_BACKUPS: usize = 20;

/// 单个模组的用户数据。key 只用 WorkshopID —— 模组卸载后这一条仍然保留。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModUserData {
    /// 自定义备注名；trim 后为空 = 没有备注
    #[serde(default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default = "default_version")]
    pub version: u32,
    /// key = WorkshopID 的字符串形式（"155009"）
    #[serde(default)]
    pub mods: BTreeMap<String, ModUserData>,
}

fn default_version() -> u32 {
    1
}

impl Default for Store {
    fn default() -> Self {
        Self { version: default_version(), mods: BTreeMap::new() }
    }
}

/// 写入结果：前端据此判断“是否真的落盘”，也便于日志排查
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub path: String,
    pub backup_path: Option<String>,
    /// 写入后的条目数（只留住收藏或备注，空条目会被丢弃）
    pub entry_count: usize,
    pub favorite_count: usize,
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

/// 读：文件不存在 / 损坏 / 带 BOM 都退回空表，绝不让界面因为一个坏文件打不开。
pub fn load(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut store = serde_json::from_slice::<Store>(stripped).unwrap_or_default();
    normalize(&mut store);
    store
}

pub fn load_for_app(app: &tauri::AppHandle) -> Store {
    match path_for(app) {
        Ok(path) => load(&path),
        Err(e) => {
            log::warn!(target: "user-data", "{e}");
            Store::default()
        }
    }
}

/// 只认纯数字 WorkshopID；既没收藏也没备注的条目直接丢掉，保证文件始终干净。
/// 备注名统一 trim 并按字符（不是字节）截断，中文不会被切坏。
pub fn normalize(store: &mut Store) {
    store.version = default_version();
    let mut cleaned: BTreeMap<String, ModUserData> = BTreeMap::new();
    for (key, mut value) in std::mem::take(&mut store.mods) {
        let key = key.trim().to_string();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        value.custom_name = value
            .custom_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.chars().take(MAX_NAME_LEN).collect::<String>());
        if value.is_favorite || value.custom_name.is_some() {
            cleaned.insert(key, value);
        }
    }
    store.mods = cleaned;
}

/// 写前备份：备份失败就中止写入（绝不出现“旧数据没了、新数据也没写进去”）。
fn backup_before_write(path: &Path, backup_dir: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("无法创建备份目录 {}：{e}", backup_dir.display()))?;

    let ms = now_ms();
    let mut target = backup_dir.join(format!("user_data-{ms}.json"));
    let mut suffix = 1;
    while target.exists() {
        target = backup_dir.join(format!("user_data-{ms}-{suffix}.json"));
        suffix += 1;
    }
    fs::copy(path, &target).map_err(|e| {
        format!(
            "备份 user_data.json 失败（{}），已中止，未修改任何内容：{e}",
            target.display()
        )
    })?;
    prune_backups(backup_dir);
    Ok(Some(target))
}

/// 只保留最近 MAX_BACKUPS 份 user_data 备份（按修改时间倒序）
fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(u128, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with("user_data-") && name.ends_with(".json")
        })
        .filter_map(|entry| {
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            Some((mtime, entry.path()))
        })
        .collect();
    if files.len() <= MAX_BACKUPS {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_file(path);
    }
}

/// 覆盖式写入整份 user_data.json：备份旧文件 → 写临时文件 → rename 原子替换。
/// 前端每次只改一条，但落盘时始终写完整快照，避免半截文件。
pub fn save(path: &Path, backup_dir: &Path, store: &Store) -> Result<SaveReport, String> {
    let mut cleaned = store.clone();
    normalize(&mut cleaned);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }

    let backup = backup_before_write(path, backup_dir)?;

    let text =
        serde_json::to_string_pretty(&cleaned).map_err(|e| format!("user_data 序列化失败：{e}"))?;
    let tmp_path = path.with_file_name(format!("{FILE_NAME}.aoe2mm-{}.tmp", now_ms()));
    if let Err(e) = fs::write(&tmp_path, text.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败：{e}"));
    }
    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("替换 user_data.json 失败：{e}"));
    }

    let favorite_count = cleaned.mods.values().filter(|m| m.is_favorite).count();
    log::info!(
        target: "user-data",
        "已写入 user_data.json：条目 {} 个（收藏 {}），备份 {:?}",
        cleaned.mods.len(),
        favorite_count,
        backup
    );
    Ok(SaveReport {
        path: path.to_string_lossy().to_string(),
        backup_path: backup.map(|p| p.to_string_lossy().to_string()),
        entry_count: cleaned.mods.len(),
        favorite_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(custom: Option<&str>, fav: bool) -> ModUserData {
        ModUserData { custom_name: custom.map(|s| s.to_string()), is_favorite: fav }
    }

    #[test]
    fn normalize_drops_empty_and_non_numeric_keys() {
        let mut store = Store::default();
        store.mods.insert("155009".into(), entry(Some("  日本音效  "), true));
        store.mods.insert("abc".into(), entry(Some("x"), false));
        store.mods.insert("7".into(), entry(Some("   "), false));
        store.mods.insert("8".into(), entry(None, true));
        normalize(&mut store);
        assert_eq!(store.mods.len(), 2);
        assert_eq!(store.mods.get("155009").unwrap().custom_name.as_deref(), Some("日本音效"));
        assert!(store.mods.contains_key("8"));
    }

    #[test]
    fn normalize_truncates_long_names() {
        let mut store = Store::default();
        store.mods.insert("1".into(), entry(Some(&"音".repeat(200)), false));
        normalize(&mut store);
        let name = store.mods.get("1").unwrap().custom_name.clone().unwrap();
        assert_eq!(name.chars().count(), MAX_NAME_LEN);
    }

    #[test]
    fn save_backs_up_previous_file() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-user-{}", now_ms()));
        let backups = dir.join("backups");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let mut first = Store::default();
        first.mods.insert("155009".into(), entry(Some("日本音效"), true));
        let report = save(&path, &backups, &first).unwrap();
        assert!(report.backup_path.is_none(), "首次写入没有旧文件可备份");

        let mut second = Store::default();
        second.mods.insert("155009".into(), entry(None, false));
        let report = save(&path, &backups, &second).unwrap();
        assert!(report.backup_path.is_some(), "第二次写入必须备份旧文件");
        assert_eq!(report.entry_count, 0, "取消收藏且清空备注后条目应被丢弃");

        let reread = load(&path);
        assert!(reread.mods.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
