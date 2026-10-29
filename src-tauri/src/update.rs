//! 软件更新检测（GitHub Releases）。
//!
//! 设计要点：
//! - 走 Rust 而不是前端 fetch：ureq 复用 [`crate::net`] 解析出的链路（手动 > 系统注册表 > 环境变量 > 直连），
//!   WebView2 里的 fetch 只会跟系统代理，用户设的手动代理会失效。
//! - 匿名请求（不带 Cookie），GitHub 要求必须带 User-Agent，否则 403。
//! - 只读 latest release，不写任何本地文件；版本比较在本地完成。

use serde::Serialize;
use std::time::Duration;

/// 仓库首页（Release 地址兜底用）
pub const REPO_URL: &str = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const RELEASES_LATEST: &str = "https://api.github.com/repos/Einsteinband/AoE2-Mod-Manager/releases/latest";
/// JSON 里最多取多少个字符的更新说明（前端只做简短展示，避免撑破弹窗）
const NOTES_LIMIT: usize = 600;

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

fn translate_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(403, _) => "GitHub 接口暂时限流（403），请稍后再试".to_string(),
        ureq::Error::Status(404, _) => "仓库或 Release 不存在（404）".to_string(),
        ureq::Error::Status(code, _) => format!("GitHub 返回 HTTP {code}"),
        ureq::Error::Transport(t) => format!("网络请求失败：{t}"),
    }
}

/// 拉取最新 Release。`proxy` 由调用方按当前设置解析后传入。
pub fn fetch_latest(proxy: Option<ureq::Proxy>) -> Result<UpdateInfo, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(12))
        .user_agent(concat!(
            "AoE2ModManager/",
            env!("CARGO_PKG_VERSION"),
            " (Windows)"
        ));
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();

    let response = agent
        .get(RELEASES_LATEST)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(translate_error)?;

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

#[cfg(test)]
mod tests {
    use super::is_newer;

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
}
