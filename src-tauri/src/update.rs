//! 软件更新检测（GitHub Releases）。
//!
//! 设计要点：
//! - 走 Rust 而不是前端 fetch：ureq 复用 [`crate::net`] 解析出的链路（手动 > 系统注册表 > 环境变量 > 直连），
//!   WebView2 里的 fetch 只会跟系统代理，用户设的手动代理会失效。
//! - 匿名请求（不带 Cookie），GitHub 要求必须带 User-Agent，否则 403。
//! - 只读 latest release；版本比较在本地完成。
//! - 启动静默检查带 24 小时时间锁（settings.json 的 last_auto_update_check_ms），
//!   时间锁命中时直接返回，连一条 `[update]` 日志都不会打；手动检查不受限制。

use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 仓库首页（Release 地址兜底用）
pub const REPO_URL: &str = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const RELEASES_LATEST: &str = "https://api.github.com/repos/Einsteinband/AoE2-Mod-Manager/releases/latest";
/// JSON 里最多取多少个字符的更新说明（前端只做简短展示，避免撑破弹窗）
const NOTES_LIMIT: usize = 600;
/// GitHub 强制要求 User-Agent，缺失会被直接判 403
const USER_AGENT: &str = concat!("AoE2ModManager/", env!("CARGO_PKG_VERSION"), " (Windows)");
/// 自动检查的最小间隔：24 小时（匿名接口只有 60 次/小时，启动时不该每次都去刷）
pub const AUTO_CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前运行版本（编译期 CARGO_PKG_VERSION，唯一来源 tauri.conf.json / Cargo.toml）
    pub current_version: String,
    /// 服务器上的最新版本（已去掉前缀 v）
    pub latest_version: String,
    /// latest_version > current_version
    pub has_update: bool,
    /// Release 页面地址（只允许 https://github.com/...）
    pub release_url: String,
    pub release_name: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
}

/// 当前版本：编译期常量，运行期无法被伪造
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 归一化版本号：去掉空白与 v 前缀
fn normalize(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['v', 'V'])
        .trim()
        .to_string()
}

