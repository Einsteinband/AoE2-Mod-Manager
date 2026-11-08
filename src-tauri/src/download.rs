use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::online::ApiFailure;
use crate::user_err;

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
    let parsed = tauri::Url::parse(url).map_err(|e| ApiFailure::new("invalid", user_err("download.invalidUrl", json!({ "error": e.to_string() })), None))?;
    if parsed.scheme() != "https" {
        return Err(ApiFailure::new("invalid", user_err("download.notHttps", json!({})), None));
    }
    let host = parsed.host_str().unwrap_or("unknown").to_string();

    let stamp = crate::scan::now_ms();
    let work_dir = std::env::temp_dir().join("aoe2mm").join(format!("{mod_id}-{stamp}"));
    fs::create_dir_all(&work_dir)
        .map_err(|e| ApiFailure::new("io", user_err("download.createWorkDirFailed", json!({ "error": e.to_string() })), None))?;
    let zip_path = work_dir.join("mod.zip");

    emit(app, DownloadProgress {
        mod_id, phase: "connecting".into(), received: 0, total: 0, percent: 0.0,
    });

    // timeout_read 是 socket 级「两次数据之间」的空闲超时：断网后最多等 60s 即报错。
    // 整体超时由下面下载循环里的 `started` 兜底（见 R2），避免 ureq 在半开连接下
    // read timeout 未如期触发时任务永久挂起。
    let mut agent_builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .user_agent("AoE2ModManager/0.1 (Windows)");
    // 只记 host，不记完整 URL：CDN 地址可能带签名，按函数文档约定不落盘完整链接
    log::info!(target: "downloader", "开始下载 modId={mod_id} host={host}");

    // 下载走同一套代理策略（手动 > 系统注册表 > 环境变量 > 直连）
    let settings = crate::settings::load_for_app(app);
    match crate::net::resolve(&crate::net::NetConfig::from_settings(&settings)) {
        Ok(resolved) => {
            // 关键诊断行：把「这次到底走哪条链路」固定写进日志。
            // 旧版只有 resolve 的 http 行，下载一失败日志里一片空白，
            // 分不清是「直连被墙」还是「代理节点不可用」。
            log::info!(
                target: "downloader",
                "下载代理就绪：source={} url={}",
                resolved.source,
                resolved.proxy_url.as_deref().unwrap_or("直连")
            );
            if let Some(note) = resolved.note.as_deref() {
                log::info!(target: "downloader", "代理探测备注：{note}");
            }
            match crate::net::ureq_proxy(&resolved) {
                Ok(Some(proxy)) => {
                    agent_builder = agent_builder.proxy(proxy);
                }
                Ok(None) => {}
                Err(e) => log::warn!(target: "http", "下载代理不可用（{e}），本次下载直连"),
            }
        }
        Err(e) => log::warn!(target: "http", "网络配置解析失败（{e}），本次下载直连"),
    }
    let agent = agent_builder.build();

    // 传输层 / TLS 失败在代理链路上是**间歇性**的：实测同一节点对 cdn.ageofempires.com
    // 约一半连接被 `tls connection init failed` 掐断，而同时刻 API 全 200。
    // 因此只对 `Transport` 重试一次（HTTP 4xx/5xx 重试无意义；无限重试会变成死循环）。
    // 重试前先看取消标志，用户点取消立刻退出；整体仍受下面的 900s 兜底约束。
    const MAX_CALL_ATTEMPTS: u8 = 2;
    const RETRY_DELAY: Duration = Duration::from_secs(2);
    let mut attempt: u8 = 0;
    let response = loop {
        attempt += 1;
        let result = agent
            .get(url)
            .set("Accept", "application/zip, application/octet-stream, */*")
            .call();
        match result {
            Ok(resp) => break resp,
            Err(ureq::Error::Transport(t)) if attempt < MAX_CALL_ATTEMPTS => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = fs::remove_dir_all(&work_dir);
                    return Err(ApiFailure::new("cancelled", user_err("download.cancelled", json!({})), None));
                }
                log::warn!(
                    target: "downloader",
                    "下载第 {attempt} 次尝试失败 modId={mod_id}（host={host}）：传输层错误：{t}；{}s 后自动重试",
                    RETRY_DELAY.as_secs()
                );
                std::thread::sleep(RETRY_DELAY);
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&work_dir);
                let failure = match e {
                    ureq::Error::Status(code, _) => {
                        log::error!(
                            target: "downloader",
                            "下载失败 modId={mod_id}：HTTP {code}（host={host}）"
                        );
                        ApiFailure::new(
                            if code == 401 || code == 403 { "unauthenticated" } else { "http" },
                            user_err("download.httpError", json!({ "code": code })),
                            Some(code),
                        )
                    }
                    ureq::Error::Transport(t) => {
                        // 传输层失败：把这行打出来，「TLS 被掐」和「DNS 失败」才有区分度
                        log::error!(
                            target: "downloader",
                            "下载失败 modId={mod_id}：传输层错误（host={host}，共尝试 {attempt} 次）：{t}"
                        );
                        ApiFailure::new(
                            "network",
                            user_err("download.transport", json!({ "error": t.to_string() })),
                            None,
                        )
                    }
                };
                return Err(failure);
            }
        }
    };

    let total: u64 = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let content_type = response.header("Content-Type").unwrap_or("").to_string();
    log::info!(
        target: "downloader",
        "下载响应 modId={mod_id} HTTP 200 total={total} type={content_type}"
    );

    let mut reader = response.into_reader();
    let file = fs::File::create(&zip_path)
        .map_err(|e| ApiFailure::new("io", user_err("download.openFileFailed", json!({ "error": e.to_string() })), None));
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
    // R2：整体超时兜底。ureq 的 timeout_read 只保证「两次数据之间」不超过 60s，
    // 若对端以极慢速度持续发字节（或在 Windows/rustls 下半开连接 read timeout 未触发），
    // 空闲超时不会报警。这里再压一个 15 分钟总上限，保证 spawn_blocking 线程必然返回。
    let started = Instant::now();
    const MAX_DOWNLOAD: Duration = Duration::from_secs(900);
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&work_dir);
            return Err(ApiFailure::new("cancelled", user_err("download.cancelled", json!({})), None));
        }
        if started.elapsed() >= MAX_DOWNLOAD {
            let _ = fs::remove_dir_all(&work_dir);
            log::error!(
                target: "downloader",
                "下载超时中止 modId={mod_id} 已收 {received}/{total} 字节（上限 {} 分钟）",
                MAX_DOWNLOAD.as_secs() / 60
            );
            return Err(ApiFailure::new(
                "network",
                user_err("download.timeout", json!({ "minutes": MAX_DOWNLOAD.as_secs() / 60 })),
                None,
            ));
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                received += n as u64;
                if let Err(e) = file.write_all(&buf[..n]) {
                    let _ = fs::remove_dir_all(&work_dir);
                    return Err(ApiFailure::new("io", user_err("download.writeFailed", json!({ "error": e.to_string() })), None));
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
                log::error!(
                    target: "downloader",
                    "下载中断 modId={mod_id} 已收 {received}/{total} 字节：{e}"
                );
                return Err(ApiFailure::new(
                    "network",
                    user_err("download.interrupted", json!({ "error": e.to_string() })),
                    None,
                ));
            }
        }
    }
    let _ = file.flush();
    drop(file);
    log::info!(target: "downloader", "下载完成 modId={mod_id} 共 {received} 字节");

    if received == 0 {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(ApiFailure::new("invalid", user_err("download.emptyContent", json!({})), None));
    }
    // 服务器返回 HTML（例如登录页/错误页）时，zip 校验会给出明确错误，这里先提示得更直白
    if content_type.contains("text/html") {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(ApiFailure::new(
            "invalid",
            user_err("download.notArchive", json!({})),
            None,
        ));
    }

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
