use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::metadata::{self, Store};
use crate::models::{InstalledIndexEntry, ModEntry, ModSource, ModStats, ScanReport};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 Windows 路径风格的 key 归一化，用于和 mod-status.json 的 Path 字段比对
pub(crate) fn normalize_key(raw: &str) -> String {
    raw.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase()
}

fn friendly_io_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => "权限不足，Windows 拒绝访问该目录".to_string(),
        std::io::ErrorKind::NotFound => "路径不存在".to_string(),
        _ => err.to_string(),
    }
}

/// `108404_Name` -> (Some(108404), "Name")；无数字前缀则 (None, 原名)
fn split_folder_name(folder: &str) -> (Option<u64>, String) {
    if let Some(idx) = folder.find('_') {
        let (head, tail) = folder.split_at(idx);
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
            let rest = tail.trim_start_matches('_').trim().to_string();
            let id = head.parse::<u64>().ok();
            return (id, if rest.is_empty() { folder.to_string() } else { rest });
        }
    }
    (None, folder.to_string())
}

/// 本地特征兜底扫描的结果（向下 3 层）
#[derive(Debug, Default)]
struct Probe {
    ui: bool,
    audio: bool,
    map: bool,
    data: bool,
    files: usize,
    tags: Vec<String>,
}

const PROBE_MAX_DEPTH: usize = 3;
const PROBE_MAX_FILES: usize = 20_000;

fn push_tag(tags: &mut Vec<String>, tag: &str) {
    if tags.len() < 6 && !tags.iter().any(|t| t == tag) {
        tags.push(tag.to_string());
    }
}

impl Probe {
    /// 命中多个就归多个；前三类都没命中时统一归到“数据 / 其他”
    fn categories(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if self.ui {
            out.push("ui".to_string());
        }
        if self.audio {
            out.push("audio".to_string());
        }
        if self.map {
            out.push("map".to_string());
        }
        if self.data || out.is_empty() {
            out.push("data".to_string());
        }
        out
    }
}

fn probe_dir(dir: &Path) -> Probe {
    let mut probe = Probe::default();
    probe_walk(dir, 0, &mut probe);
    probe
}

/// 目录名与扩展名的特征检测（只看真实存在的文件，不做猜测）
fn probe_walk(dir: &Path, depth: usize, probe: &mut Probe) {
    if depth > PROBE_MAX_DEPTH || probe.files > PROBE_MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            match name.to_lowercase().as_str() {
                "sound" | "sounds" | "audio" | "voice" | "voices" => {
                    probe.audio = true;
                    push_tag(&mut probe.tags, "音频");
                }
                "widgetui" | "ui" => {
                    probe.ui = true;
                    push_tag(&mut probe.tags, "界面 UI");
                }
                "art" | "textures" => {
                    probe.ui = true;
                    push_tag(&mut probe.tags, "美术贴图");
                }
                "wpfg" => {
                    probe.ui = true;
                    push_tag(&mut probe.tags, "材质");
                }
                "gamedata" => {
                    probe.data = true;
                    push_tag(&mut probe.tags, "数据表");
                }
                "scenario" | "scenarios" => {
                    probe.map = true;
                    push_tag(&mut probe.tags, "场景");
                }
                "campaign" | "campaigns" => {
                    probe.map = true;
                    push_tag(&mut probe.tags, "战役");
                }
                "history" => push_tag(&mut probe.tags, "历史条目"),
                "localisation" | "localization" => push_tag(&mut probe.tags, "本地化"),
                _ => {}
            }
            probe_walk(&path, depth + 1, probe);
            continue;
        }

        let lower = name.to_lowercase();
        // info.json 只是模组元数据，隐藏文件同理：都不作为内容特征
        if lower.starts_with('.') || lower == "info.json" {
            continue;
        }
        probe.files += 1;
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "wav" | "mp3" | "ogg" | "wem" | "flac" => {
                probe.audio = true;
                push_tag(&mut probe.tags, "音频");
            }
            "scx" | "aoe2scenario" | "aoe2map" => {
                probe.map = true;
                push_tag(&mut probe.tags, "场景");
            }
            "aoe2campaign" | "cpn" => {
                probe.map = true;
                push_tag(&mut probe.tags, "战役");
            }
            "json" | "xml" => {
                probe.ui = true;
                push_tag(&mut probe.tags, "界面 UI");
            }
            "slp" | "smx" | "dds" => {
                probe.ui = true;
                push_tag(&mut probe.tags, "美术贴图");
            }
            "dat" | "drs" => {
                probe.data = true;
                push_tag(&mut probe.tags, "数据表");
            }
            _ => {}
        }
    }
}

