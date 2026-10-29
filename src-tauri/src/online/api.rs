use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

use super::models::{pick_str, FindResult, ModTag};

/// 官方模组服务基址（来自官网 main.js：const V="https://api.ageofempires.com",
/// F=V+"/api/v4/mods"）
pub const API_BASE: &str = "https://api.ageofempires.com";
pub const MODS_PATH: &str = "/api/v4/mods";
pub const WEBSITE_ORIGIN: &str = "https://www.ageofempires.com";
pub const MODS_REFERER: &str = "https://www.ageofempires.com/mods/";
/// AoE II: DE 在官网 mods 页对应 game=2（`_gameHero`： "2" → aoeII）
pub const GAME_AOE2DE: i64 = 2;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiFailure {
    /// unauthenticated | http | network | timeout | parse | not_found | invalid
    pub kind: String,
    pub message: String,
    pub status: Option<u16>,
}

impl ApiFailure {
    pub fn new(kind: &str, message: impl Into<String>, status: Option<u16>) -> Self {
        Self { kind: kind.to_string(), message: message.into(), status }
    }
    pub fn unauthenticated() -> Self {
        Self::new("unauthenticated", "登录状态无效或已过期，请重新登录", Some(401))
    }
    pub fn network(msg: impl Into<String>) -> Self {
        Self::new("network", format!("网络请求失败：{}", msg.into()), None)
    }
    pub fn parse(msg: impl Into<String>) -> Self {
        Self::new("parse", format!("服务端返回内容无法解析：{}", msg.into()), None)
    }
}

/// 代理由 [`crate::net`] 统一决定（手动 > 系统注册表 > 环境变量 > 直连），
/// 这里只负责把它交给 ureq。ureq 2.x 自己不会读 Windows 系统代理设置。
pub struct ApiClient {
    agent: ureq::Agent,
    cookie: String,
}

