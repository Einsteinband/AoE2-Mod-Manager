use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

mod cache;
mod data_dir;
mod download;
mod download_queue;
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

/// 数据与缓存总目录的统一入口（图片/在线数据/索引/译文/收藏/预设/队列/会话凭证）
pub use data_dir::data_root;

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
    // 镜像优先 + 直连兜底：国内直连 api.github.com 基本不可达，
    // 与软件更新检查共用 update::fetch_with_mirrors。
    // User-Agent / 代理 / 镜像顺序与超时都在那一层统一处理，这里只管解析。
    let (_reached, result) = update::fetch_with_mirrors(proxy, RELEASES_LIST_URL);
    let raw = result.map_err(|e| format!("获取更新历史失败：{e}"))?;
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

/// 打开登录窗口。v3.3 起只保留**微软 / Xbox** 一条入口（用户指令：移除 Steam 与 PlayStation）。
///
/// auth.ageofempires.com 会 302 到 login.microsoftonline.com，这是官方行为，不是 bug。
#[tauri::command]
async fn online_open_login(app: tauri::AppHandle) -> Result<(), String> {
    let url = online::session::LOGIN_URL;
    log::info!(target: "account-window", "前端请求打开登录窗口 url={url}");
    // v3.2 回归修复：**不再销毁窗口**。旧代码走 invalidate_cached_session（内部 destroy），
    // 而 destroy 是异步派发——紧接着的 ensure_account_window 会命中“正在销毁”的窗口，
    // show/navigate 静默失败，前端永远停在「等待登录」（即用户报的「点登录没反应」）。
    // 现在只清 AoE Cookie，窗口保留复用。
    match online::session::purge_aoe_cookies_for_relogin(&app) {
        Ok(n) => log::info!(target: "account-window", "登录前已清理 AoE Cookie {n} 条"),
        Err(e) => log::warn!(target: "account-window", "登录前清理 AoE Cookie 未完成：{e}"),
    }
    let window = online::session::ensure_account_window(&app, url, true)?;
    // show() 失败必须冒泡：否则前端拿到 Ok(()) 会一直停在 waitingLogin
    window
        .show()
        .map_err(|e| format!("登录窗口无法显示：{e}"))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    log::info!(
        target: "account-window",
        "登录窗口已显示 visible={:?}",
        window.is_visible()
    );
    Ok(())
}

