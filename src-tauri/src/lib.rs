use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

mod cache;
mod download;
mod images;
mod install;
mod metadata;
mod models;
mod modupdate;
mod net;
mod presets;
mod online;
mod online_index;
mod scan;
mod secure;
mod settings;
mod translator;
mod update;
mod user_data;

use online::api::ApiClient;
use online::ApiFailure;

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    settings::path_for(app)
}

fn mod_root(app: &tauri::AppHandle) -> Result<PathBuf, ApiFailure> {
    let path = settings_path(app)
        .ok()
        .map(|p| settings::load(&p))
        .and_then(|s| s.mod_root)
        .ok_or_else(|| {
            ApiFailure::new(
                "no_root",
                "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录",
                None,
            )
        })?;
    Ok(PathBuf::from(path))
}

fn client(app: &tauri::AppHandle) -> Result<ApiClient, ApiFailure> {
    let cookie = online::session::current_cookie_header(app).map_err(|e| {
        ApiFailure::new(
            "unauthenticated",
            if e.contains("尚未登录") {
                "尚未登录《帝国时代》账号".to_string()
            } else {
                e
            },
            Some(401),
        )
    })?;

    // 代理统一由 net 模块决定：手动 > 系统注册表 > 环境变量 > 直连
    let settings = settings::load_for_app(app);
    let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
        .map_err(|e| ApiFailure::new("network", format!("网络配置无效：{e}"), None))?;
    let proxy = net::ureq_proxy(&resolved).map_err(|e| ApiFailure::new("network", e, None))?;

    Ok(ApiClient::new(cookie, proxy))
}

// ---------------- 本地扫描（阶段一，保持行为不变） ----------------

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> models::Settings {
    match settings_path(&app) {
        Ok(path) => {
            let mut current = settings::load(&path);
            // v2.4：老 settings.json 里的扁平排版字段一次性搬进 reader_*，
            // 顺手把迁移结果写回（写盘失败不影响本次读取，迁移本身可重复执行）。
            if current.migrate_legacy_typography() {
                let _ = settings::save(&path, &current);
            }
            current
        }
        Err(_) => models::Settings::default(),
    }
}

/// 保存界面语言；具体有哪些语言由前端 src/i18n/locales/ 目录决定，
/// 后端只校验格式（2-5 位英文字母），新增语言不需要改 Rust。
#[tauri::command]
fn set_locale(app: tauri::AppHandle, locale: String) -> Result<String, String> {
    let normalized = locale.trim().to_lowercase();
    if !normalized.is_empty() {
        let valid_len = (2..=5).contains(&normalized.len());
        let ascii_alpha = normalized.chars().all(|c| c.is_ascii_alphabetic());
        if !valid_len || !ascii_alpha {
            return Err(format!("不支持的语言代码：{locale}"));
        }
    }
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    current.locale = normalized.clone();
    settings::save(&path, &current)?;
    Ok(normalized)
}

// ---------------- v0.4：软件更新检测（GitHub Releases） ----------------

/// 当前版本号（编译期常量；前端「关于」页与更新提示都用它，避免前端硬编码）
#[tauri::command]
fn app_version() -> String {
    update::current_version()
}

/// 检查更新：代理链路与在线接口保持一致（手动 > 系统 > 环境变量 > 直连），
/// 因此用户设了手动代理时 GitHub 也能通；请求本身匿名，不需要登录态。
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<update::UpdateInfo, String> {
    let settings = settings::load_for_app(&app);
    let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
        .map_err(|e| format!("网络配置无效：{e}"))?;
    let proxy = net::ureq_proxy(&resolved).map_err(|e| format!("代理配置无效：{e}"))?;

    tauri::async_runtime::spawn_blocking(move || update::fetch_latest(proxy))
        .await
        .map_err(|e| format!("更新检查线程异常：{e}"))?
}

/// 启动静默检查：24 小时内已自动查过就直接跳过（不发请求、不打日志）。
/// 手动「检查更新」仍走 check_update，不受时间锁限制。
#[tauri::command]
async fn check_update_auto(app: tauri::AppHandle) -> Result<Option<update::UpdateInfo>, String> {
    let settings = settings::load_for_app(&app);
    let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
        .map_err(|e| format!("网络配置无效：{e}"))?;
    let proxy = net::ureq_proxy(&resolved).map_err(|e| format!("代理配置无效：{e}"))?;

    tauri::async_runtime::spawn_blocking(move || update::fetch_latest_auto(&app, proxy))
        .await
        .map_err(|e| format!("更新检查线程异常：{e}"))?
}
// ---------------- v3.1：GitHub Releases 全量列表（更新历史 / 首启「新版本特性」） ----------------

/// 公开仓库的 Releases 列表：匿名可读（60 次/小时）；
/// **必须带 User-Agent**，否则 GitHub 直接 403。
const RELEASES_LIST_URL: &str =
    "https://api.github.com/repos/Einsteinband/AoE2-Mod-Manager/releases?per_page=30";

/// 单条 Release 的精简视图：只给前端需要的字段，body 原样返回（Markdown 交给前端渲染）
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct GithubRelease {
    /// 原始 tag（如 v0.3.3）
    tag_name: String,
    /// 去掉 v 前缀的版本号（如 0.3.3）：前端用它和 appVersion 比对
    version: String,
    /// Release 标题（缺省回落到 tag）
    name: String,
    /// 更新说明（Markdown 原文，可能为空）
    body: String,
    /// ISO8601 发布时间
    published_at: String,
    /// Release 页面地址（只放行 github.com）
    html_url: String,
    /// 是否就是当前运行版本
    is_current: bool,
}

/// 去掉 tag 的 v 前缀并 trim，仅用于版本比对
fn normalize_version_tag(value: &str) -> String {
    value.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

/// 拉取 Releases 列表（阻塞；调用方放进 spawn_blocking）
fn fetch_releases_blocking(proxy: Option<ureq::Proxy>) -> Result<Vec<GithubRelease>, String> {
    // GitHub 强制要求 User-Agent：Agent 级挂一次，单个请求再挂一次，两条路径都不会漏
    let user_agent = format!("AoE2ModManager/{} (Windows)", update::current_version());
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(8))
        .timeout_read(std::time::Duration::from_secs(15))
        .user_agent(&user_agent);
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();

    let response = agent
        .get(RELEASES_LIST_URL)
        .set("User-Agent", &user_agent)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let text = resp.into_string().unwrap_or_default();
                let message = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("message")
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| format!("GitHub 返回 {code}"));
                format!("获取更新历史失败：{message}")
            }
            ureq::Error::Transport(t) => format!("获取更新历史失败：{t}"),
        })?;

    let raw = response
        .into_string()
        .map_err(|e| format!("读取 GitHub 响应失败：{e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("GitHub 响应不是合法 JSON：{e}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "GitHub 响应不是 Release 数组".to_string())?;

    let current = normalize_version_tag(&update::current_version());
    let mut releases: Vec<GithubRelease> = items
        .iter()
        .filter(|item| item.get("draft").and_then(|v| v.as_bool()) != Some(true))
        .map(|item| {
            let tag = item
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let version = normalize_version_tag(&tag);
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| tag.clone());
            GithubRelease {
                is_current: !version.is_empty() && version == current,
                tag_name: tag,
                version,
                name,
                body: item
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                published_at: item
                    .get("published_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                html_url: item
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .filter(|url| url.starts_with("https://github.com/"))
                    .unwrap_or(update::REPO_URL)
                    .to_string(),
            }
        })
        .filter(|release| !release.tag_name.is_empty())
        .collect();

    // 时间倒序：ISO8601 字符串按字典序比较即可（同一天内同样成立）
    releases.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    Ok(releases)
}

/// 更新历史：设置页「关于」与启动首启弹窗共用。
/// 前端绝不直连 GitHub API（跨域会被 CORS 拦），一律走这里。
#[tauri::command]
async fn fetch_github_releases(app: tauri::AppHandle) -> Result<Vec<GithubRelease>, String> {
    let settings = settings::load_for_app(&app);
    let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
        .map_err(|e| format!("网络配置无效：{e}"))?;
    let proxy = net::ureq_proxy(&resolved).map_err(|e| format!("代理配置无效：{e}"))?;

    tauri::async_runtime::spawn_blocking(move || fetch_releases_blocking(proxy))
        .await
        .map_err(|e| format!("更新历史线程异常：{e}"))?
}

// ---------------- v0.4：本地模组批量更新检测 ----------------

/// 批量检查本地模组是否有新版本。
///
/// 只用官方 `/Installed`（每页 50 条，最多 20 页），**绝不逐个请求 Detail**；
/// 比对全部在 Rust 内存里完成，返回的 items 带 hasUpdate / unknown 标记。
#[tauri::command]
async fn check_mod_updates(app: tauri::AppHandle) -> Result<modupdate::ModUpdateReport, ApiFailure> {
    let root = mod_root(&app)?;
    let store = metadata::load_for_app(&app);
    let client = client(&app)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<modupdate::ModUpdateReport, ApiFailure> {
        let locals = modupdate::local_mods(&root, &store);
        if locals.is_empty() {
            return Ok(modupdate::build_report(
                &locals,
                &std::collections::HashMap::new(),
                None,
                0,
            ));
        }

        let mut server: std::collections::HashMap<i64, modupdate::ServerMod> =
            std::collections::HashMap::new();
        let mut server_total: Option<i64> = None;
        let mut pages = 0usize;
        let mut start: i64 = 1;

        while pages < modupdate::MAX_PAGES {
            let page = client.installed(start, modupdate::PAGE_SIZE)?;
            pages += 1;
            if server_total.is_none() {
                server_total = page.total_count;
            }
            if page.items.is_empty() {
                break;
            }
            modupdate::collect_page(&page, &mut server);

            // 本机模组全部命中就提前收工，少发请求
            if locals.iter().all(|local| server.contains_key(&local.mod_id)) {
                break;
            }
            start += modupdate::PAGE_SIZE;
            if let Some(total) = server_total {
                if start > total {
                    break;
                }
            }
        }

        log::info!(
            target: "modupdate",
            "批量更新检测完成：本地 {} 个，服务端已订阅 {:?}，请求 {} 页",
            locals.len(),
            server_total,
            pages
        );
        Ok(modupdate::build_report(&locals, &server, server_total, pages))
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("批量检查任务失败：{e}"), None))?
}
/// 首次启动引导用：本机真实存在、含 local/subscribed 的候选路径（只有路径）
#[tauri::command]
fn candidate_roots() -> Vec<String> {
    settings::detect_roots()
}

