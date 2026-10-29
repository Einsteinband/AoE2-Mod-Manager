//! 在线数据离线缓存（SWR：先读缓存秒开，再静默换真实数据）。
//!
//! 文件位置：`%APPDATA%\com.aoe2.modmanager\online_cache.json`（与 settings / metadata /
//! user_data 同级，绝不写进游戏目录）。
//!
//! 三条铁律：
//! 1. 只缓存**成功**的响应。失败（401 / 网络错误 / 解析错误）绝不写入，
//!    否则会把「登录失效」固化成「缓存里永远没数据」。
//! 2. Key 由本文件唯一实现（[`find_key`] / [`installed_key`] / [`detail_key`]），
//!    前端只传原始参数、不自己拼 key，杜绝两套逻辑漂移。
//! 3. 读盘走 [`load`] 的宽松解析：文件损坏 / 带 BOM / 被手动改坏都退回空表，
//!    绝不让一个坏缓存文件卡死在线页。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

pub const FILE_NAME: &str = "online_cache.json";
/// 当前结构版本（将来字段变了靠它做迁移，不兼容时直接整体丢弃）
pub const CURRENT_VERSION: u32 = 1;
/// 缓存有效期：超过 24 小时视为无效。前端拿到 expired=true 会当“没有缓存”处理。
pub const TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// 条目上限。
///
/// 注意：**不是 1000**。每条 find 条目内含 24 项完整原始 JSON（`OnlineModSummary.raw`），
/// 1000 条会是几十 MB，而这个文件每次写入都要整份重写 —— 会让列表请求本身变慢。
/// 300 条已经覆盖「首页 + 十几次翻页 × 十几次搜索/分类」的日常使用。
pub const MAX_ENTRIES: usize = 300;
/// 文件体积上限（字节）。超出时按“最旧优先”丢弃，保证最坏情况下写盘时间可控。
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 写盘互斥：并发的 Find / Detail 都在 spawn_blocking 线程里，
/// 没有锁的话「读-改-写」会互相覆盖，最后只剩最后一次写入的条目。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 见 [`find_key`] 等函数的生成规则
    pub key: String,
    /// find | installed | detail
    pub kind: String,
    /// 写入时间（毫秒时间戳），TTL 与淘汰都按它算
    pub saved_at_ms: u64,
    /// 最近一次写入/命中时间（仅用于排查，淘汰不看它）
    pub used_at_ms: u64,
    /// `value` 序列化后的字节数（淘汰时不用反复重新计算）
    pub bytes: u64,
    /// 原始响应体：find/installed 是 FindResult 的 camelCase JSON，detail 是官方 Detail 原文
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

/// 返回给前端的命中结果（结构体本身不判断“用不用”，只用 expired 表达是否过期）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheHit {
    pub kind: String,
    pub key: String,
    pub value: Value,
    pub saved_at_ms: u64,
    pub age_ms: u64,
    pub expired: bool,
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
    /// 文件确实存在并被删掉 = true；本来就没有 = false
    pub removed: bool,
    pub path: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 极简百分号编码：query 里可能有空格、中文、`|`、`=` 等会破坏 key 结构的字符。
/// 小写化在调用处做，这里只负责“让 key 可逆且不含分隔符”。
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

/// 搜索 / 分页的 key。
///
/// `start` 与 `count` 都在 key 里，所以「第 1 页 24 条」与「第 2 页 24 条」是两条独立记录，
/// 翻页、切分类、改排序都能各自秒开，不会互相覆盖。
/// `tags` 先升序去重再拼，保证 `[15,22]` 与 `[22,15]` 命中同一条缓存。
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

/// 已订阅列表（`/Installed`）的 key：该接口不支持 tags 过滤，只有分页参数
pub fn installed_key(start: i64, count: i64) -> String {
    format!("installed|start={start}|count={count}")
}

/// 详情（`/Detail/{id}`）的 key
pub fn detail_key(mod_id: i64) -> String {
    format!("detail|{mod_id}")
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

/// 读：不存在 / 损坏 / 带 BOM 一律退回空表；顺手丢掉已过 TTL 的条目
pub fn load(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut store = serde_json::from_slice::<Store>(stripped).unwrap_or_default();
    if store.version != CURRENT_VERSION {
        // 结构版本不兼容：整体丢弃，不冒险解析旧格式
        log::info!(
            target: "cache",
            "缓存结构版本不匹配（文件={} 期望={}），已丢弃",
            store.version,
            CURRENT_VERSION
        );
        store = Store::default();
    }
    let now = now_ms();
    let before = store.entries.len();
    store
        .entries
        .retain(|e| !e.key.trim().is_empty() && !e.value.is_null() && now.saturating_sub(e.saved_at_ms) <= TTL_MS);
    if before != store.entries.len() {
        log::info!(target: "cache", "读取时丢弃过期/损坏缓存 {} 条", before - store.entries.len());
    }
    store
}

/// 原子写：先写临时文件再 rename（Rust 的 rename 在 Windows 上带
/// MOVEFILE_REPLACE_EXISTING，可以直接覆盖目标）
fn save(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_vec_pretty(store).map_err(|e| format!("缓存序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写入临时缓存失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换缓存文件失败：{e}")
    })
}