/// 后台静默登录：用**隐藏**窗口打开登录入口，靠平台 SSO 的持久 Cookie 自动跑完
/// login.microsoftonline.com → /Home/CompleteLogin 整条跳转链，因此应用重启后
/// 通常不需要用户再点一次“微软登录”（会话 Cookie 不跨进程存活，但 MS 的会）。
/// 失败也不报错：窗口保持隐藏，用户手动点登录时会被 ensure_account_window 复用并显示。
#[tauri::command]
async fn online_open_login_silent(app: tauri::AppHandle) -> Result<(), String> {
    let url = online::session::LOGIN_URL;
    log::info!(target: "account-window", "后台静默登录 url={url}");
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
    card_font_weight: u32,
    latin_font: bool,
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
    current.card_font_weight = models::normalize_card_font_weight(card_font_weight);
    // v3.5：纯布尔开关，无非法值需要归一化
    current.latin_font = latin_font;
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
                "已移入 local/{final_folder} 并置为启用（目录已去掉 ID 前缀、WorkshopID=0）。账号订阅状态不会因本地化而改变：若仍订阅该模组，游戏下次启动会重新下载一份到 subscribed，请到官网或游戏内取消订阅"
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
    const ALLOWED_HOSTS: [&str; 5] = [
        "github.com",
        "www.github.com",
        "ageofempires.com",
        "www.ageofempires.com",
        // v3.3：官方账号中心（登录后绑定 Steam）。实测 302 到 login.microsoftonline.com，
        // 是「微软账号未绑定 Steam」时用户唯一该去的地方。
        "auth.ageofempires.com",
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

// ---------------- v0.4.3：下载队列持久化（download_queue.json） ----------------
//
// 队列本身是前端状态机（src/online/downloadQueue.ts），Rust 只做“原样存 / 原样取”。
// 每次前端状态变化写一次完整快照：临时文件 → rename 原子替换，不做 .bak 备份
// （队列是易恢复数据，频繁备份会塞满 backups 目录）。

/// 读取上次退出时尚未结束的下载队列快照（文件缺失 / 损坏都返回空表）。
#[tauri::command]
fn load_download_queue(app: tauri::AppHandle) -> download_queue::Snapshot {
    download_queue::load_for_app(&app)
}

/// 覆盖式保存整份下载队列快照，返回最终文件路径。
#[tauri::command]
fn save_download_queue(
    app: tauri::AppHandle,
    data: download_queue::Snapshot,
) -> Result<String, String> {
    let path = download_queue::path_for(&app)?;
    download_queue::save(&path, &data)
}

// ---------------- v3.2：三类本地缓存的存放位置（设置 → 缓存与存储） ----------------
//
// 缓存默认都在 AppData 里；图片与译文越攒越大时把 C 盘顶满，所以允许用户把它们
// 指到其它磁盘。三类缓存共用同一个入口 [`get_cache_dir`]：**读配置优先，回退默认**。
// 换目录**不迁移旧数据**（旧文件留在原处，新缓存写入新目录），也不删除任何文件。

/// 缓存种类下标：0 = 图片 / 1 = 模组信息 / 2 = 翻译
const CACHE_KIND_IMAGE: usize = 0;
const CACHE_KIND_MODINFO: usize = 1;
const CACHE_KIND_TRANSLATION: usize = 2;

/// 进程内的「用户自定义缓存目录」快照。
///
/// 为什么需要它：cache.rs / translator.rs 每次读写都要 `path_for()`，如果每次都读一遍
/// settings.json，就把「内存优先的微秒级命中」退化成磁盘 IO。首次访问从配置载入，
/// 之后只读内存；`set_cache_dir` / `reset_cache_dir` 成功后立即刷新这一份。
static CACHE_DIR_OVERRIDES: std::sync::Mutex<Option<[Option<String>; 3]>> =
    std::sync::Mutex::new(None);

/// 前端传来的 kind 归一化：只认 image / modinfo / translation
fn cache_kind_index(kind: &str) -> Result<usize, String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "image" => Ok(CACHE_KIND_IMAGE),
        "modinfo" => Ok(CACHE_KIND_MODINFO),
        "translation" => Ok(CACHE_KIND_TRANSLATION),
        other => Err(format!("未知的缓存类型：{other}")),
    }
}

fn cache_kind_code(index: usize) -> &'static str {
    match index {
        CACHE_KIND_IMAGE => "image",
        CACHE_KIND_MODINFO => "modinfo",
        _ => "translation",
    }
}

fn cache_overrides(app: &tauri::AppHandle) -> [Option<String>; 3] {
    let settings = settings::load_for_app(app);
    [
        settings.image_cache_dir,
        settings.mod_info_cache_dir,
        settings.translation_cache_dir,
    ]
}

fn refresh_cache_overrides(app: &tauri::AppHandle) {
    let fresh = cache_overrides(app);
    let mut guard = CACHE_DIR_OVERRIDES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(fresh);
}