/// 首次启动引导用：带来源说明的候选路径（注册表 / Steam 库 / 用户目录 / 全盘扫描）
#[tauri::command]
fn detect_root_candidates() -> Vec<models::RootCandidate> {
    settings::detect_candidates()
}

async fn run_scan(app: tauri::AppHandle, root: PathBuf) -> Result<models::ScanReport, String> {
    // 只读放行缩略图所在目录（asset 协议），不涉及任何写操作
    let _ = app.asset_protocol_scope().allow_directory(&root, true);

    let target = root.clone();
    // 软件自己的元数据（官方 Tag，记录在配置目录，不写游戏目录）
    let meta = metadata::load_for_app(&app);
    let report = tauri::async_runtime::spawn_blocking(move || scan::scan(&target, &meta))
        .await
        .map_err(|e| format!("扫描任务执行失败：{e}"))?;

    if let Ok(path) = settings_path(&app) {
        let mut current = settings::load(&path);
        current.mod_root = report.root.clone();
        current.last_scan_ms = Some(report.scanned_at_ms);
        let _ = settings::save(&path, &current);
    }

    Ok(report)
}

#[tauri::command]
async fn scan_mods(
    app: tauri::AppHandle,
    root: Option<String>,
) -> Result<models::ScanReport, String> {
    let resolved: PathBuf = match root {
        Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw),
        _ => match settings_path(&app).map(|p| settings::load(&p)) {
            Ok(saved) => match saved.mod_root {
                Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw),
                _ => return Err("尚未设置《帝国时代 II：决定版》的模组根目录".to_string()),
            },
            Err(e) => return Err(e),
        },
    };
    run_scan(app, resolved).await
}

#[tauri::command]
async fn set_mod_root(
    app: tauri::AppHandle,
    root: String,
) -> Result<models::ScanReport, String> {
    let trimmed = root.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let path = PathBuf::from(&trimmed);
    if !path.exists() {
        return Err(format!("路径不存在：{trimmed}"));
    }
    if !path.is_dir() {
        return Err(format!("该路径不是文件夹：{trimmed}"));
    }
    if !settings::is_mod_root(&path) {
        return Err(format!(
            "该目录下没有 local 或 subscribed 子目录，看起来不是 AoE2DE 的模组根目录：{trimmed}"
        ));
    }

    let report = run_scan(app.clone(), path).await?;
    if let Ok(cfg) = settings_path(&app) {
        let mut current = settings::load(&cfg);
        current.mod_root = Some(trimmed);
        let _ = settings::save(&cfg, &current);
    }
    Ok(report)
}

/// 选中模组后按需统计真实体积；路径必须位于已配置的根目录内
#[tauri::command]
async fn mod_stats(app: tauri::AppHandle, path: String) -> Result<models::ModStats, String> {
    let root = settings_path(&app)
        .map(|p| settings::load(&p))
        .ok()
        .and_then(|s| s.mod_root)
        .ok_or_else(|| "尚未设置模组根目录".to_string())?;

    let root_canon = fs::canonicalize(&root).map_err(|e| format!("根目录不可访问：{e}"))?;
    let target_canon = fs::canonicalize(&path).map_err(|e| format!("目标路径不可访问：{e}"))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("拒绝访问：目标路径不在模组根目录内".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || scan::dir_stats(&target_canon))
        .await
        .map_err(|e| format!("统计任务执行失败：{e}"))?
}

// ---------------- 官网账号与会话 ----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    logged_in: bool,
    cookie_count: usize,
    window_ready: bool,
    /// 登录态的放置位置（WebView2 数据目录 / DPAPI 加密缓存）
    storage: String,
    /// webview | cache；未登录时为 None
    cookie_source: Option<String>,
    error: Option<String>,
}

fn storage_note(source: online::session::SessionSource) -> String {
    match source {
        online::session::SessionSource::Webview => {
            "WebView2 会话 Cookie（数据目录已持久化）".to_string()
        }
        online::session::SessionSource::Cache => {
            "本地加密缓存（DPAPI，仅当前 Windows 用户可解密）".to_string()
        }
    }
}

fn session_status_logged_out(error: Option<String>) -> SessionStatus {
    SessionStatus {
        logged_in: false,
        cookie_count: 0,
        window_ready: false,
        storage: "未登录".to_string(),
        cookie_source: None,
        error,
    }
}

/// 检查登录态。
///
/// 必须是 `async`：Tauri 2 的注释明确写了两件事在 Windows 上只能在非主线程做
/// - `WebviewWindowBuilder::build()`：同步命令里调用会死锁
///   （tauri-2.12.5/src/webview/webview_window.rs:58 "You should use async commands and separate threads when creating windows."）
/// - `WebviewWindow::cookies()`：同样只能在异步命令/独立线程里调用
///   （同文件 :2727 "You should use async commands and separate threads when reading cookies."）
#[tauri::command]
async fn online_session_status(app: tauri::AppHandle) -> SessionStatus {
    // 窗口创建与 Cookie 读取都必须在非主线程完成（见上方注释），
    // 这里把整个探测（含 DPAPI 缓存回退）都放进阻塞线程。
    let handle = app.clone();
    let probed = tauri::async_runtime::spawn_blocking(move || {
        online::session::probe_session(&handle)
    })
    .await;

    match probed {
        Ok(Ok(probe)) => {
            let count = probe.header.split(';').count();
            log::info!(
                target: "account",
                "会话探测成功：来源={} Cookie 数={}（内容不打印）",
                probe.source.as_str(),
                count
            );
            SessionStatus {
                logged_in: true,
                cookie_count: count,
                window_ready: probe.source == online::session::SessionSource::Webview,
                storage: storage_note(probe.source),
                cookie_source: Some(probe.source.as_str().to_string()),
                error: None,
            }
        }
        Ok(Err(e)) => {
            if e.contains("尚未登录") {
                session_status_logged_out(None)
            } else {
                session_status_logged_out(Some(format!("读取会话 Cookie 失败：{e}")))
            }
        }
        Err(e) => session_status_logged_out(Some(format!("会话线程异常：{e}"))),
    }
}

/// 启动期会话检查（持久登录默认关闭时的兜底）。
///
/// 顺序：`probe_session`（只读现有 Cookie）→ 未登录且 `remember_login=false`
/// → 后台跑一次 `ensure_session`（隐藏窗口静默 SSO，自带 25s 上限）。
/// 整个流程都在阻塞线程里，命令只把结果交给前端底栏，不阻塞首屏。
#[tauri::command]
async fn online_startup_session(app: tauri::AppHandle) -> SessionStatus {
    let handle = app.clone();
    let checked = tauri::async_runtime::spawn_blocking(move || -> SessionStatus {
        let remember = settings::load_for_app(&handle).remember_login;
        log::info!(target: "startup", "启动会话检查：remember_login={remember}");
        match online::session::probe_session(&handle) {
            Ok(probe) => {
                let count = probe.header.split(';').count();
                log::info!(
                    target: "startup",
                    "启动会话检查：已有可用会话（来源={} Cookie 数={}），无需静默重登",
                    probe.source.as_str(),
                    count
                );
                SessionStatus {
                    logged_in: true,
                    cookie_count: count,
                    window_ready: probe.source == online::session::SessionSource::Webview,
                    storage: storage_note(probe.source),
                    cookie_source: Some(probe.source.as_str().to_string()),
                    error: None,
                }
            }
            Err(e) if remember => {
                // 开关开着却探测不到：持久 Cookie 已失效，交给用户手动登录
                log::info!(
                    target: "startup",
                    "启动会话检查：无有效会话（remember_login=true，不自动重登）：{e}"
                );
                session_status_logged_out(Some(e))
            }
            Err(e) => {
                log::info!(
                    target: "startup",
                    "启动会话检查：无有效会话（{e}），开始隐藏窗口静默重登"
                );
                match online::session::ensure_session(&handle) {
                    Ok(header) => {
                        let count = header.split(';').count();
                        log::info!(target: "startup", "启动静默重登成功（Cookie 数={count}）");
                        SessionStatus {
                            logged_in: true,
                            cookie_count: count,
                            window_ready: true,
                            storage: storage_note(online::session::SessionSource::Webview),
                            cookie_source: Some(
                                online::session::SessionSource::Webview.as_str().to_string(),
                            ),
                            error: None,
                        }
                    }
                    Err(e2) => {
                        log::info!(target: "startup", "启动静默重登失败，改为提示手动登录：{e2}");
                        session_status_logged_out(Some(e2))
                    }
                }
            }
        }
    })
    .await;

    match checked {
        Ok(status) => status,
        Err(e) => session_status_logged_out(Some(format!("会话线程异常：{e}"))),
    }
}

