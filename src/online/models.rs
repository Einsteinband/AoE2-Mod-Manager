use serde::Serialize;
use serde_json::Value;

/// 在线模组列表项。
/// 字段名来自官网列表模板实际渲染用到的键（main.js 中的 _.each(items...) 模板），
/// 未确认的字段一律不解析、不臆造，原始 JSON 保留在 `raw` 里以便排查。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OnlineModSummary {
    pub mod_id: i64,
    pub title: String,
    pub creator: Option<String>,
    pub thumbnail: Option<String>,
    pub installs: Option<i64>,
    pub installs_truncated: bool,
    pub rating: Option<f64>,
    pub mod_status: Option<String>,
    pub user_installed: bool,
    pub user_downloaded: bool,
    pub update_available: bool,
    pub game_title_id: Option<i64>,
    /// 官方分类（`modTagIds` / `modTagNames` 一一对应），来自 `/api/v4/mods/Tags` 的 modTypeId
    pub tag_ids: Vec<i64>,
    pub tag_names: Vec<String>,
    /// 列表接口通常不带体积；若服务端带了 `modFileSize`（字节）则透传，否则由详情补
    pub file_size: Option<i64>,
    pub raw: Value,
}

/// `/api/v4/mods/Tags` 的单项：官方分类字典（含所有游戏的标签，前端按 gameTitleId 过滤）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModTag {
    pub mod_type_id: i64,
    pub mod_type_name: String,
    pub game_title_id: Option<i64>,
}

impl ModTag {
    pub fn from_value(raw: &Value) -> Option<Self> {
        Some(Self {
            mod_type_id: pick_i64(raw, &["modTypeId", "modtypeid", "id"])?,
            mod_type_name: pick_str(raw, &["modTypeName", "modtypename", "name"])?,
            game_title_id: pick_i64(raw, &["gameTitleId", "gameId"]),
        })
    }
}

fn pick_value<'a>(raw: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(v) = raw.get(*key) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}