/// 目录「能不能用」：必须真实存在且是文件夹。
/// 配置里写坏的路径、被手动删掉的目录、没插上的移动硬盘，一律当作「没配」。
fn usable_dir(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// 默认位置：图片缓存是 `%APPDATA%\<app>\image_cache`，
/// 模组信息与译文缓存直接落在配置目录下（靠文件名区分）。
fn default_cache_dir(app: &tauri::AppHandle, index: usize) -> Result<PathBuf, String> {
    // v1.x：默认位置 = 「数据与缓存总目录」（没自定义时它就是 %APPDATA%\<bundleId>）
    let base = data_dir::data_root(app)?;
    Ok(if index == CACHE_KIND_IMAGE {
        base.join(images::DIR_NAME)
    } else {
        base
    })
}

/// **缓存目录的唯一入口**：读配置优先，回退默认。
///
/// 1. settings.json 里 `*_cache_dir` 有值、且该目录真实存在 → 用它；
/// 2. 没配 / 空串 / 目录已被删除 → 回退默认 AppData 位置（并打一行 warn）。
///
/// 任何情况下都返回一个可用路径，绝不因为配置坏掉让缓存功能整体失效。
pub fn get_cache_dir(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let index = cache_kind_index(kind)?;
    // 总目录优先：用户既然设了统一目录，旧的「三类分目录」就不该再抢方向
    if !data_dir::is_configured(app) {
        let configured = {
            let mut guard = CACHE_DIR_OVERRIDES
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_none() {
                *guard = Some(cache_overrides(app));
            }
            guard.as_ref().and_then(|all| all[index].clone())
        };
        if let Some(raw) = configured {
            if let Some(path) = usable_dir(&raw) {
                return Ok(path);
            }
            log::warn!(
                target: "cache-dir",
                "配置的 {} 缓存目录不可用（{}），本次回退默认位置",
                cache_kind_code(index),
                raw
            );
        }
    }
    default_cache_dir(app, index)
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct CacheDirEntry {
    /// image | modinfo | translation
    kind: String,
    /// 当前实际生效的目录（配置可用就是配置的，否则是默认的）
    path: String,
    /// 默认（AppData）目录，「恢复默认」按钮据此说明会回到哪里
    default_path: String,
    /// true = 用户自定义且正在生效
    is_custom: bool,
    exists: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct CacheDirsView {
    dirs: Vec<CacheDirEntry>,
}

fn build_cache_dirs_view(app: &tauri::AppHandle) -> CacheDirsView {
    let overrides = cache_overrides(app);
    let mut dirs = Vec::with_capacity(3);
    for index in [CACHE_KIND_IMAGE, CACHE_KIND_MODINFO, CACHE_KIND_TRANSLATION] {
        let default_path = default_cache_dir(app, index)
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let custom = overrides[index].as_deref().and_then(usable_dir);
        let (path, is_custom) = match custom {
            Some(dir) => (dir.display().to_string(), true),
            None => (default_path.clone(), false),
        };
        let exists = std::path::Path::new(&path).is_dir();
        dirs.push(CacheDirEntry {
            kind: cache_kind_code(index).to_string(),
            path,
            default_path,
            is_custom,
            exists,
        });
    }
    CacheDirsView { dirs }
}

/// 三类缓存目录的当前状态（设置 → 缓存与存储）
#[tauri::command]
async fn cache_dirs(app: tauri::AppHandle) -> CacheDirsView {
    tauri::async_runtime::spawn_blocking(move || build_cache_dirs_view(&app))
        .await
        .unwrap_or_else(|_| CacheDirsView { dirs: Vec::new() })
}

/// 目标目录体检：能建就建，再用临时文件实测一次可写。
/// 只读盘、exFAT、无权限目录（Program Files 根、系统盘根）都能当场测出来，
/// 不会等用户写了几百条缓存之后才失败。
fn prepare_cache_dir(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return Err("目录路径不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("请选择完整路径（如 D:\\AoE2Cache）：{}", path.display()));
    }
    if path.is_file() {
        return Err(format!("这个路径是一个文件，不是文件夹：{}", path.display()));
    }
    fs::create_dir_all(&path).map_err(|e| format!("无法创建目录 {}：{e}", path.display()))?;
    let probe = path.join(format!(".aoe2-write-test-{}.tmp", std::process::id()));
    let written = fs::write(&probe, b"ok");
    let _ = fs::remove_file(&probe);
    written.map_err(|e| format!("目标目录不可写（{}）：{e}", path.display()))?;
    Ok(path)
}

/// 设置某一类缓存的存放目录。校验通过才写 settings.json。
/// 已经在旧目录里的缓存**不迁移、不删除**（新缓存写新目录，要搬请用户自己复制）。
#[tauri::command]
async fn set_cache_dir(
    app: tauri::AppHandle,
    kind: String,
    new_path: String,
) -> Result<CacheDirsView, String> {
    let index = cache_kind_index(&kind)?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = prepare_cache_dir(&new_path)?;
        let text = dir.display().to_string();
        let mut settings = settings::load_for_app(&handle);
        match index {
            CACHE_KIND_IMAGE => settings.image_cache_dir = Some(text.clone()),
            CACHE_KIND_MODINFO => settings.mod_info_cache_dir = Some(text.clone()),
            _ => settings.translation_cache_dir = Some(text.clone()),
        }
        settings::save_for_app(&handle, &settings)?;
        refresh_cache_overrides(&handle);
        // 图片靠 asset 协议读取：换了目录必须重新放行，否则封面全是空白
        if index == CACHE_KIND_IMAGE {
            images::allow_scope(&handle);
        }
        log::info!(
            target: "cache-dir",
            "{} 缓存目录已切换到：{text}",
            cache_kind_code(index)
        );
        Ok(build_cache_dirs_view(&handle))
    })
    .await
    .map_err(|e| format!("保存缓存目录失败：{e}"))?
}

/// 恢复默认位置：把配置写回 null。同样不迁移、不删除任何文件。
#[tauri::command]
async fn reset_cache_dir(app: tauri::AppHandle, kind: String) -> Result<CacheDirsView, String> {
    let index = cache_kind_index(&kind)?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = settings::load_for_app(&handle);
        match index {
            CACHE_KIND_IMAGE => settings.image_cache_dir = None,
            CACHE_KIND_MODINFO => settings.mod_info_cache_dir = None,
            _ => settings.translation_cache_dir = None,
        }
        settings::save_for_app(&handle, &settings)?;
        refresh_cache_overrides(&handle);
        if index == CACHE_KIND_IMAGE {
            images::allow_scope(&handle);
        }
        log::info!(
            target: "cache-dir",
            "{} 缓存目录已恢复默认",
            cache_kind_code(index)
        );
        Ok(build_cache_dirs_view(&handle))
    })
    .await
    .map_err(|e| format!("恢复默认目录失败：{e}"))?
}

