//! 网络代理解析：默认零配置跟随 Windows 系统代理，手动代理只作为高级选项。
//!
//! 关键事实（实现时验证过，勿凭感觉改）：
//! - ureq 2.x **不会**读 Windows 注册表里的系统代理；只有可选的 `proxy-from-env`
//!   feature 会读环境变量（本 crate 已开启，作为最后兜底）。
//! - WebView2（Chromium）**默认就会读 WinINET 系统代理**，只要不传 `--proxy-server`
//!   就等于"跟随系统"。一旦调用 `additional_browser_args`，wry 的默认参数会被整体
//!   覆盖，所以必须自己带上 [`WRY_DEFAULT_ARGS`]。
//! - TUN 模式加速器（UU / 雷神 / Clash TUN）在系统代理关闭时也能通，此时
//!   `ProxyEnable=0`，我们按直连处理即可。

use serde::Serialize;

use crate::models::Settings;

/// `settings.proxy_mode` 的取值
pub const MODE_SYSTEM: &str = "system";
pub const MODE_MANUAL: &str = "manual";

/// wry 在 Windows 上的默认浏览器参数（见 wry-0.57.1/src/webview2/mod.rs:308-311）。
/// 只要我们自己设置 `additional_browser_args`，就必须原样带上它。
pub const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 注册表位置：Windows 系统代理（WinINET）
#[cfg(windows)]
const IE_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Clone, Debug)]
pub struct NetConfig {
    pub mode: String,
    pub manual_url: Option<String>,
}

impl NetConfig {
    pub fn from_settings(settings: &Settings) -> Self {
        Self { mode: settings.proxy_mode.clone(), manual_url: settings.proxy_url.clone() }
    }
}

/// 解析结果：既用于日志，也直接给前端展示"当前实际走哪条链路"
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResolution {
    /// system | manual
    pub mode: String,
    /// manual | system | env | direct
    pub source: String,
    /// 最终使用的代理地址；直连时为 None
    pub proxy_url: Option<String>,
    /// 给用户看的补充说明（例如检测到 PAC 但无法应用、环境变量代理对登录窗口无效）
    pub note: Option<String>,
}

impl NetResolution {
    fn new(mode: &str, source: &str, proxy_url: Option<String>, note: Option<String>) -> Self {
        Self { mode: mode.to_string(), source: source.to_string(), proxy_url, note }
    }

    /// 解析失败时的兜底：直连，并把原因带给日志/UI
    pub fn direct(note: Option<String>) -> Self {
        Self::new(MODE_SYSTEM, "direct", None, note)
    }
}

/// 校验并规范化手动填写的代理地址。
/// 只接受 `http://host:port`；SOCKS 明确报错（ureq 需要额外依赖，当前不提供）。
pub fn normalize_manual(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("代理地址不能为空".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("socks") {
        return Err(
            "暂不支持 SOCKS 代理，请改填 HTTP 代理地址，例如 http://127.0.0.1:7897".to_string(),
        );
    }

    let (scheme, rest) = match trimmed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r.to_string()),
        None => ("http".to_string(), trimmed.to_string()),
    };
    if scheme != "http" {
        return Err(format!(
            "仅支持 HTTP 代理（http://），当前填写的是 {scheme}://"
        ));
    }
    let rest = rest.trim_end_matches('/').trim();
    if rest.is_empty() {
        return Err("代理地址缺少主机名，例如 http://127.0.0.1:7897".to_string());
    }
    if rest.contains('@') {
        return Err(
            "代理地址不支持用户名/密码，请使用允许本机匿名访问的端口（例如 Clash 的混合端口）"
                .to_string(),
        );
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some(parts) => parts,
        None => {
            return Err("代理地址缺少端口，例如 http://127.0.0.1:7897".to_string());
        }
    };
    if host.trim().is_empty() {
        return Err("代理地址缺少主机名，例如 http://127.0.0.1:7897".to_string());
    }
    let port_num: u16 = port
        .trim()
        .parse()
        .map_err(|_| format!("代理端口无效：{port}（应为 1-65535 的数字）"))?;
    if port_num == 0 {
        return Err("代理端口不能为 0".to_string());
    }
    Ok(format!("http://{}:{port_num}", host.trim()))
}