/// 打开登录窗口。`platform` = "steam" | "microsoft" | "psn"。
///
/// 默认地址 auth.ageofempires.com 会 302 到微软，这是官方行为；要选 Steam 就必须
/// 直接导航到 /loginsteam（实测 → steamcommunity.com/openid/login → 回跳 /signin-steam）。
#[tauri::command]
async fn online_open_login(app: tauri::AppHandle, platform: Option<String>) -> Result<(), String> {
    let key = platform.unwrap_or_else(|| "microsoft".to_string());
    let url = match key.as_str() {
        "steam" => online::session::LOGIN_STEAM_URL,
        "psn" => online::session::LOGIN_PSN_URL,
        _ => online::session::LOGIN_URL,
    };
    log::info!(target: "account-window", "前端请求打开登录窗口 platform={key} url={url}");
    // 主动登录意味着旧会话已失效，先丢掉缓存，避免"假登录态"
    let _ = online::session::invalidate_cached_session(&app);
    let window = online::session::ensure_account_window(&app, url, true)?;
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginTarget {
    key: String,
    label: String,
    url: String,
    hint: String,
}

/// 后台静默登录：用**隐藏**窗口打开登录入口，靠平台 SSO 的持久 Cookie 自动跑完
/// login.microsoftonline.com → /Home/CompleteLogin 整条跳转链，因此应用重启后
/// 通常不需要用户再点一次“微软登录”（会话 Cookie 不跨进程存活，但 MS 的会）。
/// 失败也不报错：窗口保持隐藏，用户手动点登录时会被 ensure_account_window 复用并显示。
#[tauri::command]
async fn online_open_login_silent(
    app: tauri::AppHandle,
    platform: Option<String>,
) -> Result<(), String> {
    let key = platform.unwrap_or_else(|| "microsoft".to_string());
    let url = match key.as_str() {
        "steam" => online::session::LOGIN_STEAM_URL,
        "psn" => online::session::LOGIN_PSN_URL,
        _ => online::session::LOGIN_URL,
    };
    log::info!(target: "account-window", "后台静默登录 platform={key} url={url}");
    // 注意：不调用 invalidate_cached_session，失败时仍保留 DPAPI 兜底
    let window = online::session::ensure_account_window(&app, url, false)?;
    // 已有隐藏窗口时 ensure_account_window 不会导航，这里补一次，保证真的触发 SSO 回跳
    if let Ok(parsed) = tauri::Url::parse(url) {
        if let Err(e) = window.navigate(parsed) {
            log::warn!(target: "account-window", "静默登录导航失败：{e}");
        }
    }
    Ok(())
}

/// 登录入口清单：前端只负责渲染，不自己拼 URL
#[tauri::command]
fn online_login_targets() -> Vec<LoginTarget> {
    vec![
        LoginTarget {
            key: "steam".to_string(),
            label: "用 Steam 账号登录".to_string(),
            url: online::session::LOGIN_STEAM_URL.to_string(),
            hint: "适合 Steam 版游戏；如果之后提示无权限，请改用微软/Xbox 账号".to_string(),
        },
        LoginTarget {
            key: "microsoft".to_string(),
            label: "用微软 / Xbox 账号登录".to_string(),
            url: online::session::LOGIN_URL.to_string(),
            hint: "官方 mod 接口的主体系，兼容性最好".to_string(),
        },
        LoginTarget {
            key: "psn".to_string(),
            label: "用 PlayStation Network 登录".to_string(),
            url: online::session::LOGIN_PSN_URL.to_string(),
            hint: "主机平台账号".to_string(),
        },
    ]
}

#[tauri::command]
async fn online_close_login_window(app: tauri::AppHandle) {
    log::info!(target: "account-window", "前端请求隐藏登录窗口（online_close_login_window）");
    online::session::note_programmatic_hide("前端调用 online_close_login_window");
    if let Some(win) = app.get_webview_window(online::session::ACCOUNT_WINDOW) {
        let _ = win.hide();
    }
}

/// 登录/退出后让 WebView 回到普通页面（不接触账号数据）
#[tauri::command]
async fn online_reset_login_view(app: tauri::AppHandle) -> Result<(), String> {
    let win = online::session::ensure_account_window(&app, online::session::HOME_URL, false)?;
    if let Ok(url) = tauri::Url::parse(online::session::HOME_URL) {
        let _ = win.navigate(url);
    }
    let _ = win.hide();
    Ok(())
}

/// 诊断用：显式创建隐藏会话窗口并回读 Cookie 数量（不返回任何令牌内容）
#[tauri::command]
async fn online_probe_account_window(app: tauri::AppHandle) -> Result<String, String> {
    let window = online::session::ensure_account_window(
        &app,
        online::session::HOME_URL,
        false,
    )?;
    let label = window.label().to_string();
    let url = window
        .url()
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "(未知)".to_string());

    let handle = window.clone();
    let header = tauri::async_runtime::spawn_blocking(move || {
        online::session::collect_cookie_header(&handle)
    })
    .await
    .map_err(|e| format!("会话线程异常：{e}"))??;

    let count = if header.is_empty() { 0 } else { header.split(';').count() };
    Ok(format!("隐藏窗口已创建：label={label} url={url} ageofempires Cookie 数={count}"))
}

// ---------------- 网络与登录缓存（高级设置） ----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkSettingsView {
    /// true = 自动跟随系统网络（默认）
    auto: bool,
    proxy_url: Option<String>,
    remember_login: bool,
    /// manual | system | env | direct（实际生效的链路）
    source: String,
    effective_proxy: Option<String>,
    note: Option<String>,
    /// 传给 WebView2 的启动参数（None = 交给 WebView2 自己跟系统）
    webview_args: Option<String>,
    /// 登录态实际存放的数据目录（排查“为什么每次都要登录”用）
    data_dir: Option<String>,
    error: Option<String>,
}

fn network_view(app: &tauri::AppHandle, settings: &models::Settings) -> NetworkSettingsView {
    let data_dir = online::session::webview_data_dir(app)
        .ok()
        .map(|p| p.display().to_string());
    let cfg = net::NetConfig::from_settings(settings);
    match net::resolve(&cfg) {
        Ok(resolved) => NetworkSettingsView {
            auto: settings.proxy_mode != net::MODE_MANUAL,
            proxy_url: settings.proxy_url.clone(),
            remember_login: settings.remember_login,
            source: resolved.source.clone(),
            effective_proxy: resolved.proxy_url.clone(),
            note: resolved.note.clone(),
            webview_args: net::webview_args(&resolved),
            data_dir,
            error: None,
        },
        Err(e) => NetworkSettingsView {
            auto: settings.proxy_mode != net::MODE_MANUAL,
            proxy_url: settings.proxy_url.clone(),
            remember_login: settings.remember_login,
            source: "direct".to_string(),
            effective_proxy: None,
            note: None,
            webview_args: None,
            data_dir,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn get_network_settings(app: tauri::AppHandle) -> NetworkSettingsView {
    let settings = settings::load_for_app(&app);
    network_view(&app, &settings)
}

/// 保存网络设置并让新配置立即生效。
/// WebView2 只在创建 Environment 时读代理参数，所以必须销毁账号窗口，
/// 下次打开（或下次探测）时用新配置重建。
#[tauri::command]
async fn set_network_settings(
    app: tauri::AppHandle,
    auto: bool,
    proxy_url: Option<String>,
    remember_login: bool,
) -> Result<NetworkSettingsView, String> {
    let mut settings = settings::load_for_app(&app);
    if auto {
        settings.proxy_mode = net::MODE_SYSTEM.to_string();
        settings.proxy_url = None;
    } else {
        let url = net::normalize_manual(proxy_url.as_deref().unwrap_or(""))?;
        settings.proxy_mode = net::MODE_MANUAL.to_string();
        settings.proxy_url = Some(url);
    }
    settings.remember_login = remember_login;
    settings::save_for_app(&app, &settings)?;

    if !remember_login {
        if let Ok(path) = settings::session_cache_for(&app) {
            let _ = secure::clear(&path);
            log::info!(target: "session-cache", "“记住登录”已关闭，已删除本地会话缓存");
        }
    }

    let handle = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        online::session::destroy_account_window(&handle, "网络设置变更，下次打开登录窗口时重建");
        std::thread::sleep(std::time::Duration::from_millis(300));
    })
    .await;

    Ok(network_view(&app, &settings))
}

/// 「记住登录 7 天」开关：**只做存储**，不触发任何 Cookie/登录逻辑。
/// 真正的门控在 `session.rs` 的 `persist_auth_cookies` 调用处读同一个字段。
#[tauri::command]
fn set_remember_login(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let mut settings = settings::load_for_app(&app);
    if settings.remember_login != enabled {
        settings.remember_login = enabled;
        settings::save_for_app(&app, &settings)?;
        log::info!(
            target: "settings",
            "记住登录开关已写入 settings.json：remember_login={enabled}"
        );
    }
    // 关闭时顺手清掉旧的 DPAPI 会话缓存，避免“开关关了、磁盘上还留着凭证”
    if !enabled {
        if let Ok(path) = settings::session_cache_for(&app) {
            if path.exists() {
                match secure::clear(&path) {
                    Ok(()) => log::info!(target: "settings", "记住登录已关闭，旧会话缓存已删除"),
                    Err(e) => log::warn!(target: "settings", "删除旧会话缓存失败：{e}"),
                }
            }
        }
    }
    Ok(enabled)
}

/// 退出登录：只在用户显式点击时执行，清空 WebView2 数据目录与加密会话缓存
#[tauri::command]
async fn online_clear_login_cache(app: tauri::AppHandle) -> Result<String, String> {
    log::info!(target: "account-window", "前端请求退出登录 / 清除登录缓存");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || online::session::clear_login_cache(&handle))
        .await
        .map_err(|e| format!("清理任务异常：{e}"))?
}

// ---------------- 在线浏览 ----------------

/// 在资源管理器中定位模组文件夹（仅允许模组根目录下的真实目录）
#[tauri::command]
async fn reveal_mod_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let settings = settings::load_for_app(&app);
    let root = settings
        .mod_root
        .ok_or_else(|| "尚未设置游戏模组目录".to_string())?;
    let target = std::fs::canonicalize(&path).map_err(|e| format!("模组目录不可访问：{e}"))?;
    let root_dir =
        std::fs::canonicalize(&root).map_err(|e| format!("模组根目录不可访问：{e}"))?;
    if !target.starts_with(&root_dir) {
        return Err("拒绝打开模组根目录之外的路径".to_string());
    }
    if !target.is_dir() {
        return Err("目标不是一个文件夹".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe 只认命令行原文：显式加引号，兼容含空格的模组路径
        let arg = format!("/select,\"{}\"", target.display());
        std::process::Command::new("explorer.exe")
            .raw_arg(arg)
            .spawn()
            .map_err(|e| format!("无法启动资源管理器：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".to_string())
    }
}

#[tauri::command]
async fn online_tags(app: tauri::AppHandle) -> Result<Vec<online::models::ModTag>, ApiFailure> {
    let client = client(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        client.tags().map(|all| {
            all.into_iter()
                .filter(|tag| tag.game_title_id == Some(online::api::GAME_AOE2DE))
                .collect()
        })
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("请求任务失败：{e}"), None))?
}