#[derive(Debug, Default)]
struct InfoJson {
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
}

struct InfoRead {
    info: Option<InfoJson>,
    /// 仅当 info.json 存在却读不出来时给出原因
    error: Option<String>,
}

/// 游戏写出的 info.json 并不总是合法 JSON（常见：字符串里含裸换行）。
/// 这里在字符串字面量内把控制字符转义成 \u00XX 后再解析一次。
fn escape_raw_control_chars(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 32);
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            if escaped {
                out.push(ch);
                escaped = false;
                continue;
            }
            match ch {
                '\\' => {
                    out.push(ch);
                    escaped = true;
                }
                '"' => {
                    out.push(ch);
                    in_string = false;
                }
                c if (c as u32) < 0x20 => match c {
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    other => out.push_str(&format!("\\u{:04x}", other as u32)),
                },
                c => out.push(c),
            }
        } else {
            if ch == '"' {
                in_string = true;
            }
            out.push(ch);
        }
    }
    out
}

fn decode_text(bytes: &[u8]) -> String {
    // UTF-16LE / BE BOM
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes };
    String::from_utf8_lossy(stripped).to_string()
}

/// 描述里常有 `<p>` / `<br>` 之类的标记，转成纯文本展示（只做格式清理，不改写内容）
fn clean_description(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '<' => {
                in_tag = true;
                let mut tag = String::new();
                clone_peek_into(&mut chars, &mut tag);
                let lower = tag.to_lowercase();
                if lower.starts_with("br") || lower.starts_with("/p") || lower.starts_with("/div") {
                    out.push('\n');
                }
            }
            '>' => in_tag = false,
            _ if in_tag => {}
            c => out.push(c),
        }
    }

    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");

    // 折叠多余空行
    let mut result = String::new();
    let mut blank_run = 0;
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(trimmed);
    }
    result.trim().to_string()
}

fn clone_peek_into<I: Iterator<Item = char>>(chars: &mut std::iter::Peekable<I>, tag: &mut String) {
    while let Some(&next) = chars.peek() {
        if next == '>' {
            break;
        }
        tag.push(next);
        chars.next();
    }
}

fn read_info_json(dir: &Path) -> InfoRead {
    let path = dir.join("info.json");
    if !path.is_file() {
        return InfoRead { info: None, error: None };
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            return InfoRead {
                info: None,
                error: Some(format!("info.json 无法读取：{}", friendly_io_error(&e))),
            }
        }
    };
    let text = decode_text(&bytes);

    let value = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v,
        Err(first_err) => match serde_json::from_str::<serde_json::Value>(&escape_raw_control_chars(&text))
        {
            Ok(v) => v,
            Err(_) => {
                return InfoRead {
                    info: None,
                    error: Some(format!(
                        "info.json 内容不是合法 JSON（{first_err}），名称改用文件夹名"
                    )),
                }
            }
        },
    };

    let pick = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    InfoRead {
        info: Some(InfoJson {
            title: pick("Title"),
            author: pick("Author"),
            description: pick("Description").map(|d| clean_description(&d)).filter(|d| !d.is_empty()),
        }),
        error: None,
    }
}

#[derive(Debug, Clone, Default)]
struct StatusRecord {
    enabled: Option<bool>,
    priority: Option<i64>,
    last_update: Option<i64>,
    checksum: Option<String>,
}

