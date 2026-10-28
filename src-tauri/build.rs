use std::path::{Path, PathBuf};
use std::process::Command;

/// 应用 manifest：comctl32 v6（tauri 对话框 / 任务对话框需要）+ Per-Monitor DPI + 长路径。
/// 在 Windows GNU 工具链下由 windres 编译成 COFF 对象，注入到 **所有** 链接目标（bin 与 test），
/// 这样 `cargo test` 产生的测试可执行文件也能正常加载（否则启动即 STATUS_ENTRYPOINT_NOT_FOUND）。
const APP_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <assemblyIdentity type="win32" name="com.aoe2.modmanager" version="0.1.0.0" processorArchitecture="*"/>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <asmv3:application>
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness>PerMonitorV2, PerMonitor</dpiAwareness>
      <longPathAware>true</longPathAware>
    </asmv3:windowsSettings>
  </asmv3:application>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#;

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "gnu" {
        match build_with_custom_manifest() {
            Ok(()) => {}
            Err(err) => {
                println!("cargo:warning=自定义 manifest 注入失败（{err}），回退到 tauri 默认设置");
                tauri_build::build();
            }
        }
    } else {
        tauri_build::build();
    }

    stage_webview2_loader();
}

fn build_with_custom_manifest() -> Result<(), String> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let manifest_path = out_dir.join("app.manifest");
    let rc_path = out_dir.join("app.rc");
    let obj_path = out_dir.join("app_manifest.o");

    std::fs::write(&manifest_path, APP_MANIFEST).map_err(|e| format!("写 manifest 失败：{e}"))?;
    // RT_MANIFEST = 24, 资源 ID 1；windres 在 Windows 上更接受正斜杠路径
    let rc_body = format!(
        "1 24 \"{}\"\n",
        manifest_path.to_string_lossy().replace('\\', "/")
    );
    std::fs::write(&rc_path, rc_body).map_err(|e| format!("写 rc 失败：{e}"))?;

    let windres = find_windres().ok_or_else(|| "PATH 中找不到 windres.exe".to_string())?;
    let status = Command::new(&windres)
        .arg("-I")
        .arg(&out_dir)
        .arg(&rc_path)
        .arg("-O")
        .arg("coff")
        .arg("-o")
        .arg(&obj_path)
        .status()
        .map_err(|e| format!("执行 windres 失败：{e}"))?;
    if !status.success() {
        return Err(format!("windres 退出码 {status}"));
    }

    // 我们自己提供 manifest，禁掉 tauri 的那一份，避免出现两个 manifest
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .map_err(|e| format!("tauri-build 失败：{e}"))?;

    println!("cargo:rustc-link-arg={}", obj_path.display());
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}

fn find_windres() -> Option<PathBuf> {
    for name in ["x86_64-w64-mingw32-windres.exe", "windres.exe"] {
        // PATH 查找：Command 直接执行即可，这里只做存在性确认
        if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(';') {
                if dir.is_empty() {
                    continue;
                }
                let candidate = Path::new(dir).join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Windows GNU 工具链下 `tauri` 链接的是 `WebView2Loader.dll`（动态导入），
/// 但 webview2-com-sys 只把该 DLL 放在 build/.../out/x64 里，exe 同目录没有它，
/// 运行时会去 PATH 里捡到旧版本并报 STATUS_ENTRYPOINT_NOT_FOUND。
/// 这里在编译期把它复制到 exe 所在目录（仅复制，不涉及游戏目录）。
fn stage_webview2_loader() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };

    let Some(profile_dir) = Path::new(&out_dir).ancestors().nth(3).map(|p| p.to_path_buf()) else {
        return;
    };

    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("x86") => "x86",
        Ok("aarch64") => "arm64",
        _ => return,
    };

    let build_dir = profile_dir.join("build");
    let Ok(entries) = std::fs::read_dir(&build_dir) else { return };

    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("webview2-com-sys-")
        {
            continue;
        }
        let candidate = entry
            .path()
            .join("out")
            .join(arch)
            .join("WebView2Loader.dll");
        if candidate.is_file() {
            for dest_dir in [profile_dir.clone(), profile_dir.join("deps")] {
                let dest = dest_dir.join("WebView2Loader.dll");
                if let Err(err) = std::fs::copy(&candidate, &dest) {
                    println!("cargo:warning=无法复制 WebView2Loader.dll 到 {}：{err}", dest.display());
                }
            }
            break;
        }
    }
}