/// 在资源管理器中打开当前生效的缓存目录（目录不存在就先建出来）。
#[tauri::command]
async fn open_cache_dir(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = get_cache_dir(&handle, &kind)?;
        if !dir.is_dir() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("无法创建缓存目录 {}：{e}", dir.display()))?;
        }
        let shown = dir.display().to_string();
        #[cfg(windows)]
        {
            std::process::Command::new("explorer.exe")
                .arg(&dir)
                .spawn()
                .map_err(|e| format!("无法启动资源管理器：{e}"))?;
            Ok(shown)
        }
        #[cfg(not(windows))]
        {
            let _ = shown;
            Err("仅支持 Windows".to_string())
        }
    })
    .await
    .map_err(|e| format!("打开缓存目录失败：{e}"))?
}

// ---------------- v1.x：数据与缓存总目录（设置 → 缓存与存储） ----------------
//
// 心智模型：图片缓存、在线数据、搜索索引、译文、收藏、预设、下载队列、DPAPI 会话凭证
// 共用一个根目录。路径裁决 / 目标体检 / 迁移 / 回滚全在 data_dir.rs，前端只负责展示。

/// 当前「数据与缓存总目录」的路径 / 占用 / 是否自定义
#[tauri::command]
async fn data_dir_view(app: tauri::AppHandle) -> data_dir::DataDirView {
    tauri::async_runtime::spawn_blocking(move || data_dir::view(&app))
        .await
        .unwrap_or_else(|_| data_dir::empty_view())
}

/// 迁移到新目录：体检 → 预检同名 → 物理移动 → 落盘；任何一步失败自动回滚
#[tauri::command]
async fn migrate_data_dir(
    app: tauri::AppHandle,
    new_path: String,
) -> Result<data_dir::DataDirView, String> {
    tauri::async_runtime::spawn_blocking(move || data_dir::migrate(&app, &new_path))
        .await
        .map_err(|e| format!("迁移任务异常：{e}"))?
}

/// 在资源管理器中打开当前数据目录（不存在就先建出来）
#[tauri::command]
async fn open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir::data_root(&app)?;
        if !dir.is_dir() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
        }
        let shown = dir.display().to_string();
        #[cfg(windows)]
        {
            std::process::Command::new("explorer.exe")
                .arg(&dir)
                .spawn()
                .map_err(|e| format!("无法启动资源管理器：{e}"))?;
            Ok(shown)
        }
        #[cfg(not(windows))]
        {
            let _ = shown;
            Err("仅支持 Windows".to_string())
        }
    })
    .await
    .map_err(|e| format!("打开数据目录失败：{e}"))?
}

// ---------------- v0.4.5：本地日志与「复制诊断信息给 AI」 ----------------

/// 本次运行的日志文件名（不含 `.log` 后缀），形如 `aoe2mm-20261107-175230`。
///
/// 用 `OnceLock` 固定：插件初始化时求值一次，之后清理旧文件、诊断导出都读同一个值，
/// 保证「本次运行」这个语义在整个进程里不会漂移。
static SESSION_LOG_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 生成本次运行的日志文件名。取本地时区，取不到就退回 UTC（不让它挡住启动）。
fn session_log_name() -> String {
    SESSION_LOG_NAME
        .get_or_init(|| {
            let now = time::OffsetDateTime::now_local()
                .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
            format!(
                "aoe2mm-{:04}{:02}{:02}-{:02}{:02}{:02}",
                now.year(),
                now.month() as u8,
                now.day(),
                now.hour(),
                now.minute(),
                now.second()
            )
        })
        .clone()
}

