//! 软件更新检测（GitHub Releases）。
//!
//! 设计要点：
//! - 走 Rust 而不是前端 fetch：ureq 复用 [`crate::net`] 解析出的链路（手动 > 系统注册表 > 环境变量 > 直连），
//!   WebView2 里的 fetch 只会跟系统代理，用户设的手动代理会失效。
//! - 匿名请求（不带 Cookie），GitHub 要求必须带 User-Agent，否则 403。
//! - 只读 latest release；版本比较在本地完成。
//! - **国内网络优先走反代镜像**：[`API_MIRROR_PREFIXES`] 依次尝试（5s 连接 / 3s 读取），
//!   全部失败才回退直连 `api.github.com`。国内直连 `api.github.com` 基本不可达，
//!   旧实现只有直连，所以「更新检测收不到通知」。统一入口是 [`fetch_with_mirrors`]，
//!   `lib::fetch_releases_blocking`（更新历史 / 首启新版本特性）也复用它。
//! - 启动静默检查带 2 小时防抖（settings.json 的 last_auto_update_check_ms），
//!   命中时直接返回、不发请求，只打一条 `[update] auto check skipped` 诊断日志；
//!   手动检查不受限制。
//!
//! 为什么不是 24 小时锁：旧实现用 24 小时，导致「刚发完新 Release，用户重启旧版本」
//! 这段时间里自动检查被静默跳过，界面完全不提示——这正是被报上来的 bug。
//! 现在只在 2 小时内已查过时省一次请求（匿名接口 60 req/h，正常使用绰绰有余）。

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::user_err;

/// 仓库首页（Release 地址兜底用）
pub const REPO_URL: &str = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const RELEASES_LATEST: &str = "https://api.github.com/repos/Einsteinband/AoE2-Mod-Manager/releases/latest";

/// 国内可用的 GitHub API 反代前缀（用户 2026-11-06 裁决：gh-proxy.com 优先，gh.llkk.cc 已移除）。
/// 请求时拼成 `{prefix}{完整 url}`，例如 `https://gh-proxy.com/https://api.github.com/...`。
/// 放常量里是为了后续维护：某个反代失效时只删一行，数组顺序即尝试优先级。
/// 2026-11-06 实测：gh-proxy.com 返回 200 正常 JSON，其余两个当前 403（公益反代，日后可能恢复），
/// 已移除持续超时的 gh.llkk.cc。存活项放第一位，国内用户日常检测 1 次请求即命中。
pub const API_MIRROR_PREFIXES: &[&str] = &[
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://ghfast.top/",
];
/// 镜像超时：5s 连接 / 3s 读取（用户 2026-11-06 裁决，为了快速失败而不是卡住）
const MIRROR_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MIRROR_READ_TIMEOUT: Duration = Duration::from_secs(3);
/// 直连超时：沿用改造前取值，给慢网络留足时间
const DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const DIRECT_READ_TIMEOUT: Duration = Duration::from_secs(12);
/// JSON 里最多取多少个字符的更新说明（前端只做简短展示，避免撑破弹窗）
const NOTES_LIMIT: usize = 600;
/// GitHub 强制要求 User-Agent，缺失会被直接判 403
const USER_AGENT: &str = concat!("AoE2ModManager/", env!("CARGO_PKG_VERSION"), " (Windows)");
/// 自动检查的最小间隔：2 小时（用户 2026-10-31 确认的取值）。
/// 24 小时锁会漏掉「刚发完却重启」的新版本；2 小时对普通用户足够温和，
/// 也远低于匿名接口 60 req/h 的配额（最坑也才 1 req/2h，单日 ≈ 12 次）。
pub const AUTO_CHECK_MIN_INTERVAL_MS: i64 = 2 * 60 * 60 * 1000;

/// v3.2：加 `Deserialize` 只为一件事——把上一次的检查结论落盘缓存，
/// 防抖跳过时原样交还前端（见 [`AutoCheckState`]）。序列化字段不变，IPC 契约不受影响。
#[derive(Serialize, Deserialize, Clone, Debug)]
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
    log::info!(target: "update", "---- response headers: {} ----", names.len());
    for name in names {
        for value in response.all(&name) {
            log::info!(target: "update", "  {name}: {value}");
        }
    }
    log::info!(target: "update", "---- end headers ----");
}

/// 限流关键字段单独强调：remaining / reset / retry-after
fn log_rate_limit(response: &ureq::Response) {
    let head = |key: &str| response.header(key).unwrap_or("-").to_string();
    log::info!(
        target: "update",
        "rate-limit: status={} limit={} remaining={} used={} reset={} retry-after={}",
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
            log::info!(
                target: "update",
                "rate-limit window resets in {}s (epoch {reset})",
                reset - now
            );
        } else {
            log::info!(target: "update", "rate-limit window already reset (epoch {reset})");
        }
    }
    if response.header("x-ratelimit-remaining").map(|v| v.trim()) == Some("0") {
        log::warn!(
            target: "update",
            "WARNING: remaining=0, anonymous GitHub API allows only 60 req/h per IP"
        );
    }
}

