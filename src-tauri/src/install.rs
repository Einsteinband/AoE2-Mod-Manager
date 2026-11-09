use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;
use zip::ZipArchive;

use crate::user_err;

/// 旧版本曾在模组目录内写入 `.aoe2mm-mod.json` 作为安装标记。
/// 现在一律不写：元数据统一存到软件自己的 mod_metadata.json（与 settings.json 同目录），
/// 游戏目录保持零侵入；该常量仅用于兼容识别与清理旧标记。
pub const MARKER_FILE: &str = ".aoe2mm-mod.json";
const MAX_ENTRIES: usize = 100_000;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallMarker {
    pub mod_id: i64,
    pub title: String,
    pub installed_at_ms: i64,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub target_dir: String,
    pub file_count: u64,
    pub bytes: u64,
    pub backup_dir: Option<String>,
    pub updated: bool,
}

/// 把标题变成合法的文件夹名片段（游戏本身用 `{id}_{名称}` 的形式）
pub fn sanitize_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (ch as u32) < 0x20;
        if bad {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 校验压缩包内的相对路径：禁止绝对路径、盘符、`..`、以及 Windows 保留形态
pub fn safe_entry_path(name: &str) -> Result<PathBuf, String> {
    if name.contains('\0') {
        return Err(user_err("install.zipNulByte", json!({})));
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(user_err("install.zipAbsolute", json!({ "name": name })));
    }
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return Err(user_err("install.zipDriveLetter", json!({ "name": name })));
    }

    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(user_err("install.zipTraversal", json!({ "name": name })));
        }
        if part.contains(':') {
            return Err(user_err("install.zipIllegalChar", json!({ "name": name })));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(user_err("install.zipEmptyPath", json!({ "name": name })));
    }
    for comp in out.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(user_err("install.zipUnnormalized", json!({ "name": name }))),
        }
    }
    Ok(out)
}

/// 解压到指定目录，返回 (文件数, 总字节)
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(u64, u64), String> {
    let file = fs::File::open(zip_path).map_err(|e| user_err("install.zipOpenFailed", json!({ "error": e.to_string() })))?;
    let mut archive = ZipArchive::new(file).map_err(|e| user_err("install.zipCorrupt", json!({ "error": e.to_string() })))?;

    if archive.len() > MAX_ENTRIES {
        return Err(user_err("install.zipTooManyEntries", json!({ "count": archive.len() })));
    }

    fs::create_dir_all(dest).map_err(|e| user_err("install.extractDirCreateFailed", json!({ "error": e.to_string() })))?;

    let mut files = 0u64;
    let mut total = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| user_err("install.zipEntryReadFailed", json!({ "index": index, "error": e.to_string() })))?;

        if let Some(mode) = entry.unix_mode() {
            // 0o120000 = 符号链接，Windows 上不应出现，出现即视为恶意
            if mode & 0o170000 == 0o120000 {
                return Err(user_err("install.zipSymlink", json!({})));
            }
        }

        let raw_name = entry.name().to_string();
        if raw_name.ends_with('/') && entry.is_dir() {
            let rel = match safe_entry_path(&raw_name) {
                Ok(p) => p,
                Err(e) => return Err(e),
            };
            fs::create_dir_all(dest.join(rel)).map_err(|e| user_err("install.mkdirFailed", json!({ "error": e.to_string() })))?;
            continue;
        }
        if entry.is_dir() {
            continue;
        }

        let rel = safe_entry_path(&raw_name)?;
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| user_err("install.mkdirFailed", json!({ "error": e.to_string() })))?;
        }

        let mut out = fs::File::create(&out_path)
            .map_err(|e| user_err("install.fileWriteFailed", json!({ "path": out_path.display().to_string(), "error": e.to_string() })))?;
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|e| user_err("install.entryReadFailed", json!({ "name": raw_name, "error": e.to_string() })))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_TOTAL_BYTES {
                return Err(user_err("install.zipTooLarge", json!({})));
            }
            out.write_all(&buffer[..n])
                .map_err(|e| user_err("install.diskFull", json!({ "error": e.to_string() })))?;
        }
        files += 1;
    }

    if files == 0 {
        return Err(user_err("install.zipNoFiles", json!({})));
    }
    Ok((files, total))
}

/// 有些压缩包整包套了一层文件夹，这里识别真正的模组根目录：
/// 只有"恰好一个子目录且根目录没有散文件"时才下钻，避免丢掉散在根部的资源文件
pub fn detect_mod_root(extracted: &Path) -> PathBuf {
    if extracted.join("info.json").is_file() {
        return extracted.to_path_buf();
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut loose_files = 0usize;
    if let Ok(rd) = fs::read_dir(extracted) {
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !is_junk_dir(&name) {
                    dirs.push(path);
                }
            } else if !is_junk_file(&path) {
                loose_files += 1;
            }
        }
    }
    if dirs.len() == 1 && loose_files == 0 {
        return dirs.into_iter().next().unwrap();
    }
    extracted.to_path_buf()
}

/// 系统缓存/元数据文件：不算“内容”，避免只有一个 .DS_Store 的空包被当成有效模组
const JUNK_FILE_NAMES: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini", ".gitkeep"];

/// 模组不需要可执行载荷；命中即拒绝安装（并明确指出是哪个文件）
const BLOCKED_EXTS: &[&str] = &[
    "exe", "dll", "sys", "drv", "ocx", "cpl", "scr", "com", "bat", "cmd", "ps1", "psm1",
    "vbs", "vbe", "hta", "msi", "msp", "reg", "lnk", "jar",
];

fn is_junk_dir(name: &str) -> bool {
    name.eq_ignore_ascii_case("__MACOSX")
}

fn is_junk_file(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .map(|n| JUNK_FILE_NAMES.contains(&n.as_str()))
        .unwrap_or(false)
}

#[derive(Default)]
struct ContentScan {
    files: usize,
    blocked: Vec<String>,
}

fn scan_content(dir: &Path, depth: usize, acc: &mut ContentScan) {
    if depth > 8 || acc.files > 10_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if is_junk_dir(&name) {
                continue;
            }
            scan_content(&path, depth + 1, acc);
            continue;
        }
        if is_junk_file(&path) {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if BLOCKED_EXTS.contains(&ext.as_str()) {
            acc.blocked.push(name);
        }
        acc.files += 1;
    }
}

/// 内容检查（放宽版）。
///
/// 官方在线模组的结构非常自由：很多小模组只有几个资源文件，既没有 info.json，
/// 也没有 widgetui / resources / gamedata 这类标准目录，游戏客户端依旧能识别。
/// 因此不再把“缺少 info.json / 缺少标准目录”当成拒绝理由，只保留两条底线：
/// 1. 剥掉系统缓存文件后，至少有一个真实文件
/// 2. 不包含可执行/安装器类载荷（exe / dll / bat / ps1 …）
pub fn validate_structure(mod_root: &Path) -> Result<(), String> {
    let mut acc = ContentScan::default();
    scan_content(mod_root, 0, &mut acc);

    if let Some(name) = acc.blocked.first() {
        return Err(user_err("install.blockedExecutable", json!({ "name": name })));
    }
    if acc.files == 0 {
        return Err(user_err("install.noInstallableFiles", json!({})));
    }
    log::info!(
        target: "install",
        "内容检查通过：{} 个文件（无 info.json、无标准目录也算有效模组）",
        acc.files
    );
    Ok(())
}

/// 应当位于 `resources/` 之下、却常被老旧/不规范压缩包直接摊在模组根目录的资源目录名。
///
/// 保守白名单：只认这 4 个游戏确实从 `resources/` 下层加载的目录。
/// 宁可漏搬也不误搬——误搬的代价是整个模组失效。
const ROOT_RESOURCE_DIRS: &[&str] = &["_common", "gamedata", "drs", "wpfg"];

/// 永远保持原位的目录。
///
/// `widgetui` 必须留在模组根目录：早期版本把它当成根目录资源搬进 `resources/`，
/// 导致界面类模组大面积失效。这里作为硬约束写死，任何步骤都不得移动它。
const NEVER_MOVE_DIRS: &[&str] = &["widgetui"];

/// 该目录沿“唯一子目录”链向下，是否最终能碰到 `info.json`。
///
/// 遇到散文件或分叉即判定为假：这种结构不敢展开，怕把内容搬到错误的层级。
fn has_info_json_in_chain(dir: &Path) -> bool {
    const MAX_DEPTH: usize = 8;
    let mut cur = dir.to_path_buf();
    for _ in 0..MAX_DEPTH {
        if cur.join("info.json").is_file() {
            return true;
        }
        let Ok(rd) = fs::read_dir(&cur) else { return false };
        let mut next: Option<PathBuf> = None;
        let mut dirs = 0usize;
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if is_junk_dir(&name) {
                    continue;
                }
                dirs += 1;
                next = Some(path);
            } else if !is_junk_file(&path) {
                return false;
            }
        }
        if dirs != 1 {
            return false;
        }
        match next {
            Some(path) => cur = path,
            None => return false,
        }
    }
    false
}

