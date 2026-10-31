//! 在线数据离线缓存 v2（内存优先 + 永久保存 + 大批量）。
//!
//! 位置：`%APPDATA%\com.aoe2.modmanager\online_cache.json`。
//!
//! 与 v1 的三个关键差别（都是为了“秒开”）：
//! 1. **永不过期**：不再有 24h TTL。只要文件在，数据就在（[`TTL_MS`] = 0）。
//! 2. **内存优先**：v1 每次读缓存都要 `fs::read` + 全量 `serde_json` 解析整个文件
//!    （实测 1.8MB 13 条尚可，几万条时是几十上百 MB → 比网络还慢，这就是“缓存没生效”的真凶）。
//!    现在整个 Store 常驻内存，读缓存是纯内存查找，微秒级；写盘节流 + 原子替换。
//! 3. **剥离冗余**：缓存时把每条 list item 的 `raw`（接口原始 JSON，占 90%+ 体积）清空，
//!    前端从未读取它，换来同样磁盘能装 30 倍以上的条目。
//!
//! 容量：条目 10000、体积 200MB，超了按“最旧写入”淘汰。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};


pub const FILE_NAME: &str = "online_cache.json";
/// 2 = 无 TTL + 内存优先 + raw 剥离；旧文件（1）自动丢弃，不会误读
pub const CURRENT_VERSION: u32 = 2;
/// 0 = 永不过期（保留字段是为了前端/设置页能显示“永久有效”）
pub const TTL_MS: u64 = 0;
pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;

/// 小于这个体积就每次写入都立即落盘（小文件写盘只要几毫秒）
const FLUSH_SMALL_BYTES: u64 = 8 * 1024 * 1024;
/// 大文件的写盘节流间隔：数据已经在内存里，晚 2 秒落盘不影响任何读操作
const FLUSH_INTERVAL_MS: u64 = 2_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    /// find | installed | detail
    pub kind: String,
    pub saved_at_ms: u64,
    pub used_at_ms: u64,
    pub bytes: u64,
    pub value: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

