//! 在线模组封面图本地缓存（图文双缓存的“图”）。
//!
//! 目录：`%APPDATA%\com.aoe2.modmanager\image_cache\<modId>.jpg`
//! 上限：500 MB，超了按“最久未访问”删除（LRU 依据文件的 mtime）。
//!
//! 为什么不用网络 URL 直接渲染：官网 CDN 在离线 / 弱网下几乎不可用，
//! 而且每次进在线页都会重新拉几十张图，既慢又费流量。存到本地后由
//! asset 协议（`http://asset.localhost/...`）读取，属于本机文件读取，零网络。

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::Manager;

use crate::user_err;

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

/// 单张封面下载失败的回执（成功走 `online://images-ready`，失败走 `online://images-failed`）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailedImage {
    pub mod_id: i64,
    pub kind: String,
    pub message: String,
    pub status: Option<u16>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchTask {
    pub mod_id: i64,
    pub url: String,
    /// 手动「重新加载封面」时为 true：先删除既有（可能损坏的）本地缓存再下载；
    /// 普通批量缩略图下载保持 false，文件存在即跳过。默认 false 以兼容旧调用。
    #[serde(default)]
    pub force: bool,
}

pub fn dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // v3.2：目录可由用户在「设置 → 缓存与存储」里改到其它磁盘，
    // 统一走 crate::get_cache_dir（读配置优先、目录不可用则回退默认 AppData 位置）
    crate::get_cache_dir(app, "image")
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

/// 删除指定 Mod 的本地封面缓存；返回是否确实删掉了一个已存在文件。
pub fn remove_for(app: &tauri::AppHandle, mod_id: i64) -> bool {
    let Ok(path) = file_for(app, mod_id) else { return false };
    match fs::remove_file(&path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            log::warn!(target: "image-cache", "删除旧封面缓存失败 {mod_id}：{e}");
            false
        }
    }
}

/// 最小图片有效性校验：非空且头部像 JPEG / PNG / WEBP 视为有效；其余按损坏缓存处理。
/// 只做头部魔数判断，不做完整解码（与现有缓存策略一致，不引入新依赖）。
pub fn looks_valid_image(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return true; // JPEG
    }
    if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 {
        return true; // PNG
    }
    if bytes[0] == b'R' && bytes[1] == b'I' && bytes[2] == b'F' && bytes[3] == b'F'
        && bytes.len() >= 12
        && &bytes[8..12] == b"WEBP"
    {
        return true; // WEBP
    }
    false
}

/// 写入图片（原子替换）。返回最终路径。
pub fn store_bytes(app: &tauri::AppHandle, mod_id: i64, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err(user_err("image.empty", json!({})));
    }
    let dir = dir_for(app)?;
    fs::create_dir_all(&dir).map_err(|e| user_err("image.createDirFailed", json!({ "error": e.to_string() })))?;
    let final_path = dir.join(format!("{mod_id}.jpg"));
    let tmp = dir.join(format!("{mod_id}.jpg.tmp"));
    fs::write(&tmp, bytes).map_err(|e| user_err("image.writeFailed", json!({ "error": e.to_string() })))?;
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        user_err("image.replaceFailed", json!({ "error": e.to_string() }))
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
    let failed: Arc<Mutex<Vec<FailedImage>>> = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::new();
    for _ in 0..WORKERS {
        let app = app.clone();
        let queue = queue.clone();
        let finished = finished.clone();
        let failed = failed.clone();
        handles.push(std::thread::spawn(move || {
            let Ok(client) = crate::client(&app) else {
                // 未登录 / 网络配置无效：整批放弃，下次进在线页会重试；登记失败便于前端诊断
                if let Ok(mut list) = failed.lock() {
                    for task in queue.lock().map_err(|p| p.into_inner()).unwrap().iter() {
                        list.push(FailedImage {
                            mod_id: task.mod_id,
                            kind: "client".to_string(),
                            message: "client unavailable".to_string(),
                            status: None,
                        });
                    }
                }
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
                let exists = file_for(&app, task.mod_id).map(|p| p.is_file()).unwrap_or(false);
                log::info!(
                    target: "image-cache",
                    "封面下载开始 modId={} force={} exists={} url={}",
                    task.mod_id, task.force, exists, task.url
                );
                // 手动强制刷新：先删除既有（可能损坏的）本地缓存，再重新下载；
                // 普通批量下载文件存在即跳过，行为不变。
                if task.force && exists {
                    let removed = remove_for(&app, task.mod_id);
                    log::info!(target: "image-cache", "强制刷新删除旧缓存 modId={} removed={}", task.mod_id, removed);
                } else if exists {
                    log::info!(target: "image-cache", "封面缓存命中，跳过下载 modId={}", task.mod_id);
                    continue;
                }
                match client.fetch_bytes(&task.url, MAX_IMAGE_BYTES) {
                    Ok(bytes) => match store_bytes(&app, task.mod_id, &bytes) {
                        Ok(path) => {
                            log::info!(
                                target: "image-cache",
                                "封面下载成功 modId={} 响应大小={} 写入={}",
                                task.mod_id, bytes.len(), path
                            );
                            if let Ok(mut list) = finished.lock() {
                                list.push(LocalImage { mod_id: task.mod_id, path });
                            }
                        }
                        Err(e) => {
                            log::warn!(target: "image-cache", "封面写入失败 modId={}：{e}", task.mod_id);
                            if let Ok(mut list) = failed.lock() {
                                list.push(FailedImage {
                                    mod_id: task.mod_id,
                                    kind: "store".to_string(),
                                    message: e,
                                    status: None,
                                });
                            }
                        }
                    },
                    Err(e) => {
                        log::info!(
                            target: "image-cache",
                            "封面下载失败 modId={} kind={} status={:?} message={}",
                            task.mod_id, e.kind, e.status, e.message
                        );
                        if let Ok(mut list) = failed.lock() {
                            list.push(FailedImage {
                                mod_id: task.mod_id,
                                kind: e.kind,
                                message: e.message,
                                status: e.status,
                            });
                        }
                    }
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
    let failed_list = Arc::try_unwrap(failed)
        .map(|mutex| mutex.into_inner().unwrap_or_default())
        .unwrap_or_default();
    evict(&app);
    if !done.is_empty() {
        log::info!(target: "image-cache", "本次新增封面 {} 张", done.len());
        let _ = app.emit("online://images-ready", &done);
    }
    if !failed_list.is_empty() {
        log::info!(target: "image-cache", "本次封面下载失败 {} 张", failed_list.len());
        let _ = app.emit("online://images-failed", &failed_list);
    }
}

#[cfg(test)]
mod tests {
    use super::FetchTask;

    #[test]
    fn image_magic_detects_valid_and_rejects_garbage() {
        assert!(super::looks_valid_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]));
        assert!(super::looks_valid_image(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        assert!(super::looks_valid_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "));
        assert!(!super::looks_valid_image(b""));
        assert!(!super::looks_valid_image(b"not-an-image"));
    }

    #[test]
    fn force_defaults_false_for_legacy_tasks() {
        // 旧批量调用不传 force：默认 false，保持「文件存在即跳过」
        let legacy: FetchTask =
            serde_json::from_str(r#"{"modId":1,"url":"https://cdn.example/a.jpg"}"#).unwrap();
        assert!(!legacy.force);
        // 手动刷新显式带 force=true
        let forced: FetchTask =
            serde_json::from_str(r#"{"modId":1,"url":"https://cdn.example/a.jpg","force":true}"#).unwrap();
        assert!(forced.force);
    }
}