fn ensure_http_scheme(value: &str) -> String {
    let value = value.trim().trim_end_matches('/');
    if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

/// 解析注册表 `ProxyServer` 的值：
/// 可能是裸的 `127.0.0.1:7897`，也可能是 `http=127.0.0.1:7897;https=127.0.0.1:7897`
fn pick_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if !raw.contains('=') {
        return Some(ensure_http_scheme(raw));
    }
    let mut preferred: Option<String> = None;
    let mut fallback: Option<String> = None;
    for part in raw.split(';') {
        let Some((key, value)) = part.split_once('=') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(ensure_http_scheme(value));
        }
        let key = key.trim();
        if key.eq_ignore_ascii_case("http") || key.eq_ignore_ascii_case("https") {
            preferred = Some(ensure_http_scheme(value));
        }
    }
    preferred.or(fallback)
}

#[cfg(windows)]
struct SystemProxyProbe {
    proxy_url: Option<String>,
    note: Option<String>,
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读取 HKCU 的 Internet Settings（只读，不碰系统配置）
#[cfg(windows)]
fn read_reg_u32(name: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };
    let sub = wide(IE_SETTINGS_KEY);
    let value_name = wide(name);
    let mut kind: u32 = 0;
    let mut data: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_DWORD,
            &mut kind,
            &mut data as *mut u32 as *mut std::ffi::c_void,
            &mut size,
        )
    };
    if rc == 0 {
        Some(data)
    } else {
        None
    }
}

#[cfg(windows)]
fn read_reg_string(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let sub = wide(IE_SETTINGS_KEY);
    let value_name = wide(name);
    let mut buf = vec![0u16; 2048];
    let mut kind: u32 = 0;
    let mut size: u32 = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            &mut kind,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1);
    let text = String::from_utf16_lossy(&buf[..chars.min(buf.len())]);
    let text = text.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(windows)]
fn probe_system_proxy() -> SystemProxyProbe {
    let enabled = read_reg_u32("ProxyEnable").unwrap_or(0) != 0;
    let server = read_reg_string("ProxyServer");
    let auto_config = read_reg_string("AutoConfigURL");

    if enabled {
        if let Some(proxy) = server.as_deref().and_then(pick_proxy_server) {
            return SystemProxyProbe { proxy_url: Some(proxy), note: None };
        }
    }

    let note = match (enabled, auto_config) {
        (_, Some(url)) => Some(format!(
            "系统代理使用自动配置脚本（PAC：{url}），本应用无法执行 PAC 脚本；如果你的加速器只设置了 PAC，请改用 TUN 模式或在高级设置里手动填写 HTTP 代理"
        )),
        (true, None) => Some("系统代理已开启，但 ProxyServer 为空，按直连处理".to_string()),
        _ => None,
    };
    SystemProxyProbe { proxy_url: None, note }
}

#[cfg(not(windows))]
fn probe_system_proxy() -> SystemProxyProbe {
    SystemProxyProbe {
        proxy_url: None,
        note: Some("非 Windows 平台不支持读取系统代理，请使用环境变量或手动代理".to_string()),
    }
}

fn env_proxy() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        let Ok(value) = std::env::var(key) else { continue };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        match normalize_manual(trimmed) {
            Ok(url) => {
                log::info!(target: "http", "使用环境变量代理：{key}={url}");
                return Some(url);
            }
            Err(e) => log::warn!(target: "http", "环境变量 {key} 无法作为 HTTP 代理使用：{e}"),
        }
    }
    None
}

