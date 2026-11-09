//! 本地模组的「是否有新版本」批量检测。
//!
//! 检测分两阶段：
//! 1. **主检测**：调用官方 `/Installed`（一次 50 条分页，最多 20 页），
//!    把服务端的 `lastUpdate` / `updateAvailable` 与本地 `mod-status.json` 的 `LastUpdate`
//!    在内存里比对。
//! 2. **补充检测**：对有官方 Workshop ID 但不在 `/Installed` 返回中的模组，
//!    逐个调用 `/Detail/{id}` 查询 `lastUpdate`，与本地时间比较。
//!    请求间隔 500ms，避免触发限流。
//!
//! 判定规则（任一成立即视为有新版本）：
//! 1. 服务端 `updateAvailable == true`（仅 /Installed 返回此字段）
//! 2. 服务端 `lastUpdate` 比本地 `LastUpdate` 大超过 [`TOLERANCE_MS`]
//!
//! 服务端时间可能是 ISO 字符串、秒或毫秒时间戳，统一归一化到毫秒再比较。

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use crate::metadata::Store;
use crate::online::models::FindResult;

/// 时钟漂移容忍：小于 2 秒的差异不算更新
const TOLERANCE_MS: i64 = 2_000;
/// 每页条数（官方 /Installed 上限 50）
pub const PAGE_SIZE: i64 = 50;
/// 最多翻页数（20 × 50 = 1000 条，足够覆盖个人订阅量，同时避免无限翻页）
pub const MAX_PAGES: usize = 20;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModUpdateItem {
    /// 与前端 `ModEntry.id` 完全一致：`local:文件夹名` / `subscribed:文件夹名`
    pub entry_id: String,
    pub mod_id: i64,
    /// 官方 WorkshopID（用于匹配 /Installed）；无官方身份时为 0
    #[serde(skip_serializing_if = "is_zero")]
    pub workshop_id: i64,
    pub folder_name: String,
    pub has_update: bool,
    pub local_last_update_ms: Option<i64>,
    pub server_last_update_ms: Option<i64>,
    /// 服务端没有返回这个模组（本地独有 / 未订阅 / 不在第一页范围内）
    pub unknown: bool,
    /// 检测分类：matched / known_not_in_installed / no_workshop_id / data_incomplete
    pub category: String,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModUpdateReport {
    pub checked_at_ms: i64,
    pub total_local: usize,
    pub update_count: usize,
    pub unknown_count: usize,
    /// 服务端报告的已订阅总数（可能为 None）
    pub server_total: Option<i64>,
    /// 实际请求了几页 /Installed（日志/界面展示用）
    pub pages: usize,
    /// Detail 补充检测：发起了多少次 Detail 请求
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_requested: usize,
    /// Detail 补充检测：成功返回了多少条
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_succeeded: usize,
    /// Detail 补充检测：失败了多少条
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_failed: usize,
    /// Detail 补充检测：缓存命中数（未发网络请求）
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_cache_hit: usize,
    /// Detail 补充检测：网络请求成功数
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_network_ok: usize,
    /// Detail 补充检测：网络请求失败数
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub detail_network_failed: usize,
    pub items: Vec<ModUpdateItem>,
}

fn is_zero_usize(v: &usize) -> bool {
    *v == 0
}

/// 一条本地模组记录
#[derive(Clone, Debug)]
pub struct LocalMod {
    pub entry_id: String,
    /// 元数据中的模组 ID（可能为 0，不用于官方匹配）
    pub mod_id: i64,
    /// 官方 WorkshopID（用于匹配 /Installed）；无官方身份时为 None
    pub workshop_id: Option<i64>,
    pub folder_name: String,
    pub last_update_ms: Option<i64>,
}

/// 服务端单条模组的比对信息
#[derive(Clone, Debug, Default)]
pub struct ServerMod {
    pub last_update_ms: Option<i64>,
    pub update_available: bool,
}

fn as_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(n) => n.as_u64().or_else(|| n.as_i64().map(|v| v.max(0) as u64)),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// `local//foo` → ("local", "foo")；只有这两类目录才参与比对
fn split_status_path(raw: &str) -> Option<(String, String)> {
    let normalized = raw.replace('\\', "/");
    let mut parts = normalized.split('/').filter(|s| !s.is_empty());
    let kind = parts.next()?.to_lowercase();
    let folder = parts.next()?.trim().to_string();
    if folder.is_empty() {
        return None;
    }
    match kind.as_str() {
        "local" | "subscribed" => Some((kind, folder)),
        _ => None,
    }
}

/// 收集参与比对的本地模组。
///
/// 两路来源合并（同一文件夹只算一条）：
/// 1. `mod_metadata.json` —— 本工具装过的，`WorkshopID` 可能已被置 0，只能靠文件夹名对应
/// 2. `mod-status.json` 里 `WorkshopID > 0` 且工具没碰过的记录 —— 游戏自己订阅的
///
/// workshop_id 提取优先级：
///   mod-status.json 的 WorkshopID > 0  →  元数据 mod_id > 0  →  None
pub fn local_mods(root: &Path, store: &Store) -> Vec<LocalMod> {
    // (entry_id, folder, workshop_id_from_status, last_update_ms)
    let mut records: Vec<(String, String, Option<u64>, Option<i64>)> = Vec::new();

    if let Ok(bytes) = std::fs::read(root.join("mod-status.json")) {
        let text = String::from_utf8_lossy(&bytes).to_string();
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(mods) = value.get("Mods").and_then(|m| m.as_array()) {
                for record in mods {
                    let raw_path = record.get("Path").and_then(|v| v.as_str()).unwrap_or("");
                    let Some((kind, folder)) = split_status_path(raw_path) else {
                        continue;
                    };
                    let workshop_id = as_u64(record.get("WorkshopID")).filter(|id| *id > 0);
                    let last_update = as_i64(record.get("LastUpdate")).filter(|ms| *ms > 0);
                    records.push((format!("{kind}:{folder}"), folder, workshop_id, last_update));
                }
            }
        }
    }

    /// 合并两路 workshop_id 来源：status 优先，metadata 兜底
    fn merge_workshop_id(
        status_ws: Option<u64>,
        meta_mod_id: i64,
    ) -> Option<i64> {
        if let Some(id) = status_ws {
            return Some(id as i64);
        }
        if meta_mod_id > 0 {
            return Some(meta_mod_id);
        }
        None
    }

    let mut out: Vec<LocalMod> = Vec::new();
    let mut consumed: Vec<usize> = Vec::new();

    // ① 元数据优先：能拿到真实的 WorkshopID 与文件夹名
    for meta in store.mods.values() {
        let folder = meta.folder_name.clone().unwrap_or_default();
        if folder.is_empty() {
            continue;
        }
        let hit = records
            .iter()
            .enumerate()
            .find(|(index, rec)| !consumed.contains(index) && rec.1.eq_ignore_ascii_case(&folder));
        match hit {
            Some((index, rec)) => {
                consumed.push(index);
                let workshop_id = merge_workshop_id(rec.2, meta.mod_id);
                out.push(LocalMod {
                    entry_id: rec.0.clone(),
                    mod_id: meta.mod_id,
                    workshop_id,
                    folder_name: rec.1.clone(),
                    last_update_ms: rec.3,
                });
            }
            None => {
                // 磁盘上有目录、但 mod-status.json 里还是 local// 以外的形态：按存在性推断
                let kind = if root.join("local").join(&folder).is_dir() {
                    "local"
                } else {
                    "subscribed"
                };
                let workshop_id = merge_workshop_id(None, meta.mod_id);
                out.push(LocalMod {
                    entry_id: format!("{kind}:{folder}"),
                    mod_id: meta.mod_id,
                    workshop_id,
                    folder_name: folder,
                    last_update_ms: None,
                });
            }
        }
    }

    // ② 游戏自己订阅、工具从未写入元数据的记录
    for (index, rec) in records.iter().enumerate() {
        if consumed.contains(&index) {
            continue;
        }
        let Some(workshop_id) = rec.2 else { continue };
        out.push(LocalMod {
            entry_id: rec.0.clone(),
            mod_id: workshop_id as i64,
            workshop_id: Some(workshop_id as i64),
            folder_name: rec.1.clone(),
            last_update_ms: rec.3,
        });
    }

    out
}

