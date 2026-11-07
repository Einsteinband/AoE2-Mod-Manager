//! 本地模组的「是否有新版本」批量检测。
//!
//! 防封号原则：**绝不对 180 个模组逐个请求 `/Detail`**。
//! 这里只调用官方 `/Installed`（一次 50 条分页，最多 20 页），
//! 把服务端的 `lastUpdate` / `updateAvailable` 与本地 `mod-status.json` 的 `LastUpdate`
//! 在内存里比对，全程只读、不写游戏目录。
//!
//! 判定规则（任一成立即视为有新版本）：
//! 1. 服务端 `updateAvailable == true`（官网列表也是用这个字段打「Update Available」角标，
//!    前提是 `userInstalled`，官方接口已经替你算好了）
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
    pub folder_name: String,
    pub has_update: bool,
    pub local_last_update_ms: Option<i64>,
    pub server_last_update_ms: Option<i64>,
    /// 服务端没有返回这个模组（本地独有 / 未订阅 / 不在第一页范围内）
    pub unknown: bool,
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
    /// 实际请求了几页（日志/界面展示用，便于确认没有逐个请求 Detail）
    pub pages: usize,
    pub items: Vec<ModUpdateItem>,
}

/// 一条本地模组记录
#[derive(Clone, Debug)]
pub struct LocalMod {
    pub entry_id: String,
    pub mod_id: i64,
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
pub fn local_mods(root: &Path, store: &Store) -> Vec<LocalMod> {
    // (entry_id, folder, workshop_id, last_update_ms)
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
                out.push(LocalMod {
                    entry_id: rec.0.clone(),
                    mod_id: meta.mod_id,
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
                out.push(LocalMod {
                    entry_id: format!("{kind}:{folder}"),
                    mod_id: meta.mod_id,
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
        let Some(remote) = server.get(&local.mod_id) else {
            items.push(ModUpdateItem {
                entry_id,
                mod_id: local.mod_id,
                folder_name: local.folder_name.clone(),
                has_update: false,
                local_last_update_ms: local.last_update_ms,
                server_last_update_ms: None,
                unknown: true,
            });
            continue;
        };
        let newer_by_time = match (remote.last_update_ms, local.last_update_ms) {
            (Some(server_ms), Some(local_ms)) => server_ms > local_ms + TOLERANCE_MS,
            _ => false,
        };
        items.push(ModUpdateItem {
            entry_id,
            mod_id: local.mod_id,
            folder_name: local.folder_name.clone(),
            has_update: remote.update_available || newer_by_time,
            local_last_update_ms: local.last_update_ms,
            server_last_update_ms: remote.last_update_ms,
            unknown: false,
        });
    }

    ModUpdateReport {
        checked_at_ms: crate::scan::now_ms(),
        total_local: items.len(),
        update_count: items.iter().filter(|i| i.has_update).count(),
        unknown_count: items.iter().filter(|i| i.unknown).count(),
        server_total,
        pages,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local(entry: &str, mod_id: i64, last: Option<i64>) -> LocalMod {
        LocalMod {
            entry_id: entry.to_string(),
            mod_id,
            folder_name: entry.split(':').nth(1).unwrap_or("x").to_string(),
            last_update_ms: last,
        }
    }

    #[test]
    fn update_available_flag_wins() {
        let mut server = HashMap::new();
        server.insert(
            7,
            ServerMod { last_update_ms: Some(1_000), update_available: true },
        );
        let report = build_report(&[local("local:A", 7, Some(9_999))], &server, Some(1), 1);
        assert_eq!(report.update_count, 1);
        assert!(report.items[0].has_update);
    }

    #[test]
    fn newer_server_timestamp_flags_update() {
        let mut server = HashMap::new();
        server.insert(
            8,
            ServerMod { last_update_ms: Some(2_000_000), update_available: false },
        );
        let report = build_report(&[local("local:B", 8, Some(1_000_000))], &server, Some(1), 1);
        assert!(report.items[0].has_update);
    }

    #[test]
    fn same_or_older_server_is_not_an_update() {
        let mut server = HashMap::new();
        server.insert(
            9,
            ServerMod { last_update_ms: Some(1_000_000), update_available: false },
        );
        let report = build_report(&[local("local:C", 9, Some(1_000_500))], &server, Some(1), 1);
        assert!(!report.items[0].has_update);
        assert!(!report.items[0].unknown);
    }

    #[test]
    fn missing_server_entry_is_unknown_not_update() {
        let report = build_report(&[local("local:D", 10, Some(1))], &HashMap::new(), None, 1);
        assert_eq!(report.unknown_count, 1);
        assert!(!report.items[0].has_update);
    }

    #[test]
    fn timestamp_formats_are_normalized() {
        // 秒 → 毫秒
        assert_eq!(parse_server_ms(Some(&json!(1_700_000_000))), Some(1_700_000_000_000));
        // 毫秒原样
        assert_eq!(parse_server_ms(Some(&json!(1_700_000_000_123i64))), Some(1_700_000_000_123));
        // 数字字符串
        assert_eq!(parse_server_ms(Some(&json!("1700000000"))), Some(1_700_000_000_000));
        // ISO 字符串（UTC）
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
}