impl Default for Store {
    fn default() -> Self {
        Self { version: CURRENT_VERSION, entries: Vec::new() }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheHit {
    pub kind: String,
    pub key: String,
    pub value: Value,
    pub saved_at_ms: u64,
    pub used_at_ms: u64,
    /// 永远为 false（无 TTL）；保留字段兼容前端判断
    pub expired: bool,
}

/// 一页缓存（[`pages_for_app`] 的返回值）：前端据此一次性铺满整个列表
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CachedPage {
    pub start: i64,
    pub total_count: Option<i64>,
    pub items: Vec<Value>,
    /// 这一页的写入时间（前端据此判断“缓存有多新”，决定要不要立刻联网刷新）
    pub saved_at_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheStat {
    pub path: String,
    pub entries: usize,
    pub bytes: u64,
    pub oldest_ms: Option<u64>,
    pub newest_ms: Option<u64>,
    pub ttl_ms: u64,
    pub max_entries: usize,
    pub max_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub removed: bool,
    pub path: String,
    pub entries_removed: usize,
}

/// 一次查询的完整参数（find / installed 共用）
pub struct PageQuery<'a> {
    pub query: &'a str,
    pub start: i64,
    pub count: i64,
    pub sort: &'a str,
    pub order: &'a str,
    pub tags: &'a [i64],
    pub installed: bool,
}

struct Memory {
    path: PathBuf,
    store: Store,
    dirty: bool,
    last_flush_ms: u64,
}

/// 进程内缓存：整个进程只从磁盘读一次
static MEM: Mutex<Option<Memory>> = Mutex::new(None);

/// 写盘互斥：同一进程内的并发行，绝不能同时往同一个临时文件写。
/// （之前只在修改内存时持有 MEM 锁、写盘时已经解锁，两个请求线程会同时
///  `write(tmp)` → `rename(tmp)`，先完成的那一个把 tmp 改名走，
///   后一个 rename 就报 ERROR_FILE_NOT_FOUND，即 os error 2）
static IO_LOCK: Mutex<()> = Mutex::new(());
/// 临时文件名序号：保证多个进程/线程不会用同一个 tmp 名
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn encode(text: &str) -> String {
    let lowered = text.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for byte in lowered.as_bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 搜索 / 分页 key：`start`、`count`、排序、tags 全部进 key，
/// 所以「不同分类」「不同页」「不同排序」各自独立命中，互不覆盖。
pub fn find_key(
    query: &str,
    start: i64,
    count: i64,
    sort: &str,
    order: &str,
    tags: &[i64],
) -> String {
    let mut sorted: Vec<i64> = tags.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let tag_text = sorted
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "find|q={}|sort={}|order={}|tags={}|start={}|count={}",
        encode(query),
        encode(sort),
        encode(order),
        tag_text,
        start,
        count
    )
}

pub fn installed_key(start: i64, count: i64) -> String {
    format!("installed|start={start}|count={count}")
}

pub fn detail_key(mod_id: i64) -> String {
    format!("detail|{mod_id}")
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // v3.2：目录可由用户在「设置 → 缓存与存储」里改到其它磁盘；
    // 默认仍然是应用配置目录（get_cache_dir 里做「读配置优先、回退默认」的判定）
    Ok(crate::get_cache_dir(app, "modinfo")?.join(FILE_NAME))
}

/// 列表项里的 `raw` 是接口原始 JSON（含 metaData 全套重复字段），占 90%+ 体积；
/// 前端**从未读取**列表项的 raw（详情页的 raw 面板用的是 /Detail 响应），这里直接清空。
fn strip_heavy(value: &mut Value) {
    let Some(items) = value.get_mut("items").and_then(|v| v.as_array_mut()) else { return };
    for item in items.iter_mut() {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("raw".to_string(), Value::Object(serde_json::Map::new()));
        }
    }
}

fn read_store(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut store = serde_json::from_slice::<Store>(stripped).unwrap_or_default();
    if store.version != CURRENT_VERSION {
        log::info!(
            target: "cache",
            "缓存结构版本不匹配（文件={} 期望={}），已丢弃重建",
            store.version,
            CURRENT_VERSION
        );
        return Store::default();
    }
    store.version = CURRENT_VERSION;
    store
        .entries
        .retain(|e| !e.key.trim().is_empty() && !e.value.is_null() && e.bytes > 0);
    prune(&mut store);
    store
}

/// 临时文件名：**同目录** + 进程号 + 序号，避免并发写互相覆盖。
/// `online_cache.json` → `online_cache.json.12345-7.tmp`（与目标同目录，rename 不会跳盘符）
fn unique_tmp(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| FILE_NAME.to_string());
    path.with_file_name(format!(
        "{name}.{}-{seq}.tmp",
        std::process::id()
    ))
}

/// 写盘：**先写唯一临时文件，再原子替换**。
///
/// 失败回退链（Windows 上目标文件可能被另一个实例、杀毒软件或索引服务短暂占用）：
/// 1. rename（原子，MOVEFILE_REPLACE_EXISTING）
/// 2. 失败 → `fs::copy` 直接覆盖（非原子但不会丢旧缓存）
/// 3. 都失败 → 只记日志，**绝不删除已有的旧缓存文件**
fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_vec(store).map_err(|e| format!("缓存序列化失败：{e}"))?;

    // 写盘期间独占：同一进程内不会有两个线程同时动 tmp / target
    let _io = IO_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let tmp = unique_tmp(path);
    fs::write(&tmp, &text).map_err(|e| format!("写入临时缓存失败（{}）：{e}", tmp.display()))?;

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first) => match fs::copy(&tmp, path) {
            Ok(_) => {
                let _ = fs::remove_file(&tmp);
                log::warn!(target: "cache", "rename 失败（{first}），已用 copy 兜底写入");
                Ok(())
            }
            Err(second) => {
                let _ = fs::remove_file(&tmp);
                Err(format!(
                    "rename 失败（{first}）；copy 兜底也失败（{second}）；tmp={} target={}",
                    tmp.display(),
                    path.display()
                ))
            }
        },
    }
}