/// 时间戳归一化到毫秒：小于 1e11 视为秒
fn normalize_epoch(value: i64) -> Option<i64> {
    if value <= 0 {
        return None;
    }
    if value < 100_000_000_000 {
        Some(value.saturating_mul(1000))
    } else {
        Some(value)
    }
}

/// Detail 请求间隔（500ms），避免触发官方限流
pub const DETAIL_REQUEST_INTERVAL_MS: u64 = 500;

/// Detail 并发数上限
pub const DETAIL_CONCURRENCY: usize = 5;

/// Detail 缓存有效期（24 小时）
pub const DETAIL_CACHE_TTL_MS: u64 = 86_400_000;

/// 单条 Detail 查询结果（线程间传递），区分缓存命中与网络请求
#[derive(Clone, Debug)]
pub enum DetailResult {
    /// 缓存命中，成功获取到 lastUpdate
    CacheHit(i64),
    /// 缓存命中，但缺少 lastUpdate 字段
    CacheNoTime,
    /// 网络请求成功，获取到 lastUpdate
    NetworkTime(i64),
    /// 网络请求成功，但缺少 lastUpdate 字段
    NetworkNoTime,
    /// 网络请求失败（超时/404/限流等）
    NetworkFailed,
}

/// 对 `known_not_in_installed` 的模组调 Detail 补充查询。
///
/// detail_fn 是实际发起 HTTP 请求或读缓存的闭包（由 lib.rs 传入）。
/// 返回 Ok(Some(ms)) = 有时间；Ok(None) = 无时间；Err = 失败。
///
/// 缓存由 lib.rs 闭包内部处理（先查缓存再发网络请求），本函数只负责调度。
/// 未命中缓存的请求最多 DETAIL_CONCURRENCY 路并发执行。
pub fn supplement_with_detail<F>(
    report: &mut ModUpdateReport,
    detail_fn: F,
    on_progress: Option<&dyn Fn(usize, usize, &ModUpdateItem)>,
) where
    F: Fn(i64) -> DetailResult + Sync,
{
    // 收集需要补充检测的 item 索引
    let targets: Vec<(usize, i64)> = report
        .items
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            if item.category == "known_not_in_installed" && item.workshop_id > 0 {
                Some((idx, item.workshop_id))
            } else {
                None
            }
        })
        .collect();

    if targets.is_empty() {
        return;
    }

    report.detail_requested = targets.len();
    let total = targets.len();

    // 任务队列：worker 从中取 (slot_idx, (item_idx, ws_id))
    let queue: std::sync::Mutex<Vec<(usize, (usize, i64))>> = std::sync::Mutex::new(
        targets.iter().enumerate().map(|(i, &t)| (i, t)).collect(),
    );

    // channel：worker → 主线程，发送完成的 slot_idx
    let (tx, rx) = std::sync::mpsc::channel::<(usize, DetailResult)>();

    // 存放每个 slot 的结果（由主线程写入）
    let mut slot_results: Vec<Option<DetailResult>> = vec![None; total];
    let mut processed_count = 0usize;

    std::thread::scope(|s| {
        for worker_id in 0..DETAIL_CONCURRENCY {
            let tx = tx.clone();
            let queue = &queue;
            let detail_fn = &detail_fn;
            s.spawn(move || {
                loop {
                    let task = {
                        let mut guard = queue.lock().unwrap();
                        if guard.is_empty() {
                            None
                        } else {
                            Some(guard.pop().unwrap())
                        }
                    };
                    let Some((slot_idx, (_item_idx, ws_id))) = task else {
                        break;
                    };

                    let result = detail_fn(ws_id);

                    let _ = tx.send((slot_idx, result));

                    // worker 之间轻微错开
                    if worker_id > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            });
        }
        drop(tx);

        // 主线程按完成顺序处理结果
        while let Ok((slot_idx, result)) = rx.recv() {
            let (item_idx, _ws_id) = targets[slot_idx];
            apply_detail_result(report, item_idx, result.clone());
            slot_results[slot_idx] = Some(result);
            processed_count += 1;
            if let Some(cb) = on_progress {
                cb(processed_count, total, &report.items[item_idx]);
            }
        }
    });

    // 重新统计
    report.update_count = report.items.iter().filter(|i| i.has_update).count();
    report.unknown_count = report.items.iter().filter(|i| i.unknown).count();
}

