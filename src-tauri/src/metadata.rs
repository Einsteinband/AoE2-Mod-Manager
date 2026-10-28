use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 软件自己的元数据文件，和 settings.json 放在同一个配置目录。
/// 绝不写入游戏目录（local / subscribed），避免游戏扫描到未知文件。
pub const FILE_NAME: &str = "mod_metadata.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModMeta {
    pub mod_id: i64,
    pub title: String,
    /// 官方分类 id（/api/v4/mods/Tags 的 modTypeId）
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    /// 官方分类名（原始英文，仅作留档）
    #[serde(default)]
    pub tag_names: Vec<String>,
    /// 安装时的目标文件夹名，目录被改名后仍能按名字匹配
    #[serde(default)]
    pub folder_name: Option<String>,
    pub installed_at_ms: i64,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default = "default_version")]
    pub version: u32,
    /// key = WorkshopID 的字符串形式
    #[serde(default)]
    pub mods: BTreeMap<String, ModMeta>,
}

fn default_version() -> u32 {
    1
}

impl Default for Store {
    fn default() -> Self {
        Self { version: default_version(), mods: BTreeMap::new() }
    }
}

/// 官方分类 id → 中文展示名（与前端 online/types.ts 的 TAG_ZH 一致）
const TAG_ZH: &[(i64, &str)] = &[
    (9, "人工智能"),
    (10, "战役"),
    (11, "数据模组"),
    (12, "图像"),
    (13, "影片"),
    (14, "音乐"),
    (15, "随机地图"),
    (16, "场景"),
    (17, "音效"),
    (18, "语音"),
    (19, "嘲讽音"),
    (20, "地形"),
    (21, "菜单背景"),
    (22, "用户界面"),
    (23, "文本"),
    (26, "其他"),
    (30, "罗马复兴"),
];

/// 官方分类 id → 四个筛选项之一：ui | audio | map | data
fn category_of_tag(id: i64) -> &'static str {
    match id {
        // 图像 / UI
        12 | 13 | 20 | 21 | 22 => "ui",
        // 音效 / 音乐
        14 | 17 | 18 | 19 => "audio",
        // 地图 / 战役
        10 | 15 | 16 => "map",
        // 数据 / 其他
        _ => "data",
    }
}

/// 接口偶尔只给名字不给 id，这里按关键词兜底识别
fn category_of_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| lower.contains(k));
    if has(&["sound", "music", "speech", "taunt", "audio", "音"]) {
        "audio"
    } else if has(&["campaign", "map", "scenario", "战役", "地图", "场景"]) {
        "map"
    } else if has(&["interface", "graphic", "visual", "terrain", "menu", "movie", "界面", "图像", "美术"]) {
        "ui"
    } else {
        "data"
    }
}

/// 官方 Tag → 去重后的筛选项（至少返回一项）
pub fn categories_for_tags(tag_ids: &[i64], tag_names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |cat: &str, out: &mut Vec<String>| {
        if !out.iter().any(|c| c == cat) {
            out.push(cat.to_string());
        }
    };
    for id in tag_ids {
        push(category_of_tag(*id), &mut out);
    }
    if tag_ids.is_empty() {
        for name in tag_names {
            push(category_of_name(name), &mut out);
        }
    }
    if out.is_empty() {
        out.push("data".to_string());
    }
    out
}

/// 官方 Tag → 中文展示名（详情页徽章用）
pub fn display_tags(meta: &ModMeta) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (index, id) in meta.tag_ids.iter().enumerate() {
        let zh = TAG_ZH.iter().find(|(tid, _)| tid == id).map(|(_, name)| *name);
        let name = zh
            .map(|s| s.to_string())
            .or_else(|| meta.tag_names.get(index).cloned());
        if let Some(name) = name {
            if !out.iter().any(|t| *t == name) {
                out.push(name);
            }
        }
    }
    if out.is_empty() {
        for name in &meta.tag_names {
            if !out.iter().any(|t| t == name) {
                out.push(name.clone());
            }
        }
    }
    out
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

pub fn load(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    // 容忍 BOM，避免手工编辑后整份元数据失效
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    serde_json::from_slice::<Store>(stripped).unwrap_or_default()
}

pub fn load_for_app(app: &tauri::AppHandle) -> Store {
    match path_for(app) {
        Ok(path) => load(&path),
        Err(e) => {
            log::warn!(target: "metadata", "{e}");
            Store::default()
        }
    }
}