pub fn pick_str(raw: &Value, keys: &[&str]) -> Option<String> {
    let v = pick_value(raw, keys)?;
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn pick_i64(raw: &Value, keys: &[&str]) -> Option<i64> {
    let v = pick_value(raw, keys)?;
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

pub fn pick_f64(raw: &Value, keys: &[&str]) -> Option<f64> {
    let v = pick_value(raw, keys)?;
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub fn pick_i64_vec(raw: &Value, keys: &[&str]) -> Vec<i64> {
    pick_value(raw, keys)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| match v {
                    Value::Number(n) => n.as_i64(),
                    Value::String(s) => s.trim().parse::<i64>().ok(),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn pick_str_vec(raw: &Value, keys: &[&str]) -> Vec<String> {
    pick_value(raw, keys)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| match v {
                    Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn pick_bool(raw: &Value, keys: &[&str]) -> bool {
    match pick_value(raw, keys) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(Value::String(s)) => matches!(s.to_lowercase().as_str(), "true" | "1" | "yes"),
        _ => false,
    }
}

/// 官方列表模板实际用的键（已从 www.ageofempires.com 的 main.js 验证）：
/// `<%= item.modName %>`（标题）、`item.creatorName`、`item.thumbnail`、`item.installs`、
/// `item.installsTruncated`、`item.modStatus`、`item.userInstalled`、`item.updateAvailable`。
/// 厂商把标题叫 `modName` 而不是 `title`，这就是之前全显示“(未命名模组)”的原因。
impl OnlineModSummary {
    pub fn from_value(raw: &Value) -> Option<Self> {
        let mod_id = pick_i64(raw, &["modId", "modid", "id"])?;
        let title = pick_str(raw, &["modName", "title", "name"])
            .unwrap_or_else(|| format!("(未命名模组 #{mod_id})"));
        Some(Self {
            mod_id,
            title,
            creator: pick_str(raw, &["creatorName", "creator", "userName", "author"]),
            thumbnail: pick_str(raw, &["thumbnail", "thumbnailUrl", "image"])
                .filter(|url| !is_placeholder_thumbnail(url)),
            installs: pick_i64(raw, &["installs", "downloadCount"]),
            installs_truncated: pick_bool(raw, &["installsTruncated"]),
            rating: pick_f64(raw, &["rating", "avgRating"]),
            mod_status: pick_str(raw, &["modStatus", "status"]),
            user_installed: pick_bool(raw, &["userInstalled"]),
            user_downloaded: pick_bool(raw, &["userDownloaded"]),
            update_available: pick_bool(raw, &["updateAvailable"]),
            game_title_id: pick_i64(raw, &["gameTitleId", "gameId"]),
            tag_ids: pick_i64_vec(raw, &["modTagIds", "modTagId", "tags"]),
            tag_names: pick_str_vec(raw, &["modTagNames", "modTagName"]),
            file_size: pick_i64(raw, &["modFileSize", "fileSize", "size"]),
            raw: raw.clone(),
        })
    }
}

/// 官方占位图形如 `https://cdn.ageofempires.com/aoe/mods/thumb_`，
/// 官网模板判断无封面的方式就是对比这个字符串（见 main.js 里 length 为 1 的那个 `thumb_`）
fn is_placeholder_thumbnail(url: &str) -> bool {
    let lower = url.trim().trim_end_matches('/').to_ascii_lowercase();
    lower.ends_with("thumb_") || lower.is_empty()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub total_count: Option<i64>,
    pub is_logged_on: bool,
    pub items: Vec<OnlineModSummary>,
    /// 服务端在未抛错但返回 errorCode 时给出的原始提示
    pub server_message: Option<String>,
}

impl FindResult {
    pub fn from_value(value: &Value) -> Self {
        let items = value
            .get("modList")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(OnlineModSummary::from_value).collect())
            .unwrap_or_default();
        Self {
            total_count: pick_i64(value, &["totalCount"]),
            is_logged_on: pick_bool(value, &["isLoggedOn"]),
            items,
            server_message: pick_str(value, &["errorMessage"]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(extra: Value) -> Value {
        let mut base = json!({
            "modId": 409484,
            "modName": "Legacy Ensemble Studios Maps",
            "creatorName": "AoE Official",
            "thumbnail": "https://cdn.ageofempires.com/aoe/mods/409484.jpg",
            "installs": 2215000,
            "installsTruncated": true,
            "modStatus": "Published",
            "userInstalled": true,
            "gameTitleId": 2
        });
        if let (Some(obj), Value::Object(next)) = (base.as_object_mut(), extra) {
            for (k, v) in next {
                obj.insert(k, v);
            }
        }
        base
    }

    #[test]
    fn title_comes_from_mod_name() {
        let parsed = OnlineModSummary::from_value(&item(json!({}))).unwrap();
        assert_eq!(parsed.title, "Legacy Ensemble Studios Maps");
        assert_eq!(parsed.creator.as_deref(), Some("AoE Official"));
        assert_eq!(parsed.installs, Some(2_215_000));
        assert!(parsed.installs_truncated);
        assert!(parsed.user_installed);
    }

    #[test]
    fn title_falls_back_to_title_then_placeholder() {
        let parsed = OnlineModSummary::from_value(&json!({"modId": 7, "title": "Old Field Name"})).unwrap();
        assert_eq!(parsed.title, "Old Field Name");

        let parsed = OnlineModSummary::from_value(&json!({"modId": 8})).unwrap();
        assert_eq!(parsed.title, "(未命名模组 #8)");
    }

    #[test]
    fn tags_and_size_are_parsed() {
        let parsed = OnlineModSummary::from_value(&item(json!({
            "modTagIds": [15, 22],
            "modTagNames": ["Random Maps", "User Interface"],
            "modFileSize": 1048576
        })))
        .unwrap();
        assert_eq!(parsed.tag_ids, vec![15, 22]);
        assert_eq!(parsed.tag_names, vec!["Random Maps", "User Interface"]);
        assert_eq!(parsed.file_size, Some(1_048_576));
    }

    #[test]
    fn tags_default_to_empty_when_absent() {
        let parsed = OnlineModSummary::from_value(&item(json!({}))).unwrap();
        assert!(parsed.tag_ids.is_empty());
        assert!(parsed.tag_names.is_empty());
        assert_eq!(parsed.file_size, None);
    }

    #[test]
    fn mod_tag_parses_from_tags_payload() {
        let tag = ModTag::from_value(&json!({
            "modTypeId": 15,
            "modTypeName": "Random Maps",
            "gameTitleId": 2
        }))
        .unwrap();
        assert_eq!(tag.mod_type_id, 15);
        assert_eq!(tag.mod_type_name, "Random Maps");
        assert_eq!(tag.game_title_id, Some(2));
        assert!(ModTag::from_value(&json!({ "modTypeName": "缺 id" })).is_none());
    }

    #[test]
    fn placeholder_thumbnail_is_dropped() {
        let parsed = OnlineModSummary::from_value(&item(json!({ "thumbnail": "https://cdn.ageofempires.com/aoe/mods/thumb_" })))
            .unwrap();
        assert_eq!(parsed.thumbnail, None);
    }
}
