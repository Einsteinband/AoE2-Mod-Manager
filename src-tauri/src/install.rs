use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

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
        return Err("压缩包条目包含空字节".to_string());
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("压缩包条目为绝对路径，已拒绝：{name}"));
    }
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return Err(format!("压缩包条目包含盘符，已拒绝：{name}"));
    }

    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("压缩包条目包含路径穿越（..），已拒绝：{name}"));
        }
        if part.contains(':') {
            return Err(format!("压缩包条目包含非法字符，已拒绝：{name}"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(format!("压缩包条目路径为空：{name}"));
    }
    for comp in out.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("压缩包条目路径不规范，已拒绝：{name}")),
        }
    }
    Ok(out)
}

/// 解压到指定目录，返回 (文件数, 总字节)
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(u64, u64), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("无法打开下载的压缩包：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("压缩包损坏或不是 ZIP 格式：{e}"))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!("压缩包条目过多（{}），已拒绝", archive.len()));
    }

    fs::create_dir_all(dest).map_err(|e| format!("无法创建解压目录：{e}"))?;

    let mut files = 0u64;
    let mut total = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取压缩包第 {index} 项失败：{e}"))?;

        if let Some(mode) = entry.unix_mode() {
            // 0o120000 = 符号链接，Windows 上不应出现，出现即视为恶意
            if mode & 0o170000 == 0o120000 {
                return Err("压缩包包含符号链接，已拒绝解压".to_string());
            }
        }

        let raw_name = entry.name().to_string();
        if raw_name.ends_with('/') && entry.is_dir() {
            let rel = match safe_entry_path(&raw_name) {
                Ok(p) => p,
                Err(e) => return Err(e),
            };
            fs::create_dir_all(dest.join(rel)).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if entry.is_dir() {
            continue;
        }

        let rel = safe_entry_path(&raw_name)?;
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }

        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("写入文件失败（{}）：{e}", out_path.display()))?;
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|e| format!("解压条目失败（{raw_name}）：{e}"))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_TOTAL_BYTES {
                return Err("解压后体积超过 4 GB，已中止".to_string());
            }
            out.write_all(&buffer[..n])
                .map_err(|e| format!("写入失败（可能磁盘已满）：{e}"))?;
        }
        files += 1;
    }

    if files == 0 {
        return Err("压缩包里没有任何文件".to_string());
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
        return Err(format!(
            "压缩包内出现可执行文件，出于安全考虑已拒绝安装：{name}（若确认安全，可自行解压后手动放入 subscribed）"
        ));
    }
    if acc.files == 0 {
        return Err("压缩包内没有任何可安装的文件（只有空目录或系统缓存文件）".to_string());
    }
    log::info!(
        target: "install",
        "内容检查通过：{} 个文件（无 info.json、无标准目录也算有效模组）",
        acc.files
    );
    Ok(())
}

pub fn install_dir_name(mod_id: i64, title: &str) -> String {
    format!("{mod_id}_{}", sanitize_component(title))
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
    let text = serde_json::to_string(&data).map_err(|e| format!("info.json 序列化失败：{e}"))?;
    fs::write(&path, text.as_bytes()).map_err(|e| format!("写入 info.json 失败：{e}"))?;
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
        return Err("缩略图内容为空".to_string());
    }
    let path = dir.join("thumbnail.jpg");
    fs::write(&path, bytes).map_err(|e| format!("写入缩略图失败：{e}"))?;
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
        return Err("WorkshopID 无效，拒绝卸载".to_string());
    }
    let prefix = format!("{mod_id}_");

    // 1) 先在 subscribed（游戏下载位置）找；没有再看 local（本工具兜底转过去的位置）
    let mut chosen: Option<(String, Vec<String>)> = None;
    for kind in ["subscribed", "local"] {
        let base = mods_root.join(kind);
        if !base.is_dir() {
            continue;
        }
        let names = candidate_dirs(&base, &prefix, folder_hint);
        if !names.is_empty() {
            chosen = Some((kind.to_string(), names));
            break;
        }
    }
    let Some((kind, mut names)) = chosen else {
        return Err(format!(
            "本地没有该模组的目录（subscribed / local 里都没有以“{prefix}”开头的文件夹）"
        ));
    };
    if names.len() > 1 {
        return Err(format!(
            "本地存在多个匹配目录，无法确定要删除哪一个：{}。请手动处理后重试。",
            names.join(" / ")
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
        return Err(format!("未知的模组来源：{kind}"));
    }
    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err("模组文件夹名为空，拒绝删除".to_string());
    }
    let base = mods_root.join(kind);
    if !base.is_dir() {
        return Err(format!("目录不存在：{}", base.display()));
    }
    validate_child(kind.to_string(), &base, folder_name.to_string())
}