pub fn save(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| format!("元数据序列化失败：{e}"))?;
    fs::write(path, text).map_err(|e| format!("无法写入元数据 {}：{e}", path.display()))
}

/// 记录一次成功安装（合并写入，不覆盖其他模组的条目）
pub fn upsert_for_app(app: &tauri::AppHandle, meta: ModMeta) -> Result<PathBuf, String> {
    let path = path_for(app)?;
    let mut store = load(&path);
    store.version = default_version();
    store.mods.insert(meta.mod_id.to_string(), meta);
    save(&path, &store)?;
    Ok(path)
}

/// 卸载后删除该模组的元数据条目；返回是否真的删掉了（本来就没有 = false）
pub fn remove_for_app(app: &tauri::AppHandle, mod_id: i64) -> Result<bool, String> {
    let path = path_for(app)?;
    let mut store = load(&path);
    if store.mods.remove(&mod_id.to_string()).is_none() {
        return Ok(false);
    }
    store.version = default_version();
    save(&path, &store)?;
    log::info!(target: "metadata", "已删除模组元数据：modId={mod_id}");
    Ok(true)
}

/// 扫描时按 WorkshopID 查，查不到再按文件夹名兜底
pub fn lookup<'a>(store: &'a Store, workshop_id: Option<u64>, folder_name: &str) -> Option<&'a ModMeta> {
    if let Some(id) = workshop_id {
        if let Some(hit) = store.mods.get(&id.to_string()) {
            return Some(hit);
        }
    }
    store.mods.values().find(|m| {
        m.folder_name
            .as_deref()
            .map(|f| f.eq_ignore_ascii_case(folder_name))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_official_tags_to_four_categories() {
        assert_eq!(categories_for_tags(&[22], &[]), vec!["ui".to_string()]);
        assert_eq!(categories_for_tags(&[14, 17], &[]), vec!["audio".to_string()]);
        assert_eq!(categories_for_tags(&[15, 10], &[]), vec!["map".to_string()]);
        assert_eq!(categories_for_tags(&[11], &[]), vec!["data".to_string()]);
        assert_eq!(categories_for_tags(&[], &[]), vec!["data".to_string()]);
    }

    #[test]
    fn falls_back_to_names_when_ids_missing() {
        assert_eq!(categories_for_tags(&[], &["Sounds".to_string()]), vec!["audio".to_string()]);
    }

    #[test]
    fn lookup_prefers_workshop_id_then_folder() {
        let mut store = Store::default();
        store.mods.insert(
            "42".to_string(),
            ModMeta {
                mod_id: 42,
                title: "T".to_string(),
                tag_ids: vec![22],
                tag_names: vec!["User Interface".to_string()],
                folder_name: Some("42_Renamed".to_string()),
                installed_at_ms: 0,
                source: "api.ageofempires.com".to_string(),
            },
        );
        assert!(lookup(&store, Some(42), "whatever").is_some());
        assert!(lookup(&store, None, "42_renamed").is_some());
        assert!(lookup(&store, Some(7), "nope").is_none());
    }

    #[test]
    fn store_round_trips_on_disk() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-meta-{}", crate::scan::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let mut store = Store::default();
        store.mods.insert(
            "900".to_string(),
            ModMeta {
                mod_id: 900,
                title: "Hero".to_string(),
                tag_ids: vec![22, 14],
                tag_names: vec!["User Interface".to_string(), "Music".to_string()],
                folder_name: None,
                installed_at_ms: 1,
                source: "api.ageofempires.com".to_string(),
            },
        );
        save(&path, &store).unwrap();
        let loaded = load(&path);
        let hit = lookup(&loaded, Some(900), "x").expect("应能按 WorkshopID 找到记录");
        assert_eq!(hit.title, "Hero");
        assert_eq!(categories_for_tags(&hit.tag_ids, &hit.tag_names), vec!["ui".to_string(), "audio".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn display_tags_are_chinese() {
        let meta = ModMeta {
            mod_id: 1,
            title: "T".to_string(),
            tag_ids: vec![22, 17, 999],
            tag_names: vec!["User Interface".to_string(), "Sounds".to_string(), "Custom".to_string()],
            folder_name: None,
            installed_at_ms: 0,
            source: String::new(),
        };
        assert_eq!(display_tags(&meta), vec!["用户界面".to_string(), "音效".to_string(), "Custom".to_string()]);
    }
}