/// 解析 <root>/mod-status.json（游戏本机写出的真实启用状态）
fn load_status_map(root: &Path, warnings: &mut Vec<String>) -> HashMap<String, StatusRecord> {
    let mut map = HashMap::new();
    let path = root.join("mod-status.json");
    if !path.is_file() {
        warnings.push(format!(
            "未找到 mod-status.json，模组的启用状态将显示为“未知”（路径：{}）",
            path.display()
        ));
        return map;
    }
    match fs::read(&path).map(|b| String::from_utf8_lossy(&b).to_string()) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => {
                if let Some(mods) = value.get("Mods").and_then(|m| m.as_array()) {
                    for m in mods {
                        let raw_path = m.get("Path").and_then(|v| v.as_str()).unwrap_or("");
                        if raw_path.is_empty() {
                            continue;
                        }
                        let rec = StatusRecord {
                            enabled: m.get("Enabled").and_then(|v| v.as_bool()),
                            priority: m.get("Priority").and_then(|v| v.as_i64()),
                            last_update: m
                                .get("LastUpdate")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<i64>().ok()),
                            checksum: m
                                .get("CheckSum")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        };
                        map.insert(normalize_key(raw_path), rec);
                    }
                }
            }
            Err(e) => warnings.push(format!("mod-status.json 解析失败（{e}），启用状态显示为“未知”")),
        },
        Err(e) => warnings.push(format!(
            "无法读取 mod-status.json（{}），启用状态显示为“未知”",
            friendly_io_error(&e)
        )),
    }
    map
}