fn apply_detail_result(
    report: &mut ModUpdateReport,
    item_idx: usize,
    result: DetailResult,
) {
    match result {
        DetailResult::CacheHit(server_ms) => {
            report.detail_cache_hit += 1;
            report.detail_succeeded += 1;
            apply_server_time(report, item_idx, server_ms);
        }
        DetailResult::CacheNoTime => {
            report.detail_cache_hit += 1;
            report.detail_succeeded += 1;
            let item = &mut report.items[item_idx];
            item.category = "data_incomplete".to_string();
        }
        DetailResult::NetworkTime(server_ms) => {
            report.detail_network_ok += 1;
            report.detail_succeeded += 1;
            apply_server_time(report, item_idx, server_ms);
        }
        DetailResult::NetworkNoTime => {
            report.detail_network_ok += 1;
            report.detail_succeeded += 1;
            let item = &mut report.items[item_idx];
            item.category = "data_incomplete".to_string();
        }
        DetailResult::NetworkFailed => {
            report.detail_network_failed += 1;
            report.detail_failed += 1;
            let item = &mut report.items[item_idx];
            item.category = "detail_failed".to_string();
        }
    }
}

/// 应用服务端时间到 item（缓存命中和网络成功共用）
fn apply_server_time(report: &mut ModUpdateReport, item_idx: usize, server_ms: i64) {
    let item = &mut report.items[item_idx];
    let newer = match (server_ms, item.local_last_update_ms) {
        (s, Some(local)) => s > local + TOLERANCE_MS,
        _ => false,
    };
    if item.local_last_update_ms.is_none() {
        item.category = "data_incomplete".to_string();
        item.unknown = true;
    } else {
        item.category = "matched".to_string();
        item.unknown = false;
        item.has_update = newer;
    }
    item.server_last_update_ms = Some(server_ms);
}