impl ApiClient {
    pub fn new(cookie: impl Into<String>, proxy: Option<ureq::Proxy>) -> Self {
        let mut builder = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(12))
            .timeout_read(Duration::from_secs(45))
            .timeout_write(Duration::from_secs(20))
            .user_agent("AoE2ModManager/0.1 (Windows; local read-only prototype)");
        match proxy {
            Some(proxy) => {
                builder = builder.proxy(proxy);
            }
            None => {
                log::info!(target: "http", "本次请求直连（未使用代理）");
            }
        }
        Self { agent: builder.build(), cookie: cookie.into() }
    }

    /// 统一请求头：官方接口要求同站来源
    fn request(&self, method: &str, path: &str) -> ureq::Request {
        let url = format!("{API_BASE}{MODS_PATH}{path}");
        let req = if method == "GET" { self.agent.get(&url) } else { self.agent.post(&url) };
        req.set("Cookie", &self.cookie)
            .set("Origin", WEBSITE_ORIGIN)
            .set("Referer", MODS_REFERER)
            .set("Accept", "application/json")
    }

    fn finish(
        &self,
        url: &str,
        result: Result<ureq::Response, ureq::Error>,
    ) -> Result<Value, ApiFailure> {
        match result {
            Ok(resp) => {
                log::info!(target: "http", "HTTP {}（{url}）", resp.status());
                resp.into_string()
                    .map_err(|e| ApiFailure::parse(e.to_string()))
                    .and_then(|text| {
                        if text.trim().is_empty() {
                            // 订阅类接口可能返回 200 + 空响应体
                            return Ok(Value::Null);
                        }
                        serde_json::from_str::<Value>(&text).map_err(|e| {
                            ApiFailure::parse(format!("{e}（前 160 字符：{}）", snippet(&text, 160)))
                        })
                    })
            }
            Err(ureq::Error::Status(code, resp)) => {
                let allow = resp.header("Allow").unwrap_or("").to_string();
                log::warn!(target: "http", "HTTP {code}（{url}）Allow={allow}");
                let body = resp.into_string().unwrap_or_default();
                if code == 401 {
                    return Err(ApiFailure::unauthenticated());
                }
                let server_msg = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| pick_str(&v, &["errorMessage", "message"]));
                Err(ApiFailure::new(
                    if code == 404 { "not_found" } else { "http" },
                    format!(
                        "服务端返回 HTTP {code}{}{}",
                        server_msg.map(|m| format!("：{m}")).unwrap_or_default(),
                        if code == 405 && !allow.is_empty() {
                            format!("（该接口只接受 {allow} 请求）")
                        } else {
                            String::new()
                        }
                    ),
                    Some(code),
                ))
            }
            Err(ureq::Error::Transport(t)) => {
                let msg = t.to_string();
                log::error!(target: "http", "传输层错误（{url}）：{msg}");
                // DNS / 连接 / TLS / 超时 一律归为 kind="network"：
                // 前端据此点亮全局「网络已断开」，并在断网时停止一切后续请求。
                Err(transport_failure(msg))
            }
        }
    }

    /// 只有 Find / Installed / Featured / Tags 是 POST（实测 GET 返回 405）
    fn post(&self, path: &str, body: &Value) -> Result<Value, ApiFailure> {
        let url = format!("{API_BASE}{MODS_PATH}{path}");
        log::info!(target: "http", "POST {url}");
        let result = self.request("POST", path).send_json(body);
        self.finish(&url, result)
    }

    /// Detail / Download / Subscribe / UnSubscribe 实测为 **GET**：
    /// POST 会返回 405 且响应头 `Allow: GET`，GET 才正常进入认证或成功。
    fn get(&self, path: &str) -> Result<Value, ApiFailure> {
        let url = format!("{API_BASE}{MODS_PATH}{path}");
        log::info!(target: "http", "GET {url}");
        let result = self.request("GET", path).call();
        self.finish(&url, result)
    }

    /// POST {F}/Find —— 请求体字段来自官网 `queryParams` 的构造方式
    pub fn find(
        &self,
        query: &str,
        start: i64,
        count: i64,
        sort: &str,
        order: &str,
        tags: &[i64],
    ) -> Result<FindResult, ApiFailure> {
        let body = json!({
            "q": query,
            "game": GAME_AOE2DE,
            "modid": 0,
            "filter": 0,
            "status": "",
            "tags": tags,
            "sort": sort,
            "order": order,
            "start": start,
            "count": count,
        });
        let value = self.post("/Find", &body)?;
        Ok(FindResult::from_value(&value))
    }

    /// POST {F}/Installed —— 已订阅模组列表（官网 subscribed 页使用）
    pub fn installed(&self, start: i64, count: i64) -> Result<FindResult, ApiFailure> {
        let body = json!({
            "q": "",
            "game": GAME_AOE2DE,
            "modid": 0,
            "filter": 0,
            "status": "",
            "tags": [],
            "sort": "recentpopular",
            "order": "DESC",
            "start": start,
            "count": count,
        });
        let value = self.post("/Installed", &body)?;
        Ok(FindResult::from_value(&value))
    }

    /// POST {F}/Detail/{id}
    pub fn detail(&self, mod_id: i64) -> Result<Value, ApiFailure> {
        self.get(&format!("/Detail/{mod_id}"))
    }

    /// GET {F}/Download/{id} —— 从响应里取 downloadUrl（官网：`t.downloadUrl`）
    pub fn download_url(&self, mod_id: i64) -> Result<String, ApiFailure> {
        let value = self.get(&format!("/Download/{mod_id}"))?;
        pick_str(&value, &["downloadUrl", "downloadURL", "url"]).ok_or_else(|| {
            ApiFailure::parse(format!(
                "响应中没有 downloadUrl 字段（{}）",
                snippet(&value.to_string(), 200)
            ))
        })
    }

    /// 下载非 JSON 资源（模组缩略图），复用同一个 agent / 代理配置。
    /// 仅允许 https，且限制最大体积，避免被异常内容拖死。
    pub fn fetch_bytes(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, ApiFailure> {
        let parsed = tauri::Url::parse(url)
            .map_err(|e| ApiFailure::new("invalid", format!("资源地址无效：{e}"), None))?;
        if parsed.scheme() != "https" {
            return Err(ApiFailure::new("invalid", "资源地址不是 HTTPS，已拒绝", None));
        }
        let response = self
            .agent
            .get(url)
            .set("Accept", "image/*,*/*")
            .set("Referer", MODS_REFERER)
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => ApiFailure::new(
                    "http",
                    format!("缩略图下载失败：HTTP {code}"),
                    Some(code),
                ),
                ureq::Error::Transport(t) => {
                    ApiFailure::network(format!("缩略图下载失败：{t}"))
                }
            })?;
        let mut buf: Vec<u8> = Vec::new();
        response
            .into_reader()
            .take(max_bytes + 1)
            .read_to_end(&mut buf)
            .map_err(|e| ApiFailure::network(format!("读取缩略图失败：{e}")))?;
        if buf.len() as u64 > max_bytes {
            return Err(ApiFailure::new(
                "invalid",
                format!("缩略图超过 {max_bytes} 字节上限，已放弃"),
                None,
            ));
        }
        if buf.is_empty() {
            return Err(ApiFailure::new("invalid", "缩略图内容为空", None));
        }
        Ok(buf)
    }

    /// GET {F}/Tags —— 官方分类字典。实测：GET 匿名即可返回全部游戏的标签数组，
    /// POST 会返回 405（与 Detail / Download 同一条规则）。
    pub fn tags(&self) -> Result<Vec<ModTag>, ApiFailure> {
        let value = self.get("/Tags")?;
        let items = value.as_array().cloned().unwrap_or_default();
        Ok(items.iter().filter_map(ModTag::from_value).collect())
    }

    /// POST {F}/Featured —— 官网首页推荐位（当前 UI 未使用）
    #[allow(dead_code)]
    pub fn featured(&self, count: i64) -> Result<FindResult, ApiFailure> {
        let body = json!({
            "q": "", "game": GAME_AOE2DE, "modid": 0, "filter": 0, "status": "",
            "tags": [], "sort": "recentpopular", "order": "DESC", "start": 1, "count": count,
        });
        let value = self.post("/Featured", &body)?;
        Ok(FindResult::from_value(&value))
    }
}

