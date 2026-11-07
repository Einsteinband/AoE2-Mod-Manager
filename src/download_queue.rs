//! 下载队列持久化（`download_queue.json`）。
//!
//! 为什么单独一个文件：下载队列是**前端**的状态机（`src/online/downloadQueue.ts`），
//! Rust 不理解单个任务字段，只负责"原样存、原样取"。因此这里把 `tasks` 当作
//! `Vec<serde_json::Value>` 透传 —— 前端加字段不需要改 Rust。
//!
//! 落盘策略：每次前端状态变化（入队 / 出队 / 结束）写一次完整快照，
//! 临时文件 + rename 原子替换，**不做 .bak 备份**（队列是易恢复数据，
//! 每次进度变化都备份会瞬间塞满 backups 目录）。
//!
//! 与 settings.json / user_data.json 同目录：`%APPDATA%\com.aoe2.modmanager\download_queue.json`。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::scan::now_ms;

pub const FILE_NAME: &str = "download_queue.json";

/// 最多保留的任务条数（超出只截断末尾，不报错）
const MAX_TASKS: usize = 50;

/// 快照结构版本号：前端结构大改时递增，便于将来做迁移
const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default = "default_version")]
    pub version: u32,
    /// 前端任务对象原样透传（Rust 不解析字段语义）
    #[serde(default)]
    pub tasks: Vec<serde_json::Value>,
    /// 写入时间（毫秒时间戳），仅用于排查
    #[serde(default)]
    pub saved_at: i64,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

impl Default for Snapshot {
    fn default() -> Self {
        Self { version: SCHEMA_VERSION, tasks: Vec::new(), saved_at: 0 }
    }
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // v1.x：跟随「数据与缓存总目录」（未自定义时即 %APPDATA%\<bundleId>）
    crate::data_root(app).map(|dir| dir.join(FILE_NAME))
}

/// 读：文件不存在 / 损坏 / 带 BOM 都退回空快照，绝不让界面因一个坏文件打不开。
pub fn load(path: &Path) -> Snapshot {
    let Ok(bytes) = fs::read(path) else { return Snapshot::default() };
    let stripped =
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut snap = match serde_json::from_slice::<Snapshot>(stripped) {
        Ok(snap) => snap,
        Err(e) => {
            log::warn!(target: "downloader", "download_queue.json 解析失败，已按空队列处理：{e}");
            Snapshot::default()
        }
    };
    if snap.tasks.len() > MAX_TASKS {
        snap.tasks.truncate(MAX_TASKS);
    }
    snap
}

pub fn load_for_app(app: &tauri::AppHandle) -> Snapshot {
    match path_for(app) {
        Ok(path) => load(&path),
        Err(e) => {
            log::warn!(target: "downloader", "无法定位下载队列文件：{e}");
            Snapshot::default()
        }
    }
}

/// 覆盖式写入整份 download_queue.json：写临时文件 → rename 原子替换。
/// 返回最终路径（前端只在日志里用）。
pub fn save(path: &Path, snap: &Snapshot) -> Result<String, String> {
    let mut clean = snap.clone();
    clean.version = SCHEMA_VERSION;
    clean.saved_at = now_ms() as i64;
    if clean.tasks.len() > MAX_TASKS {
        clean.tasks.truncate(MAX_TASKS);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }

    let text =
        serde_json::to_string_pretty(&clean).map_err(|e| format!("下载队列序列化失败：{e}"))?;
    let tmp_path = path.with_file_name(format!("{FILE_NAME}.aoe2mm-{}.tmp", now_ms()));
    if let Err(e) = fs::write(&tmp_path, text.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败：{e}"));
    }
    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("替换 download_queue.json 失败：{e}"));
    }

    log::info!(target: "downloader", "已写入下载队列：{} 条任务", clean.tasks.len());
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_empty_snapshot() {
        let path = std::env::temp_dir().join(format!("aoe2mm-dlq-none-{}.json", now_ms()));
        let snap = load(&path);
        assert_eq!(snap.version, SCHEMA_VERSION);
        assert!(snap.tasks.is_empty());
    }

    #[test]
    fn save_then_load_roundtrip_keeps_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-dlq-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let snap = Snapshot {
            version: 1,
            tasks: vec![
                serde_json::json!({"id": "1-2-1", "modId": 1, "title": "测试", "status": "queued"}),
                serde_json::json!({"modId": 2, "status": "done", "unknownField": [1, 2, 3]}),
            ],
            saved_at: 0,
        };
        save(&path, &snap).unwrap();
        let reread = load(&path);
        assert_eq!(reread.tasks.len(), 2);
        assert_eq!(reread.tasks[0]["title"], "测试");
        assert_eq!(reread.tasks[1]["unknownField"][2], 3);
        assert!(reread.saved_at > 0, "写入时应回填 savedAt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_empty() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-dlq-bad-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).tasks.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