/// 公历日期 → Unix 纪元天数（Howard Hinnant 算法，避免引入 chrono 依赖）
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 解析 `2024-05-06T07:08:09Z` / `2024-05-06 07:08:09` / `2024-05-06`
fn parse_iso_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim().trim_end_matches('Z');
    let (date_part, time_part) = match trimmed.find(['T', ' ']) {
        Some(index) => (&trimmed[..index], &trimmed[index + 1..]),
        None => (trimmed, ""),
    };
    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: i64 = date_iter.next()?.parse().ok()?;
    let day: i64 = date_iter.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut seconds = 0i64;
    if !time_part.is_empty() {
        let time_part = time_part.split('.').next().unwrap_or(time_part);
        let mut time_iter = time_part.split(':');
        let hour: i64 = time_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let minute: i64 = time_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let second: i64 = time_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        seconds = hour * 3600 + minute * 60 + second;
    }
    Some((days_from_civil(year, month, day) * 86_400 + seconds) * 1000)
}

/// 服务端条目里的 `lastUpdate`（可能是数字、秒/毫秒时间戳或 ISO 字符串）
pub fn parse_server_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => normalize_epoch(n.as_i64()?),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(number) = trimmed.parse::<i64>() {
                return normalize_epoch(number);
            }
            parse_iso_ms(trimmed)
        }
        _ => None,
    }
}

/// 把一页 `/Installed` 结果并进服务端索引（只保留比对需要的字段）
pub fn collect_page(page: &FindResult, server: &mut HashMap<i64, ServerMod>) {
    for item in &page.items {
        server.insert(
            item.mod_id,
            ServerMod {
                last_update_ms: parse_server_ms(item.raw.get("lastUpdate")),
                update_available: item.update_available,
            },
        );
    }
}

