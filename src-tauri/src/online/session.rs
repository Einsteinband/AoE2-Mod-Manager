use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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

/// 全量 Cookie 的元数据快照：只打印 name/domain/path/是否会话 Cookie，**绝不打印值**。
/// 用来区分“抓取太早”与“会话 Cookie 根本不落盘”这两个病因。
fn describe_full(cookies: &[cookie::Cookie<'static>]) -> String {
    if cookies.is_empty() {
        return "(无)".to_string();
    }
    cookies
        .iter()
        .map(|c| {
            format!(
                "{}[domain={},path={},{}]",
                c.name(),
                c.domain().unwrap_or("<host-only>"),
                c.path().unwrap_or("/"),
                if is_session_cookie(c) { "session" } else { "persistent" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// 全量 Cookie 诊断只打一次：`collect_cookie_header` 每次请求前都会调，
/// 翻页 50 页就是 50 行日志，这里用一次性开关兑掉。
static ALL_COOKIES_LOGGED: AtomicBool = AtomicBool::new(false);

/// 打印全量 Cookie 的元数据（name/domain/path/session|persistent），**全进程只打一次**。
/// 内容与旧版 `collect_cookie_header` 里的全量诊断行完全一致。
pub fn log_all_cookies_once(webview: &WebviewWindow) {
    // swap 成功 = 本进程第一次进来；失败直接返回，不读 Cookie 也不写日志
    if ALL_COOKIES_LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    match webview.cookies() {
        Ok(all) => log::info!(
            target: "account",
            "全量 Cookie {} 条：{}",
            all.len(),
            describe_full(&all)
        ),
        Err(e) => {
            // 读失败不算“已打印过”，放开开关下次再试
            ALL_COOKIES_LOGGED.store(false, Ordering::Relaxed);
            log::warn!(target: "account", "读取全量 Cookie 失败：{e}");
        }
    }
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

/// 清除登录缓存（退出登录唯一入口）：阻断账号窗口重载 → 清 AoE Cookie
/// → 删 DPAPI 会话缓存 → 删 WebView2 数据目录。
/// **任何一步失败都必须返回 Err**：前端据此显示“退出登录失败”，绝不谎报成功。
/// **必须在阻塞线程里调用。**
pub fn clear_login_cache(app: &AppHandle) -> Result<String, String> {
    log::info!(
        target: "account-window",
        "开始退出登录：阻断窗口重载 → 清 AoE Cookie → 删数据目录"
    );
    let mut failures: Vec<String> = Vec::new();

    // ① 窗口还活着时：先断掉页面重载、清 AoE Cookie（清理需要活窗口），再销毁窗口
    if let Err(e) = invalidate_cached_session(app) {
        failures.push(e);
    }

    // ② DPAPI 加密会话缓存：存在才删，删不掉也算失败
    if let Ok(cache_path) = settings::session_cache_for(app) {
        if cache_path.exists() {
            if let Err(e) = secure::clear(&cache_path) {
                log::error!(target: "session-cache", "删除加密会话缓存失败：{e}");
                failures.push(format!("删除加密会话缓存失败：{e}"));
            }
        }
    }

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
        log::error!(
            target: "account-window",
            "WebView2 数据目录仍被占用：{}（{last_err}）",
            dir.display()
        );
        failures.push(format!(
            "WebView2 数据目录仍被占用（{}）：{last_err}",
            dir.display()
        ));
    }

    if !failures.is_empty() {
        log::error!(
            target: "account-window",
            "退出登录未完成：{}",
            failures.join("；")
        );
        return Err(format!(
            "退出登录失败：文件被占用，请重启软件后清理（{}）",
            failures.join("；")
        ));
    }
    let _ = std::fs::create_dir_all(&dir);

    Ok(format!(
        "已退出登录：AoE Cookie 与 WebView2 数据目录均已清空（{}）",
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

    // 诊断：记录本次 header 的来源（只看不改）
    let mut header_source = "cookies_for_url(api)";
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
        header_source = "全量 fallback(domain=ageofempires.com)";
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

    // 病灶B：jar 里没有真凭证时，补入 auth / www 域的关键 Cookie
    // （只在缺凭证时多一次全量读取，正常已登录的请求不受影响）
    if !has_real_credential(&join_header(&jar)) {
        let added = merge_auth_credentials(webview, &mut jar);
        log::info!(
            target: "account",
            "补入 auth/www 域凭证：{}",
            if added.is_empty() { "(无)".to_string() } else { added.join(", ") }
        );
    }

    // 诊断：这个 header 实际装了哪些 name，以及它是从哪个渠道来的
    {
        let names: Vec<&str> = jar.iter().map(|(n, _)| n.as_str()).collect();
        log::info!(
            target: "account",
            "Cookie 头来源={} 共 {} 条：{}",
            header_source,
            names.len(),
            if names.is_empty() { "(空)".to_string() } else { names.join(", ") }
        );
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

/// 一次性日志：本进程第一次读到开关值时记一条（target=settings）
fn log_remember_login_once(enabled: bool) {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    log::info!(target: "settings", "读取持久登录开关 remember_login={enabled}");
}

/// 一次性日志：避免每次会话探测都刷一条“跳过持久化”
fn log_skip_persist_once() {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    log::info!(target: "session-cookie", "持久登录开关关闭，跳过 Cookie 持久化");
}

/// 全局“会话已结束”取消信号：索引同步每页开始前检查它（见 `online_index`）。
/// 退出登录时置位，登录成功后复位。
static SYNC_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 退出登录时调用：置位取消标记 + 广播事件，让前端立刻停止在线请求。
pub fn cancel_sync(app: &AppHandle) {
    SYNC_CANCELLED.store(true, Ordering::SeqCst);
    log::warn!(
        target: "index",
        "会话已结束：索引同步取消标记已置位，本轮同步会在下一页之前中断"
    );
    if let Err(e) = app.emit(crate::online_index::CANCEL_EVENT, "logout") {
        log::debug!(target: "index", "索引中断事件发送失败：{e}");
    }
}

/// 索引同步每页开始前调用：true = 会话已结束，必须立刻停手
pub fn is_sync_cancelled() -> bool {
    SYNC_CANCELLED.load(Ordering::SeqCst)
}

/// 会话恢复（探到有效凭证）后复位取消标记
pub fn clear_sync_cancel() {
    SYNC_CANCELLED.store(false, Ordering::SeqCst);
}

/// 取会话：优先 WebView2 实时 Cookie（并顺手刷新加密缓存），
/// 实时 Cookie 为空时若开启“记住登录”则回退到加密缓存。
pub fn probe_session(app: &AppHandle) -> Result<SessionProbe, String> {
    let settings: Settings = settings::load_for_app(app);
    log_remember_login_once(settings.remember_login);
    let window = ensure_account_window(app, HOME_URL, false)?;
    let header = collect_cookie_header(&window)?;

    if !header.is_empty() && has_real_credential(&header) {
        // 诊断：先回答“这份 header 里到底有没有真凭证”
        log_key_credentials(&header);
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
        // 门控：开关关闭时只用本次进程内的会话，绝不把 AoE 凭证写进磁盘
        if settings.remember_login {
            match persist_auth_cookies(&window) {
                Ok(n) if n > 0 => log::info!(
                    target: "session-cookie",
                    "已把 {n} 条会话 Cookie 改成 7 天持久 Cookie（下次启动无需重新登录）"
                ),
                Ok(_) => {}
                Err(e) => log::warn!(target: "session-cookie", "持久化会话 Cookie 失败：{e}"),
            }
        } else {
            log_skip_persist_once();
        }
        // 拿到有效会话：之前的“已退出登录”取消标记作废，索引可以重新跑
        clear_sync_cancel();
        // 登录成功后的第一次探测：把全量 Cookie 快照打一次（全进程仅一次）
        log_all_cookies_once(&window);
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
                log_key_credentials(&cached);
                if has_real_credential(&cached) {
                    return Ok(SessionProbe { header: cached, source: SessionSource::Cache });
                }
                log::info!(
                    target: "session-cache",
                    "加密缓存里也没有真凭证（多为旧版本写入的游客 Cookie），不当作已登录"
                );
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

/// 退出登录 / 主动重新登录前的清理：**阻断窗口重载 → 清 AoE Cookie → 销毁窗口**。
/// 失败一律返回 Err（调用方必须如实告诉用户），绝不静默吞掉。
pub fn invalidate_cached_session(app: &AppHandle) -> Result<(), String> {
    // 诊断开关重置：下次登录成功后还能再打一次 Cookie 快照
    ALL_COOKIES_LOGGED.store(false, Ordering::Relaxed);
    // ① 立刻中止索引同步：退出登录后不该再有任何在线请求
    cancel_sync(app);

    let mut failures: Vec<String> = Vec::new();
    match app.get_webview_window(ACCOUNT_WINDOW) {
        Some(window) => {
            // ② 阻断重新导航：页面立刻换成 about:blank，
            //    官方页面来不及再下发 PHPSESSID / AgeAuthSession
            note_programmatic_hide("用户退出登录：阻断账号窗口重载");
            match Url::parse("about:blank") {
                Ok(blank) => {
                    if let Err(e) = window.navigate(blank) {
                        log::error!(target: "session-cookie", "阻断账号窗口重载失败：{e}");
                        failures.push(format!("阻断窗口重载失败：{e}"));
                    }
                }
                Err(e) => failures.push(format!("about:blank 解析失败：{e}")),
            }

            // ③ 清 AoE Cookie（需要活窗口才拿得到 CookieManager），失败必须冒泡
            match purge_webview_cookies(app) {
                Ok(n) => log::info!(target: "session-cookie", "已清空 AoE Cookie {n} 条"),
                Err(e) => failures.push(e),
            }

            // ④ 销毁窗口且不重建：销毁后网页不可能再回来下发凭证
            if let Err(e) = window.destroy() {
                log::error!(target: "account-window", "销毁账号窗口失败：{e}");
                failures.push(format!("销毁账号窗口失败：{e}"));
            }
        }
        None => log::info!(target: "session-cookie", "没有账号窗口，跳过 Cookie 清理"),
    }

    // ⑤ DPAPI 加密缓存：存在才删，删不掉也算失败
    if let Ok(path) = settings::session_cache_for(app) {
        if path.exists() {
            if let Err(e) = secure::clear(&path) {
                log::error!(target: "session-cache", "删除加密会话缓存失败：{e}");
                failures.push(format!("删除加密会话缓存失败：{e}"));
            }
        }
    }

    if failures.is_empty() {
        log::info!(target: "session-cookie", "退出登录清理完成：AoE Cookie 与加密缓存均已清空");
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

// ---------------- 会话 Cookie 强行续命（session → 持久化） ----------------

/// 续命后的本地有效期（天）。
/// 这只决定 Chromium 把 Cookie 落盘时的到期时间；服务端若自行判票据失效仍会 401，
/// 那种情况由 [`ensure_session`] 静默重登兜底。
const PERSIST_DAYS: f64 = 7.0;
/// 两次续命的最小间隔：避免每次会话探测都碰一遍 COM + 磁盘
const PERSIST_THROTTLE_MS: u64 = 10 * 60 * 1000;
/// 等待 WebView2 回调的上限（本进程内查询，正常只要几毫秒）
const PERSIST_TIMEOUT: Duration = Duration::from_secs(5);
/// 自动重登的总等待上限（含微软 SSO 整条跳转链）
const SILENT_LOGIN_TIMEOUT: Duration = Duration::from_secs(25);
/// 自动重登的轮询间隔
const SILENT_LOGIN_POLL: Duration = Duration::from_millis(500);
/// 轮询期间的日志降噪间隔：SSO 跳转中 / 集合变了但无凭证，这两类日志每 5 秒最多一条
const SSO_LOG_SECS: u64 = 5;

/// 最近一次成功续命的时间戳（毫秒），0 = 从未续命
static LAST_PERSIST_MS: Mutex<u64> = Mutex::new(0);

/// Cookie 头里的 name 列表（不包含值）
fn header_names(header: &str) -> Vec<String> {
    header
        .split(';')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| p.split('=').next().unwrap_or("").to_string())
        .collect()
}

/// 诊断：Cookie 头里是否包含关键凭证（只打 bool，不打印任何值）
fn log_key_credentials(header: &str) {
    let names = header_names(header);
    let has = |key: &str| names.iter().any(|n| n.contains(key));
    log::info!(
        target: "account",
        "关键凭证存在性：AgeAuthSession={} wordpress_logged_in={} PHPSESSID={}",
        has("AgeAuthSession"),
        has("wordpress_logged_in"),
        has("PHPSESSID")
    );
}

/// 真正的登录凭证 Cookie 名（子串匹配：`wordpress_logged_in_` 后面还带 hash）
const AUTH_CRED_KEYS: [&str; 3] = ["AgeAuthSession", "wordpress_logged_in", "PHPSESSID"];

/// 一等凭证：WordPress 登录 Cookie（真实名字带 hash 后缀，用子串匹配）
const WP_LOGIN_KEY: &str = "wordpress_logged_in";
/// 辅助凭证：`AgeAuthSession` 单独存在不算登录，必须同时有 `PHPSESSID` 才认
const AGE_AUTH_KEY: &str = "AgeAuthSession";
const PHP_SESSID_KEY: &str = "PHPSESSID";

/// 这份 Cookie 头里是否含真实登录凭证（只判 name，不判 domain / expires）。
///
/// v1.5 收紧（退出登录后 UI 横跳的根因）：
/// - **只有 `PHPSESSID` 或只有 `AgeAuthSession` 一律不算登录**——游客态同样会下发这两条；
/// - 唯一的一等凭证是 `wordpress_logged_in_*`；
/// - 若服务端确实只认 `AgeAuthSession`，必须 `AgeAuthSession + PHPSESSID` 同时具备。
pub fn has_real_credential(header: &str) -> bool {
    let names = header_names(header);
    let has = |key: &str| names.iter().any(|n| n.contains(key));
    has(WP_LOGIN_KEY) || (has(AGE_AUTH_KEY) && has(PHP_SESSID_KEY))
}

/// 把 jar 拼回 Cookie 头字符串
/// `CreateCookie` 要求域级 Cookie 的 domain 带前导点；cookie crate 给出的 domain 不带点，
/// 直接沿用会变成 host-only cookie（`api.ageofempires.com` 收不到），冷启动后登录态就丢了。
/// 空串原样返回（保持调用方原意图），已有点的也原样返回。
fn ensure_dot_prefix(d: &str) -> String {
    if d.is_empty() || d.starts_with('.') {
        d.to_string()
    } else {
        format!(".{d}")
    }
}

fn join_header(jar: &[(String, String)]) -> String {
    jar.iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 病灶B：`cookies_for_url(api)` 只返回“能发给 api 域的那批”，天然排除了
/// `AgeAuthSession[domain=auth.ageofempires.com]` 与 `PHPSESSID[domain=www.ageofempires.com]`。
/// 这里把 auth / www 域上的关键凭证补进 jar；**已存在的同名项一律跳过（不覆盖游客 Cookie）**。
fn merge_auth_credentials(webview: &WebviewWindow, jar: &mut Vec<(String, String)>) -> Vec<String> {
    let all = match webview.cookies() {
        Ok(all) => all,
        Err(e) => {
            log::warn!(target: "account", "补入凭证时读取全量 Cookie 失败：{e}");
            return Vec::new();
        }
    };

    let mut added: Vec<String> = Vec::new();
    for cookie in all.iter() {
        let name = cookie.name().to_string();
        if !AUTH_CRED_KEYS.iter().any(|key| name.contains(key)) {
            continue;
        }
        let domain = cookie
            .domain()
            .unwrap_or_default()
            .trim_start_matches('.')
            .to_lowercase();
        if !(domain.ends_with("auth.ageofempires.com") || domain.ends_with("www.ageofempires.com")) {
            continue;
        }
        let value = cookie.value().to_string();
        if value.is_empty() {
            continue;
        }
        // 不覆盖 jar 里已有的同名项
        if jar.iter().any(|(n, _)| n == &name) {
            continue;
        }
        added.push(name.clone());
        jar.push((name, value));
    }
    added
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cookie 头归一成可排序集合：服务端返回顺序不固定，直接比字符串会误判成“已换新”
fn cookie_signature(header: &str) -> Vec<String> {
    let mut parts: Vec<String> = header
        .split(';')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    parts.sort();
    parts
}

/// 把内存里的**会话**鉴权 Cookie 强行改成持久 Cookie（Expires = 现在 + 7 天）。
///
/// 为什么必须这么做：实测 `.AgeOfEmpiresServices` / `wordpress_logged_in_*` 都是
/// `Expires=0` 的会话 Cookie，Chromium 从不写盘（落盘的只有
/// `_clck / _clsk / _ga / age_login_expire / MSCC` 这几条），进程一退出登录态就没了。
/// 改写后 WebView2 会把它写进 `Network\Cookies`，下次启动直接可用，不必再跑 SSO。
///
/// **必须在非主线程调用**：`with_webview` 会阻塞到主线程把闭包跑完；
/// 若从主线程调用，WebView2 的回调永远排不上队（自锁）。
pub fn persist_auth_cookies(window: &WebviewWindow) -> Result<usize, String> {
    let last = LAST_PERSIST_MS.lock().map(|v| *v).unwrap_or(0);
    if now_ms().saturating_sub(last) < PERSIST_THROTTLE_MS {
        return Ok(0);
    }

    // 在调用线程读全量 Cookie（cookies() 只能在非主线程调用，见会话探测处的说明），
    // 再把目标列表搬进 WebView2 线程写回；WebView2 线程上只做同步 COM 调用，绝不等异步回调。
    let all = window
        .cookies()
        .map_err(|e| format!("读取 WebView2 Cookie 失败：{e}"))?;
    let targets: Vec<cookie::Cookie<'static>> =
        all.into_iter().filter(is_persist_target).collect();
    if targets.is_empty() {
        log::info!(target: "session-cookie", "没有需要续命的会话 Cookie（未登录或已持久化）");
        return Ok(0);
    }
    log::info!(target: "session-cookie", "准备续命：{} 条会话 Cookie", targets.len());

    let (tx, rx) = std::sync::mpsc::channel::<Result<usize, String>>();
    window
        .with_webview(move |webview| {
            let _ = tx.send(persist_in_window(webview, targets));
        })
        .map_err(|e| format!("无法访问 WebView2：{e}"))?;

    let outcome = rx
        .recv_timeout(PERSIST_TIMEOUT)
        .map_err(|_| "设置持久 Cookie 超时（WebView2 未回应）".to_string())?;

    if let Ok(count) = &outcome {
        if *count > 0 {
            if let Ok(mut slot) = LAST_PERSIST_MS.lock() {
                *slot = now_ms();
            }
        }
    }
    outcome
}

/// 是否会话 Cookie（Expires 缺失，或显式标记为 Session）
fn is_session_cookie(c: &cookie::Cookie<'static>) -> bool {
    match c.expires() {
        None => true,
        // wry 把服务端的 Expires=0 / IsSession 映射成 Expiration::Session
        Some(exp) => matches!(exp, cookie::Expiration::Session),
    }
}

/// 续命目标：ageofempires 域的**会话** Cookie。
/// 已经是持久 Cookie 的不碰（不做无谓写盘），微软 SSO / 分析统计等其它域也不碰。
fn is_persist_target(c: &cookie::Cookie<'static>) -> bool {
    let domain = match c.domain() {
        Some(d) => d.trim_start_matches('.').to_lowercase(),
        None => return false,
    };
    domain.ends_with("ageofempires.com") && is_session_cookie(c)
}

/// 在 WebView2 线程上把会话 Cookie 重建为持久 Cookie（Expires = 现在 + 7 天）。
/// 全部是同步 COM 调用（CreateCookie / AddOrUpdateCookie），不需要消息泵，
/// 所以既不会卡住主线程，也不存在“等回调等不到”的死锁。
#[cfg(windows)]
fn persist_in_window(
    webview: tauri::webview::PlatformWebview,
    targets: Vec<cookie::Cookie<'static>>,
) -> Result<usize, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
    };
    use windows_core::{Interface, HSTRING};

    let controller = webview.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("取 CoreWebView2 失败：{e}"))?;
    // CookieManager 在 ICoreWebView2_2 上（与 wry 内部做法一致，ICoreWebView2 本身没有）
    let core = core
        .cast::<ICoreWebView2_2>()
        .map_err(|e| format!("升级到 ICoreWebView2_2 失败：{e}"))?;
    let manager = unsafe { core.CookieManager() }
        .map_err(|e| format!("取 CookieManager 失败：{e}"))?;

    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
        + PERSIST_DAYS * 86_400.0;

    let mut persisted = 0usize;
    for cookie in targets {
        let name = cookie.name().to_string();
        // domain 必须带前导点，否则重建出来是 host-only，api 子域收不到
        let raw_domain = cookie.domain().unwrap_or_default().to_string();
        let h_domain_str = ensure_dot_prefix(&raw_domain);
        let h_name = HSTRING::from(cookie.name());
        let h_value = HSTRING::from(cookie.value());
        let h_domain = HSTRING::from(h_domain_str.as_str());
        let h_path = HSTRING::from(cookie.path().unwrap_or("/"));

        let created = match unsafe { manager.CreateCookie(&h_name, &h_value, &h_domain, &h_path) } {
            Ok(created) => created,
            Err(e) => {
                log::warn!(target: "session-cookie", "重建 Cookie {name} 失败：{e}");
                continue;
            }
        };

        // 属性逐项照抄原 Cookie，别把 HttpOnly / Secure / SameSite 丢掉
        let _ = unsafe { created.SetIsHttpOnly(cookie.http_only().unwrap_or(false)) };
        let _ = unsafe { created.SetIsSecure(cookie.secure().unwrap_or(false)) };
        let same_site = match cookie.same_site() {
            Some(cookie::SameSite::Strict) => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
            Some(cookie::SameSite::None) => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
            _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
        };
        let _ = unsafe { created.SetSameSite(same_site) };
        if let Err(e) = unsafe { created.SetExpires(deadline) } {
            log::warn!(target: "session-cookie", "设置 {name} 过期时间失败：{e}");
            continue;
        }
        match unsafe { manager.AddOrUpdateCookie(&created) } {
            Ok(()) => {
                persisted += 1;
                log::info!(
                    target: "session-cookie",
                    "会话 Cookie 已改为持久：{name}（domain={raw_domain}，{PERSIST_DAYS} 天）"
                );
                log::info!(
                    target: "session-cookie",
                    "写回 {name} domain={h_domain_str} (原始={raw_domain} 前导点={})",
                    h_domain_str.starts_with('.')
                );
            }
            Err(e) => log::warn!(target: "session-cookie", "写回 {name} 失败：{e}"),
        }
    }
    Ok(persisted)
}

#[cfg(not(windows))]
fn persist_in_window(
    _webview: tauri::webview::PlatformWebview,
    _targets: Vec<cookie::Cookie<'static>>,
) -> Result<usize, String> {
    Ok(0)
}

/// 只清 AoE 自己的 Cookie，绝不动微软 SSO 的（MSPAuth / MSPProf / __Host-MSAAUTHP）。
///
/// 为什么要显式删：WebView2 会把持久 Cookie 同步写进数据目录的 `Network\Cookies`，
/// 只删 DPAPI 缓存或只销毁窗口都留不下“已退出”的事实。窗口不存在时直接跳过
/// （那种情况由 `clear_login_cache` 把整个数据目录删掉）。
///
/// GetCookies 是**异步回调**：闭包里只负责注册、立刻返回；等结果放在非主线程上
/// 用 recv_timeout，主线程照常跑消息循环，所以既不卡 UI 也不会自锁。超时/失败只 warn。
fn purge_webview_cookies(app: &AppHandle) -> Result<usize, String> {
    let Some(window) = app.get_webview_window(ACCOUNT_WINDOW) else {
        let msg = "账号窗口不存在，无法清理 WebView2 Cookie".to_string();
        log::error!(target: "session-cookie", "{msg}");
        return Err(msg);
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<usize, String>>();
    if let Err(e) = window.with_webview(move |webview| {
        delete_aoe_cookies_in_window(webview, tx);
    }) {
        let msg = format!("无法访问 WebView2，AoE Cookie 未清理：{e}");
        log::error!(target: "session-cookie", "{msg}");
        return Err(msg);
    }

    // 每个查询 URL 回一条结果，整体共用 PERSIST_TIMEOUT（5s）上限
    let deadline = Instant::now() + PERSIST_TIMEOUT;
    let mut replies = 0usize;
    let mut deleted = 0usize;
    let mut last_err: Option<String> = None;
    while replies < AOE_COOKIE_URLS.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(Ok(n)) => {
                deleted += n;
                replies += 1;
            }
            Ok(Err(e)) => {
                last_err = Some(e);
                replies += 1;
            }
            Err(_) => break,
        }
    }

    if replies < AOE_COOKIE_URLS.len() {
        let msg = format!(
            "清空 AoE Cookie 超时（{replies}/{} 个域已回，已删 {deleted} 条）",
            AOE_COOKIE_URLS.len()
        );
        log::error!(target: "session-cookie", "{msg}");
        return Err(msg);
    }
    if let Some(e) = last_err {
        let msg = format!("清空 AoE Cookie 失败：{e}（已删 {deleted} 条）");
        log::error!(target: "session-cookie", "{msg}");
        return Err(msg);
    }
    log::info!(
        target: "session-cookie",
        "已按域清理 AoE Cookie {deleted} 条（微软 SSO Cookie 未触碰）"
    );
    Ok(deleted)
}

/// 需要逐域查询的三个 AoE 入口。
/// GetCookies 按 URI 返回“会发给该地址的 Cookie”，所以天然拿不到 login.live.com
/// 或 login.microsoftonline.com 下的任何内容。
const AOE_COOKIE_URLS: [&str; 3] = [HOME_URL, LOGIN_URL, API_COOKIE_URL];

/// 是否 AoE 域：去掉前导点、转小写后必须以 ageofempires.com 结尾
/// （带标签边界判断，避免 `notageofempires.com` 这种后缀巧合被误删）。
#[cfg(windows)]
fn is_aoe_cookie_domain(domain: &str) -> bool {
    let host = domain.trim_start_matches('.').to_ascii_lowercase();
    host == "ageofempires.com" || host.ends_with(".ageofempires.com")
}

/// 在 WebView2 线程上注册 GetCookies（每个 AoE URL 一次），命中 AoE 域的逐条 DeleteCookie。
/// 回调由 WebView2 派发在 UI 线程上，删除动作（DeleteCookie）是同步 COM，安全。
#[cfg(windows)]
fn delete_aoe_cookies_in_window(
    webview: tauri::webview::PlatformWebview,
    tx: std::sync::mpsc::Sender<Result<usize, String>>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use webview2_com::GetCookiesCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let controller = webview.controller();
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(e) => {
            let _ = tx.send(Err(format!("取 CoreWebView2 失败：{e}")));
            return;
        }
    };
    let core = match core.cast::<ICoreWebView2_2>() {
        Ok(core) => core,
        Err(e) => {
            let _ = tx.send(Err(format!("升级到 ICoreWebView2_2 失败：{e}")));
            return;
        }
    };
    let manager = match unsafe { core.CookieManager() } {
        Ok(manager) => manager,
        Err(e) => {
            let _ = tx.send(Err(format!("取 CookieManager 失败：{e}")));
            return;
        }
    };

    for url in AOE_COOKIE_URLS {
        let manager_in_handler = manager.clone();
        let tx_reply = tx.clone();
        // 只注册，立刻返回；结果由外层线程 recv_timeout 收
        let handler = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
            // 第一个参数已被 webview2-com 包装成 Result：Err 表示这次查询失败
            let outcome = match hr {
                Err(e) => Err(format!("GetCookies({url}) 失败：{e}")),
                Ok(()) => delete_aoe_cookies_from_list(&manager_in_handler, list, url),
            };
            let _ = tx_reply.send(outcome);
            Ok(())
        }));
        let uri = HSTRING::from(url);
        if let Err(e) = unsafe { manager.GetCookies(&uri, &handler) } {
            let _ = tx.send(Err(format!("GetCookies({url}) 调用失败：{e}")));
        }
    }
}

/// 遍历一次 GetCookies 的结果，只删 AoE 域，返回删除条数
#[cfg(windows)]
fn delete_aoe_cookies_from_list(
    manager: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieManager,
    list: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>,
    url: &str,
) -> Result<usize, String> {
    let Some(list) = list else {
        return Ok(0);
    };
    let mut total = 0u32;
    unsafe { list.Count(&mut total) }.map_err(|e| format!("读取 Cookie 列表长度失败：{e}"))?;

    let mut deleted = 0usize;
    let mut failed = 0usize;
    for index in 0..total {
        let cookie = match unsafe { list.GetValueAtIndex(index) } {
            Ok(cookie) => cookie,
            Err(e) => {
                log::warn!(target: "session-cookie", "读取第 {index} 条 Cookie 失败：{e}");
                continue;
            }
        };
        let mut raw_domain = windows_core::PWSTR::null();
        if unsafe { cookie.Domain(&mut raw_domain) }.is_err() {
            continue;
        }
        // CoTaskMemPWSTR 会在 Drop 时 CoTaskMemFree，避免每次查询都漏一块 CoTaskMem
        let domain = webview2_com::CoTaskMemPWSTR::from(raw_domain).to_string();
        if !is_aoe_cookie_domain(&domain) {
            continue;
        }
        match unsafe { manager.DeleteCookie(&cookie) } {
            Ok(()) => deleted += 1,
            Err(e) => {
                failed += 1;
                log::error!(
                    target: "session-cookie",
                    "删除 Cookie 失败（domain={domain}）：{e}"
                );
            }
        }
    }
    log::info!(
        target: "session-cookie",
        "GetCookies({url}) 命中 {total} 条，其中 AoE 域已删 {deleted} 条"
    );
    if failed > 0 {
        return Err(format!(
            "GetCookies({url}) 有 {failed} 条 AoE Cookie 删除失败（已删 {deleted} 条）"
        ));
    }
    Ok(deleted)
}

#[cfg(not(windows))]
fn delete_aoe_cookies_in_window(
    _webview: tauri::webview::PlatformWebview,
    tx: std::sync::mpsc::Sender<Result<usize, String>>,
) {
    // 非 Windows 平台没有 WebView2：立刻回 0，避免外层白等 5s
    for _ in AOE_COOKIE_URLS {
        let _ = tx.send(Ok(0));
    }
}


/// 当前 WebView 停在哪一步（只取主机名，小写）。
/// 读不到就返回空串：读失败**不**当作 SSO，继续按 Cookie 判定（不改变原有行为）。
fn current_host(window: &WebviewWindow) -> String {
    match window.url() {
        Ok(url) => url.host_str().unwrap_or("").to_ascii_lowercase(),
        Err(_) => String::new(),
    }
}

/// 是否正处在微软 SSO 跳转域名下。
/// 这些域名里 Cookie 还没落地（PHPSESSID / wordpress_logged_in 都拿不到），
/// 所以此时无论 Cookie 长什么样都**不能**判定失败，只能继续等。
fn is_sso_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    host == "login.microsoftonline.com"
        || host.ends_with(".microsoftonline.com")
        || host == "login.live.com"
        || host.ends_with(".live.com")
        || host == "account.live.com"
}

/// 是否已经跳回 AoE 站点（auth.ageofempires.com / www.ageofempires.com …）
fn is_aoe_host(host: &str) -> bool {
    host == "ageofempires.com" || host.ends_with(".ageofempires.com")
}

/// 401 之后的自动兜底：隐藏窗口跑一遍微软 / Steam SSO，等 Cookie **真的换新**才返回。
///
/// 与 [`current_cookie_header`] 的区别：那个只看“有没有”，这里看“有没有变”，
/// 否则拿着刚被 401 的旧 Cookie 直接返回，重试必然再 401。
/// **必须在非主线程调用**（内部会创建/复用 WebView2 窗口）。
pub fn ensure_session(app: &AppHandle) -> Result<String, String> {
    let before = match ensure_account_window(app, HOME_URL, false) {
        Ok(win) => collect_cookie_header(&win).unwrap_or_default(),
        Err(e) => {
            log::warn!(target: "account", "自动重登前读取旧 Cookie 失败：{e}");
            String::new()
        }
    };
    let before_sig = cookie_signature(&before);

    log::info!(
        target: "account",
        "自动重登：旧 Cookie 共 {} 条，开始隐藏窗口跑 SSO",
        before_sig.len()
    );
    let window = ensure_account_window(app, LOGIN_URL, false)?;
    if let Ok(parsed) = Url::parse(LOGIN_URL) {
        window
            .navigate(parsed)
            .map_err(|e| format!("自动重登导航失败：{e}"))?;
    }

    let started = Instant::now();
    let mut last_count = before_sig.len();
    // 降噪用的时间戳：SSO 跳转提示 / “集合变了但无凭证”提示，各自每 5 秒最多一条
    let mut last_sso_log: Option<Instant> = None;
    let mut last_wait_log: Option<Instant> = None;
    // 本轮是否真的进过微软 SSO（进过才允许“签名没变也算成功”，见 ④）
    let mut sso_seen = false;

    while started.elapsed() < SILENT_LOGIN_TIMEOUT {
        std::thread::sleep(SILENT_LOGIN_POLL);

        // ① 先看窗口停在哪一步：微软 SSO 跳转期间 Cookie 尚未落地，
        //    此时绝不能按“没有真凭证”提前结束（这正是 25s 超时的根因）
        let host = current_host(&window);
        if is_sso_host(&host) {
            sso_seen = true;
            // 这一轮完全不读 Cookie：省掉两次 COM 全量读取，也避免误判
            if last_sso_log.map(|t| t.elapsed().as_secs() >= SSO_LOG_SECS).unwrap_or(true) {
                last_sso_log = Some(Instant::now());
                log::info!(
                    target: "account",
                    "静默重登：微软SSO跳转中...（{host}，已等 {}s）",
                    started.elapsed().as_secs()
                );
            }
            continue;
        }

        // ② 已离开 SSO 域名：按 Cookie 判定
        let header = match collect_cookie_header(&window) {
            Ok(h) => h,
            Err(_) => continue,
        };
        if header.is_empty() {
            continue;
        }
        let sig = cookie_signature(&header);
        last_count = sig.len();

        // ③ 签名没变 = 还是旧会话（防死锁用）。
        //    例外：真的进过 SSO 且已经跳回 AoE 站点时，不再因签名未变而干等。
        if sig == before_sig && !(sso_seen && is_aoe_host(&host)) {
            continue;
        }

        // ④ 病灶C：集合变了还不够，必须真的出现登录凭证
        // （否则新增一条 .AspNetCore.Correlation.* 临时 Cookie 就会被误判为“重登成功”）
        if !has_real_credential(&header) {
            if last_wait_log.map(|t| t.elapsed().as_secs() >= SSO_LOG_SECS).unwrap_or(true) {
                last_wait_log = Some(Instant::now());
                log::info!(
                    target: "account",
                    "自动重登判定：Cookie集合已变但无真凭证，继续等（host={host}，已等 {}ms）",
                    started.elapsed().as_millis()
                );
            }
            continue;
        }

        // 诊断：这次“判定成功”靠的是哪些 Cookie（新增项），不参与判定
        {
            let added: Vec<String> = sig
                .iter()
                .filter(|pair| !before_sig.contains(*pair))
                .map(|pair| pair.split('=').next().unwrap_or("").to_string())
                .collect();
            log::info!(
                target: "account",
                "自动重登判定：新 Cookie 数量={} 新增了={}",
                sig.len(),
                if added.is_empty() { "(无)".to_string() } else { added.join(", ") }
            );
        }

        // 拿到新会话：开关开启才续命；关闭时只在本次进程内有效
        if remember_login_enabled(app) {
            match persist_auth_cookies(&window) {
                Ok(n) if n > 0 => log::info!(
                    target: "session-cookie",
                    "自动重登后已持久化 {n} 条会话 Cookie"
                ),
                Ok(_) => log::info!(target: "session-cookie", "自动重登成功，暂无可续命的会话 Cookie"),
                Err(e) => log::warn!(target: "session-cookie", "自动重登后持久化失败：{e}"),
            }
        } else {
            log_skip_persist_once();
        }
        log::info!(
            target: "account",
            "自动重登成功：Cookie {} 条 → {} 条（host={host}，SSO={}）",
            before_sig.len(),
            sig.len(),
            if sso_seen { "经过" } else { "未经过" }
        );
        clear_sync_cancel();
        log_all_cookies_once(&window);
        return Ok(header);
    }

    let stalled_at = current_host(&window);
    log::warn!(
        target: "account",
        "自动重登超时（{}s）：Cookie 仍为 {last_count} 条，当前页面={}，进过SSO={sso_seen}；隐藏窗口可能停在需要手动操作的页面",
        SILENT_LOGIN_TIMEOUT.as_secs(),
        if stalled_at.is_empty() { "<未知>".to_string() } else { stalled_at }
    );
    Err("自动重新登录未完成：请在设置里手动点一次登录".to_string())
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