/// 每次运行都新建一个日志文件，旧文件不清会无限堆积。
///
/// 只保留最近 19 份历史文件 + 本次运行的文件（共 20 份）；
/// 本次正在写的文件永远不参与删除判定，避免把自己删掉。
fn prune_old_logs(dir: &std::path::Path) {
    const KEEP_OLD: usize = 19;
    let current = format!("{}.log", session_log_name());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("aoe2mm") || !name.ends_with(".log") {
            continue;
        }
        if name == current {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((mtime, path));
    }
    if files.len() <= KEEP_OLD {
        return;
    }
    // 新的在前，把超出保留数的部分删掉
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut removed = 0usize;
    for (_, path) in files.into_iter().skip(KEEP_OLD) {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!(
            target: "diagnostics",
            "清理旧日志：删除 {removed} 份，保留最近 {} 份（含本次运行）",
            KEEP_OLD + 1
        );
    }
}

/// 日志目录：与 tauri-plugin-log 的 `LogDir` 目标完全一致
/// （Windows 下 = `%LOCALAPPDATA%\com.aoe2.modmanager\logs`）。
/// 前端不再让用户自己翻文件夹，统一走这个入口。
fn logs_dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map_err(|e| format!("无法定位日志目录：{e}"))
}

/// 取日志目录里最新的 `aoe2mm*.log`。
///
/// 按大小滚动后旧文件会改名成 `aoe2mm_<时间戳>.log`，所以不能只认 `aoe2mm.log`：
/// 当前文件刚滚走、新文件还没写第一行时，只认固定文件名会读到空内容。
fn newest_log_file(dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("aoe2mm") || !name.ends_with(".log") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let better = match &best {
            Some((best_time, _)) => mtime > *best_time,
            None => true,
        };
        if better {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 读一个日志文件的最后 `max` 行。
///
/// 用 `from_utf8_lossy`：日志可能被强杀截断在多字节字符中间，
/// 这里宁可出现半个中文也不能直接报错（报错就等于用户拿不到日志）。
fn tail_lines(path: &std::path::Path, max: usize) -> Vec<String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!(target: "diagnostics", "读取日志文件 {} 失败：{e}", path.display());
            return Vec::new();
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let total = text.lines().count();
    let skip = total.saturating_sub(max);
    text.lines()
        .skip(skip)
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect()
}

/// 「设置 → 关于」→「打开日志所在文件夹」。
///
/// 首次启动时目录可能还没建（插件在第一条日志写入时才创建），这里主动建一次：
/// 让用户点开就能看到文件夹，而不是收到“找不到路径”。
#[tauri::command]
async fn open_logs_dir(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = logs_dir_for(&app)?;
        if !dir.is_dir() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("无法创建日志目录 {}：{e}", dir.display()))?;
        }
        log::info!(target: "diagnostics", "用户请求打开日志目录：{}", dir.display());
        #[cfg(windows)]
        {
            let shown = dir.display().to_string();
            std::process::Command::new("explorer.exe")
                .arg(&dir)
                .spawn()
                .map_err(|e| format!("无法启动资源管理器：{e}"))?;
            Ok(shown)
        }
        #[cfg(not(windows))]
        {
            let _ = &dir;
            Err("仅支持 Windows".to_string())
        }
    })
    .await
    .map_err(|e| format!("打开日志目录失败：{e}"))?
}

/// 「复制诊断信息给 AI」的后端数据包：版本 / 系统 / 日志路径 / 最近 100 行日志。
///
/// 只回数据，不拼 Prompt：文案与问题描述都在前端（i18n 默认双语），
/// 后端保持“只读事实”的定位，方便后续单独调整提示词。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsInfo {
    version: String,
    os: String,
    log_dir: String,
    log_file: String,
    log_lines: Vec<String>,
}