/// 淘汰：先按条目数，再按总体积；两者都是「最旧的先丢」
fn prune(store: &mut Store) {
    store.entries.sort_by_key(|e| e.saved_at_ms);
    if store.entries.len() > MAX_ENTRIES {
        let drop_count = store.entries.len() - MAX_ENTRIES;
        store.entries.drain(0..drop_count);
        log::info!(target: "cache", "缓存条目超过上限，丢弃最旧 {drop_count} 条");
    }
    let mut total: u64 = store.entries.iter().map(|e| e.bytes).sum();
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

/// 写入一条缓存。**永不返回错误**：缓存是锦上添花，写失败只记日志，绝不影响请求本身。
pub fn put_for_app(app: &tauri::AppHandle, key: &str, kind: &str, value: Value) {
    let key = key.trim().to_string();
    if key.is_empty() || value.is_null() {
        return;
    }
    let Ok(path) = path_for(app) else {
        log::warn!(target: "cache", "无法定位缓存路径，跳过写入");
        return;
    };
    let bytes = serde_json::to_vec(&value).map(|b| b.len() as u64).unwrap_or(0);
    if bytes == 0 {
        return;
    }

    // 锁中毒（别的线程 panic）也要继续写：用 into_inner 恢复
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut store = load(&path);
    let now = now_ms();
    store.entries.retain(|e| e.key != key);
    store.entries.push(Entry {
        key,
        kind: kind.to_string(),
        saved_at_ms: now,
        used_at_ms: now,
        bytes,
        value,
    });
    prune(&mut store);
    if let Err(e) = save(&path, &store) {
        log::warn!(target: "cache", "写入在线缓存失败：{e}");
    }
}

/// 读一条缓存；未命中返回 None（过期也返回，由前端看 expired 决定用不用）
pub fn get_for_app(app: &tauri::AppHandle, key: &str) -> Option<CacheHit> {
    let path = path_for(app).ok()?;
    let store = load(&path);
    let entry = store.entries.into_iter().find(|e| e.key == key)?;
    let age_ms = now_ms().saturating_sub(entry.saved_at_ms);
    Some(CacheHit {
        kind: entry.kind,
        key: entry.key,
        value: entry.value,
        saved_at_ms: entry.saved_at_ms,
        age_ms,
        expired: age_ms > TTL_MS,
    })
}

/// 直接删除整个缓存文件（设置页「清理在线缓存」）
pub fn clear_for_app(app: &tauri::AppHandle) -> Result<ClearReport, String> {
    let path = path_for(app)?;
    let display = path.display().to_string();
    {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !path.is_file() {
            return Ok(ClearReport { removed: false, path: display });
        }
        fs::remove_file(&path).map_err(|e| format!("删除缓存文件失败：{e}"))?;
    }
    log::info!(target: "cache", "在线缓存已清理：{display}");
    Ok(ClearReport { removed: true, path: display })
}

/// 设置页展示用：条目数 / 体积 / 时间范围
pub fn stat_for_app(app: &tauri::AppHandle) -> CacheStat {
    let path = path_for(app).ok();
    let display = path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let bytes = path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let store = path.as_ref().map(|p| load(p)).unwrap_or_default();
    CacheStat {
        path: display,
        entries: store.entries.len(),
        bytes,
        oldest_ms: store.entries.iter().map(|e| e.saved_at_ms).min(),
        newest_ms: store.entries.iter().map(|e| e.saved_at_ms).max(),
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
        assert_eq!(a, b, "大小写与首尾空格不应影响命中");

        let page2 = find_key("japanese", 25, 24, "recentpopular", "DESC", &[15]);
        assert_ne!(a, page2, "不同页必须是不同 key");

        let count48 = find_key("japanese", 1, 48, "recentpopular", "DESC", &[15]);
        assert_ne!(a, count48, "不同每批数量必须是不同 key");
    }

    #[test]
    fn find_key_sorts_tags_and_escapes_separators() {
        let x = find_key("", 1, 24, "popular", "ASC", &[22, 15, 15]);
        let y = find_key("", 1, 24, "popular", "ASC", &[15, 22]);
        assert_eq!(x, y, "tags 顺序与重复不应影响命中");
        assert!(x.contains("tags=15,22"), "tags 应升序去重：{x}");

        let tricky = find_key("a|start=2&b=c", 1, 24, "popular", "ASC", &[]);
        assert!(!tricky.contains("q=a|start=2"), "竖线必须被编码，不能伪造出 start：{tricky}");
    }

    #[test]
    fn detail_and_installed_keys_are_distinct() {
        assert_eq!(detail_key(409484), "detail|409484");
        assert_eq!(installed_key(1, 24), "installed|start=1|count=24");
        assert_ne!(installed_key(1, 24), find_key("", 1, 24, "", "", &[]));
    }

    #[test]
    fn prune_drops_oldest_first() {
        let mut store = Store::default();
        for index in 0..(MAX_ENTRIES + 5) {
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
        assert_eq!(store.entries[0].key, "detail|5", "最旧的 5 条应被丢弃");
    }

    #[test]
    fn load_tolerates_broken_file() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-cache-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        fs::write(&path, b"\xEF\xBB\xBFnot a json").unwrap();
        let store = load(&path);
        assert!(store.entries.is_empty());
        assert_eq!(store.version, CURRENT_VERSION);
        let _ = fs::remove_dir_all(&dir);
    }
}