fn find_thumbnail(dir: &Path) -> Option<String> {
    for name in ["thumbnail.jpg", "thumbnail.jpeg", "thumbnail.png", "thumbnail.webp"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn collect_entry(
    kind: &str,
    dir: &Path,
    folder_name: &str,
    status: &HashMap<String, StatusRecord>,
    meta: &Store,
    parent_warnings: &mut Vec<String>,
) -> ModEntry {
    let mut issues: Vec<String> = Vec::new();
    let (folder_id, name_from_folder) = split_folder_name(folder_name);

    let info_read = read_info_json(dir);
    if info_read.info.is_none() {
        match &info_read.error {
            Some(err) => {
                issues.push(err.clone());
                issues.push("名称暂用文件夹名，作者与描述标记为“未提供”".to_string());
            }
            None => issues.push(
                "缺少 info.json：名称取文件夹名，作者与描述标记为“未提供”".to_string(),
            ),
        }
    }

    let title = info_read.info.as_ref().and_then(|i| i.title.clone());
    let display_name = title
        .clone()
        .unwrap_or_else(|| name_from_folder.clone());
    let display_name_source = if title.is_some() {
        "info.json".to_string()
    } else {
        "folder".to_string()
    };

    // 分类优先级：软件自己的元数据（官方 Tag） > 本地特征兜底扫描
    let recorded = metadata::lookup(meta, folder_id, folder_name);
    // local 模组的目录名不带 `{id}_` 前缀（防止游戏反向同步订阅），
    // WorkshopID 只能从软件自己的元数据补回来，否则详情页/删除会当成“无 ID 的本地模组”
    let workshop_id = folder_id
        .filter(|id| *id > 0)
        .or_else(|| {
            recorded
                .and_then(|m| u64::try_from(m.mod_id).ok())
                .filter(|id| *id > 0)
        });
    let metadata_recorded = recorded.is_some();
    let official_tags: Vec<String> = recorded.map(metadata::display_tags).unwrap_or_default();
    let official_categories: Vec<String> = recorded
        .map(|m| metadata::categories_for_tags(&m.tag_ids, &m.tag_names))
        .unwrap_or_default();

    let mut entry_count = 0usize;
    match fs::read_dir(dir) {
        Ok(entries) => entry_count = entries.flatten().count(),
        Err(e) => issues.push(format!("无法读取模组文件夹：{}", friendly_io_error(&e))),
    }

    let (mut content_tags, categories, category_source): (Vec<String>, Vec<String>, String) =
        if !official_tags.is_empty() {
            (official_tags.clone(), official_categories, "official".to_string())
        } else {
            let probe = probe_dir(dir);
            (probe.tags.clone(), probe.categories(), "heuristic".to_string())
        };
    if entry_count == 0 && !issues.iter().any(|i| i.starts_with("无法读取")) {
        issues.push("模组文件夹为空（没有任何文件）".to_string());
    }
    // 官方标签是左侧“官方分类”的数据源，必须完整保留（最多 17 项）；
    // 推断标签只做兜底展示，截断到 6 个，且必须非空，否则该模组在左侧无法被筛到
    if category_source == "official" {
        // 不截断
    } else {
        if content_tags.is_empty() {
            content_tags.push("其他".to_string());
        }
        content_tags.truncate(6);
    }

    let key = normalize_key(&format!("{kind}/{folder_name}"));
    let status = status.get(&key).cloned().unwrap_or_default();
    if status.enabled.is_none() {
        issues.push("mod-status.json 中没有该模组的记录：启用状态/优先级未知".to_string());
    }

    if issues.iter().any(|i| i.starts_with("无法读取模组文件夹")) {
        parent_warnings.push(format!("{kind}/{folder_name}：读取受限，详情可能不完整"));
    }

    ModEntry {
        id: format!("{kind}:{folder_name}"),
        folder_name: folder_name.to_string(),
        path: dir.to_string_lossy().to_string(),
        kind: kind.to_string(),
        workshop_id,
        name_from_folder,
        display_name,
        display_name_source,
        author: info_read.info.as_ref().and_then(|i| i.author.clone()),
        description: info_read.info.as_ref().and_then(|i| i.description.clone()),
        thumbnail: find_thumbnail(dir),
        enabled: status.enabled,
        priority: status.priority,
        last_update_ms: status.last_update,
        checksum: status.checksum,
        content_tags,
        categories,
        category_source,
        official_tags,
        source: ModSource::classify(kind, workshop_id, metadata_recorded),
        metadata_recorded,
        issues,
        info_json_present: info_read.info.is_some(),
    }
}

fn scan_dir(
    kind: &str,
    dir: &Path,
    status: &HashMap<String, StatusRecord>,
    meta: &Store,
    mods: &mut Vec<ModEntry>,
    warnings: &mut Vec<String>,
) -> bool {
    if !dir.is_dir() {
        warnings.push(format!(
            "{} 目录不存在：{}",
            if kind == "local" { "本地模组" } else { "已订阅模组" },
            dir.display()
        ));
        return false;
    }
    match fs::read_dir(dir) {
        Ok(entries) => {
            let mut found = 0usize;
            for entry in entries {
                match entry {
                    Ok(e) => {
                        let path = e.path();
                        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        if !is_dir {
                            // 常见的散落文件（如 .jpg、.txt）不算模组，静默忽略
                            continue;
                        }
                        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                            warnings.push(format!("跳过无法解析名称的文件夹：{}", path.display()));
                            continue;
                        };
                        if name.starts_with('.') {
                            continue;
                        }
                        found += 1;
                        mods.push(collect_entry(kind, &path, name, status, meta, warnings));
                    }
                    Err(e) => warnings.push(format!(
                        "读取 {} 中的条目失败：{}",
                        dir.display(),
                        friendly_io_error(&e)
                    )),
                }
            }
            if found == 0 {
                warnings.push(format!("{} 目录中没有模组文件夹：{}", kind, dir.display()));
            }
        }
        Err(e) => {
            warnings.push(format!("无法打开 {} 目录：{}", dir.display(), friendly_io_error(&e)));
            return false;
        }
    }
    true
}

pub fn scan(root: &Path, meta: &Store) -> ScanReport {
    let mut warnings: Vec<String> = Vec::new();
    let root_exists = root.is_dir();
    if !root_exists {
        warnings.push(format!(
            "模组根目录不存在或不是文件夹：{}（请重新选择，或确认游戏已安装）",
            root.display()
        ));
    }

    let status = if root_exists {
        load_status_map(root, &mut warnings)
    } else {
        HashMap::new()
    };

    let local_dir: PathBuf = root.join("local");
    let subscribed_dir: PathBuf = root.join("subscribed");
    let mut mods: Vec<ModEntry> = Vec::new();
    let mut local_exists = false;
    let mut subscribed_exists = false;

    if root_exists {
        local_exists = scan_dir("local", &local_dir, &status, meta, &mut mods, &mut warnings);
        subscribed_exists =
            scan_dir("subscribed", &subscribed_dir, &status, meta, &mut mods, &mut warnings);
    }

    mods.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });

    ScanReport {
        root: Some(root.to_string_lossy().to_string()),
        root_exists,
        scanned_at_ms: now_ms(),
        local_dir: local_dir.to_string_lossy().to_string(),
        subscribed_dir: subscribed_dir.to_string_lossy().to_string(),
        local_exists,
        subscribed_exists,
        mods,
        warnings,
    }
}

