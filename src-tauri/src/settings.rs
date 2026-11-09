use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::json;
use tauri::Manager;

use crate::models::{RootCandidate, Settings};
use crate::net;
use crate::user_err;

/// 配置目录下的 settings.json（首次启动引导、网络设置等共用同一个路径）
pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|e| user_err("settings.configDirNotFound", json!({ "error": e.to_string() })))
}

/// DPAPI 加密的会话 Cookie 缓存文件（不属于 settings 明文）
///
/// v1.x：跟随「数据与缓存总目录」。DPAPI blob 里不含路径信息、密钥由当前用户 SID 派生，
/// 所以换目录后同一台机器同一账户仍然能解密，不需要重新加密。
pub fn session_cache_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_root(app).map(|dir| dir.join("session.bin"))
}

pub fn load_for_app(app: &tauri::AppHandle) -> Settings {
    match path_for(app) {
        Ok(path) => load(&path),
        Err(e) => {
            log::warn!(target: "settings", "{e}");
            Settings::default()
        }
    }
}

pub fn save_for_app(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path_for(app)?;
    save(&path, settings)
}

/// 读取后做一次轻量修正：旧文件缺字段时用默认值；手动代理写坏了就退回"跟随系统"，
/// 避免用户因为一个非法地址连在线页都进不去。
fn normalize(mut settings: Settings) -> Settings {
    if settings.proxy_mode != net::MODE_MANUAL {
        settings.proxy_mode = net::MODE_SYSTEM.to_string();
        return settings;
    }
    match net::normalize_manual(settings.proxy_url.as_deref().unwrap_or("")) {
        Ok(url) => settings.proxy_url = Some(url),
        Err(e) => {
            log::warn!(
                target: "settings",
                "已保存的手动代理不可用（{e}），已退回“自动跟随系统网络”"
            );
            settings.proxy_mode = net::MODE_SYSTEM.to_string();
            settings.proxy_url = None;
        }
    }
    settings
}

pub fn load(path: &Path) -> Settings {
    match fs::read(path) {
        Ok(bytes) => {
            // 容忍 UTF-8 BOM（外部工具手写的配置文件常带 BOM）
            let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
            normalize(serde_json::from_slice::<Settings>(stripped).unwrap_or_default())
        }
        Err(_) => Settings::default(),
    }
}

/// 写入串行锁：同一进程内不会有两个线程同时动 tmp / target。
static SETTINGS_IO_LOCK: Mutex<()> = Mutex::new(());
/// 临时文件名序号：避免并发写撞名。
static SETTINGS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 覆盖式写入 settings.json：写临时文件 → fsync → rename 原子替换。
///
/// 失败保护：
/// - 临时文件写入/fsync 失败：删除 tmp，原 settings.json 不动。
/// - rename 失败（目标被占用/权限不足）：删除 tmp，原 settings.json 不动。
/// - 不做 copy 兜底：copy 是覆盖写，中途失败会截断旧配置，不如保留原文件让用户重试。
/// - 临时文件与正式文件同目录，rename 不会跨卷。
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| user_err("settings.createDirFailed", json!({ "path": parent.display().to_string(), "error": e.to_string() })))?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| user_err("settings.serializeFailed", json!({ "error": e.to_string() })))?;

    let _io = SETTINGS_IO_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let seq = SETTINGS_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".to_string());
    let tmp = path.with_file_name(format!("{file_name}.{}-{seq}.tmp", std::process::id()));

    let mut file = fs::File::create(&tmp).map_err(|e| {
        user_err("settings.writeTmpFailed", json!({ "path": tmp.display().to_string(), "error": e.to_string() }))
    })?;
    if let Err(e) = file.write_all(text.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(&tmp);
        return Err(user_err("settings.writeTmpFailed", json!({ "path": tmp.display().to_string(), "error": e.to_string() })));
    }
    if let Err(e) = file.sync_all() {
        drop(file);
        let _ = fs::remove_file(&tmp);
        return Err(user_err("settings.syncTmpFailed", json!({ "path": tmp.display().to_string(), "error": e.to_string() })));
    }
    drop(file);

    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(user_err("settings.renameFailed", json!({
            "path": path.display().to_string(),
            "error": e.to_string(),
        })));
    }
    Ok(())
}

// ---------------- 首次启动：自动探测游戏模组根目录 ----------------

/// AoE2 DE 的 Steam AppID（Steam 卸载注册表项名就是 `Steam App <id>`）
const AOE2_STEAM_APP_ID: &str = "813780";