/// ②③④ 的公共校验：单层普通名 + 真实目录（非符号链接 / junction）+ 规范化后父目录必须正好是 `base`
fn validate_child(kind: String, base: &Path, folder_name: String) -> Result<UninstallTarget, String> {

    // 2) 必须是单层普通名字
    if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
        return Err(format!("目录名不合法，拒绝卸载：{folder_name}"));
    }
    let mut comps = Path::new(&folder_name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(format!("目录名不是单层文件夹，拒绝卸载：{folder_name}")),
    }

    let dir = base.join(&folder_name);

    // 3) 必须是真实目录（排除符号链接 / junction / 挂载点）
    let meta = fs::symlink_metadata(&dir)
        .map_err(|e| format!("无法读取目标目录 {}：{e}", dir.display()))?;
    if !meta.is_dir() {
        return Err(format!("目标不是目录：{}", dir.display()));
    }
    if meta.file_type().is_symlink() {
        return Err(format!("目标目录是符号链接，拒绝卸载：{}", dir.display()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "目标目录是 junction / 重解析点，拒绝卸载：{}",
                dir.display()
            ));
        }
    }

    // 4) 规范化后父目录必须正好是 subscribed / local（不用 starts_with，杜经 ../ 绕过）
    let real_parent = fs::canonicalize(base)
        .map_err(|e| format!("无法规范化 {}：{e}", base.display()))?;
    let real_dir = fs::canonicalize(&dir)
        .map_err(|e| format!("无法规范化 {}：{e}", dir.display()))?;
    if real_dir.parent() != Some(real_parent.as_path()) {
        return Err(format!(
            "目标目录解析后不在 {} 下，拒绝卸载：{}",
            kind,
            real_dir.display()
        ));
    }
    if real_dir.file_name().and_then(|n| n.to_str()) != Some(folder_name.as_str()) {
        return Err("目标目录名与校验结果不一致，拒绝卸载".to_string());
    }

    Ok(UninstallTarget { dir: real_dir, parent: real_parent, folder_name, kind })
}