/// 传输层错误归一化。
///
/// 之前超时被单独归为 `timeout`、其余归为 `network`，前端要分别判断；
/// 现在统一成 `network` 并给出人话提示，前端只要看到 kind=network 就点亮断网标志。
fn transport_failure(msg: String) -> ApiFailure {
    let lower = msg.to_lowercase();
    let friendly = if lower.contains("dns")
        || lower.contains("lookup")
        || lower.contains("name or service")
        || lower.contains("failed to resolve")
    {
        format!("网络不可用：域名解析失败（{msg}）")
    } else if lower.contains("timed out") || lower.contains("timeout") {
        format!("网络超时（{msg}）")
    } else if lower.contains("refused") || lower.contains("unreachable") || lower.contains("reset") {
        format!("网络连接被拒绝或中断（{msg}）")
    } else {
        format!("网络请求失败：{msg}")
    };
    ApiFailure::new("network", friendly, None)
}

fn snippet(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthenticated_message_is_friendly() {
        let failure = ApiFailure::unauthenticated();
        assert_eq!(failure.kind, "unauthenticated");
        assert_eq!(failure.status, Some(401));
        assert!(failure.message.contains("重新登录"));
    }

    /// DNS 失败必须归为 kind="network"：前端靠这个点亮「网络已断开」并停止后续请求。
    #[test]
    fn dns_error_maps_to_network_kind() {
        let failure = transport_failure(
            "dns error: failed to lookup address information: No such host is known".to_string(),
        );
        assert_eq!(failure.kind, "network");
        assert_eq!(failure.status, None);
        assert!(failure.message.contains("域名解析失败"), "{}", failure.message);
    }

    #[test]
    fn timeout_error_maps_to_network_kind() {
        let failure = transport_failure("timed out reading response".to_string());
        assert_eq!(failure.kind, "network", "超时也要算网络不可用");
        assert!(failure.message.contains("网络超时"));
    }

    #[test]
    fn other_transport_errors_still_network_kind() {
        let failure = transport_failure("connection refused".to_string());
        assert_eq!(failure.kind, "network");
        assert!(failure.message.contains("拒绝"));
    }

    #[test]
    fn snippet_truncates_long_text() {
        let text = "a".repeat(500);
        let cut = snippet(&text, 120);
        assert_eq!(cut.chars().count(), 121);
        assert!(cut.ends_with('…'));
    }

    /// 真实联网验证：没有 Cookie 时官方接口返回 401，客户端应映射为 unauthenticated。
    /// 默认跳过，用 `cargo test -- --ignored` 单独执行（需外网/代理）。
    #[test]
    #[ignore = "需要访问 api.ageofempires.com"]
    fn live_find_without_cookie_is_unauthenticated() {
        let settings = crate::models::Settings::default();
        let resolved = crate::net::resolve(&crate::net::NetConfig::from_settings(&settings))
            .expect("默认设置必须能解析出网络配置");
        let proxy = crate::net::ureq_proxy(&resolved).expect("代理应可用");
        let client = ApiClient::new("", proxy);
        let failure = client
            .find("", 1, 5, "recentpopular", "DESC", &[])
            .expect_err("匿名调用应当失败");
        println!(
            "实际返回: kind={} status={:?} message={}",
            failure.kind, failure.status, failure.message
        );
        assert_eq!(failure.kind, "unauthenticated");
        assert_eq!(failure.status, Some(401));
    }
}