/// 第 1 步：消除套娃。
///
/// 三个条件同时成立才动手，任一条不满足就一个字节都不碰：
/// 1. 根目录没有 `info.json`
/// 2. 根目录恰好只有一个真实子目录（散文件、`__MACOSX` 视为噪声，但散文件会打断判断）
/// 3. 该子目录（或其唯一子目录链）里能找到 `info.json`
///
/// 通过后把子目录内所有内容 rename 上移一层，删掉空壳；多层套娃逐层剥。
/// 返回被剥掉的子目录名（由外到内），供调用方打日志。
fn unwrap_nested_mod_root(mod_root: &Path) -> Vec<String> {
    const MAX_UNWRAP_DEPTH: usize = 8;
    let mut unwrapped: Vec<String> = Vec::new();
    for _ in 0..MAX_UNWRAP_DEPTH {
        if mod_root.join("info.json").is_file() {
            break;
        }
        let Ok(rd) = fs::read_dir(mod_root) else { break };
        let mut dirs: Vec<PathBuf> = Vec::new();
        let mut loose = 0usize;
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !is_junk_dir(&name) {
                    dirs.push(path);
                }
            } else if !is_junk_file(&path) {
                loose += 1;
            }
        }
        if dirs.len() != 1 || loose != 0 {
            break;
        }
        let shell = dirs.remove(0);
        if !has_info_json_in_chain(&shell) {
            break;
        }
        let Some(shell_name) = shell.file_name().map(|n| n.to_string_lossy().to_string()) else {
            break;
        };
        let Ok(inner) = fs::read_dir(&shell) else { break };
        let children: Vec<PathBuf> = inner.flatten().map(|e| e.path()).collect();
        let mut aborted = false;
        for child in children {
            let Some(child_name) = child.file_name().map(|n| n.to_owned()) else {
                aborted = true;
                break;
            };
            let to = mod_root.join(&child_name);
            if to.exists() {
                log::warn!(
                    target: "install",
                    "消除套娃时目标已存在，停止展开：{}",
                    to.display()
                );
                aborted = true;
                break;
            }
            if let Err(e) = fs::rename(&child, &to) {
                log::warn!(
                    target: "install",
                    "消除套娃上移失败：{} - {e}",
                    child.display()
                );
                aborted = true;
                break;
            }
        }
        // 只删空壳；删不掉就留着（数据安全优先于目录整洁）
        if let Err(e) = fs::remove_dir(&shell) {
            log::warn!(
                target: "install",
                "套娃空壳目录未能删除（已保留）：{} - {e}",
                shell.display()
            );
        }
        unwrapped.push(shell_name);
        if aborted {
            break;
        }
    }
    unwrapped
}

/// 第 1.5 步：空壳根目录展开。
///
/// 实测畸形结构（`1385_Displayed HotKeys`）：根目录有 `info.json` + `thumbnail.jpg`，
/// 真正的资源却藏在唯一一个数字命名的子目录里（`1270057352/resources/…`）。
/// 第 1 步“消除套娃”的前提是根目录**没有** `info.json`，这种包会被整段跳过，
/// 于是游戏在根目录既找不到 `resources` 也找不到 `widgetui`，模组报感叹号。
///
/// 四个条件同时成立才动手，任一不满足就一个字节都不碰：
/// 1. 根目录有 `info.json`
/// 2. 根目录既没有 `resources` 也没有 `widgetui`
/// 3. 根目录恰好只有一个非垃圾子目录（`__MACOSX` 不算）
/// 4. 该子目录里直接包含 `resources` 或 `widgetui`
///
/// 通过后把子目录内所有内容上移一层（根目录已有的同名文件原样保留，跳过并记日志），
/// 再删空壳。返回被展开的子目录名；一个都没搬成时返回空 Vec。
fn expand_empty_shell_root(mod_root: &Path) -> Vec<String> {
    if !mod_root.join("info.json").is_file() {
        return Vec::new();
    }
    // 正常模组的根目录同时也是资源目录：一旦有这个就不展开，避免误伤
    if mod_root.join("resources").is_dir() || mod_root.join("widgetui").is_dir() {
        return Vec::new();
    }

    let Ok(rd) = fs::read_dir(mod_root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() && !is_junk_dir(&name) {
            dirs.push(path);
        }
    }
    // 分叉即视为可疑：不敢猜哪个才是真正的资源
    if dirs.len() != 1 {
        return Vec::new();
    }
    let shell = dirs.remove(0);
    if !shell.join("resources").is_dir() && !shell.join("widgetui").is_dir() {
        return Vec::new();
    }
    let Some(shell_name) = shell.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return Vec::new();
    };
    let Ok(inner) = fs::read_dir(&shell) else {
        return Vec::new();
    };
    let children: Vec<PathBuf> = inner.flatten().map(|e| e.path()).collect();

    let mut moved = 0usize;
    for child in children {
        let Some(child_name) = child.file_name().map(|n| n.to_owned()) else {
            continue;
        };
        let to = mod_root.join(&child_name);
        if to.exists() {
            // 根目录已有的 info.json / thumbnail.jpg 绝不覆盖
            log::warn!(
                target: "install",
                "空壳根目录展开时目标已存在，跳过：{}",
                to.display()
            );
            continue;
        }
        match fs::rename(&child, &to) {
            Ok(()) => moved += 1,
            Err(e) => log::warn!(
                target: "install",
                "空壳根目录展开上移失败：{} - {e}",
                child.display()
            ),
        }
    }
    if moved == 0 {
        return Vec::new();
    }
    // 只删空壳；删不掉（还有被跳过的残留）就留着，数据安全优先
    if let Err(e) = fs::remove_dir(&shell) {
        log::warn!(
            target: "install",
            "空壳子目录未能删除（已保留）：{} - {e}",
            shell.display()
        );
    }
    log::info!(target: "install", "空壳根目录已展开：{shell_name}");
    vec![shell_name]
}

/// 第 1.6 步：widgetui 补全（`textures` 直接摊在根目录）。
///
/// 实测畸形结构（`zero two 02`）：根目录 `info.json` + `thumbnail.jpg` +
/// `textures/backgrounds/mainmenu_bg.dds`，游戏报感叹号。游戏只从
/// `widgetui/textures/…` 读取主菜单背景等界面资源，缺 `widgetui` 父级就整层失效。
///
/// 两个条件同时成立才动手，任一不满足就一个字节都不碰：
/// 1. 根目录没有 `widgetui`（已存在则一概不合并、不覆盖）
/// 2. 根目录有 `textures` 目录
///
/// 通过后新建 `widgetui/` 并把 `textures` 整体 `fs::rename` 进去；
/// 失败时只记日志并撤掉刚建的空 `widgetui`，`textures` 留在原位。
/// 没做任何事时返回 None。
fn wrap_textures_in_widgetui(mod_root: &Path) -> Option<String> {
    let textures = mod_root.join("textures");
    if !textures.is_dir() {
        return None;
    }
    let widgetui = mod_root.join("widgetui");
    // 已有 widgetui（目录或同名文件）都不碰：宁可不动也不瞎合并
    if widgetui.exists() {
        return None;
    }

    if let Err(e) = fs::create_dir_all(&widgetui) {
        log::warn!(
            target: "install",
            "创建 widgetui 目录失败，跳过 textures 归位：{e}"
        );
        return None;
    }
    let to = widgetui.join("textures");
    if to.exists() {
        log::warn!(
            target: "install",
            "widgetui 下已存在 textures，跳过不覆盖：{}",
            to.display()
        );
        let _ = fs::remove_dir(&widgetui);
        return None;
    }
    match fs::rename(&textures, &to) {
        Ok(()) => {
            log::info!(
                target: "install",
                "已补全 widgetui 层级：textures -> widgetui/textures"
            );
            Some("widgetui/textures".to_string())
        }
        Err(e) => {
            log::warn!(
                target: "install",
                "textures 移入 widgetui 失败（保留原位）：{} - {e}",
                textures.display()
            );
            let _ = fs::remove_dir(&widgetui);
            None
        }
    }
}