/// 在线页用的轻量索引：只读目录名 + 元数据，不打开模组文件夹（不触发特征扫描）。
/// 只返回有 WorkshopID 的目录：没有 ID 的模组无法与在线列表对应。
pub fn installed_index(root: &Path, meta: &Store) -> Vec<InstalledIndexEntry> {
    let mut out: Vec<InstalledIndexEntry> = Vec::new();
    for kind in ["local", "subscribed"] {
        let base = root.join(kind);
        let Ok(entries) = fs::read_dir(&base) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let (workshop_id, _) = split_folder_name(&name);
            let recorded = metadata::lookup(meta, workshop_id, &name);
            // local 模组的目录名不带 `{id}_`（防止游戏反向同步订阅），
            // WorkshopID 只能从软件自己的元数据补回，否则在线页会把它当成未安装
            let id = workshop_id.filter(|id| *id > 0).or_else(|| {
                recorded
                    .and_then(|m| u64::try_from(m.mod_id).ok())
                    .filter(|id| *id > 0)
            });
            let Some(id) = id else { continue };
            let recorded = recorded.is_some();
            out.push(InstalledIndexEntry {
                workshop_id: id,
                kind: kind.to_string(),
                folder_name: name,
                source: ModSource::classify(kind, workshop_id, recorded),
            });
        }
    }
    out
}

