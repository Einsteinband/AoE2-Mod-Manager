//! 在线模组封面图本地缓存（图文双缓存的“图”）。
//!
//! 目录：`%APPDATA%\com.aoe2.modmanager\image_cache\<modId>.jpg`
//! 上限：500 MB，超了按“最久未访问”删除（LRU 依据文件的 mtime）。
//!
//! 为什么不用网络 URL 直接渲染：官网 CDN 在离线 / 弱网下几乎不可用，
//! 而且每次进在线页都会重新拉几十张图，既慢又费流量。存到本地后由
//! asset 协议（`http://asset.localhost/...`）读取，属于本机文件读取，零网络。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::Manager;

pub const DIR_NAME: &str = "image_cache";
pub const MAX_BYTES: u64 = 500 * 1024 * 1024;
/// 单张封面体积上限，防止异常响应把磁盘写满
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// 读命中后，隔多久才刷新一次 mtime（避免每次渲染都写盘）
const TOUCH_INTERVAL: Duration = Duration::from_secs(3600);
/// 后台下载并发数
const WORKERS: usize = 3;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalImage {
    pub mod_id: i64,
    pub path: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchTask {
    pub mod_id: i64,
    pub url: String,
}

pub fn dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(DIR_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

pub fn file_for(app: &tauri::AppHandle, mod_id: i64) -> Result<PathBuf, String> {
    Ok(dir_for(app)?.join(format!("{mod_id}.jpg")))
}

/// 把 image_cache 目录加进 asset 协议白名单。
/// tauri.conf.json 里 `assetProtocol.scope` 是空的，必须在运行时显式放行，
/// 否则前端用 asset: URL 读本地图片会被直接拒绝（404 / 空白）。
pub fn allow_scope(app: &tauri::AppHandle) {
    if let Ok(dir) = dir_for(app) {
        let _ = fs::create_dir_all(&dir);
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
        log::info!(target: "image-cache", "asset 协议已放行图片目录：{}", dir.display());
    }
}

/// 刷新访问时间（LRU 依据）。文件系统时间不可写时静默忽略。
fn touch(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    let Ok(modified) = meta.modified() else { return };
    let Ok(age) = SystemTime::now().duration_since(modified) else { return };
    if age < TOUCH_INTERVAL {
        return;
    }
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// 本地是否已有这张封面；命中就顺手 touch 一下（写 mtime 也要节流）
pub fn local_for(app: &tauri::AppHandle, mod_id: i64) -> Option<String> {
    let path = file_for(app, mod_id).ok()?;
    if !path.is_file() {
        return None;
    }
    touch(&path);
    Some(path.display().to_string())
}

/// 写入图片（原子替换）。返回最终路径。
pub fn store_bytes(app: &tauri::AppHandle, mod_id: i64, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    let dir = dir_for(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建图片缓存目录：{e}"))?;
    let final_path = dir.join(format!("{mod_id}.jpg"));
    let tmp = dir.join(format!("{mod_id}.jpg.tmp"));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时图片失败：{e}"))?;
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换图片文件失败：{e}")
    })?;
    Ok(final_path.display().to_string())
}

fn scan_dir(dir: &Path) -> Vec<(SystemTime, u64, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.ends_with(".jpg") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((modified, meta.len(), path))
        })
        .collect()
}

/// LRU 淘汰：按 mtime 从旧到新删，直到总量降到上限以下
pub fn evict(app: &tauri::AppHandle) -> (usize, u64) {
    let Ok(dir) = dir_for(app) else { return (0, 0) };
    let mut files = scan_dir(&dir);
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    if total <= MAX_BYTES {
        return (0, 0);
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut removed = 0usize;
    let mut freed = 0u64;
    for (_, size, path) in files {
        if total <= MAX_BYTES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            freed += size;
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!(target: "image-cache", "图片缓存超过上限，按 LRU 删除 {removed} 张，释放 {freed} 字节");
    }
    (removed, freed)
}

/// 统计：张数 + 体积
pub fn stat(app: &tauri::AppHandle) -> (usize, u64) {
    let Ok(dir) = dir_for(app) else { return (0, 0) };
    let files = scan_dir(&dir);
    (files.len(), files.iter().map(|(_, size, _)| *size).sum())
}

/// 清空图片缓存（设置页「清理在线缓存」会连这里一起清）
pub fn clear(app: &tauri::AppHandle) -> (usize, u64) {
    let Ok(dir) = dir_for(app) else { return (0, 0) };
    let files = scan_dir(&dir);
    let mut removed = 0usize;
    let mut freed = 0u64;
    for (_, size, path) in files {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += size;
        }
    }
    log::info!(target: "image-cache", "图片缓存已清理：{removed} 张，释放 {freed} 字节");
    (removed, freed)
}

/// 后台批量下载缺失的封面。
///
/// 设计要点：
/// - 在**独立后台线程**里跑（命令立即返回），绝不占用 UI / 命令线程；
/// - 每个 worker 自己建 ApiClient（复用项目的代理链路），不跨线程共享；
/// - 全部结束后统一做一次 LRU 淘汰，并通过事件把新落地的图片推给前端。
pub fn download_batch(app: tauri::AppHandle, tasks: Vec<FetchTask>) {
    use tauri::Emitter;

    if tasks.is_empty() {
        return;
    }
    let queue = Arc::new(Mutex::new(tasks));
    let finished: Arc<Mutex<Vec<LocalImage>>> = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::new();
    for _ in 0..WORKERS {
        let app = app.clone();
        let queue = queue.clone();
        let finished = finished.clone();
        handles.push(std::thread::spawn(move || {
            let Ok(client) = crate::client(&app) else {
                // 未登录 / 网络配置无效：直接放弃这一批，下次进在线页会重试
                return;
            };
            loop {
                let next = {
                    let mut guard = match queue.lock() {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    guard.pop()
                };
                let Some(task) = next else { break };
                if file_for(&app, task.mod_id).map(|p| p.is_file()).unwrap_or(false) {
                    continue;
                }
                match client.fetch_bytes(&task.url, MAX_IMAGE_BYTES) {
                    Ok(bytes) => match store_bytes(&app, task.mod_id, &bytes) {
                        Ok(path) => {
                            if let Ok(mut list) = finished.lock() {
                                list.push(LocalImage { mod_id: task.mod_id, path });
                            }
                        }
                        Err(e) => log::warn!(target: "image-cache", "封面写入失败 {}：{e}", task.mod_id),
                    },
                    Err(e) => log::info!(target: "image-cache", "封面下载失败 {}：{}", task.mod_id, e.message),
                }
            }
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }

    let done = Arc::try_unwrap(finished)
        .map(|mutex| mutex.into_inner().unwrap_or_default())
        .unwrap_or_default();
    evict(&app);
    if !done.is_empty() {
        log::info!(target: "image-cache", "本次新增封面 {} 张", done.len());
        let _ = app.emit("online://images-ready", &done);
    }
}