/// 判断目录是不是模组根目录：有 local/subscribed 子目录，或者本身就是游戏安装目录
fn looks_like_mod_root(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    dir.join("local").is_dir() || dir.join("subscribed").is_dir() || looks_like_game(dir)
}

/// 游戏安装目录特征：主程序（含 _s 的启动器变体都算）
pub fn looks_like_game(dir: &Path) -> bool {
    dir.join("AoE2DE_s.exe").is_file() || dir.join("AoE2DE.exe").is_file()
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 只读注册表字符串值；任何失败都返回 None（不 panic、不弹窗）
#[cfg(windows)]
fn read_reg_string(
    hive: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
    value_name: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

    let sub = wide(subkey);
    let name = wide(value_name);
    let mut buf = vec![0u16; 2048];
    let mut kind: u32 = 0;
    let mut size: u32 = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            hive,
            sub.as_ptr(),
            name.as_ptr(),
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
    let text = text.trim().trim_end_matches('\\').to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Steam 安装根目录：注册表（HKCU SteamPath / HKLM InstallPath）优先，其次标准安装路径
#[cfg(windows)]
fn steam_install_roots() -> Vec<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let probes: [(windows_sys::Win32::System::Registry::HKEY, &str, &str); 3] = [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
    ];

    let mut out: Vec<PathBuf> = Vec::new();
    for (hive, key, value) in probes {
        let Some(found) = read_reg_string(hive, key, value) else { continue };
        // 注册表里 Steam 常把路径写成正斜杠
        let path = PathBuf::from(found.replace('/', "\\"));
        if !out.iter().any(|existing| same_path(existing, &path)) {
            out.push(path);
        }
    }

    for env in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(dir) = std::env::var(env) {
            let path = PathBuf::from(dir).join("Steam");
            if path.is_dir() && !out.iter().any(|existing| same_path(existing, &path)) {
                out.push(path);
            }
        }
    }
    out
}

/// 从 libraryfolders.vdf 文本里取出所有库根目录：只做引号文本提取，不依赖完整 VDF 解析
/// （新版格式是 `"path" "D:\\SteamLibrary"`，老版是 `"1" "D:\\SteamLibrary"`，两种都覆盖）
fn library_roots_from_vdf(text: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for line in text.lines() {
        let mut quoted: Vec<&str> = Vec::new();
        let mut rest = line;
        while let Some(start) = rest.find('"') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('"') else { break };
            quoted.push(&after[..end]);
            rest = &after[end + 1..];
        }
        if quoted.len() < 2 {
            continue;
        }
        let value = quoted[1].replace("\\\\", "\\");
        let absolute = value.chars().nth(1) == Some(':') || value.starts_with(r"\\");
        if absolute {
            out.push(PathBuf::from(value));
        }
    }
    out
}