/// 淘汰：条目数 + 总体积，都是最旧（saved_at_ms 最小）的先丢
fn prune(store: &mut Store) {
    if store.entries.len() > MAX_ENTRIES {
        store.entries.sort_by_key(|e| e.saved_at_ms);
        let drop_count = store.entries.len() - MAX_ENTRIES;
        store.entries.drain(0..drop_count);
        log::info!(target: "cache", "缓存条目超过 {MAX_ENTRIES}，丢弃最旧 {drop_count} 条");
    }
    let mut total: u64 = store.entries.iter().map(|e| e.bytes).sum();
    if total <= MAX_BYTES {
        return;
    }
    store.entries.sort_by_key(|e| e.saved_at_ms);
    let mut dropped = 0usize;
    while total > MAX_BYTES && store.entries.len() > 1 {
        let removed = store.entries.remove(0);
        total = total.saturating_sub(removed.bytes);
        dropped += 1;
    }
    if dropped > 0 {
        log::info!(target: "cache", "缓存体积超过上限，丢弃最旧 {dropped} 条");
    }
}

fn lock_mem() -> std::sync::MutexGuard<'static, Option<Memory>> {
    MEM.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 取内存实例（首次或路径变化时从磁盘加载一次），返回持有锁的 guard
fn ensure_loaded(
    app: &tauri::AppHandle,
) -> Result<std::sync::MutexGuard<'static, Option<Memory>>, String> {
    let path = path_for(app)?;
    let mut guard = lock_mem();
    let need_reload = match guard.as_ref() {
        Some(mem) => mem.path != path,
        None => true,
    };
    if need_reload {
        let store = read_store(&path);
        log::info!(target: "cache", "缓存已载入内存：{} 条（{}）", store.entries.len(), path.display());
        *guard = Some(Memory { path, store, dirty: false, last_flush_ms: 0 });
    }
    Ok(guard)
}

/// 写入一条缓存。**永不返回错误**：缓存是锦上添花，失败只打日志。
pub fn put_for_app(app: &tauri::AppHandle, key: &str, kind: &str, mut value: Value) {
    let key = key.trim().to_string();
    if key.is_empty() || value.is_null() {
        return;
    }
    strip_heavy(&mut value);
    let bytes = serde_json::to_vec(&value).map(|b| b.len() as u64).unwrap_or(0);
    if bytes == 0 {
        return;
    }

    let Ok(mut guard) = ensure_loaded(app) else { return };
    let Some(mem) = guard.as_mut() else { return };
    let now = now_ms();
    mem.store.entries.retain(|e| e.key != key);
    mem.store.entries.push(Entry {
        key,
        kind: kind.to_string(),
        saved_at_ms: now,
        used_at_ms: now,
        bytes,
        value,
    });
    prune(&mut mem.store);
    mem.dirty = true;

    let total: u64 = mem.store.entries.iter().map(|e| e.bytes).sum();
    let due = total < FLUSH_SMALL_BYTES || now.saturating_sub(mem.last_flush_ms) >= FLUSH_INTERVAL_MS;
    if !due {
        return;
    }
    mem.last_flush_ms = now;
    mem.dirty = false;
    let snapshot = mem.store.clone();
    let path = mem.path.clone();
    // 必须在释放锁之后再写盘：几十 MB 的序列化不能挡住其它线程读缓存
    drop(guard);
    if let Err(e) = write_store(&path, &snapshot) {
        log::warn!(target: "cache", "写入在线缓存失败：{e}");
    }
}

pub fn get_for_app(app: &tauri::AppHandle, key: &str) -> Option<CacheHit> {
    let guard = ensure_loaded(app).ok()?;
    let mem = guard.as_ref()?;
    let entry = mem.store.entries.iter().find(|e| e.key == key)?;
    Some(CacheHit {
        kind: entry.kind.clone(),
        key: entry.key.clone(),
        value: entry.value.clone(),
        saved_at_ms: entry.saved_at_ms,
        used_at_ms: entry.used_at_ms,
        expired: false,
    })
}