#[tauri::command]
async fn diagnostics_info(app: tauri::AppHandle) -> Result<DiagnosticsInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = logs_dir_for(&app)?;
        let file = newest_log_file(&dir);
        let log_lines = match file.as_deref() {
            Some(path) => tail_lines(path, 100),
            None => {
                log::warn!(target: "diagnostics", "日志目录 {} 里没有 aoe2mm*.log", dir.display());
                Vec::new()
            }
        };
        let log_file = file
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        log::info!(
            target: "diagnostics",
            "导出诊断信息：{} 行日志（{}）",
            log_lines.len(),
            if log_file.is_empty() { "未找到日志文件" } else { &log_file }
        );
        Ok(DiagnosticsInfo {
            version: update::current_version(),
            os: format!(
                "{} {} / {}",
                std::env::consts::OS,
                std::env::consts::ARCH,
                std::env::var("OS").unwrap_or_else(|_| "unknown".to_string())
            ),
            log_dir: dir.display().to_string(),
            log_file,
            log_lines,
        })
    })
    .await
    .map_err(|e| format!("读取诊断信息失败：{e}"))?
}

/// 「启动游戏」的错误码：后端没有配置游戏根目录（game_root_dir 为空）时返回它，
/// 前端据此把用户送到「设置 → 通用」并聚焦「游戏根目录」一行（不再弹选 exe 的文件框）。
pub const GAME_PATH_MISSING: &str = "GAME_PATH_NOT_FOUND";

/// 主程序合法性：必须是文件、扩展名 .exe，且文件名包含 "aoe2de"（大小写不敏感）。
/// 目的：防止用户在文件框里乱选别的 exe，被当成游戏启动。
fn is_game_exe(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match path.file_name().map(|v| v.to_string_lossy().to_ascii_lowercase()) {
        Some(name) => name.ends_with(".exe") && name.contains("aoe2de"),
        None => false,
    }
}

// ---------------- v3.3：启动游戏统一走 Steam 协议 ----------------
//
// 为什么不直接 spawn AoE2DE_s.exe：绕过 Steam 会丢掉启动项、不计游玩时长、
// 可能触发不了成就 / 覆盖层。所以这里只把 steam://rungameid/<appid> 交给系统协议处理器，
// 由 Steam 客户端自己拉起游戏；软件不再直接创建游戏进程。

/// AoE2 DE 的 Steam AppID（与 settings.rs 里的 AOE2_STEAM_APP_ID 同值）
const AOE2_STEAM_APP_ID: &str = "813780";

/// Steam 启动协议地址
fn steam_launch_url() -> String {
    format!("steam://rungameid/{AOE2_STEAM_APP_ID}")
}

/// 用系统协议处理器唤起 Steam。
/// Windows 走 `cmd /C start`（CREATE_NO_WINDOW，不闪黑框）；其它平台给等价实现。
/// 只负责「把请求交给系统」，Steam 未安装 / 未登录时由 Steam 自己提示。
#[cfg(windows)]
fn open_steam_protocol(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW：cmd 窗口不闪出来
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法唤起 Steam：{e}（请确认已安装并登录 Steam）"))
}

#[cfg(target_os = "macos")]
fn open_steam_protocol(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法唤起 Steam：{e}（请确认已安装并登录 Steam）"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_steam_protocol(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法唤起 Steam：{e}（请确认已安装并登录 Steam）"))
}

/// 启动游戏：校验游戏根目录 → 通过 Steam 协议拉起游戏。
///
/// 参数 `exe_path`：**向后兼容保留**。v3.2 之前前端会传用户手选的 exe，
/// 现在前端恒传 `null`；真传了就用它的父目录反推根目录（仍然要求文件名含 AoE2DE）。
///
/// 返回值：`Ok(String)` 为实际交给系统的 `steam://` 地址，前端只关心「有没有抛错」。
///
/// 错误：
/// - `GAME_PATH_MISSING`：完全没有配置根目录 → 前端跳设置页；
/// - 其它文案：目录配置有误 / 无法唤起 Steam，原样 Toast 给用户。
#[tauri::command]
async fn launch_game(app: tauri::AppHandle, exe_path: Option<String>) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = settings::load_for_app(&handle);
        let mut changed = false;

        // 1) 兼容分支：前端显式传了 exe 就校验它，并用它所在目录当根目录
        let from_frontend = exe_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from);
        if let Some(picked) = from_frontend.as_ref() {
            if !is_game_exe(picked) {
                return Err(format!(
                    "选择的文件不是 AoE2 决定版主程序（需要 AoE2DE_s.exe）：{}",
                    picked.display()
                ));
            }
        }

        // 2) 确定游戏根目录：显式 exe 的父目录 > settings.game_root_dir
        let root = match from_frontend.as_ref() {
            Some(exe) => Some(settings::game_root_of_exe(exe)),
            None => settings
                .game_root_dir
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from),
        };

        let Some(root) = root else {
            // 3) 完全没配置：前端据此跳「设置 → 通用」并聚焦游戏根目录一行
            return Err(GAME_PATH_MISSING.to_string());
        };

        // 4) 前置校验：目录必须存在且含主程序，配置错了就明确报错，绝不静默启动
        let root = settings::validate_game_root(&root.to_string_lossy())?;
        let root_text = root.to_string_lossy().to_string();
        if settings.game_root_dir.as_deref() != Some(root_text.as_str()) {
            settings.game_root_dir = Some(root_text.clone());
            changed = true;
        }
        if changed {
            if let Err(e) = settings::save_for_app(&handle, &settings) {
                // 落盘失败不影响这次启动，只是下次还要重新推导一次
                log::warn!(target: "launch", "保存游戏根目录失败：{e}");
            }
        }

        // 5) 交给 Steam 启动：启动项 / 游玩时长 / 成就 / 覆盖层都在 Steam 侧生效
        let url = steam_launch_url();
        open_steam_protocol(&url)?;
        log::info!(target: "launch", "已请求 Steam 启动游戏：{url}（根目录 {root_text}）");
        Ok(url)
    })
    .await
    .map_err(|e| format!("启动游戏失败：{e}"))?
}