#[tauri::command]
async fn online_find(
    app: tauri::AppHandle,
    query: String,
    start: i64,
    count: i64,
    sort: String,
    order: String,
    tags: Vec<i64>,
) -> Result<online::models::FindResult, ApiFailure> {
    let client = client(&app)?;
    let start = start.max(1);
    let count = count.clamp(1, 50);
    // key 与「读缓存」用的必须是同一份 cache::find_key，否则永远读不到自己写的数据
    let key = cache::find_key(&query, start, count, &sort, &order, &tags);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client.find(&query, start, count, &sort, &order, &tags)?;
        // 只有成功才写缓存：把 401 / 网络错误写进去会变成「缓存里永远没数据」
        if let Ok(value) = serde_json::to_value(&result) {
            cache::put_for_app(&handle, &key, "find", value);
        }
        Ok(result)
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("查询任务失败：{e}"), None))?
}

#[tauri::command]
async fn online_installed(
    app: tauri::AppHandle,
    start: i64,
    count: i64,
) -> Result<online::models::FindResult, ApiFailure> {
    let client = client(&app)?;
    let start = start.max(1);
    let count = count.clamp(1, 50);
    let key = cache::installed_key(start, count);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client.installed(start, count)?;
        if let Ok(value) = serde_json::to_value(&result) {
            cache::put_for_app(&handle, &key, "installed", value);
        }
        Ok(result)
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("查询任务失败：{e}"), None))?
}

#[tauri::command]
async fn online_detail(
    app: tauri::AppHandle,
    mod_id: i64,
) -> Result<serde_json::Value, ApiFailure> {
    let client = client(&app)?;
    let key = cache::detail_key(mod_id);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value = client.detail(mod_id)?;
        if !value.is_null() {
            cache::put_for_app(&handle, &key, "detail", value.clone());
        }
        Ok(value)
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("请求任务失败：{e}"), None))?
}

// ---------------- 在线数据离线缓存（SWR 秒开） ----------------

/// 读缓存：搜索 / 分页。
/// 返回 None = 未命中；命中但 expired=true 表示已超过 24 小时，前端应当直接走网络。
/// 注意：Key 由 Rust 侧 cache::find_key 统一计算，前端只传原始参数，不自己拼。
#[tauri::command]
async fn online_cache_find(
    app: tauri::AppHandle,
    query: String,
    start: i64,
    count: i64,
    sort: String,
    order: String,
    tags: Vec<i64>,
) -> Option<cache::CacheHit> {
    let start = start.max(1);
    let count = count.clamp(1, 50);
    let key = cache::find_key(&query, start, count, &sort, &order, &tags);
    tauri::async_runtime::spawn_blocking(move || cache::get_for_app(&app, &key))
        .await
        .ok()
        .flatten()
}

/// 读缓存：已订阅列表（/Installed，只有分页参数）
#[tauri::command]
async fn online_cache_installed(
    app: tauri::AppHandle,
    start: i64,
    count: i64,
) -> Option<cache::CacheHit> {
    let key = cache::installed_key(start.max(1), count.clamp(1, 50));
    tauri::async_runtime::spawn_blocking(move || cache::get_for_app(&app, &key))
        .await
        .ok()
        .flatten()
}

/// 读缓存：单个模组详情
#[tauri::command]
async fn online_cache_detail(app: tauri::AppHandle, mod_id: i64) -> Option<cache::CacheHit> {
    let key = cache::detail_key(mod_id);
    tauri::async_runtime::spawn_blocking(move || cache::get_for_app(&app, &key))
        .await
        .ok()
        .flatten()
}

/// 一次性读多页缓存（全部在内存里完成）：切分类 / 翻页 / 搜索都只发这一个 invoke，
/// 且**不会触发任何 Loading** —— 有数据就立刻渲染。
#[tauri::command]
async fn online_cache_pages(
    app: tauri::AppHandle,
    query: String,
    start: i64,
    count: i64,
    sort: String,
    order: String,
    tags: Vec<i64>,
    installed: Option<bool>,
    max_pages: Option<u32>,
) -> Vec<cache::CachedPage> {
    let start = start.max(1);
    let count = count.clamp(1, 50);
    let max_pages = max_pages.unwrap_or(8).clamp(1, 30) as usize;
    let installed = installed.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        cache::pages_for_app(
            &app,
            cache::PageQuery {
                query: &query,
                start,
                count,
                sort: &sort,
                order: &order,
                tags: &tags,
                installed,
            },
            max_pages,
        )
    })
    .await
    .unwrap_or_default()
}

/// 缓存里出现过的所有列表项（去重、按订阅数降序）：
/// 「我的收藏」纯本地浏览的数据源，让没加载过的收藏项也能显示。
#[tauri::command]
async fn online_cache_items(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || cache::all_items_for_app(&app))
        .await
        .unwrap_or_default()
}

/// 缓存总览：JSON 缓存 + 图片缓存
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheOverview {
    #[serde(flatten)]
    cache: cache::CacheStat,
    image_dir: String,
    image_entries: usize,
    image_bytes: u64,
    image_max_bytes: u64,
}

#[tauri::command]
async fn online_cache_stat(app: tauri::AppHandle) -> CacheOverview {
    tauri::async_runtime::spawn_blocking(move || {
        let stat = cache::stat_for_app(&app);
        let (image_entries, image_bytes) = images::stat(&app);
        CacheOverview {
            cache: stat,
            image_dir: images::dir_for(&app)
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            image_entries,
            image_bytes,
            image_max_bytes: images::MAX_BYTES,
        }
    })
    .await
    .unwrap_or_else(|_| CacheOverview {
        cache: cache::CacheStat {
            path: String::new(),
            entries: 0,
            bytes: 0,
            oldest_ms: None,
            newest_ms: None,
            ttl_ms: cache::TTL_MS,
            max_entries: cache::MAX_ENTRIES,
            max_bytes: cache::MAX_BYTES,
        },
        image_dir: String::new(),
        image_entries: 0,
        image_bytes: 0,
        image_max_bytes: images::MAX_BYTES,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearEverything {
    removed: bool,
    path: String,
    entries_removed: usize,
    images_removed: usize,
    images_bytes: u64,
}

/// 清理在线缓存：online_cache.json + image_cache 整个目录（设置 → 网络）
#[tauri::command]
async fn online_cache_clear(app: tauri::AppHandle) -> Result<ClearEverything, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let report = cache::clear_for_app(&app)?;
        let (images_removed, images_bytes) = images::clear(&app);
        Ok(ClearEverything {
            removed: report.removed,
            path: report.path,
            entries_removed: report.entries_removed,
            images_removed,
            images_bytes,
        })
    })
    .await
    .map_err(|e| format!("清理任务异常：{e}"))?
}

// ---------------- v1.0：在线全量索引（中文搜索的底座） ----------------

/// 索引状态：已收录条数 / 服务端总量 / 是否同步中 / 一行状态文案
#[tauri::command]
async fn online_index_status(app: tauri::AppHandle) -> online_index::IndexStatus {
    tauri::async_runtime::spawn_blocking(move || online_index::status_for_app(&app))
        .await
        .unwrap_or_default()
}

/// 手动补全索引：受单飞 + 限流冷却保护，连点无效
#[tauri::command]
async fn online_index_sync(app: tauri::AppHandle) -> Result<online_index::SyncReport, ApiFailure> {
    tauri::async_runtime::spawn_blocking(move || online_index::sync_blocking(&app, "manual"))
        .await
        .map_err(|e| ApiFailure::new("internal", format!("索引任务失败：{e}"), None))?
}

/// 暂停 / 继续本地索引。
/// `paused=true`：只置暂停标记，同步线程在「当前这一页」完成后收手并保留分区游标；
/// `paused=false`：清标记并立刻丢一个后台线程续爬（**不等它跑完**，否则 invoke 会被
/// 卡住好几分钟），从已落盘的游标接着爬。两者都立即返回最新状态。
#[tauri::command]
async fn online_index_pause(app: tauri::AppHandle, paused: bool) -> online_index::IndexStatus {
    if paused {
        online_index::request_pause();
    } else {
        online_index::clear_pause_request();
        // 后台线程：reason="resume" → scan 里 force=true，强制跳过 24h / 7d 新鲜度闸门
        online_index::spawn_resume(app.clone());
    }
    let probe = app.clone();
    tauri::async_runtime::spawn_blocking(move || online_index::status_for_app(&probe))
        .await
        .unwrap_or_default()
}

/// 本地混合搜索：索引 + 本地译文标题，**一个网络请求都不发**。
/// 中文查询由前端拦截到这里；英文查询仍然走 `online_find`。
#[tauri::command]
async fn online_index_search(
    app: tauri::AppHandle,
    query: String,
    offset: Option<i64>,
    limit: Option<i64>,
    target_lang: Option<String>,
) -> online_index::SearchResult {
    tauri::async_runtime::spawn_blocking(move || {
        // 语言走与「一键翻译」完全相同的解析链，避免设置里换了语言搜索却按旧语言匹配
        let lang = translator::resolve_lang(&app, target_lang.as_deref());
        online_index::search_for_app(&app, &query, offset.unwrap_or(0), limit.unwrap_or(24), &lang)
    })
    .await
    .unwrap_or_default()
}

/// v1.1：**本地搜索**的唯一入口（前端「本地搜索框」专用）。
///
/// 与官方搜索彻底解耦：顶栏官方搜索走 `online_find`（英文 / ID / 作者），
/// 这里只查本地索引 + 本地译文标题，**一个网络请求都不发**。
/// 底层复用 `online_index::search_for_app`（中文标题 > 英文标题 > 作者 > 分类 > `#ID`），
/// 索引本身没有任何改动。
#[tauri::command]
async fn search_local_mods(
    app: tauri::AppHandle,
    keyword: String,
    offset: Option<i64>,
    limit: Option<i64>,
    target_lang: Option<String>,
) -> online_index::SearchResult {
    tauri::async_runtime::spawn_blocking(move || {
        // 语言与「一键翻译」共用同一条解析链，设置里换语言后搜索立刻按新语言匹配
        let lang = translator::resolve_lang(&app, target_lang.as_deref());
        online_index::search_for_app(&app, &keyword, offset.unwrap_or(0), limit.unwrap_or(60), &lang)
    })
    .await
    .unwrap_or_default()
}