/// 修复模组目录结构，按“三步规范化”执行：
///
/// 1. **消除套娃**：根目录没有 `info.json`、且唯一子目录里有 → 内容上移，删空壳。
///    1.5 **空壳根目录展开**：根目录有 `info.json`、却没有任何 `resources` / `widgetui`，
///    且唯一子目录里才有 → 内容上移，删空壳（根目录的 `info.json` / `thumbnail.jpg` 保留）。
///    1.6 **widgetui 补全**：根目录没有 `widgetui`、却有直接摊开的 `textures` →
///    新建 `widgetui/` 并把 `textures` 整体移进去。
/// 2. **补 `resources`（保守白名单）**：根目录没有 `resources` 时，把 `_common` /
///    `gamedata` / `drs` / `wpfg` 改名搬进新建的 `resources`；一个都没搬成就删掉空目录。
/// 3. **绝不触碰 `widgetui`**：永远保持原位，不判断、不移动。
///
/// 根目录已有 `resources` 目录时不做任何搬迁。
///
/// 返回本次实际做过的动作：`"子目录/**"` 表示套娃展开，`"resources/目录名"` 表示补 resources，
/// `"widgetui/textures"` 表示补 widgetui 层级。结构本来就规范时返回空 Vec。
pub fn fix_mod_structure(mod_root: &Path) -> Result<Vec<String>, String> {
    if !mod_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut actions: Vec<String> = Vec::new();

    // ---------- 第 1 步：消除套娃 ----------
    for name in unwrap_nested_mod_root(mod_root) {
        actions.push(format!("{name}/**"));
    }

    // ---------- 第 1.5 步：空壳根目录展开 ----------
    // 根目录有 info.json 但资源在唯一子目录里（如 `1385_Displayed HotKeys` 的 `1270057352/`）
    for name in expand_empty_shell_root(mod_root) {
        actions.push(format!("{name}/**"));
    }

    // ---------- 第 1.6 步：widgetui 补全（textures 直接摊在根目录） ----------
    // 如 `zero two 02`：`textures/backgrounds/…` 少了 `widgetui/` 父级
    if let Some(action) = wrap_textures_in_widgetui(mod_root) {
        actions.push(action);
    }

    // ---------- 第 2 步：补 resources（已有则一律不动） ----------
    let resources = mod_root.join("resources");
    if resources.is_dir() {
        return Ok(actions);
    }
    if resources.exists() {
        // 同名但不是目录（例如误放在根目录的文件）：不碰，交给上层提示
        return Err(user_err(
            "install.resourcesNotDir",
            json!({ "path": resources.display().to_string() }),
        ));
    }

    // 先整体探测，确认确实要搬再建目录，避免留下一个空的 resources
    let mut pending: Vec<PathBuf> = Vec::new();
    for name in ROOT_RESOURCE_DIRS {
        // 第 3 步的硬约束：即使白名单被误改，widgetui 也绝不移动
        if NEVER_MOVE_DIRS
            .iter()
            .any(|never| never.eq_ignore_ascii_case(*name))
        {
            continue;
        }
        let path = mod_root.join(name);
        if path.is_dir() {
            pending.push(path);
        }
    }
    if pending.is_empty() {
        return Ok(actions);
    }

    fs::create_dir_all(&resources)
        .map_err(|e| user_err(
            "install.resourcesCreateFailed",
            json!({ "path": resources.display().to_string(), "error": e.to_string() }),
        ))?;

    let mut moved = 0usize;
    for from in pending {
        let Some(name) = from.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let to = resources.join(&name);
        if to.exists() {
            // 目标已存在（resources 是刚建的，理论上不会发生）：绝不覆盖
            log::warn!(
                target: "install",
                "resources 下已存在同名目录，跳过：{}",
                to.display()
            );
            continue;
        }
        match fs::rename(&from, &to) {
            Ok(()) => {
                moved += 1;
                actions.push(format!("resources/{name}"));
            }
            Err(e) => log::warn!(
                target: "install",
                "移入 resources 失败：{} - {e}",
                from.display()
            ),
        }
    }
    if moved == 0 {
        // 一个都没搬成功：撤掉刚建的空目录，保持与解压结果一致
        let _ = fs::remove_dir(&resources);
    }
    Ok(actions)
}
pub fn install_dir_name(mod_id: i64, title: &str) -> String {
    format!("{mod_id}_{}", sanitize_component(title))
}

/// local 目录下应该用的目录名：去掉 `{modId}_` 前缀（`155009_Weeb` → `Weeb`）。
///
/// 游戏只把“带数字前缀 + mod-status.json 里 WorkshopID 相同”的目录当成 workshop 模组；
/// 放进 local 却保留前缀/ID，游戏启动时会该模组反向同步成“已订阅”。
pub fn strip_id_prefix(folder_name: &str, mod_id: i64) -> String {
    let prefix = format!("{mod_id}_");
    let name = folder_name.trim();
    let rest = name
        .strip_prefix(&prefix)
        .map(str::trim)
        .unwrap_or(name);
    if !rest.is_empty() {
        return rest.to_string();
    }
    // 极端情况：标题为空导致只剩 `{id}_`，退回到清洗后的名字，绝不返回空目录名
    sanitize_component(name)
}

/// mod-status.json 里 `Path` 字段的形态：`subscribed//2035_xxx`。
/// 双斜杠是游戏自己的写法，写入时必须原样保留（比对时才用 `scan::normalize_key` 归一化）。
pub fn status_rel_path(kind: &str, folder_name: &str) -> String {
    format!("{kind}//{folder_name}")
}

// ---------------- 补全游戏识别所需的文件（info.json / thumbnail） ----------------

/// 实测（本机 175 个官方下载的模组）：游戏自己生成的 info.json **全部只有 4 个键**，
/// 按字母序写出、紧凑 JSON、UTF-8 无 BOM：
/// `{"Author":"…","CacheStatus":0,"Description":"…","Title":"…"}`
///
/// `CacheStatus`：0 = 尚未生成缓存（132 个样本里 131 个是 0），1 = 已被游戏加载并缓存。
/// 没有 WorkshopID / Version / Priority 等字段，所以这四个键就是全部。
#[derive(serde::Serialize)]
struct InfoJson<'a> {
    #[serde(rename = "Author")]
    author: &'a str,
    #[serde(rename = "CacheStatus")]
    cache_status: u32,
    #[serde(rename = "Description")]
    description: &'a str,
    #[serde(rename = "Title")]
    title: &'a str,
}

#[derive(Debug, PartialEq)]
pub enum InfoAction {
    /// 原本就有 info.json，未做任何改动
    AlreadyExists,
    /// 新写入的文件路径
    Written(String),
}

/// 目录里没有 info.json 时，按游戏自己的格式补一个；**已有文件绝不覆盖**。
pub fn ensure_info_json(
    dir: &Path,
    title: &str,
    author: &str,
    description: &str,
) -> Result<InfoAction, String> {
    let path = dir.join("info.json");
    if path.is_file() {
        return Ok(InfoAction::AlreadyExists);
    }
    let data = InfoJson {
        author: author.trim(),
        cache_status: 0,
        description,
        title: title.trim(),
    };
    let text = serde_json::to_string(&data).map_err(|e| user_err("install.infoJsonSerializeFailed", json!({ "error": e.to_string() })))?;
    fs::write(&path, text.as_bytes()).map_err(|e| user_err("install.infoJsonWriteFailed", json!({ "error": e.to_string() })))?;
    log::info!(target: "install", "已补全 info.json：{}", path.display());
    Ok(InfoAction::Written(path.to_string_lossy().to_string()))
}

/// 缩略图候选（游戏读 jpg/jpeg/png/webp）
const THUMB_NAMES: &[&str] = &[
    "thumbnail.jpg",
    "thumbnail.jpeg",
    "thumbnail.png",
    "thumbnail.webp",
];

pub fn has_thumbnail(dir: &Path) -> bool {
    THUMB_NAMES.iter().any(|name| dir.join(name).is_file())
}

/// 把 thumbnail.png 改名为 thumbnail.jpg（jpg 已存在则原样保留，不删任何东西）。
/// 返回最终可用的缩略图文件名；一个都没有时返回 None。
pub fn normalize_thumbnail_extension(dir: &Path) -> Option<String> {
    if dir.join("thumbnail.jpg").is_file() {
        return Some("thumbnail.jpg".to_string());
    }
    if dir.join("thumbnail.png").is_file() {
        match fs::rename(dir.join("thumbnail.png"), dir.join("thumbnail.jpg")) {
            Ok(()) => {
                log::info!(target: "install", "缩略图已重命名：thumbnail.png -> thumbnail.jpg（{}）", dir.display());
                return Some("thumbnail.jpg".to_string());
            }
            Err(e) => {
                // 被占用/权限不足：保留 png，游戏同样能读
                log::warn!(target: "install", "缩略图重命名失败（保留 png）：{e}");
                return Some("thumbnail.png".to_string());
            }
        }
    }
    for name in THUMB_NAMES {
        if dir.join(name).is_file() {
            return Some((*name).to_string());
        }
    }
    None
}

/// 用 API 下载到的字节写成 thumbnail.jpg
pub fn write_thumbnail(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err(user_err("install.thumbnailEmpty", json!({})));
    }
    let path = dir.join("thumbnail.jpg");
    fs::write(&path, bytes).map_err(|e| user_err("install.thumbnailWriteFailed", json!({ "error": e.to_string() })))?;
    log::info!(target: "install", "已保存缩略图：{}（{} 字节）", path.display(), bytes.len());
    Ok(path.to_string_lossy().to_string())
}

// ---------------- 卸载：先解析校验，再删且只删那一个目录 ----------------

/// 校验通过的卸载目标（`dir` 与 `parent` 都已规范化）
#[derive(Debug)]
pub struct UninstallTarget {
    pub dir: PathBuf,
    pub parent: PathBuf,
    pub folder_name: String,
    /// `subscribed` | `local`
    pub kind: String,
}