/// 设置「游戏根目录」（设置 → 通用）。`None` / 空串 = 清除配置。
///
/// 保存前统一走 `settings::validate_game_root`（绝对路径 + 目录存在 + 含 `AoE2DE_s.exe`），
/// 避免用户选错层级（选到 `steamapps`、模组目录或别的游戏）后才发现启动失败。
#[tauri::command]
async fn set_game_root_dir(
    app: tauri::AppHandle,
    dir: Option<String>,
) -> Result<models::Settings, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = settings::load_for_app(&handle);
        let cleaned = dir.as_deref().map(str::trim).filter(|value| !value.is_empty());
        settings.game_root_dir = match cleaned {
            Some(raw) => Some(settings::validate_game_root(raw)?.to_string_lossy().to_string()),
            None => None,
        };
        settings::save_for_app(&handle, &settings)?;
        log::info!(
            target: "launch",
            "游戏根目录已更新：{:?}",
            settings.game_root_dir
        );
        Ok(settings)
    })
    .await
    .map_err(|e| format!("保存游戏根目录失败：{e}"))?
}

/// 自动检测游戏根目录（设置页「自动检测」按钮）：只读探测，**不写配置**。
/// 复用 `settings::detect_game_exe`（Steam 库 → 卸载注册表 → SteamPath → 盘符常见路径）。
#[tauri::command]
async fn detect_game_root() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        settings::detect_game_exe()
            .map(|exe| settings::game_root_of_exe(&exe).to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

/// 退出闸门：已经在 CloseRequested 里请求过退出，避免重复 exit / 重复起看门狗
static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 硬退出兜底（斩草除根）。
///
/// 后台线程（在线索引、静默重登轮询、封面下载、翻译队列）全都是 `thread::spawn`
/// 或 `spawn_blocking` 的分离线程，Rust 主线程一结束整进程就会被带走，
/// 它们本身不会阻止退出；真正会卡住退出的是「事件循环还在跑」。
/// 所以这里只做一件事：给优雅退出留 1.2 秒，超时就直接 OS 级强杀。
fn spawn_exit_watchdog(delay: std::time::Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        log::error!(target: "app-exit", "优雅退出超时，强制终止进程 std::process::exit(0)");
        std::process::exit(0);
    });
}

