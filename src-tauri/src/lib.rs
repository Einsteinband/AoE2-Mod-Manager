use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

mod download;
mod install;
mod metadata;
mod models;
mod net;
mod presets;
mod online;
mod scan;
mod secure;
mod settings;

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
        Ok(path) => settings::load(&path),
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
    online::session::invalidate_cached_session(&app);
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
    tauri::async_runtime::spawn_blocking(move || {
        client.find(&query, start, count, &sort, &order, &tags)
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
    tauri::async_runtime::spawn_blocking(move || client.installed(start.max(1), count.clamp(1, 50)))
        .await
        .map_err(|e| ApiFailure::new("internal", format!("查询任务失败：{e}"), None))?
}

#[tauri::command]
async fn online_detail(
    app: tauri::AppHandle,
    mod_id: i64,
) -> Result<serde_json::Value, ApiFailure> {
    let client = client(&app)?;
    tauri::async_runtime::spawn_blocking(move || client.detail(mod_id))
        .await
        .map_err(|e| ApiFailure::new("internal", format!("请求任务失败：{e}"), None))?
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
        let mut parts: Vec<String> = Vec::new();
        if o.record_added {
            parts.push("已新建 local// 记录并置为启用".to_string());
        } else if o.path_updated {
            parts.push("已把记录 Path 改为 local// 并置为启用".to_string());
        } else {
            parts.push("local// 记录已是最新状态".to_string());
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
    let owned_before = metadata::load_for_app(&app)
        .mods
        .contains_key(&mod_id.to_string());

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
        let mut final_path = install::status_rel_path("subscribed", &folder_name);
        let mut localize_note = String::new();
        let mut localize_target: Option<install::LocalizeTarget> = None;
        match install::resolve_localize_target(&root_for_task, mod_id, Some(&folder_name)) {
            Ok(target) => match install::move_to_local(&target) {
                Ok(()) => {
                    localized = true;
                    final_dir = target.to.display().to_string();
                    final_path = install::status_rel_path("local", &target.folder_name);
                    localize_target = Some(target);
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
            &folder_name,
            localized,
            false,
        ) {
            Ok(v) => v,
            Err(e) => {
                log::error!(target: "install", "modId={mod_id} 写 mod-status.json 失败：{e}");
                // 回滚：已 move 就把目录挪回 subscribed，保证“文件位置”与“记录 Path”一致
                let rollback_note = if let Some(target) = localize_target.as_ref() {
                    match install::move_dir(&target.to, &target.from) {
                        Ok(()) => {
                            localized = false;
                            final_dir = target.from.display().to_string();
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
                    &folder_name,
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
            folder_name: if folder_name.is_empty() {
                None
            } else {
                Some(folder_name.clone())
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
            note_parts.push("已移入 local 目录并置为启用，可直接在游戏内启用".to_string());
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
        .invoke_handler(tauri::generate_handler![
            ui_log,
            get_settings,
            set_locale,
            candidate_roots,
            detect_root_candidates,
            scan_mods,
            set_mod_root,
            mod_stats,
            online_session_status,
            online_login_targets,
            online_open_login,
            online_open_login_silent,
            online_close_login_window,
            online_reset_login_view,
            online_probe_account_window,
            get_network_settings,
            set_network_settings,
            online_clear_login_cache,
            online_find,
            online_tags,
            reveal_mod_folder,
            online_installed,
            online_detail,
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
            toggle_mod_enabled
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