/// 只取每段的数字部分，无法解析按 0 处理（"0.2.0-beta.1" → [0, 2, 0, 1]）
fn segments(value: &str) -> Vec<u64> {
    normalize(value)
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

/// latest 是否比 current 新（逐段数值比较，缺失段补 0）
pub fn is_newer(latest: &str, current: &str) -> bool {
    let a = segments(latest);
    let b = segments(current);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    for index in 0..a.len().max(b.len()) {
        let x = a.get(index).copied().unwrap_or(0);
        let y = b.get(index).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 把响应头全量打到终端（纯 ASCII 输出，避免 Windows 控制台代码页把内容变成乱码）
fn log_all_headers(response: &ureq::Response) {
    let mut names = response.headers_names();
    names.sort();
    println!("[update] ---- response headers: {} ----", names.len());
    for name in names {
        for value in response.all(&name) {
            println!("[update]   {name}: {value}");
        }
    }
    println!("[update] ---- end headers ----");
}

/// 限流关键字段单独强调：remaining / reset / retry-after
fn log_rate_limit(response: &ureq::Response) {
    let head = |key: &str| response.header(key).unwrap_or("-").to_string();
    println!(
        "[update] rate-limit: status={} limit={} remaining={} used={} reset={} retry-after={}",
        response.status(),
        head("x-ratelimit-limit"),
        head("x-ratelimit-remaining"),
        head("x-ratelimit-used"),
        head("x-ratelimit-reset"),
        head("retry-after"),
    );
    if let Some(reset) = response
        .header("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if reset > now {
            println!(
                "[update] rate-limit window resets in {}s (epoch {reset})",
                reset - now
            );
        } else {
            println!("[update] rate-limit window already reset (epoch {reset})");
        }
    }
    if response.header("x-ratelimit-remaining").map(|v| v.trim()) == Some("0") {
        println!(
            "[update] WARNING: remaining=0, anonymous GitHub API allows only 60 req/h per IP"
        );
    }
}

fn translate_status(code: u16) -> String {
    match code {
        403 => "GitHub 接口暂时限流（403），请稍后再试".to_string(),
        404 => "仓库或 Release 不存在（404）".to_string(),
        other => format!("GitHub 返回 HTTP {other}"),
    }
}

/// 一次请求的结局。区分「报错但请求确实发出去了」和「压根没连上」，
/// 自动检查靠这个判断该不该写时间戳（已经烧掉的配额要算数）。
enum Fetched {
    /// 拿到 2xx
    Response(ureq::Response),
    /// 拿到响应但状态码是错误（403 限流也在这里）
    HttpError { message: String },
    /// 连响应都没拿到（DNS / 代理 / 超时），不消耗配额
    Transport { message: String },
}

/// 发请求：成功打印配额摘要；失败时打印完整响应头、限流字段与响应体
fn request_latest(agent: &ureq::Agent) -> Fetched {
    println!("[update] GET {RELEASES_LATEST}");
    println!("[update] User-Agent: {USER_AGENT}");
    match agent
        .get(RELEASES_LATEST)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .call()
    {
        Ok(response) => {
            log_rate_limit(&response);
            Fetched::Response(response)
        }
        Err(ureq::Error::Status(code, response)) => {
            println!("[update] request failed: HTTP {code}");
            log_all_headers(&response);
            log_rate_limit(&response);
            match response.into_string() {
                Ok(body) => {
                    let body = body.trim();
                    if body.is_empty() {
                        println!("[update] response body: <empty>");
                    } else {
                        println!(
                            "[update] response body: {}",
                            body.chars().take(1200).collect::<String>()
                        );
                    }
                }
                Err(e) => println!("[update] response body unreadable: {e}"),
            }
            Fetched::HttpError { message: translate_status(code) }
        }
        Err(ureq::Error::Transport(t)) => {
            println!("[update] transport error: {t}");
            println!("[update] transport error debug: {t:?}");
            Fetched::Transport { message: format!("网络请求失败：{t}") }
        }
    }
}

/// 组装 Agent（8s 连接 / 12s 读取，UA 同时挂在 Agent 与请求头两处）
fn build_agent(proxy: Option<ureq::Proxy>) -> (ureq::Agent, &'static str) {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(12))
        .user_agent(USER_AGENT);
    let route = if proxy.is_some() { "configured proxy" } else { "direct" };
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    (builder.build(), route)
}

/// 发一次请求并解析。第一个返回值 = 请求是否真的发了出去（拿到任何 HTTP 响应都算）
fn run_once(proxy: Option<ureq::Proxy>) -> (bool, Result<UpdateInfo, String>) {
    let (agent, route) = build_agent(proxy);
    println!("[update] route: {route}");
    match request_latest(&agent) {
        Fetched::Response(response) => (true, parse_info(response)),
        Fetched::HttpError { message } => (true, Err(message)),
        Fetched::Transport { message } => (false, Err(message)),
    }
}

/// 拉取最新 Release（手动检查用，不受时间锁限制）。
pub fn fetch_latest(proxy: Option<ureq::Proxy>) -> Result<UpdateInfo, String> {
    run_once(proxy).1
}

/// 解析 2xx 响应体
fn parse_info(response: ureq::Response) -> Result<UpdateInfo, String> {
    let body = response
        .into_string()
        .map_err(|e| format!("读取 GitHub 响应失败：{e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("GitHub 响应不是合法 JSON：{e}"))?;

    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.trim().is_empty() {
        return Err("Release 缺少 tag_name 字段".to_string());
    }

    let latest = normalize(&tag);
    let current = current_version();
    let release_url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .filter(|url| url.starts_with("https://github.com/"))
        .map(|url| url.to_string())
        .unwrap_or_else(|| format!("{REPO_URL}/releases/latest"));

    let notes = value
        .get("body")
        .and_then(|v| v.as_str())
        .map(|text| text.trim().chars().take(NOTES_LIMIT).collect::<String>())
        .filter(|text| !text.is_empty());

    Ok(UpdateInfo {
        has_update: is_newer(&latest, &current),
        current_version: current,
        latest_version: latest,
        release_url,
        release_name: value
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        published_at: value
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        notes,
    })
}

// ---------------- v0.8：启动静默检查的 24 小时时间锁 ----------------

/// 当前毫秒时间戳（只用于「距上次自动检查多久」这类相对比较）
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 时间锁判定：距上次自动检查是否已满 24 小时。
/// `last_ms <= 0` 视为从未检查；时间戳在未来（用户改过系统时间）时不锁，避免永久卡死。
pub fn auto_check_due(last_ms: i64) -> bool {
    if last_ms <= 0 {
        return true;
    }
    let now = now_ms();
    if last_ms > now {
        return true;
    }
    now - last_ms >= AUTO_CHECK_INTERVAL_MS
}

/// 启动静默检查：未满 24 小时直接返回 `Ok(None)`——不发请求、不打任何 `[update]` 日志。
/// 请求真的发出去过（含 403）就把时间戳写回 settings.json。
pub fn fetch_latest_auto(
    app: &tauri::AppHandle,
    proxy: Option<ureq::Proxy>,
) -> Result<Option<UpdateInfo>, String> {
    let settings = crate::settings::load_for_app(app);
    if !auto_check_due(settings.last_auto_update_check_ms) {
        return Ok(None);
    }

    let (reached, result) = run_once(proxy);
    if reached {
        mark_auto_checked(app);
    }
    result.map(Some)
}

/// 写回自动检查时间戳；写盘失败只告警，不影响本次检查结果
fn mark_auto_checked(app: &tauri::AppHandle) {
    let mut settings = crate::settings::load_for_app(app);
    settings.last_auto_update_check_ms = now_ms();
    if let Err(e) = crate::settings::save_for_app(app, &settings) {
        log::warn!(target: "update", "写回自动检查时间戳失败：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{auto_check_due, is_newer, AUTO_CHECK_INTERVAL_MS};

    #[test]
    fn compares_numeric_segments() {
        assert!(is_newer("0.2.0", "0.1.1"));
        assert!(is_newer("v0.1.10", "0.1.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.1.1", "0.1.1"));
        assert!(!is_newer("v0.1.1", "0.1.1"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        // 预发布后缀只比较前面的数字段
        assert!(is_newer("0.2.0-beta", "0.1.1"));
        assert!(!is_newer("0.1.1-beta", "0.1.1"));
    }

    #[test]
    fn applies_daily_lock() {
        let now = super::now_ms();
        assert!(auto_check_due(0));
        assert!(!auto_check_due(now));
        assert!(!auto_check_due(now - AUTO_CHECK_INTERVAL_MS + 60_000));
        assert!(auto_check_due(now - AUTO_CHECK_INTERVAL_MS - 1_000));
        // 时间戳在未来（系统时间被改过）：不锁，避免永久发不出请求
        assert!(auto_check_due(now + 60_000));
    }
}