pub fn run() {
    tauri::Builder::default()
        // ★ 单实例守护：必须是 Builder 上**第一个**注册的插件。
        // 已有一个实例在跑时，再次双击图标 → 这里收到回调（新进程立刻退出），
        // 只负责把已有主窗口从最小化/隐藏状态恢复并抢焦点。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!(target: "app-exit", "检测到重复启动：激活已有主窗口");
            match app.get_webview_window("main") {
                Some(win) => {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                None => log::error!(target: "app-exit", "重复启动回调里找不到 label=main 的主窗口"),
            }
        }))
        // 日志插件紧随其后：Stdout + 落盘双路输出。
        // v3.2：release 构建的 GUI 没有终端可看，只写 Stdout 等于没有日志；
        // 现在同时写 %LOCALAPPDATA%\<bundleId>\logs\ 下的 aoe2mm-<启动时间>.log，
        // 用户报障时直接要这个文件即可（本次回归排查就是被这一点卡住的）。
        //
        // v0.4.7：改成**每次运行一个独立文件**（文件名带启动时的本地时间）。
        // 单一文件滚动会把几次运行混在一起，贴日志时很难区分哪段属于哪次复现；
        // 分开后「本次运行」=「本次启动的那个文件」，定位问题不会有歧义。
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some(session_log_name()),
                    }),
                ])
                // 单个文件仍保留 5MB 上限并按大小滚动（改名成
                // aoe2mm-<启动时间>.<时间戳>.log），长期挂机不会把硬盘写满。
                // 注意：该策略只约束**单个运行文件**，跨运行的文件清理由
                // prune_old_logs() 负责（见 setup）。
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                // 时间戳用本地时区（默认 UTC，用户对照“几点点的登录按钮”时会差 8 小时）
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
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
            // v0.4.7：每次运行一个日志文件，这里清理超出的历史文件（保留 20 份）。
            // 放在 setup 而不是插件构建期：那时 AppHandle 可用，能拿到准确的日志目录。
            match logs_dir_for(app.handle()) {
                Ok(dir) => prune_old_logs(&dir),
                Err(e) => log::warn!(target: "diagnostics", "清理旧日志跳过：{e}"),
            }
            // ★ 关闭即退出：右上角 X 必须真正结束进程。
            // 病灶：会话探测 / 静默重登会在后台常驻一个**隐藏**的账号 WebView2 窗口
            // （session::ensure_account_window(…, visible=false)，见 online/session.rs:492），
            // tauri 只要窗口表里还有窗口，就永远不认为"窗口全关"，
            // RunEvent::ExitRequested 因此从不触发 → 主窗口关了、进程还活着，
            // 反复开关就会堆出一串僵尸 aoe2-mod-manager.exe。
            match app.get_webview_window("main") {
                Some(main) => {
                    let handle = app.handle().clone();
                    main.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                            if EXITING.swap(true, Ordering::SeqCst) {
                                return;
                            }
                            log::info!(target: "app-exit", "收到关闭请求：优雅退出 + 强杀兜底");
                            // 先走正常退出：让 RunEvent::Exit / 插件清理有机会执行
                            handle.exit(0);
                            // 再挂 OS 级强杀：1.2 秒内没退干净就直接终结进程
                            spawn_exit_watchdog(std::time::Duration::from_millis(1200));
                        }
                    });
                }
                None => log::error!(target: "app-exit", "未找到 label=main 的主窗口，关闭事件未挂载"),
            }
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
            cache_dirs,
            set_cache_dir,
            reset_cache_dir,
            open_cache_dir,
            data_dir_view,
            migrate_data_dir,
            open_data_dir,
            open_logs_dir,
            diagnostics_info,
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
            load_download_queue,
            save_download_queue,
            open_external,
            launch_game,
            set_game_root_dir,
            detect_game_root
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;

    /// 临时目录：每次用不同名字，避免并行测试互相干扰
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aoe2mm-diag-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tail_lines_keeps_the_last_hundred_only() {
        let dir = temp_dir("tail");
        let path = dir.join("aoe2mm.log");
        let body: String = (1..=150).map(|i| format!("line{i}\n")).collect();
        fs::write(&path, body).unwrap();
        let lines = tail_lines(&path, 100);
        assert_eq!(lines.len(), 100);
        assert_eq!(lines.first().map(|s| s.as_str()), Some("line51"));
        assert_eq!(lines.last().map(|s| s.as_str()), Some("line150"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newest_log_file_ignores_unrelated_files_and_picks_latest() {
        let dir = temp_dir("newest");
        fs::write(dir.join("aoe2mm.log"), "current\n").unwrap();
        fs::write(dir.join("aoe2mm_2026-11-06.log"), "rotated\n").unwrap();
        // 干扰项：同目录的其他文件不应被当成日志
        fs::write(dir.join("readme.txt"), "x").unwrap();
        let picked = newest_log_file(&dir).expect("应该找到一个日志文件");
        let name = picked.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("aoe2mm") && name.ends_with(".log"));
        assert!(!tail_lines(&picked, 10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_lines_on_missing_file_returns_empty_instead_of_panicking() {
        let dir = temp_dir("missing");
        assert!(tail_lines(&dir.join("nope.log"), 100).is_empty());
        assert!(newest_log_file(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