/// v1.2：开关「本地中文搜索与自动索引」（设置 → 通用）。
///
/// 落盘到 settings.json 的 `enable_indexing`：
/// - 开启：立刻在后台补建一次索引（不阻塞命令返回）；
/// - 关闭：本轮同步在下一页之前停下，状态切成「未开启」（指示灯变 ⚪）。
#[tauri::command]
async fn set_enable_indexing(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    current.enable_indexing = enabled;
    settings::save(&path, &current)?;
    if enabled {
        online_index::spawn_now(app.clone());
    } else {
        online_index::mark_disabled(&app);
    }
    Ok(enabled)
}

/// v1.2：开关「在线页的本地搜索框」（设置 → 通用，默认关闭）。
/// 只是界面开关：只落盘 settings.json，不触碰索引数据，也不会发任何请求。
#[tauri::command]
async fn set_enable_local_search(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    current.enable_local_search = enabled;
    settings::save(&path, &current)?;
    Ok(enabled)
}

/// v1.6：本地列表的视图偏好（"grid" 大图 / "list" 紧凑 + 卡片宽度）。
///
/// 只写界面偏好：非法 view_mode 一律当成 grid，card_size 取整到 20 的倍数并夹进 160..=320，
/// 不报错、不动扫描结果、不触发重扫（前端拖滑块时可以放心调用）。
#[tauri::command]
async fn set_view_prefs(
    app: tauri::AppHandle,
    view_mode: String,
    card_size: u32,
) -> Result<models::Settings, String> {
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    current.view_mode = if view_mode == models::VIEW_MODE_LIST {
        models::VIEW_MODE_LIST.to_string()
    } else {
        models::VIEW_MODE_GRID.to_string()
    };
    current.card_size = models::clamp_card_size(card_size);
    settings::save(&path, &current)?;
    Ok(current)
}

/// v2.2：界面主题（"dark" 深色羊皮纸 / "light" 明亮米白）。
///
/// 只写界面偏好：非法值一律归一化成 dark，不报错、不动扫描结果、不触发重扫
/// （前端切换后可以立即调用，写盘失败由前端提示，不回滚界面）。
#[tauri::command]
async fn set_theme(app: tauri::AppHandle, theme: String) -> Result<models::Settings, String> {
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    current.theme = models::normalize_theme(&theme);
    settings::save(&path, &current)?;
    Ok(current)
}

/// v3.0：批量保存排版偏好 —— 三个层级一次性落盘（界面 / 正文阅读 / 卡片列表）。
///
/// 所有值在这里统一归一化：字体种类只认 hei / youyuan / system（v2.4 旧值静默改写）、
/// 缩放夹进 80..=150、正文 12..=24、卡片 10..=16，行距取最近一档（1.4 / 1.6 / 1.8），
/// 界面与正文字重都以 600 为界归到 400 / 700。
/// 不报错、不动扫描结果、不触发重扫；写盘失败由前端提示，不回滚界面。
#[tauri::command]
async fn save_typography_prefs(
    app: tauri::AppHandle,
    ui_font_family: String,
    ui_font_weight: u32,
    global_font_scale: u32,
    reader_font_size: u32,
    reader_line_height: f32,
    reader_font_weight: u32,
    card_font_size: u32,
) -> Result<models::Settings, String> {
    let path = settings_path(&app)?;
    let mut current = settings::load(&path);
    // 先排干 v2.3 遗留字段，避免它们在新值之后又被迁移逻辑覆盖
    current.migrate_legacy_typography();
    current.ui_font_family = models::normalize_ui_font_family(&ui_font_family);
    current.ui_font_weight = models::normalize_ui_font_weight(ui_font_weight);
    current.global_font_scale = models::clamp_global_font_scale(global_font_scale);
    current.reader_font_size = models::clamp_reader_font_size(reader_font_size);
    current.reader_line_height = models::normalize_reader_line_height(reader_line_height);
    current.reader_font_weight = models::normalize_reader_font_weight(reader_font_weight);
    current.card_font_size = models::clamp_card_font_size(card_font_size);
    settings::save(&path, &current)?;
    Ok(current)
}

/// 清空索引（设置 → 缓存）。下次启动会在后台自动重建，不会丢用户数据。
#[tauri::command]
async fn online_index_clear(app: tauri::AppHandle) -> Result<online_index::ClearReport, String> {
    tauri::async_runtime::spawn_blocking(move || online_index::clear_for_app(&app))
        .await
        .map_err(|e| format!("清理任务异常：{e}"))?
}

// ---------------- v1.0：批量标题翻译（online_titles_zh.json） ----------------

/// 开始批量翻译标题：后台单线程、**1 req/s**（复用 translator 的全局 FIFO 限速器）。
/// 只能由用户点按钮启动，绝不自动触发；已在跑时返回 `busy`。
#[tauri::command]
fn online_titles_translate_start(
    app: tauri::AppHandle,
    target_lang: Option<String>,
) -> Result<translator::TitleJobStatus, ApiFailure> {
    translator::start_title_job(app, target_lang)
}

/// 请求停止：当前这条请求跑完后退出，不会把在飞的 HTTP 请求掐断。
#[tauri::command]
fn online_titles_translate_stop(app: tauri::AppHandle) -> translator::TitleJobStatus {
    translator::stop_title_job(&app)
}

/// 批量标题翻译进度（含「已翻 / 待翻 / 失败」与一行状态）。
#[tauri::command]
async fn online_titles_translate_status(app: tauri::AppHandle) -> translator::TitleJobStatus {
    tauri::async_runtime::spawn_blocking(move || translator::title_job_status(&app))
        .await
        .unwrap_or_default()
}