fn translate_status(code: u16) -> String {
    match code {
        403 => user_err("update.githubRateLimited", json!({})),
        404 => user_err("update.notFound", json!({})),
        other => user_err("update.httpError", json!({ "code": other })),
    }
}

/// 一次请求的结局。区分「报错但请求确实发出去了」和「压根没连上」，
/// 自动检查靠这个判断该不该写时间戳（已经烧掉的配额要算数）。
enum Attempt {
    /// 拿到 2xx，已把响应体读成字符串
    Body(String),
    /// 拿到响应但状态码是错误（403 限流也在这里）
    HttpError { code: u16, message: String },
    /// 连响应都没拿到（DNS / 代理 / 超时），不消耗配额
    Transport(String),
}

/// 打一个 URL。`verbose` 只在直连兜底时开：那时才打印完整响应头、限流字段与响应体；
/// 镜像失败只打一行摘要，避免 4 个镜像把终端刷满。
fn request_url(agent: &ureq::Agent, url: &str, verbose: bool) -> Attempt {
    if verbose {
        log::info!(target: "update", "GET {url}");
        log::info!(target: "update", "User-Agent: {USER_AGENT}");
    }
    match agent
        .get(url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .call()
    {
        Ok(response) => {
            if verbose {
                log_rate_limit(&response);
            }
            match response.into_string() {
                Ok(body) => Attempt::Body(body),
                Err(e) => Attempt::Transport(format!("读取 GitHub 响应失败：{e}")),
            }
        }
        Err(ureq::Error::Status(code, response)) => {
            if verbose {
                log::warn!(target: "update", "request failed: HTTP {code}");
                log_all_headers(&response);
                log_rate_limit(&response);
                match response.into_string() {
                    Ok(body) => {
                        let body = body.trim();
                        if body.is_empty() {
                            log::warn!(target: "update", "response body: <empty>");
                        } else {
                            log::warn!(
                                target: "update",
                                "response body: {}",
                                body.chars().take(1200).collect::<String>()
                            );
                        }
                    }
                    Err(e) => log::warn!(target: "update", "response body unreadable: {e}"),
                }
            }
            Attempt::HttpError { code, message: translate_status(code) }
        }
        Err(ureq::Error::Transport(t)) => {
            if verbose {
                // TLS / 代理 / DNS 类错误的原文（含底层 io 错误）只在这里落盘：
                // 这是「登录无反应 / 检查更新失败」最常见的真因。
                log::warn!(target: "update", "transport error (TLS / proxy / DNS): {t}");
                log::warn!(target: "update", "transport error debug: {t:?}");
            }
            Attempt::Transport(format!("网络请求失败：{t}"))
        }
    }
}

/// 廉价形状检查：两个接口都只返回 JSON 对象/数组。
/// 反代把错误页当 200 返回时，靠它把这种响应当成失败继续试下一个镜像，
/// 而不是让上层 `serde_json` 报「不是合法 JSON」后彻底放弃。
fn looks_like_json(body: &str) -> bool {
    matches!(body.trim_start().as_bytes().first(), Some(b'{') | Some(b'['))
}

/// **统一网络入口**：镜像优先（短超时）→ 直连 api.github.com 兜底。
///
/// 调用方：
/// - [`run_once`]：请求 [`RELEASES_LATEST`]（`check_update` / `check_update_auto`）；
/// - `lib::fetch_releases_blocking`：请求 `/releases?per_page=30`（更新历史 / 首启新版本特性）。
///
/// 返回值 `.0` = 是否有任何一次请求真的拿到了 HTTP 响应（含 403 等错误码）；
/// 自动检查靠它判断要不要写时间戳——已经烧掉的配额要算数。
/// 返回值 `.1` = 拿到 2xx 时的响应体；全部失败时为错误文案。
///
/// 镜像失败日志统一前缀 `[update] mirror failed:`，用户反馈时直接搜这一行就能定位是哪个反代挂了。
pub fn fetch_with_mirrors(proxy: Option<ureq::Proxy>, url: &str) -> (bool, Result<String, String>) {
    let mut reached = false;
    let mut last_error = String::new();

    for prefix in API_MIRROR_PREFIXES {
        let full = format!("{prefix}{url}");
        let (agent, _route) =
            build_agent(proxy.clone(), MIRROR_CONNECT_TIMEOUT, MIRROR_READ_TIMEOUT);
        match request_url(&agent, &full, false) {
            Attempt::Body(body) => {
                if looks_like_json(&body) {
                    log::info!(target: "update", "mirror ok: {full} ({} bytes)", body.len());
                    return (true, Ok(body));
                }
                log::warn!(
                    target: "update",
                    "mirror failed: not JSON, {} bytes (possibly an error page) ({full})",
                    body.len()
                );
                last_error = format!("镜像返回的不是 JSON（{} 字节）", body.len());
            }
            Attempt::HttpError { code, message } => {
                reached = true;
                log::warn!(target: "update", "mirror failed: HTTP {code} {full}");
                last_error = message;
            }
            Attempt::Transport(message) => {
                log::warn!(target: "update", "mirror failed: {message} ({full})");
                last_error = message;
            }
        }
    }

    log::warn!(
        target: "update",
        "all {} mirrors failed, falling back to direct GET",
        API_MIRROR_PREFIXES.len()
    );
    let (agent, route) = build_agent(proxy, DIRECT_CONNECT_TIMEOUT, DIRECT_READ_TIMEOUT);
    log::info!(target: "update", "route: {route}");
    match request_url(&agent, url, true) {
        Attempt::Body(body) => (true, Ok(body)),
        Attempt::HttpError { message, .. } => (true, Err(message)),
        Attempt::Transport(message) => {
            let message = if last_error.is_empty() {
                message
            } else {
                format!("{message}（镜像同样失败：{last_error}）")
            };
            (reached, Err(message))
        }
    }
}

/// 组装 Agent（UA 同时挂在 Agent 与请求头两处）。
/// 超时由调用方指定：镜像用短超时快速失败，直连沿用 8s/12s。
fn build_agent(
    proxy: Option<ureq::Proxy>,
    connect: Duration,
    read: Duration,
) -> (ureq::Agent, &'static str) {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(connect)
        .timeout_read(read)
        .user_agent(USER_AGENT);
    let route = if proxy.is_some() { "configured proxy" } else { "direct" };
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    (builder.build(), route)
}

/// 发一次请求并解析。第一个返回值 = 请求是否真的发了出去（拿到任何 HTTP 响应都算）
fn run_once(proxy: Option<ureq::Proxy>) -> (bool, Result<UpdateInfo, String>) {
    let (reached, result) = fetch_with_mirrors(proxy, RELEASES_LATEST);
    match result {
        Ok(body) => (reached, parse_info(&body)),
        Err(message) => (reached, Err(message)),
    }
}

/// 拉取最新 Release（手动检查用，不受时间锁限制）。
pub fn fetch_latest(proxy: Option<ureq::Proxy>) -> Result<UpdateInfo, String> {
    run_once(proxy).1
}

/// 解析 2xx 响应体（镜像与直连的响应体走同一条路径）
fn parse_info(body: &str) -> Result<UpdateInfo, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| user_err("update.invalidJson", json!({ "error": e.to_string() })))?;

    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.trim().is_empty() {
        return Err(user_err("update.missingTagName", json!({})));
    }

    let latest = normalize(&tag);
    let current = current_version();
    // 诊断日志：下次「发了新版却不提示」时，这一行能直接看出是比对结论错、
    // 还是拿到的 tag 不对（例如 Release 被勾成 pre-release，/releases/latest 不会返回它）
    let has_update = is_newer(&latest, &current);
    log::info!(target: "update", "compare: current={current} latest={latest} tag={tag} has_update={has_update}");
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
        has_update,
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