/// 统计体积：只在用户选中某个模组时调用，避免整盘递归拖慢首屏
pub fn dir_stats(root: &Path) -> Result<ModStats, String> {
    const MAX_FILES: u64 = 500_000;
    let mut stack = vec![root.to_path_buf()];
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let mut truncated = false;

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) if dir == root => {
                return Err(format!("无法读取该模组文件夹（可能是权限问题）：{}", dir.display()))
            }
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(path),
                Ok(ft) if ft.is_file() => {
                    if let Ok(meta) = entry.metadata() {
                        size += meta.len();
                    }
                    count += 1;
                    if count >= MAX_FILES {
                        truncated = true;
                    }
                }
                _ => {}
            }
            if truncated {
                break;
            }
        }
        if truncated {
            break;
        }
    }

    Ok(ModStats { size_bytes: size, file_count: count, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用真实游戏目录验证扫描管线（目录不存在时跳过，避免 CI 失败）
    #[test]
    fn scan_real_game_dir() {
        let root = Path::new(r"F:\Games\AoE2DE");
        if !root.is_dir() {
            eprintln!("跳过：{} 不存在", root.display());
            return;
        }
        let report = scan(root, &Store::default());
        assert!(report.root_exists, "根目录应可访问");
        assert!(!report.mods.is_empty(), "应扫描到模组");

        let enabled = report.mods.iter().filter(|m| m.enabled == Some(true)).count();
        let disabled = report.mods.iter().filter(|m| m.enabled == Some(false)).count();
        let with_info = report.mods.iter().filter(|m| m.info_json_present).count();
        let with_thumb = report.mods.iter().filter(|m| m.thumbnail.is_some()).count();
        println!(
            "mods={} enabled={} disabled={} info.json={} thumbnail={} warnings={}",
            report.mods.len(),
            enabled,
            disabled,
            with_info,
            with_thumb,
            report.warnings.len()
        );
        for m in report.mods.iter().take(3) {
            println!(
                "- [{}] {} | 文件夹={} | id={:?} | 作者={:?} | 标签={:?} | 问题={:?}",
                m.kind, m.display_name, m.folder_name, m.workshop_id, m.author, m.content_tags, m.issues
            );
        }

        let prefixed = report.mods.iter().filter(|m| m.workshop_id.is_some()).count();
        assert!(prefixed > 0, "应能从文件夹名解析出数字前缀");
        assert!(
            report.mods.iter().all(|m| !m.categories.is_empty()),
            "每个模组都应至少归入一个分类"
        );
        let mut dist: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for m in &report.mods {
            for c in &m.categories {
                *dist.entry(c.as_str()).or_default() += 1;
            }
        }
        println!("分类分布：{dist:?}");
        let official = report.mods.iter().filter(|m| m.category_source == "official").count();
        println!("官方标签模组数：{official}");
        // 诊断：左侧栏实际会渲染的两组标签
        let mut official_tags: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        let mut inferred_tags: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for m in &report.mods {
            let bucket = if m.category_source == "official" { &mut official_tags } else { &mut inferred_tags };
            for tag in &m.content_tags {
                *bucket.entry(tag.as_str()).or_default() += 1;
            }
        }
        println!("官方分类组：{official_tags:?}");
        println!("特征推断组：{inferred_tags:?}");
        assert!(
            report.mods.iter().all(|m| !m.content_tags.is_empty()),
            "每个模组至少有一个可筛选标签，否则左侧无法点到它"
        );
        assert!(
            report.mods.iter().any(|m| m.kind == "local"),
            "应识别到 local 来源的模组"
        );
    }

    #[test]
    fn parses_messy_info_json() {
        // 该模组的 info.json 在字符串中包含裸换行（非法 JSON）且描述带 HTML，必须仍能解析
        let dir = Path::new(r"F:\Games\AoE2DE\subscribed\15162_0xDB Map Color Clarity UI 2.0b");
        if !dir.is_dir() {
            eprintln!("跳过：样例模组不存在");
            return;
        }
        let read = read_info_json(dir);
        let info = read.info.expect("含裸换行的 info.json 也应解析成功");
        assert_eq!(info.author.as_deref(), Some("OxDBAOE2"));
        let desc = info.description.expect("描述应存在");
        assert!(!desc.contains("<p>"), "描述应已去除 HTML 标签：{desc}");
        assert!(desc.contains("Version 2.0b"), "描述正文应保留：{desc}");
    }

    #[test]
    fn split_folder_name_works() {
        assert_eq!(
            split_folder_name("108404_JK_mainmenu_DressToImpress event"),
            (
                Some(108404),
                "JK_mainmenu_DressToImpress event".to_string()
            )
        );
        assert_eq!(split_folder_name("MyCampaignMod"), (None, "MyCampaignMod".to_string()));
        assert_eq!(split_folder_name("35_bad_name"), (Some(35), "bad_name".to_string()));
    }

    #[test]
    fn missing_root_is_reported_not_panicked() {
        let report = scan(Path::new(r"Z:\definitely\missing\path"), &Store::default());
        assert!(!report.root_exists);
        assert!(report.mods.is_empty());
        assert!(!report.warnings.is_empty());
    }

    fn temp_mod_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aoe2mm-scan-{tag}-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn probe_detects_audio_and_map_by_extension() {
        let dir = temp_mod_dir("probe-audio");
        fs::create_dir_all(dir.join("resources/sound/deep")).unwrap();
        fs::write(dir.join("resources/sound/deep/a.wav"), "x").unwrap();
        let probe = probe_dir(&dir);
        assert_eq!(probe.categories(), vec!["audio".to_string()]);
        assert!(probe.tags.iter().any(|t| t == "音频"));
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_mod_dir("probe-map");
        fs::create_dir_all(dir2.join("campaign/part2")).unwrap();
        fs::write(dir2.join("campaign/part2/ep1.aoe2campaign"), "x").unwrap();
        let probe2 = probe_dir(&dir2);
        assert_eq!(probe2.categories(), vec!["map".to_string()]);
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn probe_ignores_info_json_and_falls_back_to_data() {
        let dir = temp_mod_dir("probe-empty");
        fs::write(dir.join("info.json"), "{}").unwrap();
        fs::write(dir.join("readme.txt"), "x").unwrap();
        let probe = probe_dir(&dir);
        assert!(probe.files > 0, "真实文件仍需被统计");
        assert_eq!(probe.categories(), vec!["data".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_detects_ui_by_widgetui_and_json() {
        let dir = temp_mod_dir("probe-ui");
        fs::create_dir_all(dir.join("widgetui/layouts")).unwrap();
        fs::write(dir.join("widgetui/layouts/hud.json"), "{}").unwrap();
        let probe = probe_dir(&dir);
        assert_eq!(probe.categories(), vec!["ui".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_classification_covers_three_states() {
        // 有元数据记录 → 本工具安装（与目录无关）
        assert_eq!(ModSource::classify("subscribed", Some(7), true), ModSource::Tool);
        // local + WorkshopID → 本工具安装（旧版本安装未写元数据）
        assert_eq!(ModSource::classify("local", Some(7), false), ModSource::Tool);
        // subscribed + WorkshopID 无记录 → 官方订阅
        assert_eq!(ModSource::classify("subscribed", Some(7), false), ModSource::Official);
        // 无 WorkshopID（0 / None）→ 无法确定
        assert_eq!(ModSource::classify("local", None, false), ModSource::Unknown);
        assert_eq!(ModSource::classify("local", Some(0), false), ModSource::Unknown);
        assert_eq!(ModSource::classify("subscribed", None, false), ModSource::Unknown);
    }

    #[test]
    fn installed_index_reports_source_without_probing() {
        let dir = temp_mod_dir("index");
        fs::create_dir_all(dir.join("local/4242_Tool Mod")).unwrap();
        fs::create_dir_all(dir.join("subscribed/555_Official Mod")).unwrap();
        fs::create_dir_all(dir.join("local/ManualMod")).unwrap();

        let mut store = Store::default();
        store.mods.insert(
            "4242".to_string(),
            metadata::ModMeta {
                mod_id: 4242,
                title: "Tool Mod".to_string(),
                tag_ids: vec![] ,
                tag_names: vec![],
                folder_name: Some("4242_Tool Mod".to_string()),
                installed_at_ms: 0,
                source: "api.ageofempires.com".to_string(),
            },
        );

        let index = installed_index(&dir, &store);
        assert_eq!(index.len(), 2, "无 WorkshopID 的目录不应进索引：{index:?}");
        let tool = index.iter().find(|e| e.workshop_id == 4242).unwrap();
        assert_eq!(tool.source, ModSource::Tool);
        assert_eq!(tool.kind, "local");
        let official = index.iter().find(|e| e.workshop_id == 555).unwrap();
        assert_eq!(official.source, ModSource::Official);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_tags_win_over_local_heuristics() {
        let dir = temp_mod_dir("meta-win");
        let mod_dir = dir.join("subscribed/4242_Some Mod");
        fs::create_dir_all(mod_dir.join("widgetui")).unwrap();
        fs::write(mod_dir.join("widgetui/a.json"), "{}").unwrap();

        let mut store = Store::default();
        store.mods.insert(
            "4242".to_string(),
            metadata::ModMeta {
                mod_id: 4242,
                title: "Some Mod".to_string(),
                tag_ids: vec![17],
                tag_names: vec!["Sounds".to_string()],
                folder_name: Some("4242_Some Mod".to_string()),
                installed_at_ms: 0,
                source: "api.ageofempires.com".to_string(),
            },
        );

        let entry = collect_entry(
            "subscribed",
            &mod_dir,
            "4242_Some Mod",
            &HashMap::new(),
            &store,
            &mut Vec::new(),
        );
        assert_eq!(entry.category_source, "official");
        assert_eq!(entry.categories, vec!["audio".to_string()], "官方标签应覆盖 widgetui 推断");
        assert_eq!(entry.official_tags, vec!["音效".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn official_tags_are_not_truncated_for_sidebar() {
        let dir = temp_mod_dir("meta-many-tags");
        let mod_dir = dir.join("subscribed/5555_Multi Tag Mod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(mod_dir.join("info.json"), "{}").unwrap();

        let mut store = Store::default();
        store.mods.insert(
            "5555".to_string(),
            metadata::ModMeta {
                mod_id: 5555,
                title: "Multi Tag Mod".to_string(),
                tag_ids: vec![9, 10, 11, 12, 14, 15, 16, 17],
                tag_names: vec![
                    "Artificial Intelligence".to_string(),
                    "Campaign".to_string(),
                    "Data Mod".to_string(),
                    "Graphics".to_string(),
                    "Music".to_string(),
                    "Random Maps".to_string(),
                    "Scenarios".to_string(),
                    "Sounds".to_string(),
                ],
                folder_name: Some("5555_Multi Tag Mod".to_string()),
                installed_at_ms: 0,
                source: "api.ageofempires.com".to_string(),
            },
        );

        let entry = collect_entry(
            "subscribed",
            &mod_dir,
            "5555_Multi Tag Mod",
            &HashMap::new(),
            &store,
            &mut Vec::new(),
        );
        assert_eq!(entry.category_source, "official");
        assert_eq!(entry.official_tags.len(), 8, "官方标签必须全量保留给左侧栏");
        assert_eq!(entry.content_tags.len(), 8, "左侧栏按 contentTags 筛选，同样不得截断");
        assert!(entry.content_tags.contains(&"战役".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heuristic_tags_never_end_up_empty() {
        // 既没有官方记录、特征也一个都没命中：必须兜底成“其他”，否则左侧无法筛到它
        let dir = temp_mod_dir("heuristic-empty");
        let mod_dir = dir.join("subscribed/NoFeatureMod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(mod_dir.join("readme.txt"), "x").unwrap();

        let entry = collect_entry(
            "subscribed",
            &mod_dir,
            "NoFeatureMod",
            &HashMap::new(),
            &Store::default(),
            &mut Vec::new(),
        );
        assert_eq!(entry.category_source, "heuristic");
        assert_eq!(entry.content_tags, vec!["其他".to_string()]);
        assert_eq!(entry.categories, vec!["data".to_string()]);
        assert!(entry.official_tags.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heuristic_tags_are_capped_at_six() {
        let dir = temp_mod_dir("heuristic-cap");
        let mod_dir = dir.join("subscribed/ManyDirs");
        // 8 类特征目录：标签必然超过 6 个，展示要截断，但四类判定仍要全部保留
        for sub in [
            "sound", "widgetui", "gamedata", "scenario", "campaign", "art", "history", "localisation",
        ] {
            fs::create_dir_all(mod_dir.join(sub)).unwrap();
        }

        let entry = collect_entry(
            "subscribed",
            &mod_dir,
            "ManyDirs",
            &HashMap::new(),
            &Store::default(),
            &mut Vec::new(),
        );
        assert_eq!(entry.category_source, "heuristic");
        assert!(entry.content_tags.len() <= 6, "推断标签仅展示前 6 个");
        assert!(!entry.content_tags.is_empty());
        assert_eq!(
            entry.categories,
            vec!["ui".to_string(), "audio".to_string(), "map".to_string(), "data".to_string()],
            "四类判定不受标签截断影响"
        );
        let _ = fs::remove_dir_all(&dir);

        // 单一特征：标签必须能稳定给出
        let dir2 = temp_mod_dir("heuristic-single");
        let mod_dir2 = dir2.join("subscribed/OnlySound");
        fs::create_dir_all(mod_dir2.join("resources/sound/deep")).unwrap();
        fs::write(mod_dir2.join("resources/sound/deep/a.wav"), "x").unwrap();
        let entry2 = collect_entry(
            "subscribed",
            &mod_dir2,
            "OnlySound",
            &HashMap::new(),
            &Store::default(),
            &mut Vec::new(),
        );
        assert!(entry2.content_tags.iter().any(|t| t == "音频"));
        let _ = fs::remove_dir_all(&dir2);
    }
}