/// 在一个目录下收集 `<prefix>*` 的真实子目录名（排除 `.bak-` 版本备份）
fn candidate_dirs(dir: &Path, prefix: &str, hint: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if let Some(hint) = hint {
        let hint = hint.trim();
        if !hint.is_empty() && hint.starts_with(prefix) {
            names.push(hint.to_string());
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            // 目录与重解析点（junction / 符号链接）都算候选：后者会在后续校验里被明确拒绝，
            // 而不是被静默当成“不存在”
            if !file_type.is_dir() && !file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 版本备份目录（`.bak-`）不是模组本体，不能算候选
            if name.starts_with(prefix)
                && !name.contains(".bak-")
                && !names.iter().any(|n| n.eq_ignore_ascii_case(&name))
            {
                names.push(name);
            }
        }
    }
    names
}

/// 解析要卸载的真实目录，只接受 `<root>/subscribed/<modId>_*`。
///
/// 任何一条校验失败就直接拒绝，绝不“尽力而为”；此函数不删除任何东西。
pub fn resolve_uninstall_target(
    mods_root: &Path,
    mod_id: i64,
    folder_hint: Option<&str>,
) -> Result<UninstallTarget, String> {
    if mod_id <= 0 {
        return Err(user_err("install.badModId", json!({})));
    }
    let prefix = format!("{mod_id}_");
    let hint = folder_hint.map(str::trim).filter(|h| !h.is_empty());

    // 1) 先在 subscribed（游戏下载位置）找；没有再看 local（本工具兜底转过去的位置）
    let mut chosen: Option<(String, Vec<String>)> = None;
    for kind in ["subscribed", "local"] {
        let base = mods_root.join(kind);
        if !base.is_dir() {
            continue;
        }
        let mut names = candidate_dirs(&base, &prefix, hint);
        // 转入 local 时目录名已去掉 `{modId}_` 前缀（`Weeb` 而不是 `155009_Weeb`），
        // 所以 local 下还要按“精确目录名”再认一次 —— WorkshopID=0 的记录只能靠目录名定位
        if kind == "local" {
            if let Some(hint) = hint {
                if !hint.contains(".bak-")
                    && !names.iter().any(|n| n.eq_ignore_ascii_case(hint))
                    && base.join(hint).is_dir()
                {
                    names.push(hint.to_string());
                }
            }
        }
        if !names.is_empty() {
            chosen = Some((kind.to_string(), names));
            break;
        }
    }
    let Some((kind, mut names)) = chosen else {
        return Err(user_err(
            "install.noLocalDir",
            json!({ "prefix": prefix }),
        ));
    };
    if names.len() > 1 {
        return Err(user_err(
            "install.multipleCandidates",
            json!({ "names": names.join(" / ") }),
        ));
    }
    let base = mods_root.join(&kind);
    let folder_name = names.remove(0);
    validate_child(kind, &base, folder_name)
}

/// 按“精确目录”删除：用于没有 WorkshopID（手动放入 / 来源未知）的本地模组。
/// 校验规则与按 ID 解析完全一致；此函数不删除任何东西。
pub fn resolve_delete_target(
    mods_root: &Path,
    kind: &str,
    folder_name: &str,
) -> Result<UninstallTarget, String> {
    if kind != "local" && kind != "subscribed" {
        return Err(user_err("install.unknownKind", json!({ "kind": kind })));
    }
    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err(user_err("install.emptyFolderName", json!({})));
    }
    let base = mods_root.join(kind);
    if !base.is_dir() {
        return Err(user_err("install.baseNotExist", json!({ "path": base.display().to_string() })));
    }
    validate_child(kind.to_string(), &base, folder_name.to_string())
}

/// ②③④ 的公共校验：单层普通名 + 真实目录（非符号链接 / junction）+ 规范化后父目录必须正好是 `base`
fn validate_child(kind: String, base: &Path, folder_name: String) -> Result<UninstallTarget, String> {

    // 2) 必须是单层普通名字
    if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
        return Err(user_err("install.illegalFolderName", json!({ "name": folder_name })));
    }
    let mut comps = Path::new(&folder_name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(user_err("install.notSingleComponent", json!({ "name": folder_name }))),
    }

    let dir = base.join(&folder_name);

    // 3) 必须是真实目录（排除符号链接 / junction / 挂载点）
    let meta = fs::symlink_metadata(&dir)
        .map_err(|e| user_err("install.readDirFailed", json!({ "path": dir.display().to_string(), "error": e.to_string() })))?;
    if !meta.is_dir() {
        return Err(user_err("install.notDir", json!({ "path": dir.display().to_string() })));
    }
    if meta.file_type().is_symlink() {
        return Err(user_err("install.symlinkRejected", json!({ "path": dir.display().to_string() })));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(user_err("install.junctionRejected", json!({ "path": dir.display().to_string() })));
        }
    }

    // 4) 规范化后父目录必须正好是 subscribed / local（不用 starts_with，杜经 ../ 绕过）
    let real_parent = fs::canonicalize(base)
        .map_err(|e| user_err("install.canonicalizeBaseFailed", json!({ "path": base.display().to_string(), "error": e.to_string() })))?;
    let real_dir = fs::canonicalize(&dir)
        .map_err(|e| user_err("install.canonicalizeDirFailed", json!({ "path": dir.display().to_string(), "error": e.to_string() })))?;
    if real_dir.parent() != Some(real_parent.as_path()) {
        return Err(user_err(
            "install.outsideParent",
            json!({ "kind": kind, "path": real_dir.display().to_string() }),
        ));
    }
    if real_dir.file_name().and_then(|n| n.to_str()) != Some(folder_name.as_str()) {
        return Err(user_err("install.nameMismatch", json!({})));
    }

    Ok(UninstallTarget { dir: real_dir, parent: real_parent, folder_name, kind })
}

/// 删除 `resolve_uninstall_target` 返回的那一个目录（不递归父级），返回 (文件数, 字节数)。
pub fn uninstall(target: &UninstallTarget) -> Result<(u64, u64), String> {
    if target.dir.parent() != Some(target.parent.as_path()) {
        return Err(user_err("install.notUnderParent", json!({ "path": target.dir.display().to_string() })));
    }
    let meta = fs::symlink_metadata(&target.dir)
        .map_err(|e| user_err("install.uninstallReadFailed", json!({ "error": e.to_string() })))?;
    if !meta.is_dir() {
        return Err(user_err("install.notDir", json!({ "path": target.dir.display().to_string() })));
    }

    let (files, bytes) = dir_usage(&target.dir);
    fs::remove_dir_all(&target.dir).map_err(|e| {
        user_err(
            "install.removeFailed",
            json!({ "path": target.dir.display().to_string(), "error": e.to_string() }),
        )
    })?;
    if target.dir.exists() {
        return Err(user_err("install.removeStillExists", json!({ "path": target.dir.display().to_string() })));
    }
    Ok((files, bytes))
}

/// 列出 `subscribed` 下保留的旧版本备份目录（`.bak-*`），仅用于提示
pub fn list_version_backups(subscribed: &Path, folder_name: &str) -> Vec<String> {
    let prefix = format!("{folder_name}.bak-");
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(subscribed) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                out.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out
}

fn read_marker(dir: &Path) -> Option<InstallMarker> {
    let text = fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str::<InstallMarker>(&text).ok()
}