/// 防抖判定：距上次自动检查是否已过 [`AUTO_CHECK_MIN_INTERVAL_MS`]。
/// `last_ms <= 0` 视为从未检查；时间戳在未来（用户改过系统时间）时不锁，避免永久卡死。
pub fn auto_check_due(last_ms: i64) -> bool {
    if last_ms <= 0 {
        return true;
    }
    let now = now_ms();
    if last_ms > now {
        return true;
    }
    now - last_ms >= AUTO_CHECK_MIN_INTERVAL_MS
}

/// 自动检查的「上次结论」缓存，落盘到 app_local_data_dir/update_auto_state.json。
///
/// 为什么不放进 `Settings`：`Settings` 属于全局配置，而这里只是更新检查的内部状态；
/// 独立文件可以单独损坏/删除，也不污染 settings.json 的语义。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AutoCheckState {
    /// 拿到结论的时间戳（毫秒），仅用于诊断日志
    checked_ms: i64,
    /// 上一次成功解析出的结论（不含任何凭证，纯公开 Release 信息）
    last: Option<UpdateInfo>,
}

fn auto_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|base| base.join("update_auto_state.json"))
}

fn load_auto_state(app: &tauri::AppHandle) -> Option<AutoCheckState> {
    let path = auto_state_path(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<AutoCheckState>(&text).ok()
}

fn save_auto_state(app: &tauri::AppHandle, state: &AutoCheckState) {
    let Some(path) = auto_state_path(app) else {
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(state) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, text) {
        log::warn!(target: "update", "写回自动检查结论失败：{e}");
    }
}

/// 启动静默检查：2 小时内已检查过就不发请求，只打一条 ASCII 诊断日志。
///
/// **v3.2 修复（更新弹窗回归）**：旧实现命中防抖时直接 `Ok(None)`，前端
/// `if (!info?.hasUpdate) return` 静默退出，于是 2 小时内每次重启都看不到提示，
/// 相对 0.3.0（每次启动都查）就是「更新弹窗彻底失效」。现在改为把上一次的
/// 结论原样交还，前端行为回到 0.3.0，同时仍然省下这一次请求。
///
/// 时间戳只在**真正拿到 2xx + 合法 JSON** 后才写：403 限流、镜像错误页、
/// 网络不通一律不锁窗口，否则一次失败就会把提示静默吞掉 2 小时。
pub fn fetch_latest_auto(
    app: &tauri::AppHandle,
    proxy: Option<ureq::Proxy>,
) -> Result<Option<UpdateInfo>, String> {
    let settings = crate::settings::load_for_app(app);
    if !auto_check_due(settings.last_auto_update_check_ms) {
        let elapsed = now_ms().saturating_sub(settings.last_auto_update_check_ms);
        // 有缓存就回放：这是「2 小时内重启也要弹窗」的关键
        if let Some(state) = load_auto_state(app) {
            if let Some(mut info) = state.last {
                // 缓存的 current_version 是上次检查时的运行版本；用户可能已经升级。
                // 直接回放 has_update 会误报「有新版本」（例：刚升到 latest 又重启），
                // 所以用当前编译期版本重新比对一次。
                info.current_version = current_version();
                info.has_update = is_newer(&info.latest_version, &info.current_version);
                log::info!(
                    target: "update",
                    "auto check skipped: last check {}s ago (< {}s), current={}, replay cached result (latest={}, has_update={})",
                    elapsed / 1000,
                    AUTO_CHECK_MIN_INTERVAL_MS / 1000,
                    current_version(),
                    info.latest_version,
                    info.has_update
                );
                return Ok(Some(info));
            }
        }
        // 防抖命中但没有缓存（老版本升级上来、state 文件被删）→ 宁可查一次，
        // 也不要让用户升级后第一次启动依然看不到任何提示。
        log::warn!(
            target: "update",
            "auto check skipped but no cached result, checking anyway (last {}s ago)",
            elapsed / 1000
        );
    }

    let (reached, result) = run_once(proxy);
    match result {
        Ok(info) => {
            // 只有 2xx + 合法 JSON 才算「检查成功」→ 写时间戳 + 写缓存
            mark_auto_checked(app);
            save_auto_state(
                app,
                &AutoCheckState {
                    checked_ms: now_ms(),
                    last: Some(info.clone()),
                },
            );
            Ok(Some(info))
        }
        Err(message) => {
            if reached {
                // 拿到了 HTTP 响应但解析不了（403 限流页 / 镜像错误页）：
                // **故意不写时间戳**，下次启动立刻重试。配额真烧掉了，GitHub 自己会拒绝，
                // 不需要我们替它节流——让用户看到提示比省一次请求重要。
                log::warn!(target: "update", "auto check reachable but failed, window NOT locked: {message}");
            } else {
                log::warn!(target: "update", "auto check unreachable, window NOT locked: {message}");
            }
            Err(message)
        }
    }
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
    use super::{auto_check_due, is_newer, AUTO_CHECK_MIN_INTERVAL_MS};

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

    /// 回归测试：GitHub tag 带 v 前缀（v0.4.0）也必须判定为比本地 0.3.5 新
    #[test]
    fn detects_v_prefixed_release() {
        assert!(is_newer("v0.4.0", "0.3.5"));
        assert!(is_newer("V0.4.0", "0.3.5"));
        assert!(is_newer("v0.3.6", "0.3.5"));
        assert!(is_newer("v0.3.10", "0.3.9"));
        assert!(!is_newer("v0.3.5", "0.3.5"));
        assert!(!is_newer("v0.3.4", "0.3.5"));
    }

    #[test]
    fn applies_short_debounce() {
        let now = super::now_ms();
        assert!(auto_check_due(0));
        assert!(!auto_check_due(now));
        assert!(!auto_check_due(now - AUTO_CHECK_MIN_INTERVAL_MS + 60_000));
        assert!(auto_check_due(now - AUTO_CHECK_MIN_INTERVAL_MS - 1_000));
        // 关键回归：9 小时前查过（旧 24 小时锁会挡住）现在必须放行
        assert!(auto_check_due(now - 9 * 60 * 60 * 1000));
        // 时间戳在未来（系统时间被改过）：不锁，避免永久发不出请求
        assert!(auto_check_due(now + 60_000));
    }
}