/// **一次 invoke 读多页**（全部在内存里，微秒级）。
///
/// 起始偏移按「上一页实际条数」递推，与前端网络分页的 cursor 规则完全一致，
/// 所以缓存里第 1、2、3 页能原样拼回一屏，不会错位。
pub fn pages_for_app(app: &tauri::AppHandle, q: PageQuery<'_>, max_pages: usize) -> Vec<CachedPage> {
    let Ok(guard) = ensure_loaded(app) else { return Vec::new() };
    let Some(mem) = guard.as_ref() else { return Vec::new() };
    let mut out: Vec<CachedPage> = Vec::new();
    let mut start = q.start.max(1);
    let count = q.count.max(1);
    for _ in 0..max_pages.max(1) {
        let key = if q.installed {
            installed_key(start, count)
        } else {
            find_key(q.query, start, count, q.sort, q.order, q.tags)
        };
        let Some(entry) = mem.store.entries.iter().find(|e| e.key == key) else {
            log::info!(target: "cache", "缓存未命中：{key}");
            break;
        };
        let items = entry.value.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        // 注意：**空列表也是一次合法命中**（该分类确实 0 条），不能当成“没缓存”再去请求
        log::info!(target: "cache", "缓存命中：{key}（{} 条）", items.len());
        let total_count = entry.value.get("totalCount").and_then(|v| v.as_i64());
        let saved_at_ms = entry.saved_at_ms;
        let len = items.len() as i64;
        out.push(CachedPage { start, total_count, items, saved_at_ms });
        start += len;
        if len < count {
            break;
        }
    }
    out
}

/// 所有缓存过的列表项（按订阅数降序去重）——“我的收藏”纯本地浏览靠它，
/// 这样没加载过的收藏项也能直接显示，绝不需要发网络请求。
pub fn all_items_for_app(app: &tauri::AppHandle) -> Vec<Value> {
    let Ok(guard) = ensure_loaded(app) else { return Vec::new() };
    let Some(mem) = guard.as_ref() else { return Vec::new() };
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for entry in &mem.store.entries {
        if entry.kind != "find" && entry.kind != "installed" {
            continue;
        }
        let Some(items) = entry.value.get("items").and_then(|v| v.as_array()) else { continue };
        for item in items {
            let id = item.get("modId").and_then(|v| v.as_i64()).unwrap_or(0);
            if id <= 0 || !seen.insert(id) {
                continue;
            }
            out.push(item.clone());
        }
    }
    out.sort_by_key(|v| {
        std::cmp::Reverse(v.get("installs").and_then(|x| x.as_i64()).unwrap_or(0))
    });
    out
}

pub fn clear_for_app(app: &tauri::AppHandle) -> Result<ClearReport, String> {
    let path = path_for(app)?;
    let display = path.display().to_string();
    let entries_removed = {
        let mut guard = lock_mem();
        let removed = guard.as_ref().map(|m| m.store.entries.len()).unwrap_or(0);
        *guard = Some(Memory {
            path: path.clone(),
            store: Store::default(),
            dirty: false,
            last_flush_ms: 0,
        });
        removed
    };
    let removed = if path.is_file() {
        let _io = IO_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        fs::remove_file(&path).map_err(|e| format!("删除缓存文件失败：{e}"))?;
        true
    } else {
        false
    };
    log::info!(target: "cache", "在线缓存已清理：{display}（{entries_removed} 条）");
    Ok(ClearReport { removed, path: display, entries_removed })
}