/// 把已解压并校验过的目录安装到 `<root>/subscribed/`。
///
/// `owned_before` 由调用方根据软件自己的元数据给出（该 modId 之前是否由本工具安装过），
/// 不再往游戏目录写标记文件。
///
/// 覆盖规则：
/// - 目标不存在 → 直接安装
/// - 目标存在且归属本工具（owned_before 或旧标记）→ 视为“更新”，旧目录改名为 `.bak-<时间戳>` 保留
/// - 目标存在但不是本工具装的 → 默认拒绝；只有调用方显式 force 时才备份后覆盖
pub fn install(
    staging_mod_root: &Path,
    mods_root: &Path,
    mod_id: i64,
    title: &str,
    force: bool,
    owned_before: bool,
) -> Result<InstallReport, String> {
    // 老旧模组常见毛病：包内套了一层多余文件夹、或资源目录直接摊在根目录缺一层 `resources`。
    // 这里在改名到 subscribed 之前就地做“三步规范化”（消除套娃 / 补 resources / 不碰 widgetui），
    // 原子改名之后留下的就是修好的目录；规范化失败只记日志，绝不阻断安装。
    // （不影响下面的 WorkshopID / 去 `{id}_` 前缀逻辑）
    match fix_mod_structure(staging_mod_root) {
        Ok(moved) if !moved.is_empty() => log::info!(
            target: "install",
            "结构规范化完成：{}",
            moved.join(", ")
        ),
        Ok(_) => {}
        Err(e) => log::warn!(
            target: "install",
            "补全 resources 层级失败（不影响安装）：{e}"
        ),
    }

    let subscribed = mods_root.join("subscribed");
    fs::create_dir_all(&subscribed).map_err(|e| user_err("install.subscribedCreateFailed", json!({ "error": e.to_string() })))?;

    let target_name = install_dir_name(mod_id, title);
    let target = subscribed.join(&target_name);
    let relative_staging = staging_mod_root
        .strip_prefix(mods_root)
        .map_err(|_| user_err("install.stagingOutsideRoot", json!({})))?;

    let mut backup_dir: Option<String> = None;
    let mut updated = false;

    if target.exists() {
        // 旧标记只用于兼容早先版本装过的模组；新安装不再往游戏目录写任何文件
        let legacy_ours = read_marker(&target)
            .map(|m| m.mod_id == mod_id)
            .unwrap_or(false);
        let ours = owned_before || legacy_ours;
        if !ours && !force {
            return Err(user_err(
                "install.targetExistsForeign",
                json!({ "path": target.display().to_string() }),
            ));
        }
        updated = ours;
        let backup = subscribed.join(format!("{target_name}.bak-{}", crate::scan::now_ms()));
        fs::rename(&target, &backup).map_err(|e| {
            user_err(
                "install.backupExistingFailed",
                json!({ "path": target.display().to_string(), "error": e.to_string() }),
            )
        })?;
        backup_dir = Some(backup.to_string_lossy().to_string());
    }

    // 同一卷内的目录改名是原子的；暂存目录位于根目录下，因此不会跨盘
    let source = mods_root.join(relative_staging);
    fs::rename(&source, &target).map_err(|e| {
        user_err(
            "install.renameFailed",
            json!({ "path": target.display().to_string(), "error": e.to_string() }),
        )
    })?;

    let (file_count, bytes) = dir_usage(&target);

    // 旧版遗在游戏目录里的标记文件清理掉，保持与游戏文件零侵入
    let legacy_marker = target.join(MARKER_FILE);
    if legacy_marker.is_file() {
        match fs::remove_file(&legacy_marker) {
            Ok(_) => log::info!(
                target: "install",
                "已清理旧版写入模组目录的标记文件：{}",
                legacy_marker.display()
            ),
            Err(e) => log::warn!(
                target: "install",
                "旧标记文件无法删除（可手动删）：{} - {e}",
                legacy_marker.display()
            ),
        }
    }

    Ok(InstallReport {
        target_dir: target.to_string_lossy().to_string(),
        file_count,
        bytes,
        backup_dir,
        updated,
    })
}

// ---------------- 兜底：把模组目录挪到 local/ ----------------

/// “subscribed/<id>_* → local/” 的目标
#[derive(Debug)]
pub struct LocalizeTarget {
    pub from: PathBuf,
    pub to: PathBuf,
    pub local_root: PathBuf,
    /// 最终 local 下的目录名（已去掉 `{modId}_` 前缀）
    pub folder_name: String,
    /// 源目录名（subscribed 下带 `{modId}_` 前缀），回滚时用
    pub source_folder_name: String,
    /// local 下同名旧目录的备份路径（覆盖安装时才有）
    pub backup: Option<PathBuf>,
}

/// 通用同卷改名，成功后做双向校验
pub fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() {
        return Err(user_err("install.sourceNotExist", json!({ "path": from.display().to_string() })));
    }
    if to.exists() {
        return Err(user_err("install.targetAlreadyExists", json!({ "path": to.display().to_string() })));
    }
    fs::rename(from, to).map_err(|e| {
        user_err(
            "install.moveFailed",
            json!({ "path": from.display().to_string(), "error": e.to_string() }),
        )
    })?;
    if from.exists() || !to.is_dir() {
        return Err(user_err(
            "install.moveVerifyFailed",
            json!({ "from": from.display().to_string(), "to": to.display().to_string() }),
        ));
    }
    Ok(())
}

/// 校验并解析“把 subscribed/<id>_* 挪到 local/” 的目标；任何异常直接拒绝。
///
/// `folder_name` 会去掉 `{modId}_` 前缀；`allow_replace` 为真时才允许覆盖 local 下同名旧目录
/// （覆盖前先改名为 `<名字>.bak-<时间戳>` 保留，不删除）。
pub fn resolve_localize_target(
    mods_root: &Path,
    mod_id: i64,
    folder_hint: Option<&str>,
    allow_replace: bool,
) -> Result<LocalizeTarget, String> {
    let resolved = resolve_uninstall_target(mods_root, mod_id, folder_hint)?;
    if resolved.kind == "local" {
        return Err(user_err(
            "install.alreadyLocal",
            json!({ "path": resolved.dir.display().to_string() }),
        ));
    }
    let local = mods_root.join("local");
    fs::create_dir_all(&local).map_err(|e| user_err("install.localCreateFailed", json!({ "error": e.to_string() })))?;
    let real_local =
        fs::canonicalize(&local).map_err(|e| user_err("install.localCanonicalizeFailed", json!({ "path": local.display().to_string(), "error": e.to_string() })))?;

    // 关键：local 下的目录名不带 `{modId}_`，否则游戏会把目录认成 workshop 模组
    let folder_name = strip_id_prefix(&resolved.folder_name, mod_id);
    let to = real_local.join(&folder_name);
    let mut backup: Option<PathBuf> = None;
    if to.exists() {
        if !allow_replace {
            return Err(user_err(
                "install.localTargetExists",
                json!({ "path": to.display().to_string() }),
            ));
        }
        backup = Some(real_local.join(format!(
            "{folder_name}.bak-{}",
            crate::scan::now_ms()
        )));
    }
    Ok(LocalizeTarget {
        from: resolved.dir,
        to,
        local_root: real_local,
        folder_name,
        source_folder_name: resolved.folder_name,
        backup,
    })
}

/// 执行移动（subscribed → local）。返回被覆盖的旧 local 目录备份路径（没有覆盖时为 None）
pub fn move_to_local(target: &LocalizeTarget) -> Result<Option<PathBuf>, String> {
    if target.to.parent() != Some(target.local_root.as_path()) {
        return Err(user_err("install.notUnderLocal", json!({ "path": target.to.display().to_string() })));
    }
    if let Some(backup) = target.backup.as_ref() {
        if backup.exists() {
            return Err(user_err("install.backupAlreadyExists", json!({ "path": backup.display().to_string() })));
        }
        if target.to.exists() {
            fs::rename(&target.to, backup).map_err(|e| {
                user_err(
                    "install.localBackupFailed",
                    json!({ "path": target.to.display().to_string(), "error": e.to_string() }),
                )
            })?;
        }
    }
    match move_dir(&target.from, &target.to) {
        Ok(()) => Ok(target.backup.clone()),
        Err(e) => {
            // 移动失败：把刚备份的旧目录还原，不能因为一次失败让用户的旧版本消失
            if let Some(backup) = target.backup.as_ref() {
                if backup.exists() && !target.to.exists() {
                    let _ = fs::rename(backup, &target.to);
                }
            }
            Err(e)
        }
    }
}

/// 回滚一次 `move_to_local`：新目录挪回 subscribed（恢复带前缀的原名），并还原被覆盖的旧 local 目录
pub fn revert_localize(target: &LocalizeTarget) -> Result<(), String> {
    move_dir(&target.to, &target.from).map_err(|e| {
        user_err(
            "install.revertFailed",
            json!({ "from": target.folder_name, "to": target.source_folder_name, "error": e }),
        )
    })?;
    if let Some(backup) = target.backup.as_ref() {
        if backup.exists() {
            fs::rename(backup, &target.to)
                .map_err(|e| user_err("install.revertRestoreFailed", json!({ "path": target.to.display().to_string(), "error": e.to_string() })))?;
        }
    }
    Ok(())
}

