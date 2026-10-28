use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::models::Settings;
use crate::net;
use crate::secure;
use crate::settings;

/// 专门用于维持官网登录态的独立窗口。
/// 登录过程完全发生在 WebView2 内，本应用不接触账号密码。
pub const ACCOUNT_WINDOW: &str = "aoe-account";
/// 官网登录入口：实测该地址会 302 到 login.microsoftonline.com（官方行为，不是 bug）
pub const LOGIN_URL: &str = "https://auth.ageofempires.com/";
/// 实测来源：www.ageofempires.com/mods 登录弹窗里的 "Sign in with your Steam Account"
/// → 302 到 steamcommunity.com/openid/login → 回跳 /signin-steam?state=…
pub const LOGIN_STEAM_URL: &str = "https://auth.ageofempires.com/loginsteam";
/// 同上，PlayStation Network 入口
pub const LOGIN_PSN_URL: &str = "https://auth.ageofempires.com/loginpsn";
pub const HOME_URL: &str = "https://www.ageofempires.com/mods/";
/// 判断“是否已登录”时以 API 目标域为准（避免把 www 域上的 WordPress 会话 Cookie 误当成登录态）
pub const API_COOKIE_URL: &str = "https://api.ageofempires.com/";
/// WebView2 用户数据目录名。固定放在 LocalAppData，不随 exe 位置变化，
/// 这样 dev / release / 换构建目录都不会丢会话。
const WEBVIEW_DIR: &str = "webview2";

/// 记录最近一次由我们主动隐藏窗口的原因，用于在 CloseRequested 日志里标注来源
static LAST_PROGRAMMATIC_REASON: Mutex<String> = Mutex::new(String::new());

pub fn note_programmatic_hide(reason: &str) {
    if let Ok(mut slot) = LAST_PROGRAMMATIC_REASON.lock() {
        *slot = reason.to_string();
    }
    log::info!(target: "account-window", "程序主动隐藏/销毁窗口：{reason}");
}

fn last_programmatic_reason() -> String {
    LAST_PROGRAMMATIC_REASON
        .lock()
        .map(|v| v.clone())
        .unwrap_or_default()
}

fn describe_cookies(cookies: &[cookie::Cookie<'static>]) -> String {
    if cookies.is_empty() {
        return "(无)".to_string();
    }
    cookies
        .iter()
        .map(|c| format!("{}(domain={})", c.name(), c.domain().unwrap_or("<host-only>")))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 给账号窗口挂上关闭/销毁事件日志
fn attach_window_logging(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => {
            let url = handle
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|e| format!("<读取 URL 失败：{e}>"));
            let reason = last_programmatic_reason();
            log::warn!(
                target: "account-window",
                "窗口被请求关闭（CloseRequested）：label={} url={} 最近一次程序侧原因={}",
                handle.label(),
                url,
                if reason.is_empty() { "（无，可能是用户点了关闭按钮）" } else { reason.as_str() }
            );
        }
        WindowEvent::Destroyed => {
            log::warn!(target: "account-window", "窗口已销毁（Destroyed）：label={}", handle.label());
        }
        _ => {}
    });
}

/// 持久化的 WebView2 数据目录（登录态就存在这里，应用启动时绝不清空）
pub fn webview_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let dir = base.join(WEBVIEW_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建 WebView2 数据目录 {}：{e}", dir.display()))?;
    Ok(dir)
}

fn resolve_net(app: &AppHandle) -> net::NetResolution {
    let settings = settings::load_for_app(app);
    match net::resolve(&net::NetConfig::from_settings(&settings)) {
        Ok(resolved) => resolved,
        Err(e) => {
            log::warn!(target: "account-window", "网络配置解析失败（{e}），本次按直连处理");
            net::NetResolution::direct(Some(format!("网络配置无效（{e}），已按直连处理")))
        }
    }
}