pub fn stat_for_app(app: &tauri::AppHandle) -> CacheStat {
    let path = path_for(app).ok();
    let display = path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let bytes = path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let (entries, oldest, newest) = match ensure_loaded(app) {
        Ok(guard) => match guard.as_ref() {
            Some(mem) => (
                mem.store.entries.len(),
                mem.store.entries.iter().map(|e| e.saved_at_ms).min(),
                mem.store.entries.iter().map(|e| e.saved_at_ms).max(),
            ),
            None => (0, None, None),
        },
        Err(_) => (0, None, None),
    };
    CacheStat {
        path: display,
        entries,
        bytes,
        oldest_ms: oldest,
        newest_ms: newest,
        ttl_ms: TTL_MS,
        max_entries: MAX_ENTRIES,
        max_bytes: MAX_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn find_key_is_stable_and_disambiguates_pages() {
        let a = find_key("  Japanese  ", 1, 24, "recentpopular", "DESC", &[15]);
        let b = find_key("japanese", 1, 24, "recentpopular", "DESC", &[15]);
        assert_eq!(a, b);
        assert_ne!(a, find_key("japanese", 25, 24, "recentpopular", "DESC", &[15]));
        assert_ne!(a, find_key("japanese", 1, 48, "recentpopular", "DESC", &[15]));
    }

    #[test]
    fn find_key_sorts_tags_and_escapes_separators() {
        let x = find_key("", 1, 24, "popular", "ASC", &[22, 15, 15]);
        let y = find_key("", 1, 24, "popular", "ASC", &[15, 22]);
        assert_eq!(x, y);
        assert!(x.contains("tags=15,22"));
        let tricky = find_key("a|start=2&b=c", 1, 24, "popular", "ASC", &[]);
        assert!(!tricky.contains("q=a|start=2"));
    }

    #[test]
    fn strip_heavy_clears_raw_but_keeps_items() {
        let mut value = json!({
            "totalCount": 2,
            "items": [
                { "modId": 1, "title": "a", "raw": { "big": "x".repeat(500) } },
                { "modId": 2, "title": "b", "raw": { "big": "y".repeat(500) } }
            ]
        });
        strip_heavy(&mut value);
        assert_eq!(value["items"][0]["raw"], json!({}));
        assert_eq!(value["items"][1]["title"], json!("b"));
        assert!(serde_json::to_vec(&value).unwrap().len() < 300);
    }

    #[test]
    fn prune_drops_oldest_first() {
        let mut store = Store::default();
        for index in 0..(MAX_ENTRIES + 3) {
            store.entries.push(Entry {
                key: format!("detail|{index}"),
                kind: "detail".into(),
                saved_at_ms: index as u64,
                used_at_ms: index as u64,
                bytes: 10,
                value: json!({ "n": index }),
            });
        }
        prune(&mut store);
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert_eq!(store.entries[0].key, "detail|3");
    }

    #[test]
    fn concurrent_writes_never_fail_with_file_not_found() {
        // 复现旧版 bug：多个线程共用同一个 tmp 名时，先 rename 走 tmp 的线程会让
        // 后一个线程 rename 报 ERROR_FILE_NOT_FOUND（os error 2）。
        let dir = std::env::temp_dir().join(format!("aoe2mm-cache-race-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let mut handles = Vec::new();
        for worker in 0..8u64 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                for round in 0..5 {
                    let mut store = Store::default();
                    store.entries.push(Entry {
                        key: format!("detail|{worker}-{round}"),
                        kind: "detail".into(),
                        saved_at_ms: now_ms(),
                        used_at_ms: now_ms(),
                        bytes: 8,
                        value: json!({ "w": worker }),
                    });
                    write_store(&path, &store).expect("并发写盘不得失败");
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let store = read_store(&path);
        assert_eq!(store.entries.len(), 1, "最终文件必须是一个完整快照");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不得留下临时文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_store_tolerates_broken_and_old_version() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-cache2-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        fs::write(&path, b"\xEF\xBB\xBFnot json").unwrap();
        assert!(read_store(&path).entries.is_empty());

        fs::write(&path, br#"{"version":1,"entries":[{"key":"detail|1","kind":"detail","savedAtMs":1,"usedAtMs":1,"bytes":5,"value":{"a":1}}]}"#).unwrap();
        assert!(read_store(&path).entries.is_empty(), "旧版本必须整体丢弃");

        let _ = fs::remove_dir_all(&dir);
    }
}