fn dir_usage(root: &Path) -> (u64, u64) {
    let mut stack = vec![root.to_path_buf()];
    let mut files = 0u64;
    let mut bytes = 0u64;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => {
                    files += 1;
                    if let Ok(meta) = entry.metadata() {
                        bytes += meta.len();
                    }
                }
                _ => {}
            }
        }
    }
    (files, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_entry_path("../evil.txt").is_err());
        assert!(safe_entry_path("a/../../evil.txt").is_err());
        assert!(safe_entry_path("..\\evil.txt").is_err());
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(safe_entry_path("/etc/passwd").is_err());
        assert!(safe_entry_path("C:/Windows/system32/x.dll").is_err());
        assert!(safe_entry_path("c:evil.txt").is_err());
    }

    #[test]
    fn rejects_ads_and_nul() {
        assert!(safe_entry_path("file.txt:stream").is_err());
        assert!(safe_entry_path("bad\0name").is_err());
    }

    #[test]
    fn accepts_normal_nested_paths() {
        let p = safe_entry_path("widgetui/textures/icon.png").unwrap();
        assert_eq!(p, PathBuf::from("widgetui").join("textures").join("icon.png"));
        let p2 = safe_entry_path("resources\\_common\\wpfg\\x.dds").unwrap();
        assert!(p2.ends_with("x.dds"));
    }

    #[test]
    fn sanitizes_titles_for_folder_names() {
        assert_eq!(sanitize_component("AoE2: DE / Mod?"), "AoE2_ DE _ Mod_");
        assert_eq!(sanitize_component("   "), "unnamed");
        assert_eq!(sanitize_component("trailing..."), "trailing");
    }

    #[test]
    fn install_dir_matches_game_convention() {
        assert_eq!(install_dir_name(20505, "Feudal Japanese Town"), "20505_Feudal Japanese Town");
    }

    // ---- 端到端（本地文件系统）安装流程测试 ----

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aoe2mm-test-{tag}-{}", crate::scan::now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_zip_with_path_traversal_entry() {
        let dir = temp_dir("zip-trav");
        let zip_path = dir.join("bad.zip");
        write_zip(&zip_path, &[("../escape.txt", "x")]);
        let err = extract_zip(&zip_path, &dir.join("out")).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.zipTraversal"), "实际错误：{err}");
        assert!(!dir.join("escape.txt").exists(), "不得在上级目录写出文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_then_update_backs_up_previous_version() {
        let dir = temp_dir("install");
        let root = dir.join("game");
        fs::create_dir_all(root.join("subscribed")).unwrap();

        // 第一次安装
        let zip_a = dir.join("a.zip");
        write_zip(
            &zip_a,
            &[
                ("info.json", "{\"Title\":\"Test Mod\"}"),
                ("widgetui/textures/a.dds", "aaa"),
            ],
        );
        let staging_a = root.join(".aoe2mm-staging").join("stage-a");
        let (files_a, bytes_a) = extract_zip(&zip_a, &staging_a).unwrap();
        assert_eq!(files_a, 2);
        assert!(bytes_a > 0);
        let mod_root_a = detect_mod_root(&staging_a);
        validate_structure(&mod_root_a).unwrap();
        let first = install(&mod_root_a, &root, 424242, "Test Mod", false, false).unwrap();
        assert!(!first.updated);
        assert!(Path::new(&first.target_dir).join("info.json").is_file());
        assert!(
            !Path::new(&first.target_dir).join(MARKER_FILE).exists(),
            "不得再向游戏模组目录写入任何标记文件"
        );

        // 第二次安装（更新）：旧目录应被保留为 .bak-*
        let zip_b = dir.join("b.zip");
        write_zip(
            &zip_b,
            &[
                ("info.json", "{\"Title\":\"Test Mod\"}"),
                ("widgetui/textures/b.dds", "bbb"),
            ],
        );
        let staging_b = root.join(".aoe2mm-staging").join("stage-b");
        extract_zip(&zip_b, &staging_b).unwrap();
        let mod_root_b = detect_mod_root(&staging_b);
        let second = install(&mod_root_b, &root, 424242, "Test Mod", false, true).unwrap();
        assert!(second.updated);
        let backup = second.backup_dir.expect("更新时必须给出备份目录");
        // 两个 zip 都是老旧布局（widgetui 直接摊在根目录）。结构修复只搬白名单目录，
        // widgetui 必须原地保留，因此断言路径仍在模组根目录下。
        assert!(
            Path::new(&backup).join("widgetui/textures/a.dds").is_file(),
            "旧版本文件应保留在备份里"
        );
        assert!(Path::new(&second.target_dir)
            .join("widgetui/textures/b.dds")
            .is_file());
        assert!(
            !Path::new(&second.target_dir).join("resources").exists(),
            "只有 widgetui 时不得创建空的 resources"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_overwrite_foreign_folder_without_force() {
        let dir = temp_dir("foreign");
        let root = dir.join("game");
        let foreign = root.join("subscribed").join(install_dir_name(777, "Foreign Mod"));
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("keep.txt"), "user data").unwrap();

        let zip = dir.join("c.zip");
        write_zip(&zip, &[("info.json", "{}"), ("resources/x.txt", "x")]);
        let staging = root.join(".aoe2mm-staging").join("stage-c");
        extract_zip(&zip, &staging).unwrap();
        let mod_root = detect_mod_root(&staging);

        let err = install(&mod_root, &root, 777, "Foreign Mod", false, false).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.targetExistsForeign"), "实际错误：{err}");
        assert!(foreign.join("keep.txt").is_file(), "未经确认不得动用户自己的目录");

        // 显式 force 后才允许覆盖，并且仍然保留备份
        let report = install(&mod_root, &root, 777, "Foreign Mod", true, false).unwrap();
        assert!(report.backup_dir.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structure_check_accepts_loose_files_without_info_json() {
        // 官方很多小模组就是几个散资源文件，没有 info.json 也没有标准目录
        let dir = temp_dir("struct-loose");
        fs::write(dir.join("castle.dds"), "x").unwrap();
        fs::write(dir.join("readme.txt"), "not a mod").unwrap();
        validate_structure(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structure_check_accepts_nested_files_without_known_dirs() {
        let dir = temp_dir("struct-nested");
        fs::create_dir_all(dir.join("my_mod/whatever")).unwrap();
        fs::write(dir.join("my_mod/whatever/a.slp"), "x").unwrap();
        validate_structure(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structure_check_rejects_empty_or_junk_only() {
        let dir = temp_dir("struct-empty");
        fs::create_dir_all(dir.join("empty/sub")).unwrap();
        let err = validate_structure(&dir).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.noInstallableFiles"), "实际错误：{err}");

        fs::write(dir.join(".DS_Store"), "x").unwrap();
        fs::create_dir_all(dir.join("__MACOSX")).unwrap();
        fs::write(dir.join("__MACOSX/junk.txt"), "x").unwrap();
        let err = validate_structure(&dir).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.noInstallableFiles"), "实际错误：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structure_check_rejects_executables() {
        let dir = temp_dir("struct-exe");
        fs::create_dir_all(dir.join("resources")).unwrap();
        fs::write(dir.join("resources/x.txt"), "x").unwrap();
        fs::write(dir.join("resources/setup.exe"), "MZ").unwrap();
        let err = validate_structure(&dir).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.blockedExecutable"), "实际错误：{err}");
        assert!(err.contains("setup.exe"), "错误信息应指出具体文件：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_keeps_already_normalized_layout() {
        // “Battle of Gallach”：根目录已有 info.json + resources + widgetui —— 空操作，结构不变
        let dir = temp_dir("fix-struct-gallach");
        fs::write(dir.join("info.json"), r#"{"Title":"Battle of Gallach"}"#).unwrap();
        fs::create_dir_all(dir.join("resources/_common")).unwrap();
        fs::write(dir.join("resources/_common/a.dds"), "a").unwrap();
        fs::create_dir_all(dir.join("widgetui/layouts")).unwrap();
        fs::write(dir.join("widgetui/layouts/game.json"), "{}").unwrap();

        assert!(
            fix_mod_structure(&dir).unwrap().is_empty(),
            "已规范的结构不得产生任何动作"
        );
        assert!(dir.join("info.json").is_file());
        assert!(dir.join("resources/_common/a.dds").is_file());
        assert!(dir.join("widgetui/layouts/game.json").is_file());
        assert!(!dir.join("resources/widgetui").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_unwraps_nested_folders() {
        // 套娃两层：<dir>/A/B/{info.json, resources, widgetui}
        let dir = temp_dir("fix-struct-unwrap");
        let inner = dir.join("A").join("B");
        fs::create_dir_all(inner.join("resources/_common")).unwrap();
        fs::create_dir_all(inner.join("widgetui/layouts")).unwrap();
        fs::write(inner.join("info.json"), r#"{"Title":"Nested"}"#).unwrap();
        fs::write(inner.join("resources/_common/a.dds"), "a").unwrap();
        fs::write(inner.join("widgetui/layouts/game.json"), "{}").unwrap();

        let actions = fix_mod_structure(&dir).unwrap();
        assert_eq!(
            actions,
            vec!["A/**".to_string(), "B/**".to_string()],
            "两层套娃应逐层展开"
        );
        assert!(!dir.join("A").exists(), "套娃空壳应被删除");
        assert!(dir.join("info.json").is_file(), "info.json 应落到根目录");
        assert!(
            dir.join("resources/_common/a.dds").is_file(),
            "resources 应与 widgetui 平级留在根目录"
        );
        assert!(
            dir.join("widgetui/layouts/game.json").is_file(),
            "widgetui 应与 resources 平级留在根目录"
        );
        assert!(
            !dir.join("resources/widgetui").exists(),
            "不得把 widgetui 塞进 resources"
        );

        // 幂等：再来一次什么都不做
        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        assert!(dir.join("widgetui/layouts/game.json").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_moves_only_whitelisted_dirs_into_resources() {
        let dir = temp_dir("fix-struct-whitelist");
        fs::write(dir.join("info.json"), r#"{"Title":"Old"}"#).unwrap();
        fs::create_dir_all(dir.join("_common/a")).unwrap();
        fs::write(dir.join("_common/a/a.dds"), "a").unwrap();
        fs::create_dir_all(dir.join("gamedata")).unwrap();
        fs::write(dir.join("gamedata/b.txt"), "b").unwrap();
        fs::create_dir_all(dir.join("widgetui/layouts")).unwrap();
        fs::write(dir.join("widgetui/layouts/game.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("misc")).unwrap();
        fs::write(dir.join("misc/c.txt"), "c").unwrap();

        let actions = fix_mod_structure(&dir).unwrap();
        assert_eq!(
            actions,
            vec![
                "resources/_common".to_string(),
                "resources/gamedata".to_string()
            ]
        );
        assert!(dir.join("resources/_common/a/a.dds").is_file());
        assert!(dir.join("resources/gamedata/b.txt").is_file());
        assert!(!dir.join("_common").exists(), "根目录下的 _common 应已被移走");
        assert!(!dir.join("gamedata").exists());
        assert!(dir.join("info.json").is_file(), "info.json 不得被搬动");
        assert!(
            dir.join("widgetui/layouts/game.json").is_file(),
            "widgetui 必须留在根目录"
        );
        assert!(
            !dir.join("resources/widgetui").exists(),
            "widgetui 不得被搬进 resources"
        );
        assert!(dir.join("misc/c.txt").is_file(), "白名单外的目录不得被搬动");

        // 幂等：已有 resources 后什么都不做
        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        assert!(dir.join("widgetui/layouts/game.json").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_keeps_existing_resources_untouched() {
        let dir = temp_dir("fix-struct-keep");
        fs::write(dir.join("info.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("resources/_common")).unwrap();
        fs::write(dir.join("resources/_common/a.dds"), "a").unwrap();
        // 根目录还残留一个白名单目录，但既然已有 resources，一律不动
        fs::create_dir_all(dir.join("gamedata")).unwrap();
        fs::write(dir.join("gamedata/b.txt"), "b").unwrap();

        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        assert!(dir.join("gamedata/b.txt").is_file(), "已有 resources 时不得移动");
        assert!(dir.join("resources/_common/a.dds").is_file());
        assert!(!dir.join("resources/gamedata").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_ignores_mods_without_resource_dirs() {
        let dir = temp_dir("fix-struct-noop");
        fs::write(dir.join("info.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("misc")).unwrap();

        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        assert!(
            !dir.join("resources").exists(),
            "没有可搬目录时不得创建空的 resources"
        );
        assert!(dir.join("misc").is_dir(), "白名单外的目录不得被搬动");

        // 没有 info.json 的单层套娃也不展开：链上没有 info.json 就不是模组根
        let dir2 = temp_dir("fix-struct-noinfo");
        fs::create_dir_all(dir2.join("Wrap/inner")).unwrap();
        fs::write(dir2.join("Wrap/inner/a.dds"), "a").unwrap();
        assert!(fix_mod_structure(&dir2).unwrap().is_empty());
        assert!(dir2.join("Wrap/inner/a.dds").is_file(), "无 info.json 时不得展开");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }
    #[test]
    fn fix_mod_structure_expands_empty_shell_root_with_info_json() {
        // “1385_Displayed HotKeys”：根目录 info.json + thumbnail.jpg，资源藏在数字子目录里
        let dir = temp_dir("fix-struct-empty-root");
        let original_info = r#"{"Title":"Displayed HotKeys","Author":"someone"}"#;
        fs::write(dir.join("info.json"), original_info).unwrap();
        fs::write(dir.join("thumbnail.jpg"), "jpg").unwrap();
        let inner = dir.join("1270057352");
        fs::create_dir_all(inner.join("resources/_common/drs")).unwrap();
        fs::write(inner.join("resources/_common/drs/a.sld"), "a").unwrap();

        let actions = fix_mod_structure(&dir).unwrap();
        assert_eq!(actions, vec!["1270057352/**".to_string()]);
        assert!(
            dir.join("resources/_common/drs/a.sld").is_file(),
            "resources 应上移到根目录"
        );
        assert!(!inner.exists(), "空壳数字目录应被删除");
        assert!(
            dir.join("info.json").is_file(),
            "根目录原有 info.json 必须保留"
        );
        assert_eq!(
            fs::read_to_string(dir.join("info.json")).unwrap(),
            original_info,
            "info.json 内容不得被改写"
        );
        assert!(dir.join("thumbnail.jpg").is_file());
        assert!(
            !dir.join("resources/1270057352").exists(),
            "不得把子目录整个塞进 resources"
        );

        // 幂等：已有 resources 后什么都不做
        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_keeps_normal_mod_with_info_and_resources() {
        // 正常模组：根目录同时有 info.json 和 resources —— 不得展开（即使没有 widgetui）
        let dir = temp_dir("fix-struct-normal-mod");
        fs::write(dir.join("info.json"), r#"{"Title":"Normal"}"#).unwrap();
        fs::create_dir_all(dir.join("resources/_common")).unwrap();
        fs::write(dir.join("resources/_common/a.dds"), "a").unwrap();
        fs::create_dir_all(dir.join("misc")).unwrap();
        fs::write(dir.join("misc/b.txt"), "b").unwrap();

        assert!(
            fix_mod_structure(&dir).unwrap().is_empty(),
            "正常模组不得产生任何动作"
        );
        assert!(dir.join("resources/_common/a.dds").is_file());
        assert!(dir.join("misc/b.txt").is_file());
        assert!(!dir.join("resources/misc").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_does_not_expand_two_subfolders() {
        // 根目录有 info.json + 两个子文件夹：不冒险展开
        let dir = temp_dir("fix-struct-two-shells");
        fs::write(dir.join("info.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("a/resources/_common")).unwrap();
        fs::write(dir.join("a/resources/_common/x.dds"), "x").unwrap();
        fs::create_dir_all(dir.join("b")).unwrap();
        fs::write(dir.join("b/y.txt"), "y").unwrap();

        assert!(
            fix_mod_structure(&dir).unwrap().is_empty(),
            "子文件夹不止一个时不得展开"
        );
        assert!(dir.join("a/resources/_common/x.dds").is_file());
        assert!(dir.join("b/y.txt").is_file());
        assert!(
            !dir.join("resources").exists(),
            "没有可搬目录时不得创建空的 resources"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_wraps_loose_textures_into_widgetui() {
        // “zero two 02”：根目录 info.json + thumbnail.jpg + textures/backgrounds/…
        let dir = temp_dir("fix-struct-textures");
        fs::write(dir.join("info.json"), r#"{"Title":"zero two 02"}"#).unwrap();
        fs::write(dir.join("thumbnail.jpg"), "jpg").unwrap();
        fs::create_dir_all(dir.join("textures/backgrounds")).unwrap();
        fs::write(dir.join("textures/backgrounds/mainmenu_bg.dds"), "dds").unwrap();

        let actions = fix_mod_structure(&dir).unwrap();
        assert_eq!(actions, vec!["widgetui/textures".to_string()]);
        assert!(
            dir.join("widgetui/textures/backgrounds/mainmenu_bg.dds")
                .is_file(),
            "textures 应被移入新建的 widgetui/ 下"
        );
        assert!(!dir.join("textures").exists(), "根目录的 textures 应已消失");
        assert!(dir.join("info.json").is_file(), "info.json 必须保留");
        assert!(dir.join("thumbnail.jpg").is_file());
        assert!(
            !dir.join("resources").exists(),
            "不得凭空创建 resources 目录"
        );

        // 幂等：已有 widgetui 后什么都不做
        assert!(fix_mod_structure(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_mod_structure_keeps_textures_when_widgetui_exists() {
        // 已有 widgetui + 根目录又摊了一个 textures：不合并、不塞进去
        let dir = temp_dir("fix-struct-widgetui-exists");
        fs::write(dir.join("info.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("widgetui/layouts")).unwrap();
        fs::write(dir.join("widgetui/layouts/game.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("textures/backgrounds")).unwrap();
        fs::write(dir.join("textures/backgrounds/bg.dds"), "dds").unwrap();

        assert!(
            fix_mod_structure(&dir).unwrap().is_empty(),
            "widgetui 已存在时不得产生任何动作"
        );
        assert!(
            dir.join("widgetui/layouts/game.json").is_file(),
            "原 widgetui 内容不得变动"
        );
        assert!(
            !dir.join("widgetui/textures").exists(),
            "不得把根目录 textures 塞进已有 widgetui"
        );
        assert!(
            dir.join("textures/backgrounds/bg.dds").is_file(),
            "根目录 textures 必须原位保留"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_mod_root_keeps_loose_files() {
        let dir = temp_dir("root-loose");
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("loose.dds"), "x").unwrap();
        // 根目录有散文件时不得下钻，否则散文件会被丢掉
        assert_eq!(detect_mod_root(&dir), dir);

        let dir2 = temp_dir("root-wrap");
        fs::create_dir_all(dir2.join("Wrapped/inner")).unwrap();
        fs::write(dir2.join("Wrapped/a.dds"), "x").unwrap();
        assert_eq!(detect_mod_root(&dir2), dir2.join("Wrapped"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn ensure_info_json_matches_game_format_and_never_overwrites() {
        let dir = temp_dir("info-json");
        let action = ensure_info_json(&dir, "My Mod", " Author X ", "desc <p>html</p>").unwrap();
        let written = match action {
            InfoAction::Written(path) => path,
            other => panic!("应写入 info.json，实际：{other:?}"),
        };
        let text = fs::read_to_string(&written).unwrap();
        // 与游戏自己写出的字节结构一致：四键、字母序、紧凑 JSON、无 BOM
        assert_eq!(
            text,
            r#"{"Author":"Author X","CacheStatus":0,"Description":"desc <p>html</p>","Title":"My Mod"}"#
        );
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["Author", "CacheStatus", "Description", "Title"]);

        // 已有 info.json 绝不覆盖
        fs::write(dir.join("info.json"), r#"{"Title":"keep"}"#).unwrap();
        assert_eq!(
            ensure_info_json(&dir, "X", "Y", "Z").unwrap(),
            InfoAction::AlreadyExists
        );
        assert_eq!(
            fs::read_to_string(dir.join("info.json")).unwrap(),
            r#"{"Title":"keep"}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn thumbnail_png_becomes_jpg_and_missing_thumbnail_is_written() {
        let dir = temp_dir("thumb-rename");
        assert!(normalize_thumbnail_extension(&dir).is_none());
        assert!(!has_thumbnail(&dir));

        fs::write(dir.join("thumbnail.png"), "PNG").unwrap();
        assert_eq!(
            normalize_thumbnail_extension(&dir).as_deref(),
            Some("thumbnail.jpg")
        );
        assert!(!dir.join("thumbnail.png").exists(), "png 应被改名");
        assert_eq!(fs::read_to_string(dir.join("thumbnail.jpg")).unwrap(), "PNG");
        assert!(has_thumbnail(&dir));

        // 已存在 jpg 时幂等
        assert_eq!(
            normalize_thumbnail_extension(&dir).as_deref(),
            Some("thumbnail.jpg")
        );

        // 没有任何缩略图时，用下载到的字节写 thumbnail.jpg
        let dir2 = temp_dir("thumb-write");
        let path = write_thumbnail(&dir2, b"JPGDATA").unwrap();
        assert!(path.ends_with("thumbnail.jpg"));
        assert_eq!(fs::read_to_string(dir2.join("thumbnail.jpg")).unwrap(), "JPGDATA");
        assert!(write_thumbnail(&dir2, b"").is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    // ---- 兜底：移动到 local ----

    #[test]
    fn localize_moves_dir_from_subscribed_to_local() {
        let dir = temp_dir("localize");
        let root = dir.join("game");
        fs::create_dir_all(root.join("subscribed")).unwrap();
        fs::create_dir_all(root.join("local")).unwrap();
        let src = make_mod_dir(&root, "subscribed", "313131_Probe");

        let target = resolve_localize_target(&root, 313131, None, false).unwrap();
        assert_eq!(target.folder_name, "Probe", "local 下的目录名必须去掉 ID 前缀");
        assert_eq!(target.source_folder_name, "313131_Probe");
        let backup = move_to_local(&target).unwrap();
        assert!(backup.is_none());

        assert!(!src.exists(), "subscribed 下的目录应已移走");
        assert!(root.join("local").join("Probe").join("info.json").is_file());

        // 只给 local 目录名（无前缀）也能定位到（WorkshopID=0 的记录靠这个卸载）
        let resolved = resolve_uninstall_target(&root, 313131, Some("Probe")).unwrap();
        assert_eq!(resolved.kind, "local");
        assert_eq!(resolved.folder_name, "Probe");

        // local 下已有同名目录、不允许覆盖：拒绝且不移动任何东西
        make_mod_dir(&root, "subscribed", "313132_Probe");
        let err = resolve_localize_target(&root, 313132, None, false).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.localTargetExists"), "实际错误：{err}");
        assert!(
            root.join("subscribed").join("313132_Probe").is_dir(),
            "拒绝时不得移动任何东西"
        );

        // 允许覆盖：旧目录改名 .bak- 保留，新目录到位
        make_mod_dir(&root, "local", "Probe");
        let overwrite = resolve_localize_target(&root, 313132, None, true).unwrap();
        assert!(overwrite.backup.is_some(), "覆盖前必须先备份旧目录");
        let backup = move_to_local(&overwrite).unwrap().expect("覆盖安装必须返回备份路径");
        assert!(backup.is_dir(), "旧目录备份必须保留");
        assert!(root.join("local").join("Probe").is_dir());

        let _ = fs::remove_dir_all(&dir);
    }

    // ---- 卸载：安全校验 ----

    fn make_mod_dir(root: &Path, kind: &str, name: &str) -> PathBuf {
        let dir = root.join(kind).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("info.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn uninstall_resolves_only_the_matching_subscribed_dir() {
        let dir = temp_dir("uninstall-ok");
        let root = dir.join("game");
        fs::create_dir_all(root.join("subscribed")).unwrap();
        let target = make_mod_dir(&root, "subscribed", "424242_Probe");
        make_mod_dir(&root, "subscribed", "424243_Other");
        make_mod_dir(&root, "local", "424242_Probe");
        let backup = root.join("subscribed").join("424242_Probe.bak-1700000000000");
        fs::create_dir_all(&backup).unwrap();

        let resolved = resolve_uninstall_target(&root, 424242, None).unwrap();
        assert_eq!(resolved.folder_name, "424242_Probe");
        assert_eq!(resolved.dir, fs::canonicalize(&target).unwrap());

        let (files, bytes) = uninstall(&resolved).unwrap();
        assert_eq!(files, 1);
        assert!(bytes > 0);
        assert!(!target.exists(), "目标目录必须被删除");
        assert!(root.join("subscribed").join("424243_Other").is_dir(), "其它模组不得受影响");
        assert!(root.join("local").join("424242_Probe").is_dir(), "local 目录不得受影响");
        assert!(backup.is_dir(), "旧版本备份必须保留");
        assert_eq!(list_version_backups(&root.join("subscribed"), "424242_Probe").len(), 1);

        // subscribed 下的已删：此时应该解析到 local 下的同名目录（而不是“本地没有”）
        let fallback = resolve_uninstall_target(&root, 424242, None).unwrap();
        assert_eq!(fallback.kind, "local");

        // 两边都没有了，才报“本地没有”
        fs::remove_dir_all(root.join("local").join("424242_Probe")).unwrap();
        let err = resolve_uninstall_target(&root, 424242, None).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.noLocalDir"), "实际错误：{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_rejects_bad_ids_hints_and_ambiguous_dirs() {
        let dir = temp_dir("uninstall-bad");
        let root = dir.join("game");
        fs::create_dir_all(root.join("subscribed")).unwrap();

        assert!(resolve_uninstall_target(&root, 0, None).is_err());
        assert!(resolve_uninstall_target(&root, -5, None).is_err());
        assert!(resolve_uninstall_target(&root, 7, Some("../../evil")).is_err());
        assert!(resolve_uninstall_target(&root, 7, Some("other_name")).is_err());

        make_mod_dir(&root, "subscribed", "777_A");
        make_mod_dir(&root, "subscribed", "777_B");
        let err = resolve_uninstall_target(&root, 777, None).unwrap_err();
        assert!(err.starts_with("aoe2mm:err:install.multipleCandidates"), "实际错误：{err}");
        assert!(root.join("subscribed").join("777_A").is_dir(), "拒绝时不得删除任何东西");

        fs::remove_dir_all(root.join("subscribed").join("777_B")).unwrap();
        let resolved = resolve_uninstall_target(&root, 777, None).unwrap();
        assert_eq!(resolved.folder_name, "777_A");
        // 提示名不以 {id}_ 开头时被忽略，最终仍以真实目录为准
        assert_eq!(
            resolve_uninstall_target(&root, 777, Some("wrong_name"))
                .unwrap()
                .folder_name,
            "777_A"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_rejects_junction() {
        let dir = temp_dir("uninstall-junction");
        let root = dir.join("game");
        fs::create_dir_all(root.join("subscribed")).unwrap();
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();

        let link = root.join("subscribed").join("555_Link");
        let created = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status();
        match created {
            Ok(status) if status.success() => {}
            _ => {
                eprintln!("跳过：本机无法创建 junction（mklink /J 失败）");
                let _ = fs::remove_dir_all(&dir);
                return;
            }
        }

        let err = resolve_uninstall_target(&root, 555, None).unwrap_err();
        // 当前 Rust 版本下 junction 被 symlink_metadata 报告为 is_dir=false，
        // 提前在 notDir 分支拒绝；核心意图是 junction 不得被删除（外部文件保留）。
        assert!(
            err.starts_with("aoe2mm:err:install."),
            "实际错误：{err}"
        );
        assert!(outside.join("keep.txt").is_file(), "外部文件不得被删");

        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&dir);
    }
}