/// 把设置解析成"最终使用哪个代理"。优先级：手动 > 系统注册表 > 环境变量 > 直连。
pub fn resolve(config: &NetConfig) -> Result<NetResolution, String> {
    if config.mode == MODE_MANUAL {
        let url = normalize_manual(config.manual_url.as_deref().unwrap_or(""))?;
        log::info!(target: "http", "使用手动代理：{url}");
        return Ok(NetResolution::new(MODE_MANUAL, "manual", Some(url), None));
    }

    let probe = probe_system_proxy();
    if let Some(url) = probe.proxy_url.clone() {
        log::info!(target: "http", "使用系统代理：{url}");
        return Ok(NetResolution::new(MODE_SYSTEM, "system", Some(url), probe.note));
    }

    if let Some(url) = env_proxy() {
        log::warn!(
            target: "http",
            "系统代理不可用，已退回到环境变量代理 {url}；注意：内置登录窗口不读环境变量，只有 HTTP 请求走这里"
        );
        return Ok(NetResolution::new(
            MODE_SYSTEM,
            "env",
            Some(url),
            Some(
                "当前使用的是环境变量代理：只有模组接口请求会走它，内置登录窗口仍跟随系统网络"
                    .to_string(),
            ),
        ));
    }

    log::info!(target: "http", "未检测到系统/环境变量代理，直连");
    Ok(NetResolution::new(MODE_SYSTEM, "direct", None, probe.note))
}

/// 生成 ureq 用的代理对象
pub fn ureq_proxy(resolved: &NetResolution) -> Result<Option<ureq::Proxy>, String> {
    match resolved.proxy_url.as_deref() {
        Some(url) => ureq::Proxy::new(url).map(Some).map_err(|e| {
            format!("代理地址 {url} 无法被 HTTP 客户端使用：{e}")
        }),
        None => Ok(None),
    }
}

/// 生成 WebView2 的 `additional_browser_args`。
///
/// 只有手动代理才需要传参：系统/环境代理模式下留空，让 WebView2 自己跟随系统设置
/// （这也是"零配置自适应"成立的原因）。
pub fn webview_args(resolved: &NetResolution) -> Option<String> {
    if resolved.source != "manual" {
        return None;
    }
    let url = resolved.proxy_url.as_deref()?;
    Some(format!("{WRY_DEFAULT_ARGS} --proxy-server={url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_proxy_accepts_bare_host_port() {
        assert_eq!(normalize_manual("127.0.0.1:7897").unwrap(), "http://127.0.0.1:7897");
        assert_eq!(
            normalize_manual("  http://127.0.0.1:7897/ ").unwrap(),
            "http://127.0.0.1:7897"
        );
    }

    #[test]
    fn manual_proxy_rejects_socks_with_clear_message() {
        let err = normalize_manual("socks5://127.0.0.1:7890").unwrap_err();
        assert!(err.contains("暂不支持 SOCKS"), "实际提示：{err}");
        assert!(err.contains("http://127.0.0.1:7897"));
    }

    #[test]
    fn manual_proxy_rejects_bad_input() {
        assert!(normalize_manual("").is_err());
        assert!(normalize_manual("https://127.0.0.1:7897").is_err());
        assert!(normalize_manual("http://127.0.0.1").is_err());
        assert!(normalize_manual("http://127.0.0.1:99999").is_err());
        assert!(normalize_manual("http://user:pass@127.0.0.1:7897").is_err());
    }

    #[test]
    fn proxy_server_value_variants() {
        assert_eq!(
            pick_proxy_server("http=127.0.0.1:7897;https=127.0.0.1:7897").unwrap(),
            "http://127.0.0.1:7897"
        );
        assert_eq!(pick_proxy_server("127.0.0.1:7897").unwrap(), "http://127.0.0.1:7897");
        assert_eq!(pick_proxy_server("  ").is_none(), true);
        assert_eq!(
            pick_proxy_server("ftp=1.2.3.4:21;http=5.6.7.8:8080").unwrap(),
            "http://5.6.7.8:8080"
        );
    }

    #[test]
    fn webview_args_only_for_manual_proxy() {
        let system = NetResolution::new(MODE_SYSTEM, "system", Some("http://127.0.0.1:7897".into()), None);
        assert!(webview_args(&system).is_none(), "系统代理不应传参，交给 WebView2 自己读");

        let manual = NetResolution::new(MODE_MANUAL, "manual", Some("http://127.0.0.1:7897".into()), None);
        let args = webview_args(&manual).unwrap();
        assert!(args.contains("--proxy-server=http://127.0.0.1:7897"));
        assert!(args.contains("msWebOOUI"), "必须保留 wry 默认参数：{args}");
    }
}