/// 纯逻辑比对：可直接单测，不碰网络
pub fn build_report(
    locals: &[LocalMod],
    server: &HashMap<i64, ServerMod>,
    server_total: Option<i64>,
    pages: usize,
) -> ModUpdateReport {
    let mut items = Vec::with_capacity(locals.len());
    for local in locals {
        let entry_id = local.entry_id.clone();
        let folder_name = local.folder_name.clone();
        let mod_id = local.mod_id;

        // 没有有效官方 ID：无法与服务端比对
        let Some(ws) = local.workshop_id else {
            items.push(ModUpdateItem {
                entry_id,
                mod_id,
                workshop_id: 0,
                folder_name,
                has_update: false,
                local_last_update_ms: local.last_update_ms,
                server_last_update_ms: None,
                unknown: true,
                category: "no_workshop_id".to_string(),
            });
            continue;
        };

        // 有官方 ID，但 /Installed 未返回该记录
        let Some(remote) = server.get(&ws) else {
            items.push(ModUpdateItem {
                entry_id,
                mod_id,
                workshop_id: ws,
                folder_name,
                has_update: false,
                local_last_update_ms: local.last_update_ms,
                server_last_update_ms: None,
                unknown: true,
                category: "known_not_in_installed".to_string(),
            });
            continue;
        };

        // 已匹配到服务端记录
        let newer_by_time = match (remote.last_update_ms, local.last_update_ms) {
            (Some(server_ms), Some(local_ms)) => server_ms > local_ms + TOLERANCE_MS,
            _ => false,
        };

        // 数据不完整：有官方身份和服务端记录，但缺少时间数据无法可靠比较
        let category = if remote.update_available {
            // 官方已标记有更新，直接判定
            "matched".to_string()
        } else if remote.last_update_ms.is_none() || local.last_update_ms.is_none() {
            // 时间数据缺失，无法做时间比较，且 updateAvailable=false
            "data_incomplete".to_string()
        } else {
            "matched".to_string()
        };

        items.push(ModUpdateItem {
            entry_id,
            mod_id,
            workshop_id: ws,
            folder_name,
            has_update: remote.update_available || newer_by_time,
            local_last_update_ms: local.last_update_ms,
            server_last_update_ms: remote.last_update_ms,
            unknown: false,
            category,
        });
    }

    let unknown_count = items.iter().filter(|i| i.unknown).count();
    ModUpdateReport {
        checked_at_ms: crate::scan::now_ms(),
        total_local: items.len(),
        update_count: items.iter().filter(|i| i.has_update).count(),
        unknown_count,
        server_total,
        pages,
        detail_requested: 0,
        detail_succeeded: 0,
        detail_failed: 0,
        detail_cache_hit: 0,
        detail_network_ok: 0,
        detail_network_failed: 0,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local(entry: &str, mod_id: i64, ws: Option<i64>, last: Option<i64>) -> LocalMod {
        LocalMod {
            entry_id: entry.to_string(),
            mod_id,
            workshop_id: ws,
            folder_name: entry.split(':').nth(1).unwrap_or("x").to_string(),
            last_update_ms: last,
        }
    }

    #[test]
    fn update_available_flag_wins() {
        let mut server = HashMap::new();
        server.insert(7, ServerMod { last_update_ms: Some(1_000), update_available: true });
        let report = build_report(&[local("local:A", 7, Some(7), Some(9_999))], &server, Some(1), 1);
        assert_eq!(report.update_count, 1);
        assert!(report.items[0].has_update);
        assert_eq!(report.items[0].category, "matched");
    }

    #[test]
    fn newer_server_timestamp_flags_update() {
        let mut server = HashMap::new();
        server.insert(8, ServerMod { last_update_ms: Some(2_000_000), update_available: false });
        let report = build_report(&[local("local:B", 8, Some(8), Some(1_000_000))], &server, Some(1), 1);
        assert!(report.items[0].has_update);
        assert_eq!(report.items[0].category, "matched");
    }

    #[test]
    fn same_or_older_server_is_not_an_update() {
        let mut server = HashMap::new();
        server.insert(9, ServerMod { last_update_ms: Some(1_000_000), update_available: false });
        let report = build_report(&[local("local:C", 9, Some(9), Some(1_000_500))], &server, Some(1), 1);
        assert!(!report.items[0].has_update);
        assert!(!report.items[0].unknown);
        assert_eq!(report.items[0].category, "matched");
    }

    #[test]
    fn missing_server_entry_is_known_not_in_installed() {
        let report = build_report(&[local("local:D", 10, Some(10), Some(1))], &HashMap::new(), None, 1);
        assert_eq!(report.unknown_count, 1);
        assert!(!report.items[0].has_update);
        assert_eq!(report.items[0].category, "known_not_in_installed");
    }

    #[test]
    fn no_workshop_id_is_third_party_local() {
        let report = build_report(&[local("local:E", 0, None, Some(1))], &HashMap::new(), None, 1);
        assert_eq!(report.unknown_count, 1);
        assert!(!report.items[0].has_update);
        assert_eq!(report.items[0].category, "no_workshop_id");
        assert_eq!(report.items[0].workshop_id, 0);
    }

    #[test]
    fn data_incomplete_when_timestamps_missing() {
        let mut server = HashMap::new();
        server.insert(15, ServerMod { last_update_ms: None, update_available: false });
        let report = build_report(&[local("local:F", 15, Some(15), None)], &server, Some(1), 1);
        assert!(!report.items[0].has_update);
        assert_eq!(report.items[0].category, "data_incomplete");
        assert!(!report.items[0].unknown);
    }

    #[test]
    fn mod_id_zero_but_workshop_id_valid_matches_server() {
        // mod_id=0（本地导入），但 workshop_id 有效 → 应能匹配服务端
        let mut server = HashMap::new();
        server.insert(4242, ServerMod { last_update_ms: Some(5_000_000), update_available: false });
        let report = build_report(
            &[local("local:G", 0, Some(4242), Some(1_000_000))],
            &server,
            Some(1),
            1,
        );
        assert!(report.items[0].has_update);
        assert_eq!(report.items[0].category, "matched");
        assert_eq!(report.items[0].workshop_id, 4242);
    }

    #[test]
    fn timestamp_formats_are_normalized() {
        assert_eq!(parse_server_ms(Some(&json!(1_700_000_000))), Some(1_700_000_000_000));
        assert_eq!(parse_server_ms(Some(&json!(1_700_000_000_123i64))), Some(1_700_000_000_123));
        assert_eq!(parse_server_ms(Some(&json!("1700000000"))), Some(1_700_000_000_000));
        assert_eq!(
            parse_server_ms(Some(&json!("2023-11-14T22:13:20Z"))),
            Some(1_700_000_000_000)
        );
        assert_eq!(parse_server_ms(Some(&json!(""))), None);
        assert_eq!(parse_server_ms(None), None);
    }

    #[test]
    fn status_paths_are_split_by_kind() {
        assert_eq!(
            split_status_path("local//384528_Foo"),
            Some(("local".to_string(), "384528_Foo".to_string()))
        );
        assert_eq!(
            split_status_path("subscribed\\206048_Bar"),
            Some(("subscribed".to_string(), "206048_Bar".to_string()))
        );
        assert_eq!(split_status_path("local//"), None);
        assert_eq!(split_status_path("weird//x"), None);
    }

    // ---------------- supplement_with_detail 测试 ----------------

    fn base_report() -> ModUpdateReport {
        // 3 个本地模组：
        // - A: ws=100，/Installed 未命中 → known_not_in_installed
        // - B: ws=200，/Installed 未命中 → known_not_in_installed
        // - C: ws=0，无官方 ID → no_workshop_id
        let locals = vec![
            local("local:A", 100, Some(100), Some(1_000_000)),
            local("local:B", 200, Some(200), Some(2_000_000)),
            local("local:C", 0, None, Some(500_000)),
        ];
        build_report(&locals, &HashMap::new(), None, 1)
    }

    #[test]
    fn detail_successful_newer_marks_update() {
        let mut report = base_report();
        // A 的 Detail 返回 2_000_000 > 本地 1_000_000 → 有更新
        // B 的 Detail 返回 1_500_000 < 本地 2_000_000 → 无更新
        supplement_with_detail(&mut report, |ws_id| {
            match ws_id {
                100 => DetailResult::NetworkTime(2_000_000),
                200 => DetailResult::NetworkTime(1_500_000),
                _ => DetailResult::NetworkFailed,
            }
        }, None);
        assert_eq!(report.detail_requested, 2);
        assert_eq!(report.detail_succeeded, 2);
        assert_eq!(report.detail_failed, 0);
        assert_eq!(report.detail_network_ok, 2);
        // A: matched, has_update=true
        assert_eq!(report.items[0].category, "matched");
        assert!(report.items[0].has_update);
        // B: matched, has_update=false
        assert_eq!(report.items[1].category, "matched");
        assert!(!report.items[1].has_update);
        // C: no_workshop_id 不变
        assert_eq!(report.items[2].category, "no_workshop_id");
        assert_eq!(report.update_count, 1);
    }

    #[test]
    fn detail_failed_keeps_detail_failed_category() {
        let mut report = base_report();
        supplement_with_detail(&mut report, |_ws_id| {
            DetailResult::NetworkFailed
        }, None);
        assert_eq!(report.detail_failed, 2);
        assert_eq!(report.detail_network_failed, 2);
        assert_eq!(report.items[0].category, "detail_failed");
        assert_eq!(report.items[1].category, "detail_failed");
        // detail_failed 不应进入可更新集合
        assert!(!report.items[0].has_update);
        assert_eq!(report.update_count, 0);
    }

    #[test]
    fn detail_missing_last_update_is_data_incomplete() {
        let mut report = base_report();
        // Detail 成功但没有 lastUpdate 字段 → NoTime
        supplement_with_detail(&mut report, |_ws_id| DetailResult::NetworkNoTime, None);
        assert_eq!(report.detail_succeeded, 2);
        assert_eq!(report.items[0].category, "data_incomplete");
        assert_eq!(report.items[1].category, "data_incomplete");
    }

    #[test]
    fn detail_no_local_timestamp_is_data_incomplete() {
        // 本地模组没有 last_update_ms，Detail 返回了也无法比较
        let locals = vec![local("local:D", 300, Some(300), None)];
        let mut report = build_report(&locals, &HashMap::new(), None, 1);
        supplement_with_detail(&mut report, |_ws_id| DetailResult::NetworkTime(5_000_000), None);
        assert_eq!(report.items[0].category, "data_incomplete");
        assert!(!report.items[0].has_update);
    }

    #[test]
    fn detail_skips_already_matched() {
        // 已在 /Installed 匹配的模组不应该再被 Detail 查询
        let mut server = HashMap::new();
        server.insert(100, ServerMod { last_update_ms: Some(1_000), update_available: false });
        let locals = vec![local("local:A", 100, Some(100), Some(1_000))];
        let mut report = build_report(&locals, &server, Some(1), 1);
        supplement_with_detail(&mut report, |_ws_id| {
            panic!("不应查询已匹配的模组");
        }, None);
        assert_eq!(report.detail_requested, 0);
    }

    #[test]
    fn cache_hit_is_counted_separately() {
        let mut report = base_report();
        // 模拟缓存命中：返回 CacheHit 而不是 NetworkTime
        supplement_with_detail(&mut report, |ws_id| {
            match ws_id {
                100 => DetailResult::CacheHit(2_000_000),
                200 => DetailResult::NetworkTime(1_500_000),
                _ => DetailResult::NetworkFailed,
            }
        }, None);
        assert_eq!(report.detail_cache_hit, 1);
        assert_eq!(report.detail_network_ok, 1);
        assert_eq!(report.detail_network_failed, 0);
        assert_eq!(report.detail_succeeded, 2);
    }
}