/// 所有 Steam 库根目录（从各 libraryfolders.vdf 汇总）
fn steam_library_roots() -> Vec<PathBuf> {
    let mut vdfs: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    for steam in steam_install_roots() {
        vdfs.push(steam.join("steamapps").join("libraryfolders.vdf"));
        // 旧版 Steam 把库列表放在 config 下
        vdfs.push(steam.join("config").join("libraryfolders.vdf"));
    }

    if let Ok(dir) = std::env::var("STEAM_PATH") {
        vdfs.push(PathBuf::from(dir).join("steamapps").join("libraryfolders.vdf"));
    }
    for env in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(dir) = std::env::var(env) {
            vdfs.push(
                PathBuf::from(dir)
                    .join("Steam")
                    .join("steamapps")
                    .join("libraryfolders.vdf"),
            );
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for vdf in vdfs {
        let Ok(text) = fs::read_to_string(&vdf) else { continue };
        for lib in library_roots_from_vdf(&text) {
            if !roots.iter().any(|existing| same_path(existing, &lib)) {
                roots.push(lib);
            }
        }
    }
    roots
}

/// v3.2：「启动游戏」自动探测——只找主程序文件，不做递归扫描。
///
/// 顺序：Steam 库（libraryfolders.vdf）→ 卸载注册表 InstallLocation →
/// 注册表 SteamPath 拼接 → 各盘符常见安装路径。
/// 全部只做 `is_file()` 存在性检查，命中即返回。
pub fn detect_game_exe() -> Option<PathBuf> {
    // 1) 所有 Steam 库：<lib>\steamapps\common\AoE2DE
    for lib in steam_library_roots() {
        if let Some(exe) = game_exe_in(&lib.join("steamapps").join("common").join("AoE2DE")) {
            return Some(exe);
        }
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

        // 2) Steam 卸载注册表项里的 InstallLocation 最准
        let key64 = format!(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {AOE2_STEAM_APP_ID}"
        );
        let key32 = format!(
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {AOE2_STEAM_APP_ID}"
        );
        let probes: [(windows_sys::Win32::System::Registry::HKEY, &str); 3] =
            [(HKEY_LOCAL_MACHINE, &key64), (HKEY_LOCAL_MACHINE, &key32), (HKEY_CURRENT_USER, &key64)];
        for (hive, key) in probes {
            if let Some(dir) = read_reg_string(hive, key, "InstallLocation") {
                if let Some(exe) = game_exe_in(&PathBuf::from(dir.replace('/', "\\"))) {
                    return Some(exe);
                }
            }
        }

        // 3) 注册表里的 Steam 根目录 → steamapps\common\AoE2DE
        for steam in steam_install_roots() {
            if let Some(exe) = game_exe_in(&steam.join("steamapps").join("common").join("AoE2DE")) {
                return Some(exe);
            }
        }
    }

    // 4) 各盘符常见路径兜底（只做存在性检查，不递归）
    for letter in b'C'..=b'Z' {
        let drive = PathBuf::from(format!("{}:\\", letter as char));
        if !drive.is_dir() {
            continue;
        }
        for sub in [
            r"SteamLibrary\steamapps\common\AoE2DE",
            r"Steam\steamapps\common\AoE2DE",
            r"Program Files (x86)\Steam\steamapps\common\AoE2DE",
            r"Program Files\Steam\steamapps\common\AoE2DE",
            r"Games\AoE2DE",
            r"Games\Age of Empires II- Definitive Edition",
            r"XboxGames\Age of Empires II- Definitive Edition\Content",
        ] {
            if let Some(exe) = game_exe_in(&drive.join(sub)) {
                return Some(exe);
            }
        }
    }
    None
}

/// 从主程序路径推导「游戏根目录」（就是 exe 所在的那一层）。
pub fn game_root_of_exe(exe: &Path) -> PathBuf {
    exe.parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| exe.to_path_buf())
}

/// 校验游戏根目录：必须是绝对路径、目录存在、且含 `AoE2DE_s.exe`
/// （兼容老版本的 `AoE2DE.exe`）。
///
/// 校验通过返回去掉尾部反斜杠的目录，便于直接写进 settings.json；
/// 失败返回可直接展示给用户的中文原因（前端原样放进设置页的错误行）。
pub fn validate_game_root(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return Err(user_err("settings.gameRootEmpty", json!({})));
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_absolute() {
        return Err(user_err("settings.gameRootNotAbsolute", json!({ "path": trimmed })));
    }
    if !dir.is_dir() {
        return Err(user_err("settings.gameRootNotDir", json!({ "path": trimmed })));
    }
    if game_exe_in(&dir).is_none() {
        return Err(user_err("settings.gameRootNoExe", json!({ "path": trimmed })));
    }
    Ok(dir)
}