/// 删除 `resolve_uninstall_target` 返回的那一个目录（不递归父级），返回 (文件数, 字节数)。
pub fn uninstall(target: &UninstallTarget) -> Result<(u64, u64), String> {
    if target.dir.parent() != Some(target.parent.as_path()) {
        return Err("目标目录不在 subscribed 下，拒绝删除".to_string());
    }
    let meta = fs::symlink_metadata(&target.dir)
        .map_err(|e| format!("无法读取目标目录：{e}"))?;
    if !meta.is_dir() {
        return Err(format!("目标不是目录：{}", target.dir.display()));
    }

    let (files, bytes) = dir_usage(&target.dir);
    fs::remove_dir_all(&target.dir).map_err(|e| {
        format!(
            "删除目录失败（可能被游戏或杀毒软件占用）：{}\n{e}",
            target.dir.display()
        )
    })?;
    if target.dir.exists() {
        return Err(format!("删除后目录仍然存在：{}", target.dir.display()));
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
    let subscribed = mods_root.join("subscribed");
    fs::create_dir_all(&subscribed).map_err(|e| format!("无法创建 subscribed 目录：{e}"))?;

    let target_name = install_dir_name(mod_id, title);
    let target = subscribed.join(&target_name);
    let relative_staging = staging_mod_root
        .strip_prefix(mods_root)
        .map_err(|_| "暂存目录必须位于模组根目录内，以保证安装是原子改名".to_string())?;

    let mut backup_dir: Option<String> = None;
    let mut updated = false;

    if target.exists() {
        // 旧标记只用于兼容早先版本装过的模组；新安装不再往游戏目录写任何文件
        let legacy_ours = read_marker(&target)
            .map(|m| m.mod_id == mod_id)
            .unwrap_or(false);
        let ours = owned_before || legacy_ours;
        if !ours && !force {
            return Err(format!(
                "目标文件夹已存在且不是本工具安装的，已停止：{}\n如果确认要替换，请在界面上勾选“允许覆盖”后重试（旧目录会先改名备份，不会删除）。",
                target.display()
            ));
        }
        updated = ours;
        let backup = subscribed.join(format!("{target_name}.bak-{}", crate::scan::now_ms()));
        fs::rename(&target, &backup).map_err(|e| {
            format!(
                "无法备份已存在的目录（可能被游戏占用）：{}\n{e}",
                target.display()
            )
        })?;
        backup_dir = Some(backup.to_string_lossy().to_string());
    }

    // 同一卷内的目录改名是原子的；暂存目录位于根目录下，因此不会跨盘
    let source = mods_root.join(relative_staging);
    fs::rename(&source, &target).map_err(|e| {
        format!(
            "安装失败（改名阶段）：{}\n{e}",
            target.display()
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
    pub folder_name: String,
}

/// 通用同卷改名，成功后做双向校验
pub fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() {
        return Err(format!("源目录不存在：{}", from.display()));
    }
    if to.exists() {
        return Err(format!("目标目录已存在，已中止：{}", to.display()));
    }
    fs::rename(from, to).map_err(|e| {
        format!(
            "移动目录失败（可能被游戏或杀毒软件占用）：{}\n{e}",
            from.display()
        )
    })?;
    if from.exists() || !to.is_dir() {
        return Err(format!(
            "移动后校验失败：{} -> {}",
            from.display(),
            to.display()
        ));
    }
    Ok(())
}

/// 校验并解析“把 subscribed/<id>_* 挪到 local/” 的目标；任何异常直接拒绝。
pub fn resolve_localize_target(
    mods_root: &Path,
    mod_id: i64,
    folder_hint: Option<&str>,
) -> Result<LocalizeTarget, String> {
    let resolved = resolve_uninstall_target(mods_root, mod_id, folder_hint)?;
    if resolved.kind == "local" {
        return Err(format!(
            "该模组已经在 local 下（{}），无需转换",
            resolved.dir.display()
        ));
    }
    let local = mods_root.join("local");
    fs::create_dir_all(&local).map_err(|e| format!("无法创建 local 目录：{e}"))?;
    let real_local =
        fs::canonicalize(&local).map_err(|e| format!("无法规范化 {}：{e}", local.display()))?;
    let to = real_local.join(&resolved.folder_name);
    if to.exists() {
        return Err(format!(
            "local 下已存在同名文件夹，已中止：{}",
            to.display()
        ));
    }
    Ok(LocalizeTarget {
        from: resolved.dir,
        to,
        local_root: real_local,
        folder_name: resolved.folder_name,
    })
}

/// 执行移动（subscribed → local）
pub fn move_to_local(target: &LocalizeTarget) -> Result<(), String> {
    if target.to.parent() != Some(target.local_root.as_path()) {
        return Err("目标目录不在 local 下，拒绝移动".to_string());
    }
    move_dir(&target.from, &target.to)
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
        assert!(err.contains("路径穿越"), "实际错误：{err}");
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
        assert!(Path::new(&backup).join("widgetui/textures/a.dds").is_file(), "旧版本文件应保留在备份里");
        assert!(Path::new(&second.target_dir).join("widgetui/textures/b.dds").is_file());

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
        assert!(err.contains("允许覆盖"), "实际错误：{err}");
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
        assert!(err.contains("没有任何可安装的文件"), "实际错误：{err}");

        fs::write(dir.join(".DS_Store"), "x").unwrap();
        fs::create_dir_all(dir.join("__MACOSX")).unwrap();
        fs::write(dir.join("__MACOSX/junk.txt"), "x").unwrap();
        let err = validate_structure(&dir).unwrap_err();
        assert!(err.contains("没有任何可安装的文件"), "实际错误：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structure_check_rejects_executables() {
        let dir = temp_dir("struct-exe");
        fs::create_dir_all(dir.join("resources")).unwrap();
        fs::write(dir.join("resources/x.txt"), "x").unwrap();
        fs::write(dir.join("resources/setup.exe"), "MZ").unwrap();
        let err = validate_structure(&dir).unwrap_err();
        assert!(err.contains("可执行文件"), "实际错误：{err}");
        assert!(err.contains("setup.exe"), "错误信息应指出具体文件：{err}");
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

        let target = resolve_localize_target(&root, 313131, None).unwrap();
        assert_eq!(target.folder_name, "313131_Probe");
        move_to_local(&target).unwrap();

        assert!(!src.exists(), "subscribed 下的目录应已移走");
        assert!(root.join("local").join("313131_Probe").join("info.json").is_file());

        // 已经在 local：不允许重复转换
        let err = resolve_localize_target(&root, 313131, None).unwrap_err();
        assert!(err.contains("已经在 local"), "实际错误：{err}");

        // local 下已有同名目录：拒绝且不移动任何东西
        make_mod_dir(&root, "subscribed", "313132_Probe");
        fs::create_dir_all(root.join("local").join("313132_Probe")).unwrap();
        let err = resolve_localize_target(&root, 313132, None).unwrap_err();
        assert!(err.contains("已存在同名文件夹"), "实际错误：{err}");
        assert!(
            root.join("subscribed").join("313132_Probe").is_dir(),
            "拒绝时不得移动任何东西"
        );

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
        assert!(err.contains("本地没有该模组的目录"), "实际错误：{err}");

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
        assert!(err.contains("多个匹配目录"), "实际错误：{err}");
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
        assert!(
            err.contains("junction") || err.contains("重解析点"),
            "实际错误：{err}"
        );
        assert!(outside.join("keep.txt").is_file(), "外部文件不得被删");

        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&dir);
    }
}