pub fn ensure_account_window(
    app: &AppHandle,
    url: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(ACCOUNT_WINDOW) {
        log::info!(
            target: "account-window",
            "复用已有窗口 label={} visible={} 请求地址={}",
            existing.label(),
            visible,
            url
        );
        if visible {
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            if let Ok(parsed) = Url::parse(url) {
                if let Err(e) = existing.navigate(parsed) {
                    log::warn!(target: "account-window", "导航失败：{e}");
                }
            }
        }
        return Ok(existing);
    }

    let parsed = Url::parse(url).map_err(|e| format!("登录地址无效：{e}"))?;
    let data_dir = webview_data_dir(app)?;
    let resolved = resolve_net(app);
    let browser_args = net::webview_args(&resolved);

    log::info!(
        target: "account-window",
        "创建账号窗口 url={} visible={} 数据目录={} 代理={:?}",
        url,
        visible,
        data_dir.display(),
        resolved.proxy_url
    );

    let mut builder = WebviewWindowBuilder::new(app, ACCOUNT_WINDOW, WebviewUrl::External(parsed))
        .title("登录《帝国时代》账号")
        .inner_size(520.0, 780.0)
        .min_inner_size(420.0, 600.0)
        .visible(visible)
        // 关键：固定且持久的数据目录，登录 Cookie 才会留下来（“记住我”的前提）
        .data_directory(data_dir)
        .on_navigation(|target| {
            // 只记录不拦截：硬白名单会打断 Xbox Live / Steam 授权的中间跳转
            let text = target.as_str();
            if text.contains("/signin-steam") || text.contains("/Home/CompleteLogin") {
                log::info!(target: "account-window", "授权回跳（凭据已提交）：{text}");
            } else {
                log::info!(target: "account-window", "页面导航：{text}");
            }
            true
        });

    if let Some(args) = browser_args.as_deref() {
        log::info!(target: "account-window", "WebView2 启动参数：{args}");
        // 注意：这会整体替换 wry 的默认参数，net::webview_args 已把默认串带上
        builder = builder.additional_browser_args(args);
    } else {
        log::info!(
            target: "account-window",
            "未传 --proxy-server：WebView2 将自行跟随 Windows 系统代理"
        );
    }

    let window = builder.build().map_err(|e| {
        log::error!(target: "account-window", "创建账号窗口失败：{e}");
        format!("无法创建登录窗口：{e}")
    })?;

    attach_window_logging(&window);
    log::info!(target: "account-window", "账号窗口创建成功 label={}", window.label());
    Ok(window)
}

/// 销毁账号窗口（切换网络设置、退出登录时使用）
pub fn destroy_account_window(app: &AppHandle, reason: &str) {
    if let Some(win) = app.get_webview_window(ACCOUNT_WINDOW) {
        note_programmatic_hide(reason);
        if let Err(e) = win.destroy() {
            log::warn!(target: "account-window", "销毁账号窗口失败：{e}");
        }
    }
}