/// 批量查询本地是否已有封面：返回 modId → 绝对路径
/// （前端用 @tauri-apps/api 的 convertFileSrc 转成 asset URL 给 <img>）
#[tauri::command]
async fn online_images_local(
    app: tauri::AppHandle,
    mod_ids: Vec<i64>,
) -> Vec<images::LocalImage> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for id in mod_ids {
            if let Some(path) = images::local_for(&app, id) {
                out.push(images::LocalImage { mod_id: id, path });
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// 后台补齐缺失封面：立即返回排队数量；全部下载完后发 online://images-ready 事件。
#[tauri::command]
async fn online_images_fetch(app: tauri::AppHandle, tasks: Vec<images::FetchTask>) -> usize {
    let queued: Vec<images::FetchTask> = tasks
        .into_iter()
        .filter(|t| t.url.trim().starts_with("https://"))
        .collect();
    if queued.is_empty() {
        return 0;
    }
    let count = queued.len();
    std::thread::spawn(move || images::download_batch(app, queued));
    count
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallAssets {
    /// 是否新写了 info.json（原本就有 = false）
    info_json_written: bool,
    info_json_path: Option<String>,
    /// 最终可用的缩略图文件名（jpg / png）；None = 没有缩略图
    thumbnail_name: Option<String>,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallOutcome {
    install: install::InstallReport,
    downloaded_bytes: u64,
    /// info.json / 缩略图的补全结果（游戏识别模组依赖这两个文件）
    assets: InstallAssets,
    /// 是否已成功转入 local（本工具的最终形态）
    localized: bool,
    /// 最终所在目录（local 或 subscribed）
    final_dir: String,
    /// 最终写入 mod-status.json 的 Path（local//… 或 subscribed//…）
    final_path: String,
    /// mod-status.json 的写入结果说明
    status_note: String,
    status_backup_path: Option<String>,
    /// 安装后本地状态如何被游戏识别，给出明确预期
    note: String,
}

/// 把最终形态**一次性**写进 mod-status.json：
/// - localized = true  → 写 local//（Path 直接改成最终值，不产生 subscribed// 中间态）
/// - localized = false → 写 subscribed//（转本地失败时的兜底，模组仍然可用）
fn write_final_status(
    status_path: &std::path::Path,
    backup_dir: &std::path::Path,
    mod_id: i64,
    title: &str,
    folder_name: &str,
    localized: bool,
    skip_process_check: bool,
) -> Result<(String, Option<String>), String> {
    if localized {
        let kind = "local";
        let sel = presets::ModSelector {
            workshop_id: u64::try_from(mod_id).ok(),
            path: install::status_rel_path(kind, folder_name),
        };
        let o = presets::localize_record(
            status_path,
            backup_dir,
            &sel,
            folder_name,
            title,
            skip_process_check,
        )?;
        // 覆盖安装后刷新 LastUpdate：工具自己的「批量更新检测」靠它判断是否已是最新，
        // 否则刚更新完的模组会因为本地时间戳仍是旧的而被再次误报为可更新
        let _ = presets::touch_last_update(status_path, backup_dir, &sel, skip_process_check);
        let mut parts: Vec<String> = Vec::new();
        if o.record_added {
            parts.push("已新建 local// 记录并置为启用".to_string());
        } else if o.path_updated {
            parts.push("已把记录 Path 改为 local// 并置为启用".to_string());
        } else {
            parts.push("local// 记录已是最新状态".to_string());
        }
        if o.workshop_id_cleared {
            parts.push("已把该记录的 WorkshopID 置 0（游戏不会再把它反向同步为订阅）".to_string());
        }
        if o.unsub_cleared {
            parts.push("已从 Unsub 列表移除该 WorkshopID".to_string());
        }
        Ok((parts.join("；"), o.backup_path))
    } else {
        let rec = presets::NewRecord {
            workshop_id: u64::try_from(mod_id).unwrap_or(0),
            title: title.to_string(),
            path: install::status_rel_path("subscribed", folder_name),
        };
        let o = presets::register_mod(status_path, backup_dir, &rec, skip_process_check)?;
        Ok((o.message, o.backup_path))
    }
}

// ---------------- 下载与安装 ----------------

static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn online_cancel_install() {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
}

/// 完整流程：取签名下载地址 → 临时目录下载 → 校验 ZIP → 解压到根目录下的暂存区
/// → 结构校验 → 原子改名安装。任何一步失败都会清理暂存文件，不触碰已有模组。
#[tauri::command]
async fn online_install(
    app: tauri::AppHandle,
    mod_id: i64,
    title: String,
    force: bool,
    tag_ids: Option<Vec<i64>>,
    tag_names: Option<Vec<String>>,
    // 官方 Detail 里的作者（写进 info.json）
    author: Option<String>,
    // 官方 Detail 里的描述（原样 HTML 即可，与游戏自己写的一致）
    description: Option<String>,
    // 官方缩略图地址；解压包里没缩略图时用它兜底
    thumbnail_url: Option<String>,
) -> Result<InstallOutcome, ApiFailure> {
    let root = mod_root(&app)?;
    let client = client(&app)?;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    // 归属判断只看软件自己的元数据：早先装过 = 更新，从未记录 = 外来目录
    let stored_meta = metadata::load_for_app(&app);
    let owned_before = stored_meta.mods.contains_key(&mod_id.to_string());
    // 「更新到最新版」只传 modId / title：分类信息缺失时沿用上次安装记录，
    // 否则会把已有的官方 Tag 覆盖成空，分类与徽章一起丢失
    let stored = stored_meta.mods.get(&mod_id.to_string());
    let title = if title.trim().is_empty() {
        stored.map(|m| m.title.clone()).unwrap_or(title)
    } else {
        title
    };
    let tag_ids = match tag_ids {
        Some(list) if !list.is_empty() => Some(list),
        _ => stored.map(|m| m.tag_ids.clone()).filter(|list| !list.is_empty()),
    };
    let tag_names = match tag_names {
        Some(list) if !list.is_empty() => Some(list),
        _ => stored.map(|m| m.tag_names.clone()).filter(|list| !list.is_empty()),
    };

    let cookie_ok = client;
    let app_for_task = app.clone();
    let root_for_task = root.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<InstallOutcome, ApiFailure> {
        let download_url = cookie_ok.download_url(mod_id)?;

        let outcome = download::download_zip(&app_for_task, mod_id, &download_url, &CANCEL_FLAG)?;
        let staging_base = root_for_task
            .join(".aoe2mm-staging")
            .join(format!("{mod_id}-{}", scan::now_ms()));

        let cleanup_paths = || {
            download::cleanup(&outcome.work_dir);
            let _ = fs::remove_dir_all(&staging_base);
        };

        let extract_dir = staging_base.join("extracted");
        let extract_result = install::extract_zip(
            std::path::Path::new(&outcome.zip_path),
            &extract_dir,
        );
        let (files, extracted_bytes) = match extract_result {
            Ok(v) => v,
            Err(e) => {
                cleanup_paths();
                return Err(ApiFailure::new("invalid", format!("压缩包校验失败：{e}"), None));
            }
        };

        let mod_root_dir = install::detect_mod_root(&extract_dir);
        if let Err(e) = install::validate_structure(&mod_root_dir) {
            cleanup_paths();
            return Err(ApiFailure::new("invalid", format!("内容检查未通过：{e}"), None));
        }

        let install_result = install::install(&mod_root_dir, &root_for_task, mod_id, &title, force, owned_before);
        let report = match install_result {
            Ok(r) => r,
            Err(e) => {
                cleanup_paths();
                return Err(ApiFailure::new("install", e, None));
            }
        };

        cleanup_paths();
        let _ = files;

        // 补全游戏识别所需的文件（必须在写 mod-status.json 之前）：
        //  ① info.json：自己下载的 zip 里常常没有，游戏靠它拿 Title / Author / Description
        //  ② 缩略图：png 改名为 jpg；都没有就用 API 的缩略图地址下载成 thumbnail.jpg
        let target_dir = std::path::Path::new(&report.target_dir);
        let info = install::ensure_info_json(
            target_dir,
            &title,
            author.as_deref().unwrap_or(""),
            description.as_deref().unwrap_or(""),
        );
        let mut thumbnail_name = install::normalize_thumbnail_extension(target_dir);
        let mut thumb_note = match &thumbnail_name {
            Some(name) => format!("缩略图：{name}"),
            None => "缩略图：没有".to_string(),
        };
        if !install::has_thumbnail(target_dir) {
            if let Some(url) = thumbnail_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
                match cookie_ok.fetch_bytes(url, 8 * 1024 * 1024) {
                    Ok(bytes) => match install::write_thumbnail(target_dir, &bytes) {
                        Ok(path) => {
                            thumbnail_name = Some("thumbnail.jpg".to_string());
                            thumb_note = format!("缩略图：已从官网下载（{path}）");
                        }
                        Err(e) => thumb_note = format!("缩略图已下载但写入失败：{e}"),
                    },
                    Err(e) => thumb_note = format!("缩略图下载失败：{}", e.message),
                }
            }
        }
        let (info_json_written, info_json_path, info_note) = match info {
            Ok(install::InfoAction::Written(path)) => (
                true,
                Some(path.clone()),
                format!("已按游戏格式补全 info.json（{path}）"),
            ),
            Ok(install::InfoAction::AlreadyExists) => {
                (false, None, "info.json 已存在，未改动".to_string())
            }
            Err(e) => {
                log::warn!(target: "install", "生成 info.json 失败（模组可能不被游戏识别）：{e}");
                (false, None, format!("info.json 生成失败：{e}"))
            }
        };
        let assets = InstallAssets {
            info_json_written,
            info_json_path,
            thumbnail_name,
            message: format!("{info_note}；{thumb_note}"),
        };

        let folder_name = std::path::Path::new(&report.target_dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // ⑤ 最终形态：移交 local/（失败则保留在 subscribed，照常登记，模组仍然可用）
        let mut localized = false;
        let mut final_dir = report.target_dir.clone();
        let mut final_folder = folder_name.clone();
        let mut final_path = install::status_rel_path("subscribed", &folder_name);
        let mut localize_note = String::new();
        let mut localize_target: Option<install::LocalizeTarget> = None;
        match install::resolve_localize_target(
            &root_for_task,
            mod_id,
            Some(&folder_name),
            owned_before || force,
        ) {
            Ok(target) => match install::move_to_local(&target) {
                Ok(backup) => {
                    localized = true;
                    final_dir = target.to.display().to_string();
                    final_folder = target.folder_name.clone();
                    final_path = install::status_rel_path("local", &final_folder);
                    localize_target = Some(target);
                    if let Some(backup) = backup {
                        localize_note = format!(
                            "local 下的同名旧目录已备份为 {}（未删除）",
                            backup.display()
                        );
                    }
                    log::info!(target: "install", "modId={mod_id} 已转入本地目录：{final_dir}");
                }
                Err(e) => {
                    localize_note = format!("已安装到 subscribed，但转为本地失败：{e}");
                    log::warn!(target: "install", "modId={mod_id} {localize_note}");
                }
            },
            Err(e) => {
                localize_note = format!("已安装到 subscribed，但转为本地失败：{e}");
                log::warn!(target: "install", "modId={mod_id} {localize_note}");
            }
        }

        // ⑥ 只写一次 mod-status.json（写的就是最终形态）；失败则把目录挪回 subscribed 再试一次
        let status_path = root_for_task.join(presets::STATUS_FILE);
        let backup_dir =
            presets::backups_dir_for(&app_for_task).map_err(|e| ApiFailure::new("install", e, None))?;
        let (status_note, status_backup_path) = match write_final_status(
            &status_path,
            &backup_dir,
            mod_id,
            &title,
            &final_folder,
            localized,
            false,
        ) {
            Ok(v) => v,
            Err(e) => {
                log::error!(target: "install", "modId={mod_id} 写 mod-status.json 失败：{e}");
                // 回滚：已 move 就把目录挪回 subscribed，保证“文件位置”与“记录 Path”一致
                let rollback_note = if let Some(target) = localize_target.as_ref() {
                    match install::revert_localize(target) {
                        Ok(()) => {
                            localized = false;
                            final_dir = target.from.display().to_string();
                            final_folder = folder_name.clone();
                            final_path = install::status_rel_path("subscribed", &folder_name);
                            "已把目录挪回 subscribed".to_string()
                        }
                        Err(back) => format!("回滚失败，请手动把目录挪回 subscribed：{back}"),
                    }
                } else {
                    "目录本来就在 subscribed".to_string()
                };
                match write_final_status(
                    &status_path,
                    &backup_dir,
                    mod_id,
                    &title,
                    &final_folder,
                    false,
                    false,
                ) {
                    Ok((note, backup)) => (
                        format!("{note}（首次写入失败后已回退：{e}；{rollback_note}）"),
                        backup,
                    ),
                    Err(e2) => {
                        return Err(ApiFailure::new(
                            "install",
                            format!(
                                "文件已就位（{final_dir}），但 mod-status.json 写入失败：{e}；回退后重试也失败：{e2}；{rollback_note}"
                            ),
                            None,
                        ))
                    }
                }
            }
        };

        // ⑦ 记录官方分类：下次扫描优先用它，缺失时才走本地特征扫描
        let record = metadata::ModMeta {
            mod_id,
            title: title.clone(),
            tag_ids: tag_ids.unwrap_or_default(),
            tag_names: tag_names.unwrap_or_default(),
            folder_name: if final_folder.is_empty() {
                None
            } else {
                Some(final_folder.clone())
            },
            installed_at_ms: scan::now_ms(),
            source: "api.ageofempires.com".to_string(),
        };
        match metadata::upsert_for_app(&app_for_task, record) {
            Ok(path) => log::info!(
                target: "metadata",
                "已记录模组分类：modId={mod_id} -> {}",
                path.display()
            ),
            Err(e) => log::warn!(
                target: "metadata",
                "写入 mod_metadata.json 失败，该模组的分类将退回本地特征推断：{e}"
            ),
        }

        let mut note_parts = vec![
            format!("已解压 {} 个文件（{} 字节的解压数据）", files, extracted_bytes),
            assets.message.clone(),
        ];
        if localized {
            note_parts.push(format!(
                "已移入 local/{final_folder} 并置为启用（目录已去掉 ID 前缀、WorkshopID=0，游戏不会再把它反向同步为订阅）"
            ));
            if !localize_note.is_empty() {
                note_parts.push(localize_note.clone());
            }
        } else {
            note_parts.push(localize_note.clone());
        }
        note_parts.push(status_note.clone());
        let note = note_parts.join("；");

        Ok(InstallOutcome {
            install: report,
            downloaded_bytes: outcome.bytes,
            assets,
            localized,
            final_dir,
            final_path,
            status_note,
            status_backup_path,
            note,
        })
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("安装任务失败：{e}"), None))?;

    result
}

// ---------------- 卸载（只做本地清理，不向官方发任何请求） ----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UninstallReport {
    mod_id: i64,
    folder_name: String,
    removed_dir: String,
    file_count: u64,
    bytes: u64,
    status_record_removed: bool,
    status_backup_path: Option<String>,
    metadata_removed: bool,
    /// 保留的旧版本备份目录（`.bak-*`），仅用于提示
    version_backups: Vec<String>,
    message: String,
}

/// 本地清理（不向官方发任何请求）：
/// ① 游戏运行中直接中止 + 校验目标（失败时本地什么都没动）
/// ② 只删那一个目录 ③ 清 `mod-status.json` 记录与 `Unsub` 残留 ④ 清分类元数据
#[tauri::command]
async fn online_uninstall(
    app: tauri::AppHandle,
    mod_id: i64,
    folder_name: Option<String>,
) -> Result<UninstallReport, ApiFailure> {
    let root = mod_root(&app)?;
    let backup_dir =
        presets::backups_dir_for(&app).map_err(|e| ApiFailure::new("install", e, None))?;
    let handle = app.clone();

    // ① 先做本地校验（不删任何东西）：校验失败就直接拒绝
    let check_root = root.clone();
    let check_folder = folder_name.clone();
    let target =
        tauri::async_runtime::spawn_blocking(move || -> Result<install::UninstallTarget, ApiFailure> {
            presets::ensure_game_closed(false).map_err(|e| ApiFailure::new("install", e, None))?;
            install::resolve_uninstall_target(&check_root, mod_id, check_folder.as_deref())
                .map_err(|e| ApiFailure::new("install", e, None))
        })
        .await
        .map_err(|e| ApiFailure::new("internal", format!("卸载校验失败：{e}"), None))??;

    tauri::async_runtime::spawn_blocking(move || -> Result<UninstallReport, ApiFailure> {
        // ② 只删这一个目录
        let (file_count, bytes) =
            install::uninstall(&target).map_err(|e| ApiFailure::new("install", e, None))?;

        // ③ 清 mod-status.json 记录（开头已确认游戏未运行，这里不必重复检测进程）
        let status_path = root.join(presets::STATUS_FILE);
        let sel = presets::ModSelector {
            workshop_id: u64::try_from(mod_id).ok(),
            path: install::status_rel_path(&target.kind, &target.folder_name),
        };
        let (status_record_removed, status_backup_path, status_note) =
            match presets::remove_record(&status_path, &backup_dir, &sel, true) {
                Ok(r) => (
                    r.removed,
                    r.backup_path,
                    if r.removed {
                        "已从 mod-status.json 移除该记录".to_string()
                    } else {
                        "mod-status.json 里本来就没有该记录".to_string()
                    },
                ),
                Err(e) => {
                    log::warn!(target: "mod-status", "modId={mod_id} 记录清理失败：{e}");
                    (
                        false,
                        None,
                        format!("本地文件已删除，但 mod-status.json 记录未清理：{e}"),
                    )
                }
            };

        // ④ 清软件自己的分类元数据
        let metadata_removed = match metadata::remove_for_app(&handle, mod_id) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(target: "metadata", "modId={mod_id} 元数据删除失败：{e}");
                false
            }
        };

        let version_backups = install::list_version_backups(&target.parent, &target.folder_name);

        let mut parts = vec![format!(
            "已删除本地目录 {}（{} 个文件 / {} 字节）",
            target.dir.display(),
            file_count,
            bytes
        )];
        parts.push(status_note);
        if metadata_removed {
            parts.push("已清理模组分类元数据".to_string());
        }
        if !version_backups.is_empty() {
            parts.push(format!(
                "保留了 {} 个旧版本备份：{}",
                version_backups.len(),
                version_backups.join(" / ")
            ));
        }
        if let Some(backup) = &status_backup_path {
            parts.push(format!("mod-status.json 备份：{backup}"));
        }
        let message = parts.join("；");
        log::info!(target: "install", "modId={mod_id} 卸载完成：{message}");

        Ok(UninstallReport {
            mod_id,
            folder_name: target.folder_name,
            removed_dir: target.dir.display().to_string(),
            file_count,
            bytes,
            status_record_removed,
            status_backup_path,
            metadata_removed,
            version_backups,
            message,
        })
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("卸载任务执行失败：{e}"), None))?
}