/// 目录里的游戏主程序：优先 `AoE2DE_s.exe`，其次 `AoE2DE.exe`（老版本没有 _s）
fn game_exe_in(dir: &Path) -> Option<PathBuf> {
    for name in ["AoE2DE_s.exe", "AoE2DE.exe"] {
        let exe = dir.join(name);
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

fn push_candidate(out: &mut Vec<RootCandidate>, path: PathBuf, source: &str) {
    if !looks_like_mod_root(&path) {
        return;
    }
    let text = path.to_string_lossy().trim_end_matches('\\').to_string();
    if out.iter().any(|existing| existing.path.eq_ignore_ascii_case(&text)) {
        return;
    }
    out.push(RootCandidate {
        has_local: path.join("local").is_dir(),
        has_subscribed: path.join("subscribed").is_dir(),
        looks_like_game: looks_like_game(&path),
        path: text,
        source: source.to_string(),
    });
}

/// 探测本机所有可能的模组根目录：环境变量 → 注册表 → Steam 库 → 用户目录 → 全盘常见路径。
/// 全部只做只读存在性检查，命中顺序即“推荐顺序”。
pub fn detect_candidates() -> Vec<RootCandidate> {
    let mut out: Vec<RootCandidate> = Vec::new();

    // 0) 显式覆盖（便携版 / 高级用户用）
    if let Ok(explicit) = std::env::var("AOE2_MOD_ROOT") {
        if !explicit.trim().is_empty() {
            push_candidate(&mut out, PathBuf::from(explicit), "env");
        }
    }

    // 1) Steam 卸载注册表里的 InstallLocation 最准
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let key64 = format!(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {AOE2_STEAM_APP_ID}"
        );
        let key32 = format!(
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {AOE2_STEAM_APP_ID}"
        );
        let probes: [(windows_sys::Win32::System::Registry::HKEY, &str); 3] =
            [(HKEY_LOCAL_MACHINE, &key64), (HKEY_LOCAL_MACHINE, &key32), (HKEY_CURRENT_USER, &key64)];
        for (hive, key) in probes {
            if let Some(dir) = read_reg_string(hive, key, "InstallLocation") {
                push_candidate(&mut out, PathBuf::from(dir.replace('/', "\\")), "registry");
            }
        }
    }

    // 2) 所有 Steam 库里的 steamapps\common\AoE2DE
    for lib in steam_library_roots() {
        push_candidate(
            &mut out,
            lib.join("steamapps").join("common").join("AoE2DE"),
            "steam_library",
        );
    }

    // 3) 微软商店 / Xbox 版与用户级安装位置
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        for (sub, label) in [
            (r"Games\AoE2DE", "user_dir"),
            (r"Games\Age of Empires II- Definitive Edition", "user_dir"),
            (r"Documents\My Games\AoE2DE", "documents"),
        ] {
            push_candidate(&mut out, home.join(sub), label);
        }
    }

    // 4) 全盘常见路径兜底（只做存在性检查，不递归、不遍历）
    for letter in b'C'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if !Path::new(&drive).is_dir() {
            continue;
        }
        let drive = PathBuf::from(drive);
        for sub in [
            r"Games\AoE2DE",
            r"SteamLibrary\steamapps\common\AoE2DE",
            r"Steam\steamapps\common\AoE2DE",
            r"Program Files (x86)\Steam\steamapps\common\AoE2DE",
            r"Program Files\Steam\steamapps\common\AoE2DE",
            r"XboxGames\Age of Empires II- Definitive Edition\Content",
        ] {
            push_candidate(&mut out, drive.join(sub), "drive_scan");
        }
    }

    out
}

/// 兼容旧接口：只要路径
pub fn detect_roots() -> Vec<String> {
    detect_candidates().into_iter().map(|c| c.path).collect()
}

/// 合法的模组根目录：含 local/subscribed，或本身是游戏安装目录（首次启动时 last 两个目录可能还没生成）
pub fn is_mod_root(dir: &Path) -> bool {
    looks_like_mod_root(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aoe2mm-settings-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_settings(data_dir: &str) -> Settings {
        let mut s = Settings::default();
        s.data_dir = Some(data_dir.to_string());
        s
    }

    #[test]
    fn save_creates_file_when_missing() {
        let dir = temp_dir("create");
        let path = dir.join("settings.json");
        save(&path, &sample_settings("D:/AoE2Data")).unwrap();
        assert!(path.is_file());
        let loaded = load(&path);
        assert_eq!(loaded.data_dir.as_deref(), Some("D:/AoE2Data"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_replaces_existing_content() {
        let dir = temp_dir("replace");
        let path = dir.join("settings.json");
        // 先写一份旧配置
        save(&path, &sample_settings("C:/OldPath")).unwrap();
        // 再写新配置
        save(&path, &sample_settings("D:/NewPath")).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.data_dir.as_deref(), Some("D:/NewPath"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_leaves_no_tmp_behind() {
        let dir = temp_dir("notmp");
        let path = dir.join("settings.json");
        save(&path, &sample_settings("D:/X")).unwrap();
        let tmp_count = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(tmp_count, 0, "save 成功后不应残留 .tmp 文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_preserves_original_when_parent_is_file() {
        // parent 路径是一个已存在的文件 → create_dir_all 失败 → 原文件不动
        let dir = temp_dir("parentfile");
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"not a dir").unwrap();
        let path = blocker.join("settings.json");
        let result = save(&path, &sample_settings("D:/Y"));
        assert!(result.is_err(), "parent 是文件时 save 应失败");
        // blocker 文件内容未被破坏
        assert_eq!(fs::read(&blocker).unwrap(), b"not a dir");
        let _ = fs::remove_dir_all(&dir);
    }
}