/// 清除登录缓存：销毁窗口 → 删除 WebView2 数据目录与 DPAPI 会话缓存。
/// **必须在阻塞线程里调用。**
pub fn clear_login_cache(app: &AppHandle) -> Result<String, String> {
    destroy_account_window(app, "用户点击“退出登录/清除登录缓存”");

    let cache_path = settings::session_cache_for(app)?;
    let cache_note = match secure::clear(&cache_path) {
        Ok(()) => "已删除".to_string(),
        Err(e) => {
            log::warn!(target: "session-cache", "{e}");
            format!("删除失败：{e}")
        }
    };

    let dir = webview_data_dir(app)?;
    let mut removed = false;
    let mut last_err = String::new();
    for attempt in 0..12 {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {
                removed = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                removed = true;
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                log::warn!(
                    target: "account-window",
                    "第 {} 次删除 WebView2 数据目录失败：{e}",
                    attempt + 1
                );
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
    if !removed {
        return Err(format!(
            "WebView2 数据目录仍被占用，请关闭应用后手动删除 {}（{last_err}）",
            dir.display()
        ));
    }
    let _ = std::fs::create_dir_all(&dir);

    Ok(format!(
        "已退出登录：WebView2 数据目录已清空（{}），加密会话缓存：{cache_note}",
        dir.display()
    ))
}

/// 读取“将要发送给 api.ageofempires.com 的 Cookie”。
/// 先用 cookies_for_url(api) 精确匹配目标域，避免把 www.ageofempires.com 上的
/// WordPress/Analytics Cookie 误判成登录态（这正是之前登录窗口“秒关”的原因）。
pub fn collect_cookie_header(webview: &WebviewWindow) -> Result<String, String> {
    let targeted = match Url::parse(API_COOKIE_URL) {
        Ok(parsed) => match webview.cookies_for_url(parsed) {
            Ok(list) => {
                log::info!(
                    target: "account",
                    "cookies_for_url({}) 返回 {} 条：{}",
                    API_COOKIE_URL,
                    list.len(),
                    describe_cookies(&list)
                );
                list
            }
            Err(e) => {
                log::warn!(target: "account", "cookies_for_url 失败：{e}");
                Vec::new()
            }
        },
        Err(e) => {
            log::warn!(target: "account", "API_COOKIE_URL 解析失败：{e}");
            Vec::new()
        }
    };

    let mut chosen = targeted;
    if chosen.is_empty() {
        // 退回全量过滤（同样只记录名称与域，不记录值）
        let all = webview.cookies().unwrap_or_default();
        let filtered: Vec<_> = all
            .into_iter()
            .filter(|c| {
                let host = c.domain().unwrap_or_default().trim_start_matches('.').to_lowercase();
                host.ends_with("ageofempires.com")
            })
            .collect();
        log::info!(
            target: "account",
            "api 目标域无 Cookie，退回全量过滤得到 {} 条：{}",
            filtered.len(),
            describe_cookies(&filtered)
        );
        chosen = filtered;
    }

    let mut jar: Vec<(String, String)> = Vec::new();
    for cookie in chosen.iter() {
        let value = cookie.value().to_string();
        if value.is_empty() {
            continue;
        }
        let name = cookie.name().to_string();
        if let Some(slot) = jar.iter_mut().find(|(n, _)| n == &name) {
            slot.1 = value;
        } else {
            jar.push((name, value));
        }
    }

    Ok(jar
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

/// 会话来源：webview = WebView2 内实时 Cookie；cache = DPAPI 加密缓存
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionSource {
    Webview,
    Cache,
}

impl SessionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionSource::Webview => "webview",
            SessionSource::Cache => "cache",
        }
    }
}

pub struct SessionProbe {
    pub header: String,
    pub source: SessionSource,
}

fn remember_login_enabled(app: &AppHandle) -> bool {
    settings::load_for_app(app).remember_login
}

/// 取会话：优先 WebView2 实时 Cookie（并顺手刷新加密缓存），
/// 实时 Cookie 为空时若开启“记住登录”则回退到加密缓存。
pub fn probe_session(app: &AppHandle) -> Result<SessionProbe, String> {
    let settings: Settings = settings::load_for_app(app);
    let window = ensure_account_window(app, HOME_URL, false)?;
    let header = collect_cookie_header(&window)?;

    if !header.is_empty() {
        if settings.remember_login {
            if let Ok(path) = settings::session_cache_for(app) {
                match secure::save(&path, &header) {
                    Ok(()) => log::info!(
                        target: "session-cache",
                        "已用 DPAPI 加密保存会话 Cookie（{} 字节，内容不打印）",
                        header.len()
                    ),
                    Err(e) => log::warn!(target: "session-cache", "保存会话缓存失败：{e}"),
                }
            }
        }
        log::info!(target: "account", "取到 Cookie 头，长度={} 字节（内容不打印）", header.len());
        return Ok(SessionProbe { header, source: SessionSource::Webview });
    }

    if settings.remember_login {
        if let Ok(path) = settings::session_cache_for(app) {
            if let Some(cached) = secure::load(&path) {
                log::info!(
                    target: "session-cache",
                    "WebView2 内无 ageofempires Cookie，改用加密缓存（{} 字节）",
                    cached.len()
                );
                return Ok(SessionProbe { header: cached, source: SessionSource::Cache });
            }
        }
    }

    log::info!(target: "account", "当前没有可用的 ageofempires 会话 Cookie");
    Err("尚未登录".to_string())
}

/// 是否已具备可用会话（Cookie 头非空）
pub fn current_cookie_header(app: &AppHandle) -> Result<String, String> {
    probe_session(app).map(|probe| probe.header)
}

/// 开登录窗口前丢弃旧缓存：用户主动登录说明旧会话已失效，留着只会掩盖真实状态
pub fn invalidate_cached_session(app: &AppHandle) {
    if !remember_login_enabled(app) {
        return;
    }
    if let Ok(path) = settings::session_cache_for(app) {
        if let Err(e) = secure::clear(&path) {
            log::warn!(target: "session-cache", "清理旧会话缓存失败：{e}");
        } else {
            log::info!(target: "session-cache", "已清理旧会话缓存，等待重新登录产生新会话");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_domain_filter_accepts_subdomains() {
        let accept = |domain: &str| {
            let host = domain.trim_start_matches('.').to_lowercase();
            host.ends_with("ageofempires.com")
        };
        assert!(accept(".ageofempires.com"));
        assert!(accept("api.ageofempires.com"));
        assert!(accept("auth.ageofempires.com"));
        assert!(!accept(".ageofempires.com.evil.tld"));
        assert!(!accept("login.live.com"));
    }

    /// Steam / PSN 入口来自官网登录弹窗，改动前请重新实测（见对话记录里的 curl 结果）
    #[test]
    fn platform_entry_urls_are_stable() {
        assert_eq!(LOGIN_STEAM_URL, "https://auth.ageofempires.com/loginsteam");
        assert_eq!(LOGIN_PSN_URL, "https://auth.ageofempires.com/loginpsn");
        assert_eq!(LOGIN_URL, "https://auth.ageofempires.com/");
        assert_eq!(SessionSource::Cache.as_str(), "cache");
    }
}