// ---------------- 本地页：删除任意来源的模组 + 在线页安装索引 ----------------

/// 删除本地模组文件（不向官方发任何请求）：
/// ① 游戏运行中直接中止 + 校验目标（失败时本地什么都没动）
/// ② 只删那一个目录 ③ 清 `mod-status.json` 记录与 `Unsub` 残留 ④ 清分类元数据（有 WorkshopID 时）
#[tauri::command]
async fn delete_mod_files(
    app: tauri::AppHandle,
    kind: String,
    folder_name: String,
    workshop_id: Option<u64>,
) -> Result<UninstallReport, ApiFailure> {
    let root = mod_root(&app)?;
    let backup_dir =
        presets::backups_dir_for(&app).map_err(|e| ApiFailure::new("install", e, None))?;
    let handle = app.clone();
    let valid_id = workshop_id.filter(|id| *id > 0);
    let mod_id = valid_id.map(|id| id as i64).unwrap_or(0);

    // ① 先做本地校验（不删任何东西）：校验失败就直接拒绝
    let check_root = root.clone();
    let check_kind = kind.clone();
    let check_folder = folder_name.clone();
    let target =
        tauri::async_runtime::spawn_blocking(move || -> Result<install::UninstallTarget, ApiFailure> {
            presets::ensure_game_closed(false).map_err(|e| ApiFailure::new("install", e, None))?;
            install::resolve_delete_target(&check_root, &check_kind, &check_folder)
                .map_err(|e| ApiFailure::new("install", e, None))
        })
        .await
        .map_err(|e| ApiFailure::new("internal", format!("删除校验失败：{e}"), None))??;

    tauri::async_runtime::spawn_blocking(move || -> Result<UninstallReport, ApiFailure> {
        // ② 只删这一个目录
        let (file_count, bytes) =
            install::uninstall(&target).map_err(|e| ApiFailure::new("install", e, None))?;

        // ③ 清 mod-status.json 记录（开头已确认游戏未运行）
        let status_path = root.join(presets::STATUS_FILE);
        let sel = presets::ModSelector {
            workshop_id: valid_id,
            path: install::status_rel_path(&target.kind, &target.folder_name),
        };
        let (status_record_removed, status_backup_path, status_note) =
            match presets::remove_record(&status_path, &backup_dir, &sel, true) {
                Ok(r) => (
                    r.removed,
                    r.backup_path,
                    if r.removed {
                        "已从 mod-status.json 移除该记录".to_string()
                    } else {
                        "mod-status.json 里本来就没有该记录".to_string()
                    },
                ),
                Err(e) => {
                    log::warn!(target: "mod-status", "{} 记录清理失败：{e}", target.folder_name);
                    (
                        false,
                        None,
                        format!("本地文件已删除，但 mod-status.json 记录未清理：{e}"),
                    )
                }
            };

        // ④ 清软件自己的分类元数据（无 WorkshopID 的记录本就不存在）
        let metadata_removed = if mod_id > 0 {
            metadata::remove_for_app(&handle, mod_id).unwrap_or_else(|e| {
                log::warn!(target: "metadata", "modId={mod_id} 元数据删除失败：{e}");
                false
            })
        } else {
            false
        };

        let version_backups = install::list_version_backups(&target.parent, &target.folder_name);

        let mut parts = vec![format!(
            "已删除本地目录 {}（{} 个文件 / {} 字节）",
            target.dir.display(),
            file_count,
            bytes
        )];
        parts.push(status_note);
        if metadata_removed {
            parts.push("已清理模组分类元数据".to_string());
        }
        if !version_backups.is_empty() {
            parts.push(format!(
                "保留了 {} 个旧版本备份：{}",
                version_backups.len(),
                version_backups.join(" / ")
            ));
        }
        if let Some(backup) = &status_backup_path {
            parts.push(format!("mod-status.json 备份：{backup}"));
        }
        let message = parts.join("；");
        log::info!(target: "install", "删除完成：{message}");

        Ok(UninstallReport {
            mod_id,
            folder_name: target.folder_name,
            removed_dir: target.dir.display().to_string(),
            file_count,
            bytes,
            status_record_removed,
            status_backup_path,
            metadata_removed,
            version_backups,
            message,
        })
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("删除任务执行失败：{e}"), None))?
}

/// 在线页用：本机已安装索引（WorkshopID → 目录/来源）。只读目录名与元数据，不做特征扫描。
#[tauri::command]
async fn installed_local_index(
    app: tauri::AppHandle,
) -> Result<Vec<models::InstalledIndexEntry>, String> {
    let root = settings::load_for_app(&app)
        .mod_root
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录".to_string())?;
    let meta = metadata::load_for_app(&app);
    tauri::async_runtime::spawn_blocking(move || {
        scan::installed_index(PathBuf::from(root).as_path(), &meta)
    })
    .await
    .map_err(|e| format!("索引任务执行失败：{e}"))
}

// ---------------- 在网站浏览 ----------------

/// 用系统默认浏览器打开官方模组页面。
/// URL 完全由后端拼装，前端只能传一个数字，不存在注入面（也无需新增 shell 插件）。
#[tauri::command]
fn open_mod_webpage(mod_id: i64) -> Result<String, String> {
    if mod_id <= 0 {
        return Err("WorkshopID 无效，无法打开网页".to_string());
    }
    let url = format!("{}/mods/details/{mod_id}/", online::api::WEBSITE_ORIGIN);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(&url)
            .spawn()
            .map_err(|e| format!("无法打开默认浏览器：{e}"))?;
        Ok(url)
    }
    #[cfg(not(windows))]
    {
        Err(format!("仅支持 Windows（目标地址：{url}）"))
    }
}

