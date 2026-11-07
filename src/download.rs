use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::online::ApiFailure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub mod_id: i64,
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub percent: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub zip_path: String,
    pub bytes: u64,
    pub work_dir: String,
}

fn emit(app: &AppHandle, payload: DownloadProgress) {
    // 事件失败不影响下载本身
    let _ = app.emit("online://download-progress", payload);
}

/// 把模组压缩包流式下载到系统临时目录。
/// - 支持取消（AtomicBool）
/// - 不打印 URL / Cookie（URL 可能是带签名的临时地址）
pub fn download_zip(
    app: &AppHandle,
    mod_id: i64,
    url: &str,
    cancel: &AtomicBool,
) -> Result<DownloadOutcome, ApiFailure> {
    let parsed = tauri::Url::parse(url).map_err(|e| ApiFailure::new("invalid", format!("下载地址无效：{e}"), None))?;
    if parsed.scheme() != "https" {
        return Err(ApiFailure::new("invalid", "下载地址不是 HTTPS，已拒绝", None));
    }
    let host = parsed.host_str().unwrap_or("unknown").to_string();

    let stamp = crate::scan::now_ms();
    let work_dir = std::env::temp_dir().join("aoe2mm").join(format!("{mod_id}-{stamp}"));
    fs::create_dir_all(&work_dir)
        .map_err(|e| ApiFailure::new("io", format!("无法创建临时目录：{e}"), None))?;
    let zip_path = work_dir.join("mod.zip");

    emit(app, DownloadProgress {
        mod_id, phase: "connecting".into(), received: 0, total: 0, percent: 0.0,
    });

    let mut agent_builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .user_agent("AoE2ModManager/0.1 (Windows)");
    // 下载走同一套代理策略（手动 > 系统注册表 > 环境变量 > 直连）
    let settings = crate::settings::load_for_app(app);
    match crate::net::resolve(&crate::net::NetConfig::from_settings(&settings)) {
        Ok(resolved) => match crate::net::ureq_proxy(&resolved) {
            Ok(Some(proxy)) => {
                agent_builder = agent_builder.proxy(proxy);
            }
            Ok(None) => {}
            Err(e) => log::warn!(target: "http", "下载代理不可用（{e}），本次下载直连"),
        },
        Err(e) => log::warn!(target: "http", "网络配置解析失败（{e}），本次下载直连"),
    }
    let agent = agent_builder.build();

    let response = agent
        .get(url)
        .set("Accept", "application/zip, application/octet-stream, */*")
        .call()
        .map_err(|e| {
            let _ = fs::remove_dir_all(&work_dir);
            match e {
                ureq::Error::Status(code, _) => ApiFailure::new(
                    if code == 401 || code == 403 { "unauthenticated" } else { "http" },
                    format!("下载地址返回 HTTP {code}（链接可能已过期，请重试）"),
                    Some(code),
                ),
                ureq::Error::Transport(t) => ApiFailure::network(t.to_string()),
            }
        })?;

    let total: u64 = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let content_type = response.header("Content-Type").unwrap_or("").to_string();

    let mut reader = response.into_reader();
    let file = fs::File::create(&zip_path)
        .map_err(|e| ApiFailure::new("io", format!("无法写入临时文件：{e}"), None));
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_dir_all(&work_dir);
            return Err(e);
        }
    };

    let mut received: u64 = 0;
    let mut buf = vec![0u8; 128 * 1024];
    let mut last_emit = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&work_dir);
            return Err(ApiFailure::new("cancelled", "下载已取消", None));
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                received += n as u64;
                if let Err(e) = file.write_all(&buf[..n]) {
                    let _ = fs::remove_dir_all(&work_dir);
                    return Err(ApiFailure::new("io", format!("写入失败（磁盘可能已满）：{e}"), None));
                }
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    last_emit = Instant::now();
                    let percent = if total > 0 { (received as f64 / total as f64) * 100.0 } else { 0.0 };
                    emit(app, DownloadProgress {
                        mod_id, phase: "downloading".into(), received, total, percent,
                    });
                }
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&work_dir);
                return Err(ApiFailure::network(format!("下载中断：{e}")));
            }
        }
    }
    let _ = file.flush();
    drop(file);

    if received == 0 {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(ApiFailure::new("invalid", "下载内容为空", None));
    }
    // 服务器返回 HTML（例如登录页/错误页）时，zip 校验会给出明确错误，这里先提示得更直白
    if content_type.contains("text/html") {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(ApiFailure::new(
            "invalid",
            "下载地址返回的是网页而不是压缩包，登录可能已失效或链接已过期",
            None,
        ));
    }
    let _ = host;

    emit(app, DownloadProgress {
        mod_id, phase: "downloaded".into(), received, total: if total > 0 { total } else { received }, percent: 100.0,
    });

    Ok(DownloadOutcome {
        zip_path: zip_path.to_string_lossy().to_string(),
        bytes: received,
        work_dir: work_dir.to_string_lossy().to_string(),
    })
}

/// 把整个工作目录清掉（下载完成或失败后调用）
pub fn cleanup(work_dir: &str) {
    let _ = fs::remove_dir_all(PathBuf::from(work_dir));
}