/// 用系统默认浏览器打开外链（作者主页 / 官网）。
/// 不需要 opener 插件：与 open_mod_webpage 一样走 explorer.exe，但这里接受任意 URL，
/// 因此必须自己把关：强制 https + 主机名白名单，避免前端被注入 file:// / javascript: 之类。
#[tauri::command]
fn open_external(url: String) -> Result<String, String> {
    // 蓝奏云网盘（备用下载）：子域名会变（wwblm / pan / 任意前缀），只能按域名后缀放行（仍是精确后缀，不是任意 https）
    const ALLOWED_HOST_SUFFIXES: [&str; 5] = [
        "lanzouv.com",
        "lanzou.com",
        "lanzoui.com",
        "lanzoux.com",
        "lanzoub.com",
    ];
    const ALLOWED_HOSTS: [&str; 4] = [
        "github.com",
        "www.github.com",
        "ageofempires.com",
        "www.ageofempires.com",
    ];
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err(format!("只允许 https 外链（收到：{trimmed}）"));
    }
    let host = lower
        .trim_start_matches("https://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_string();
    if host.is_empty() {
        return Err(format!("不在白名单内的域名（{host}），已拒绝打开"));
    }
    let allowed = ALLOWED_HOSTS.contains(&host.as_str())
        || ALLOWED_HOST_SUFFIXES
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")));
    if !allowed {
        return Err(format!("不在白名单内的域名（{host}），已拒绝打开"));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(trimmed)
            .spawn()
            .map_err(|e| format!("无法打开默认浏览器：{e}"))?;
        Ok(trimmed.to_string())
    }
    #[cfg(not(windows))]
    {
        Err(format!("仅支持 Windows（目标地址：{trimmed}）"))
    }
}

/// 前端把关键判断写进同一份终端日志，便于对照前后端时序
#[tauri::command]
fn ui_log(level: String, message: String) {
    match level.as_str() {
        "warn" => log::warn!(target: "ui", "{message}"),
        "error" => log::error!(target: "ui", "{message}"),
        _ => log::info!(target: "ui", "{message}"),
    }
}

// ---------------- 模组预设与批量恢复（v0.3） ----------------

/// 预设列表（存于 %APPDATA%\com.aoe2.modmanager\presets.json）
#[tauri::command]
fn presets_list(app: tauri::AppHandle) -> Vec<presets::Preset> {
    presets::load_for_app(&app).presets
}

/// 保存当前启用状态为新预设；同名（忽略大小写）则覆盖更新
#[tauri::command]
fn preset_save(
    app: tauri::AppHandle,
    name: String,
    items: Vec<presets::PresetItem>,
) -> Result<presets::Preset, String> {
    presets::upsert_for_app(&app, &name, items)
}

#[tauri::command]
fn preset_delete(app: tauri::AppHandle, id: String) -> Result<Vec<presets::Preset>, String> {
    presets::delete_for_app(&app, &id).map(|store| store.presets)
}

/// 批量恢复：检测游戏进程 → 备份 mod-status.json → 只改 Enabled → 原子替换 → 回读校验
#[tauri::command]
async fn preset_apply(
    app: tauri::AppHandle,
    id: String,
) -> Result<presets::ApplyReport, String> {
    tauri::async_runtime::spawn_blocking(move || presets::apply_for_app(&app, &id))
        .await
        .map_err(|e| format!("恢复任务执行失败：{e}"))?
}

// ---------------- 需求 1：单条启用 / 禁用 ----------------

/// 切换单个模组的启用状态：检测游戏进程 → 备份 → 只改 Enabled → 原子替换 → 回读校验。
/// `kind` 只能是 local / subscribed，`folder_name` 必须是根目录下真实存在的模组文件夹。
#[tauri::command]
async fn toggle_mod_enabled(
    app: tauri::AppHandle,
    workshop_id: Option<u64>,
    kind: String,
    folder_name: String,
    enabled: bool,
) -> Result<presets::ToggleOutcome, String> {
    let root = settings::load_for_app(&app)
        .mod_root
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录".to_string())?;

    if kind != "local" && kind != "subscribed" {
        return Err(format!("未知的模组来源：{kind}"));
    }
    let folder = folder_name.trim();
    if folder.is_empty()
        || folder.contains('/')
        || folder.contains('\\')
        || folder.contains("..")
    {
        return Err("模组文件夹名不合法".to_string());
    }

    let root_path = PathBuf::from(&root);
    let mod_dir = root_path.join(&kind).join(folder);
    if !mod_dir.is_dir() {
        return Err(format!("模组目录不存在：{}", mod_dir.display()));
    }

    let status_path = root_path.join(presets::STATUS_FILE);
    let backup_dir = presets::backups_dir_for(&app)?;
    let sel = presets::ModSelector {
        workshop_id,
        path: install::status_rel_path(&kind, folder),
    };

    tauri::async_runtime::spawn_blocking(move || {
        presets::set_enabled(&status_path, &backup_dir, &sel, enabled, false)
    })
    .await
    .map_err(|e| format!("切换任务执行失败：{e}"))?
}

// ---------------- 卡片快捷开关 / 工具栏批量启用停用 ----------------

/// 批量启用 / 禁用。`targets` 由前端按当前筛选列表传入（WorkshopID + 来源 + 文件夹名）。
/// 与单条切换同一条安全链路，但**整个批次只写一次盘**：一次进程检测 → 一份备份 →
/// 一次原子替换 → 一次回读校验（失败自动回滚），不会出现部分成功。
#[tauri::command]
async fn batch_toggle_mods(
    app: tauri::AppHandle,
    enable: bool,
    targets: Vec<presets::BatchTarget>,
) -> Result<presets::BatchToggleReport, String> {
    let root = settings::load_for_app(&app)
        .mod_root
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录".to_string())?;

    if targets.is_empty() {
        return Err("当前列表没有可操作的模组".to_string());
    }
    for target in &targets {
        if target.kind != "local" && target.kind != "subscribed" {
            return Err(format!("未知的模组来源：{}", target.kind));
        }
        let folder = target.folder_name.trim();
        if folder.is_empty()
            || folder.contains('/')
            || folder.contains('\\')
            || folder.contains("..")
        {
            return Err(format!("模组文件夹名不合法：{}", target.folder_name));
        }
    }

    let status_path = PathBuf::from(&root).join(presets::STATUS_FILE);
    let backup_dir = presets::backups_dir_for(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        presets::batch_set_enabled(&status_path, &backup_dir, &targets, enable, false)
    })
    .await
    .map_err(|e| format!("批量切换任务执行失败：{e}"))?
}

// ---------------- v0.2：手动拖拽排序 ----------------

/// 把拖拽后的顺序写进 mod-status.json 的 Priority（1..n 连续）。
/// `ordered` 是前端 `ModEntry.id` 数组（`local:目录名`），不是 WorkshopID——本地模组的 WorkshopID 常为 0。
/// v1.2：`ordered` 只传**已启用**的模组；它们被物理前置并拿到 1..N，未启用模组接在后面 N+1.. 顺延。
/// 链路与预设完全一致：游戏进程检测 → 备份 → 只改 Priority → 原子替换 → 回读校验（失败自动回滚）。
#[tauri::command]
async fn update_mod_priority(
    app: tauri::AppHandle,
    ordered: Vec<String>,
) -> Result<presets::PriorityOutcome, String> {
    let root = settings::load_for_app(&app)
        .mod_root
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录".to_string())?;

    let status_path = PathBuf::from(&root).join(presets::STATUS_FILE);
    let backup_dir = presets::backups_dir_for(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        presets::reorder_priority(&status_path, &backup_dir, &ordered, false)
    })
    .await
    .map_err(|e| format!("排序任务执行失败：{e}"))?
}

// ---------------- v0.5：模组收藏与自定义备注（user_data.json） ----------------

/// 读取收藏 / 备注。key 是 WorkshopID，与模组是否安装无关（卸载后保留）。
#[tauri::command]
fn load_user_data(app: tauri::AppHandle) -> user_data::Store {
    user_data::load_for_app(&app)
}

/// 覆盖式保存整份 user_data.json：写前先备份旧文件（backups\user_data-<ms>.json）。
#[tauri::command]
fn save_user_data(
    app: tauri::AppHandle,
    data: user_data::Store,
) -> Result<user_data::SaveReport, String> {
    let path = user_data::path_for(&app)?;
    let backup_dir = presets::backups_dir_for(&app)?;
    user_data::save(&path, &backup_dir, &data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

pub fn run() {
    tauri::Builder::default()
        // 日志插件要最先注册：日志统一输出到 Stdout，终端里可见
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(log::LevelFilter::Info)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // 封面图缓存在 %APPDATA% 下的 image_cache 目录；
        // tauri.conf.json 的 assetProtocol.scope 是空的，必须在运行时显式放行，
        // 否则前端 asset: URL 读本地 jpg 会被拒绝。
        .setup(|app| {
            images::allow_scope(app.handle());
            // v1.0：后台静默建立在线模组索引（中文搜索底座）。
            // 8 秒后才开始，绝不和首屏、登录校验、更新检查抢带宽。
            online_index::spawn_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ui_log,
            get_settings,
            set_locale,
            app_version,
            check_update,
            check_update_auto,
            fetch_github_releases,
            check_mod_updates,
            candidate_roots,
            detect_root_candidates,
            scan_mods,
            set_mod_root,
            mod_stats,
            online_session_status,
            online_startup_session,
            online_login_targets,
            online_open_login,
            online_open_login_silent,
            online_close_login_window,
            online_reset_login_view,
            online_probe_account_window,
            get_network_settings,
            set_network_settings,
            set_remember_login,
            online_clear_login_cache,
            online_find,
            online_tags,
            reveal_mod_folder,
            online_installed,
            online_detail,
            online_cache_find,
            online_cache_installed,
            online_cache_detail,
            online_cache_pages,
            online_cache_items,
            online_cache_clear,
            online_cache_stat,
            online_index_status,
            online_index_sync,
            online_index_pause,
            online_index_search,
    search_local_mods,
    set_enable_indexing,
    set_enable_local_search,
    set_view_prefs,
    set_theme,
    save_typography_prefs,
            online_index_clear,
            online_titles_translate_start,
            online_titles_translate_stop,
            online_titles_translate_status,
            translator::translate_mod_text,
            translator::translation_cached,
            translator::translations_cached,
            translator::get_translate_settings,
            translator::set_translate_settings,
            translator::translation_cache_stat,
            translator::translation_cache_clear,
            online_images_local,
            online_images_fetch,
            online_install,
            online_cancel_install,
            online_uninstall,
            delete_mod_files,
            installed_local_index,
            open_mod_webpage,
            presets_list,
            preset_save,
            preset_delete,
            preset_apply,
            toggle_mod_enabled,
            batch_toggle_mods,
            update_mod_priority,
            load_user_data,
            save_user_data,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
