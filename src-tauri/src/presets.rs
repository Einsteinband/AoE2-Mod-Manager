//! 模组预设与批量恢复（v0.3）。
//!
//! 设计约束（已实测确认）：
//! 1. 预设只存软件自己的配置目录（`%APPDATA%\com.aoe2.modmanager\presets.json`），绝不写游戏目录。
//! 2. 恢复时**只**把 `mod-status.json` 里匹配记录的 `Enabled` 改成 `true`：
//!    `CheckSum` / `LastUpdate` / `Priority` / `Unsub` 以及任何未知字段一律原样透传。
//!    `CheckSum` 是游戏对本地内容的指纹，我们不动文件也不动它，因此不存在“校验和不匹配”。
//! 3. 写前必须：检测游戏进程 → 备份原文件 → 原子替换 → 回读校验；校验失败自动回滚。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::scan::{now_ms, normalize_key};

pub const FILE_NAME: &str = "presets.json";
const BACKUP_DIR: &str = "backups";
const MAX_NAME_LEN: usize = 40;
pub const STATUS_FILE: &str = "mod-status.json";

// ---------------- 数据结构 ----------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresetItem {
    /// 文件夹名里的 Workshop ID（本地模组可能没有）
    #[serde(default)]
    pub workshop_id: Option<u64>,
    /// mod-status.json 的 Path（形如 `subscribed//20505_xxx`）。
    /// WorkshopID 缺失或为 0 时用它精确匹配，避免按名字猜。
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub priority: Option<i64>,
    /// "local" | "subscribed"
    #[serde(default)]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub items: Vec<PresetItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub presets: Vec<Preset>,
}

fn default_version() -> u32 {
    1
}

impl Default for Store {
    fn default() -> Self {
        Self { version: default_version(), presets: Vec::new() }
    }
}

/// 应用预设后的真实结果（前端据此逐项汇报，绝不四舍五入成“全部成功”）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub status_path: String,
    pub backup_path: Option<String>,
    /// 预设里记录的模组数
    pub requested: usize,
    /// 本次真正由 false 改成 true 的模组数
    pub restored: usize,
    /// 本次被覆盖式禁用（true → false，且不在预设中）的模组数
    pub disabled: usize,
    /// 预设里本来就已经启用的模组数
    pub already_enabled: usize,
    /// 回读校验后整个 mod-status.json 里 Enabled=true 的总数
    pub total_enabled_after: usize,
    /// 预设里有、但 mod-status.json 里找不到对应记录的条目
    pub not_in_status: Vec<PresetItem>,
    /// 是否真的写了文件（全部已启用时不会写）
    pub wrote: bool,
    pub message: String,
}

// ---------------- 路径 ----------------

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

pub fn backups_dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(BACKUP_DIR))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

// ---------------- 预设读写 ----------------

pub fn load(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    serde_json::from_slice::<Store>(stripped).unwrap_or_default()
}

pub fn load_for_app(app: &tauri::AppHandle) -> Store {
    match path_for(app) {
        Ok(path) => load(&path),
        Err(e) => {
            log::warn!(target: "presets", "{e}");
            Store::default()
        }
    }
}

pub fn save(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store)
        .map_err(|e| format!("预设序列化失败：{e}"))?;
    fs::write(path, text).map_err(|e| format!("无法写入预设文件 {}：{e}", path.display()))
}

/// 按 Path 去重（同名路径只保留第一条），并丢掉连 Path 都没有的条目
fn clean_items(items: Vec<PresetItem>) -> Vec<PresetItem> {
    let mut out: Vec<PresetItem> = Vec::new();
    for item in items {
        if item.path.trim().is_empty() && item.workshop_id.is_none() {
            continue;
        }
        let key = normalize_key(&item.path);
        if out.iter().any(|existing| normalize_key(&existing.path) == key) {
            continue;
        }
        out.push(item);
    }
    out
}

/// 保存 / 覆盖同名预设（纯函数，便于测试）
pub fn upsert(store: &mut Store, name: &str, items: Vec<PresetItem>) -> Result<Preset, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("预设名称不能为空".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("预设名称不能超过 {MAX_NAME_LEN} 个字符"));
    }
    let items = clean_items(items);
    if items.is_empty() {
        return Err("当前没有任何可保存的模组（需要已启用、且能在 mod-status.json 里定位）".to_string());
    }

    let ms = now_ms();
    let preset = match store
        .presets
        .iter()
        .position(|p| p.name.eq_ignore_ascii_case(name))
    {
        Some(index) => {
            let preset = &mut store.presets[index];
            preset.name = name.to_string();
            preset.items = items;
            preset.updated_at_ms = ms;
            preset.clone()
        }
        None => {
            let mut id = format!("p{ms}");
            while store.presets.iter().any(|p| p.id == id) {
                id.push('x');
            }
            let preset = Preset {
                id,
                name: name.to_string(),
                created_at_ms: ms,
                updated_at_ms: ms,
                items,
            };
            store.presets.push(preset.clone());
            preset
        }
    };
    store.presets.sort_by_key(|p| p.created_at_ms);
    Ok(preset)
}

pub fn delete(store: &mut Store, id: &str) -> Result<(), String> {
    let before = store.presets.len();
    store.presets.retain(|p| p.id != id);
    if store.presets.len() == before {
        return Err("该预设已不存在，请重新打开预设管理器".to_string());
    }
    Ok(())
}

pub fn upsert_for_app(
    app: &tauri::AppHandle,
    name: &str,
    items: Vec<PresetItem>,
) -> Result<Preset, String> {
    let path = path_for(app)?;
    let mut store = load(&path);
    let preset = upsert(&mut store, name, items)?;
    save(&path, &store)?;
    log::info!(target: "presets", "已保存预设 {}（{} 个模组）-> {}", preset.name, preset.items.len(), path.display());
    Ok(preset)
}

pub fn delete_for_app(app: &tauri::AppHandle, id: &str) -> Result<Store, String> {
    let path = path_for(app)?;
    let mut store = load(&path);
    delete(&mut store, id)?;
    save(&path, &store)?;
    log::info!(target: "presets", "已删除预设 {id}");
    Ok(store)
}

/// 应用预设：读设置里的根目录 → 定位 mod-status.json → 安全写入
pub fn apply_for_app(app: &tauri::AppHandle, id: &str) -> Result<ApplyReport, String> {
    let store = load_for_app(app);
    let preset = store
        .presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "该预设已不存在，请重新打开预设管理器".to_string())?;
    let root = crate::settings::load_for_app(app)
        .mod_root
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| "尚未设置模组根目录，请先在“本地模组”页选择游戏模组目录".to_string())?;

    let status_path = PathBuf::from(&root).join(STATUS_FILE);
    let backup_dir = backups_dir_for(app)?;
    let report = apply_items(&status_path, &backup_dir, &preset.items, false)?;
    log::info!(
        target: "presets",
        "应用预设 {}：请求 {} / 恢复 {} / 原本已启用 {} / 备份 {:?}",
        preset.name,
        report.requested,
        report.restored,
        report.already_enabled,
        report.backup_path
    );
    Ok(report)
}

fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|i| u64::try_from(i).ok()))
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
}

// ---------------- mod-status.json 安全写入（公共层：预设 / 单条勾选 / 安装登记共用） ----------------

/// 记录选择器：WorkshopID 优先，Path 兜底（本地模组的 WorkshopID 常为 0）
pub struct ModSelector {
    pub workshop_id: Option<u64>,
    pub path: String,
}

/// 一条记录是否命中（双路匹配：Path 归一化后相等 优先，其次 WorkshopID 相等）。
///
/// Path 优先：local 模组的 WorkshopID 为 0，而旧记录可能仍带着真实 ID，
/// 先比 Path 才不会误碰其它记录。
fn matches_parts(record: &Value, workshop_id: Option<u64>, path: &str) -> bool {
    let record_path = record
        .get("Path")
        .and_then(|p| p.as_str())
        .map(normalize_key)
        .unwrap_or_default();
    if !path.trim().is_empty() && !record_path.is_empty() && normalize_key(path) == record_path {
        return true;
    }
    if let (Some(a), Some(b)) = (workshop_id, record.get("WorkshopID").and_then(as_u64)) {
        if a == b {
            return true;
        }
    }
    false
}

fn matches(record: &Value, sel: &ModSelector) -> bool {
    matches_parts(record, sel.workshop_id, &sel.path)
}

fn mods_array_mut(root: &mut Value) -> Result<&mut Vec<Value>, String> {
    root.get_mut("Mods")
        .and_then(|m| m.as_array_mut())
        .ok_or_else(|| {
            "mod-status.json 缺少 Mods 数组，结构无法识别，已中止（未修改任何内容）".to_string()
        })
}

/// 一次安全写入的结果（不含业务字段）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub status_path: String,
    pub backup_path: Option<String>,
    pub total_enabled_after: usize,
    pub wrote: bool,
}

pub(crate) fn ensure_game_closed(skip_process_check: bool) -> Result<(), String> {
    if skip_process_check {
        return Ok(());
    }
    if let Some(exe) = game_process_running() {
        return Err(format!(
            "检测到游戏正在运行（{exe}）。请先完全退出游戏再操作——游戏退出时会重写 mod-status.json，覆盖本次修改。"
        ));
    }
    Ok(())
}

fn read_status(status_path: &Path) -> Result<(Vec<u8>, Value), String> {
    let raw = match fs::read(status_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "未找到 mod-status.json：{}。请先在游戏里启动一次，让游戏生成本文件后重试。",
                status_path.display()
            ))
        }
        Err(e) => return Err(format!("无法读取 {}：{e}", status_path.display())),
    };
    let root: Value = serde_json::from_slice(strip_bom(&raw))
        .map_err(|e| format!("mod-status.json 不是合法 JSON（{e}），已中止，未做任何修改"))?;
    Ok((raw, root))
}

/// 备份原始字节 → 原子替换 → 回读并与内存中的值全等比对，不一致自动回滚
fn commit_status(
    status_path: &Path,
    backup_dir: &Path,
    raw: &[u8],
    root: &Value,
) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir).map_err(|e| {
        format!(
            "无法创建备份目录 {}，已中止，未修改任何内容：{e}",
            backup_dir.display()
        )
    })?;
    let ms = now_ms();
    let mut backup_path = backup_dir.join(format!("mod-status-{ms}.json"));
    let mut suffix = 1;
    while backup_path.exists() {
        backup_path = backup_dir.join(format!("mod-status-{ms}-{suffix}.json"));
        suffix += 1;
    }
    fs::write(&backup_path, raw).map_err(|e| {
        format!(
            "备份失败（{}），已中止，未修改任何内容：{e}",
            backup_path.display()
        )
    })?;
    let backup_len = fs::metadata(&backup_path).map(|m| m.len()).unwrap_or(0);
    if backup_len != raw.len() as u64 {
        return Err(format!(
            "备份文件大小校验失败（{} / {}），已中止，未修改任何内容",
            backup_len,
            raw.len()
        ));
    }

    let text =
        serde_json::to_string(root).map_err(|e| format!("序列化 mod-status.json 失败：{e}"))?;
    let tmp_path = status_path.with_file_name(format!("{STATUS_FILE}.aoe2mm-{ms}.tmp"));
    if let Err(e) = fs::write(&tmp_path, text.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "写入临时文件失败（备份保存在 {}）：{e}",
            backup_path.display()
        ));
    }
    if let Err(e) = fs::rename(&tmp_path, status_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "替换 mod-status.json 失败（备份保存在 {}）：{e}",
            backup_path.display()
        ));
    }

    let verified = fs::read(status_path)
        .map_err(|e| {
            format!(
                "回读 mod-status.json 失败（备份保存在 {}）：{e}",
                backup_path.display()
            )
        })
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(strip_bom(&bytes))
                .map_err(|e| format!("回读的 mod-status.json 无法解析（{e}）"))
        });

    match verified {
        // 全等校验：追加记录、修正 Path 这类结构性改动同样能被覆盖
        Ok(after) if after == *root => Ok(backup_path),
        Ok(_) => {
            let _ = fs::write(status_path, raw);
            Err(format!(
                "回读校验失败：写入后的 mod-status.json 与预期不一致，已回滚原始文件。备份：{}",
                backup_path.display()
            ))
        }
        Err(e) => {
            let _ = fs::write(status_path, raw);
            Err(format!("{e}；已回滚原始文件。备份：{}", backup_path.display()))
        }
    }
}

/// 唯一写入入口：进程检查 → 读取解析 → 业务改动 →（有变化才）备份 + 原子替换 + 回读校验。
///
/// `edit` 返回 `(结果, 是否真的改了)`：`changed == false` 时不写文件、不产生备份。
pub fn update_status<T>(
    status_path: &Path,
    backup_dir: &Path,
    skip_process_check: bool,
    edit: impl FnOnce(&mut Value) -> Result<(T, bool), String>,
) -> Result<(StatusOutcome, T), String> {
    ensure_game_closed(skip_process_check)?;
    let (raw, mut root) = read_status(status_path)?;
    let (value, changed) = edit(&mut root)?;
    let total_enabled_after = count_enabled(&root);

    if !changed {
        return Ok((
            StatusOutcome {
                status_path: status_path.display().to_string(),
                backup_path: None,
                total_enabled_after,
                wrote: false,
            },
            value,
        ));
    }

    let backup_path = commit_status(status_path, backup_dir, &raw, &root)?;
    log::info!(
        target: "mod-status",
        "已安全写入 {}（回读校验通过，备份 {}）",
        status_path.display(),
        backup_path.display()
    );
    Ok((
        StatusOutcome {
            status_path: status_path.display().to_string(),
            backup_path: Some(backup_path.display().to_string()),
            total_enabled_after,
            wrote: true,
        },
        value,
    ))
}

// ---------------- 需求 1：单条启用 / 禁用 ----------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToggleOutcome {
    pub enabled: bool,
    pub previous_enabled: Option<bool>,
    pub changed: bool,
    pub total_enabled_after: usize,
    pub status_path: String,
    pub backup_path: Option<String>,
}

/// 把某一条记录的 `Enabled` 设为指定值。找不到记录 = 明确报错，绝不静默新建。
pub fn set_enabled(
    status_path: &Path,
    backup_dir: &Path,
    sel: &ModSelector,
    enabled: bool,
    skip_process_check: bool,
) -> Result<ToggleOutcome, String> {
    let mut found = false;
    let mut previous_enabled: Option<bool> = None;
    let mut changed = false;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        for record in mods.iter_mut() {
            if !matches(record, sel) {
                continue;
            }
            found = true;
            previous_enabled = record.get("Enabled").and_then(|v| v.as_bool());
            if previous_enabled == Some(enabled) {
                break;
            }
            if let Some(obj) = record.as_object_mut() {
                obj.insert("Enabled".to_string(), Value::Bool(enabled));
                changed = true;
            }
            break;
        }
        if !found {
            return Err(
                "mod-status.json 里没有该模组的记录（游戏还没登记它）。请先启动一次游戏，让它出现在启用列表里再试。"
                    .to_string(),
            );
        }
        Ok(((), changed))
    })?;

    Ok(ToggleOutcome {
        enabled,
        previous_enabled,
        changed,
        total_enabled_after: outcome.total_enabled_after,
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
    })
}

// ---------------- 批量启用 / 禁用（整个批次只写一次盘） ----------------

/// 批量操作目标。与 `ModSelector` 一一对应，另带来源信息供前端回填。
///
/// 为什么不用裸 `Vec<u64>`：本工具安装的 local 记录 `WorkshopID` 会被置 0，
/// 多个本地模组共用 0，只能靠 `Path`（`<kind>//<folder>`）区分。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchTarget {
    /// 0 或缺失一律视为“没有数字 ID”，改走 Path 匹配
    #[serde(default)]
    pub workshop_id: Option<u64>,
    /// "local" | "subscribed"
    pub kind: String,
    pub folder_name: String,
}

impl BatchTarget {
    fn selector(&self) -> ModSelector {
        ModSelector {
            workshop_id: self.workshop_id.filter(|id| *id > 0),
            path: crate::install::status_rel_path(&self.kind, self.folder_name.trim()),
        }
    }
}

/// 批量结果：未登记 / 已是目标状态 / 真正被改写，三者分开计数，绝不四舍五入成“全部成功”
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchToggleReport {
    /// 目标状态
    pub enabled: bool,
    /// 前端提交的模组数
    pub requested: usize,
    /// 本次真正被改写的记录数
    pub updated: usize,
    /// 本来就是目标状态、无需改写的记录数
    pub already: usize,
    /// mod-status.json 里找不到记录的条目数（游戏还没登记）
    pub not_in_status: usize,
    pub total_enabled_after: usize,
    pub status_path: String,
    pub backup_path: Option<String>,
    /// 是否真的写了文件（全部已一致时不写盘、不产生备份）
    pub wrote: bool,
    pub message: String,
}

/// 批量把多条记录的 `Enabled` 设为同一目标值。
///
/// **整个批次只走一次 `update_status`**：一次进程检测 → 一次读盘 → 一次业务改动 →
/// 一份备份 → 一次原子替换 → 一次回读校验。逐条调用 `set_enabled` 会产生 N 份备份，
/// 且在第 k 条失败时留下「前面已改、后面没改」的部分成功状态。
///
/// 与 `set_enabled` 的差异：找不到记录的条目**只计数不报错**（批量里混入未登记模组是常态），
/// 结果通过 `not_in_status` / `message` 汇报给用户。
pub fn batch_set_enabled(
    status_path: &Path,
    backup_dir: &Path,
    targets: &[BatchTarget],
    enabled: bool,
    skip_process_check: bool,
) -> Result<BatchToggleReport, String> {
    if targets.is_empty() {
        return Err("当前列表没有可操作的模组".to_string());
    }

    let selectors: Vec<ModSelector> = targets.iter().map(BatchTarget::selector).collect();
    let mut hits = vec![false; selectors.len()];
    let mut updated = 0usize;
    let mut already = 0usize;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        for record in mods.iter_mut() {
            if record.as_object().is_none() {
                continue;
            }
            let index = match selectors.iter().position(|sel| matches(record, sel)) {
                Some(index) => index,
                None => continue,
            };
            hits[index] = true;
            let current = record.get("Enabled").and_then(|v| v.as_bool());
            if current == Some(enabled) {
                already += 1;
                continue;
            }
            // 字段缺失等价于禁用：目标也是禁用时不必写字
            if !enabled && current.is_none() {
                continue;
            }
            if let Some(obj) = record.as_object_mut() {
                obj.insert("Enabled".to_string(), Value::Bool(enabled));
                updated += 1;
            }
        }
        Ok(((), updated > 0))
    })?;

    let not_in_status = hits.iter().filter(|hit| !**hit).count();
    let action = if enabled { "启用" } else { "禁用" };
    let message = if not_in_status == selectors.len() {
        format!(
            "{not_in_status} 个模组还没有在 mod-status.json 里登记，请先启动一次游戏让它们登记后再试。"
        )
    } else if !outcome.wrote {
        format!("当前列表已经是目标状态（{already} 个模组无需改动），未修改文件。")
    } else if not_in_status > 0 {
        format!(
            "已{action} {updated} 个模组（{already} 个原本已是目标状态），跳过 {not_in_status} 个未登记模组。现在共 {} 个模组处于启用状态，请启动游戏确认。",
            outcome.total_enabled_after
        )
    } else {
        format!(
            "已{action} {updated} 个模组（{already} 个原本已是目标状态）。现在共 {} 个模组处于启用状态，请启动游戏确认。",
            outcome.total_enabled_after
        )
    };

    log::info!(
        target: "mod-status",
        "批量{action}完成：提交 {} 个，改写 {} 个，已一致 {} 个，未登记 {} 个（wrote={}）",
        selectors.len(),
        updated,
        already,
        not_in_status,
        outcome.wrote
    );

    Ok(BatchToggleReport {
        enabled,
        requested: selectors.len(),
        updated,
        already,
        not_in_status,
        total_enabled_after: outcome.total_enabled_after,
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        wrote: outcome.wrote,
        message,
    })
}

// ---------------- 需求 3：卸载时删除记录 ----------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub status_path: String,
    pub backup_path: Option<String>,
    /// 是否真的删掉了一条记录（false = 本来就没有，属于正常）
    pub removed: bool,
    /// `Unsub` 里是否有该 WorkshopID 被清掉
    pub unsub_cleared: bool,
    pub total_enabled_after: usize,
}

/// 删除匹配的那一条记录（找不到 → `removed=false`，不写文件、不产生备份）。
/// 同时清掉 `Unsub` 里该 WorkshopID 的残留（与 `remove_record` 同一次原子写入、只产生一个备份）。
pub fn remove_record(
    status_path: &Path,
    backup_dir: &Path,
    sel: &ModSelector,
    skip_process_check: bool,
) -> Result<RemoveOutcome, String> {
    let mut removed = false;
    let mut unsub_cleared = false;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        let before = mods.len();
        mods.retain(|record| !matches(record, sel));
        removed = mods.len() != before;

        // Unsub 残留：模组已被完全移除，这个 ID 再留在 Unsub 里就是指向不存在记录的脏数据
        if let Some(id) = sel.workshop_id {
            if let Some(unsub) = root.get_mut("Unsub").and_then(|v| v.as_array_mut()) {
                let before = unsub.len();
                unsub.retain(|entry| as_u64(entry) != Some(id));
                unsub_cleared = unsub.len() != before;
            }
        }

        Ok(((), removed || unsub_cleared))
    })?;

    Ok(RemoveOutcome {
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        removed,
        unsub_cleared,
        total_enabled_after: outcome.total_enabled_after,
    })
}

// ---------------- 兜底：把记录改成 local//（并清 Unsub 残留） ----------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalizeOutcome {
    pub status_path: String,
    pub backup_path: Option<String>,
    /// 是否把已有记录的 Path 改成了 local//
    pub path_updated: bool,
    /// 原来没有记录、本次新建了一条
    pub record_added: bool,
    /// 是否把 WorkshopID 置为 0（local 模组必须为 0）
    pub workshop_id_cleared: bool,
    /// Unsub 里是否有该 WorkshopID 被清掉
    pub unsub_cleared: bool,
    pub total_enabled_after: usize,
}

/// 覆盖安装成功后刷新某条记录的 `LastUpdate`（毫秒字符串）。
///
/// 为什么不揉进 `localize_record`：那个函数的“已就位就不动文件”行为已经被测试固定下来，
/// 这里单独做一次事务性写入，工具自己的更新检测靠它判断“已经是最新”，
/// 否则刚更新完的模组会被再次误报为可更新。
pub fn touch_last_update(
    status_path: &Path,
    backup_dir: &Path,
    sel: &ModSelector,
    skip_process_check: bool,
) -> Result<bool, String> {
    let (_, changed) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        let Some(index) = mods.iter().position(|record| matches(record, sel)) else {
            return Ok((false, false));
        };
        let Some(obj) = mods[index].as_object_mut() else {
            return Ok((false, false));
        };
        let now = now_ms().to_string();
        if obj.get("LastUpdate").and_then(|v| v.as_str()) == Some(now.as_str()) {
            return Ok((false, false));
        }
        obj.insert("LastUpdate".to_string(), Value::String(now));
        Ok((true, true))
    })?;
    Ok(changed)
}

/// 把某条记录的 Path 改成 `local//<folder>`（并置为启用），同时清掉 `Unsub` 里的残留 WorkshopID。
/// 记录不存在时按游戏格式新建一条（CheckSum 写 "0"，游戏启动后自行补齐）。
///
/// **local 记录的 WorkshopID 一律写 0**：带着真实 ID 的 local 记录会被游戏当成
/// workshop 模组，在启动时反向同步成“已订阅”。
pub fn localize_record(
    status_path: &Path,
    backup_dir: &Path,
    sel: &ModSelector,
    folder_name: &str,
    title: &str,
    skip_process_check: bool,
) -> Result<LocalizeOutcome, String> {
    let new_path = format!("local//{}", folder_name.trim());
    let mut path_updated = false;
    let mut record_added = false;
    let mut workshop_id_cleared = false;
    let mut unsub_cleared = false;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        {
            let mods = mods_array_mut(root)?;
            match mods.iter().position(|record| matches(record, sel)) {
                Some(index) => {
                    let record = &mut mods[index];
                    let same_path =
                        record.get("Path").and_then(|p| p.as_str()) == Some(new_path.as_str());
                    let enabled =
                        record.get("Enabled").and_then(|v| v.as_bool()) == Some(true);
                    let id_zeroed = record.get("WorkshopID").and_then(as_u64) == Some(0);
                    if !same_path || !enabled || !id_zeroed {
                        if let Some(obj) = record.as_object_mut() {
                            if !same_path {
                                obj.insert("Path".to_string(), Value::String(new_path.clone()));
                                path_updated = true;
                            }
                            if !enabled {
                                obj.insert("Enabled".to_string(), Value::Bool(true));
                            }
                            if !id_zeroed {
                                obj.insert("WorkshopID".to_string(), Value::from(0));
                                workshop_id_cleared = true;
                            }
                        }
                    }
                }
                None => {
                    record_added = true;
                    mods.push(serde_json::json!({
                        "CheckSum": "0",
                        "Enabled": true,
                        "LastUpdate": now_ms().to_string(),
                        "Path": new_path.clone(),
                        "Priority": 1,
                        "PublishID": 0,
                        "Title": title.trim(),
                        "WorkshopID": 0,
                    }));
                }
            }
        }

        // 还在 Unsub 里的 ID 会被游戏当成“已退订”，必须清掉
        if let Some(id) = sel.workshop_id {
            if let Some(unsub) = root.get_mut("Unsub").and_then(|v| v.as_array_mut()) {
                let before = unsub.len();
                unsub.retain(|entry| as_u64(entry) != Some(id));
                unsub_cleared = unsub.len() != before;
            }
        }

        Ok((
            (),
            path_updated || record_added || workshop_id_cleared || unsub_cleared,
        ))
    })?;

    Ok(LocalizeOutcome {
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        path_updated,
        record_added,
        workshop_id_cleared,
        unsub_cleared,
        total_enabled_after: outcome.total_enabled_after,
    })
}

// ---------------- 需求 2：安装后登记 ----------------

/// 新装模组要写进 mod-status.json 的记录（Path 形如 `subscribed//20505_xxx`，双斜杠原样保留）
pub struct NewRecord {
    pub workshop_id: u64,
    pub title: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOutcome {
    pub added: bool,
    pub already_present: bool,
    pub path_fixed: Option<String>,
    pub status_path: String,
    pub backup_path: Option<String>,
    pub message: String,
}

/// 安装完成后登记：不存在则追加一条（默认启用）；已存在则只在 Path/Title 与本次安装目录不一致时修正。
/// `CheckSum` / `LastUpdate` / `Priority` / `PublishID` 等既有字段一律不动。
pub fn register_mod(
    status_path: &Path,
    backup_dir: &Path,
    rec: &NewRecord,
    skip_process_check: bool,
) -> Result<RegisterOutcome, String> {
    let mut added = false;
    let mut already_present = false;
    let mut path_fixed: Option<String> = None;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        let existing = mods.iter().position(|record| {
            if rec.workshop_id != 0
                && record.get("WorkshopID").and_then(as_u64) == Some(rec.workshop_id)
            {
                return true;
            }
            matches_parts(record, Some(rec.workshop_id), &rec.path)
        });

        if let Some(index) = existing {
            already_present = true;
            let record = &mut mods[index];
            let record_path = record
                .get("Path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            let same_path = normalize_key(&record_path) == normalize_key(&rec.path);
            let same_title =
                record.get("Title").and_then(|t| t.as_str()) == Some(rec.title.as_str());
            if same_path && same_title {
                return Ok(((), false));
            }
            if !same_path {
                path_fixed = Some(rec.path.clone());
            }
            if let Some(obj) = record.as_object_mut() {
                // 目录名是 `{id}_{清洗后标题}`，标题变了目录就变了，路径必须跟着修
                if !same_path {
                    obj.insert("Path".to_string(), Value::String(rec.path.clone()));
                }
                if !same_title {
                    obj.insert("Title".to_string(), Value::String(rec.title.clone()));
                }
            }
            return Ok(((), true));
        }

        added = true;
        mods.push(serde_json::json!({
            "CheckSum": "0",
            "Enabled": true,
            "LastUpdate": now_ms().to_string(),
            "Path": rec.path.clone(),
            "Priority": 1,
            "PublishID": 0,
            "Title": rec.title.clone(),
            "WorkshopID": rec.workshop_id,
        }));
        Ok(((), true))
    })?;

    let message = if added {
        format!("已登记到 mod-status.json 并自动启用（Path={}）", rec.path)
    } else if path_fixed.is_some() {
        format!(
            "mod-status.json 里已有该模组记录，已把 Path 修正为 {}（沿用原有启用状态）",
            rec.path
        )
    } else if already_present {
        "mod-status.json 里已有该模组记录，未做改动".to_string()
    } else {
        "未写入 mod-status.json".to_string()
    };

    Ok(RegisterOutcome {
        added,
        already_present,
        path_fixed,
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        message,
    })
}

// ---------------- 预设批量应用（覆盖式，薄封装） ----------------

/// 应用预设：**覆盖式**。所有记录先视为禁用，只有预设内的记录置为启用。
/// `CheckSum` / `LastUpdate` / `Priority` / `Unsub` 与未知字段一律原样透传。
/// `skip_process_check` 只给单元测试用。
pub fn apply_items(
    status_path: &Path,
    backup_dir: &Path,
    items: &[PresetItem],
    skip_process_check: bool,
) -> Result<ApplyReport, String> {
    if items.is_empty() {
        return Err("该预设是空的，没有可应用的模组".to_string());
    }

    let mut hits = vec![false; items.len()];
    // 预设内且原本就是启用状态
    let mut enabled_now = 0usize;
    let mut to_enable = 0usize;
    let mut to_disable = 0usize;

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;
        for record in mods.iter_mut() {
            if record.as_object().is_none() {
                continue;
            }
            let hit = items
                .iter()
                .position(|item| matches_parts(record, item.workshop_id, &item.path));
            if let Some(index) = hit {
                hits[index] = true;
            }
            // 覆盖式：命中预设 = true，其余 = false
            let target = hit.is_some();
            let current = record.get("Enabled").and_then(|v| v.as_bool());

            if current == Some(target) {
                if target {
                    enabled_now += 1;
                }
                continue;
            }
            // 字段缺失等价于禁用：目标也是禁用时不必写字
            if !target && current.is_none() {
                continue;
            }
            if let Some(obj) = record.as_object_mut() {
                obj.insert("Enabled".to_string(), Value::Bool(target));
                if target {
                    to_enable += 1;
                } else {
                    to_disable += 1;
                }
            }
        }
        Ok(((), to_enable + to_disable > 0))
    })?;

    let not_in_status: Vec<PresetItem> = items
        .iter()
        .enumerate()
        .filter(|(index, _)| !hits[*index])
        .map(|(_, item)| item.clone())
        .collect();

    // 现状已与该预设完全一致：不写文件，也就不产生备份
    if !outcome.wrote {
        return Ok(ApplyReport {
            status_path: outcome.status_path,
            backup_path: None,
            requested: items.len(),
            restored: 0,
            disabled: 0,
            already_enabled: enabled_now,
            total_enabled_after: outcome.total_enabled_after,
            not_in_status,
            wrote: false,
            message: format!(
                "当前配置已与该预设一致（预设内 {} 个模组已启用，其余均已禁用），未修改文件。",
                enabled_now
            ),
        });
    }

    let message = format!(
        "已按预设覆盖配置：启用 {} 个（其中原本已启用 {} 个），禁用 {} 个不在预设中的模组，未找到记录 {} 个。现在共 {} 个模组处于启用状态，请启动游戏确认。",
        to_enable,
        enabled_now,
        to_disable,
        not_in_status.len(),
        outcome.total_enabled_after
    );
    Ok(ApplyReport {
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        requested: items.len(),
        restored: to_enable,
        disabled: to_disable,
        already_enabled: enabled_now,
        total_enabled_after: outcome.total_enabled_after,
        not_in_status,
        wrote: true,
        message,
    })
}

// ---------------- v0.2：手动拖拽排序（Priority 1..n） ----------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PriorityOutcome {
    pub status_path: String,
    pub backup_path: Option<String>,
    /// 本次真正被改写 Priority 的记录数
    pub updated: usize,
    /// 参与排序的记录总数（= 写入后 Priority 的最大值）
    pub total: usize,
    /// mod-status.json 里有、但前端列表里没有的记录（磁盘上已不存在），统一排在末尾
    pub unlisted: Vec<String>,
    pub wrote: bool,
}

/// `ModEntry.id`（`local:目录名` / `subscribed:目录名`）→ mod-status.json 的 Path 归一化键。
///
/// 故意**不**接受 WorkshopID：本地模组的 WorkshopID 常为 0、手动放入的根本没有，
/// 用来源+目录名才是唯一且稳定的。
fn priority_key(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let (kind, folder) = raw.split_once(':').ok_or_else(|| {
        format!("无法识别的模组 ID：{raw}（应为 local:目录名 或 subscribed:目录名）")
    })?;
    if kind != "local" && kind != "subscribed" {
        return Err(format!("无法识别的模组 ID：{raw}（来源只能是 local / subscribed）"));
    }
    if folder.is_empty() || folder.contains('/') || folder.contains('\\') || folder.contains("..") {
        return Err(format!("模组文件夹名不合法：{raw}"));
    }
    Ok(normalize_key(&crate::install::status_rel_path(kind, folder)))
}

/// 把前端拖拽后的顺序写进 `mod-status.json` 的 `Priority`：1, 2, 3… 连续且不重复。
///
/// 校验：数组非空 → 每个 ID 合法 → 数组内不重复 → 每条都能在 mod-status.json 找到记录。
/// 任一项不通过就直接报错，此时 `update_status` 保证**完全没有写盘**。
/// 列表之外的记录（磁盘上已消失、前端扫描不到）不丢弃，按原有相对顺序排在末尾，
/// 这样 Priority 永远是 1..n 的连续整数，游戏不会遇到空档或并列。
/// 其余字段（CheckSum / Enabled / LastUpdate / Unsub…）一律原样透传。
pub fn reorder_priority(
    status_path: &Path,
    backup_dir: &Path,
    ordered: &[String],
    skip_process_check: bool,
) -> Result<PriorityOutcome, String> {
    if ordered.is_empty() {
        return Err("排序列表为空，未修改任何内容".to_string());
    }

    let mut wanted: Vec<String> = Vec::with_capacity(ordered.len());
    for raw in ordered {
        let key = priority_key(raw)?;
        if wanted.contains(&key) {
            return Err(format!(
                "排序列表里出现了重复项：{raw}，已中止，未修改任何内容"
            ));
        }
        wanted.push(key);
    }

    let mut updated = 0usize;
    let mut total = 0usize;
    let mut unlisted: Vec<String> = Vec::new();

    let (outcome, ()) = update_status(status_path, backup_dir, skip_process_check, |root| {
        let mods = mods_array_mut(root)?;

        let mut by_key: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (index, record) in mods.iter().enumerate() {
            if let Some(path) = record.get("Path").and_then(|p| p.as_str()) {
                if !path.trim().is_empty() {
                    by_key.entry(normalize_key(path)).or_insert(index);
                }
            }
        }

        // 数量一致性：前端传来的每一个 ID 都必须能在文件里定位到
        let missing: Vec<String> = ordered
            .iter()
            .zip(wanted.iter())
            .filter(|(_, key)| !by_key.contains_key(*key))
            .map(|(raw, _)| raw.clone())
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "以下模组在 mod-status.json 里没有记录，排序已中止（未修改任何内容）：{}。请先启动一次游戏，让游戏登记这些模组。",
                missing.join("、")
            ));
        }

        let mut final_order: Vec<usize> = Vec::with_capacity(mods.len());
        let mut in_list: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for key in &wanted {
            if let Some(index) = by_key.get(key).copied() {
                final_order.push(index);
                in_list.insert(index);
            }
        }
        for index in 0..mods.len() {
            if in_list.contains(&index) {
                continue;
            }
            let path = mods[index]
                .get("Path")
                .and_then(|p| p.as_str())
                .map(|p| p.to_string())
                .unwrap_or_default();
            if !path.is_empty() {
                unlisted.push(path);
            }
            final_order.push(index);
        }

        total = final_order.len();
        let mut changed = false;
        for (slot, index) in final_order.iter().enumerate() {
            let target = (slot + 1) as i64;
            let record = &mut mods[*index];
            if record.get("Priority").and_then(|v| v.as_i64()) == Some(target) {
                continue;
            }
            if let Some(obj) = record.as_object_mut() {
                obj.insert("Priority".to_string(), Value::from(target));
                changed = true;
                if slot < wanted.len() {
                    updated += 1;
                }
            }
        }
        Ok(((), changed))
    })?;

    log::info!(
        target: "mod-status",
        "已写入 {} 条优先级（共 {} 条记录，未列出 {} 条）",
        updated,
        total,
        unlisted.len()
    );

    Ok(PriorityOutcome {
        status_path: outcome.status_path,
        backup_path: outcome.backup_path,
        updated,
        total,
        unlisted,
        wrote: outcome.wrote,
    })
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes }
}

fn count_enabled(root: &Value) -> usize {
    root.get("Mods")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter()
                .filter(|record| record.get("Enabled").and_then(|v| v.as_bool()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/// 游戏进程检测：tasklist 只看映像名，无需额外依赖（CREATE_NO_WINDOW 避免弹窗）
#[cfg(windows)]
fn game_process_running() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for exe in ["AoE2DE_s.exe", "AoE2DE.exe"] {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {exe}"), "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if text.contains(&exe.to_lowercase()) {
                return Some(exe.to_string());
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn game_process_running() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"Mods":[{"CheckSum":"3591523155","Enabled":false,"Extra":{"Keep":1},"LastUpdate":"1611403388028","Path":"subscribed//20505_A","Priority":1,"PublishID":0,"Title":"A","WorkshopID":20505},{"CheckSum":"823057912","Enabled":false,"LastUpdate":"1627160648473","Path":"subscribed//38825_B","Priority":2,"PublishID":0,"Title":"B","WorkshopID":38825},{"CheckSum":"1","Enabled":true,"LastUpdate":"1","Path":"local//9_Local","Priority":3,"PublishID":0,"Title":"L","WorkshopID":0}],"Unsub":["999"]}"#;

    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-{tag}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let status = dir.join(STATUS_FILE);
        fs::write(&status, SAMPLE).unwrap();
        (dir, status)
    }

    #[test]
    fn only_enabled_flips_and_everything_else_is_preserved() {
        let (dir, status) = fixture("apply");
        let items = vec![PresetItem {
            workshop_id: Some(20505),
            path: "subscribed//20505_A".to_string(),
            title: "A".to_string(),
            priority: Some(1),
            kind: "subscribed".to_string(),
        }];
        let report = apply_items(&status, &dir.join("backups"), &items, true).unwrap();

        assert_eq!(report.restored, 1);
        assert_eq!(report.disabled, 1, "不在预设中的旧启用项必须被禁用");
        assert_eq!(report.already_enabled, 0);
        assert!(report.wrote);
        assert_eq!(report.total_enabled_after, 1, "覆盖式：只应剩下预设中的一条");

        let text = fs::read_to_string(&status).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods[0]["Enabled"], Value::Bool(true));
        assert_eq!(mods[1]["Enabled"], Value::Bool(false));
        assert_eq!(mods[2]["Enabled"], Value::Bool(false), "原本启用的 local 模组被覆盖禁用");
        // 其它字段一律原样
        assert_eq!(mods[0]["CheckSum"], Value::String("3591523155".to_string()));
        assert_eq!(mods[0]["LastUpdate"], Value::String("1611403388028".to_string()));
        assert_eq!(mods[0]["Priority"], serde_json::json!(1));
        assert_eq!(mods[0]["Extra"], serde_json::json!({"Keep": 1}));
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));
        // 键序与游戏写出的一致（字母序），不会打乱游戏格式
        assert!(text.contains(r#"{"CheckSum":"3591523155","Enabled":true,"Extra":{"Keep":1},"LastUpdate":"1611403388028","Path":"subscribed//20505_A","Priority":1,"PublishID":0,"Title":"A","WorkshopID":20505}"#));

        // 备份必须是原始字节
        let backup = report.backup_path.expect("应生成备份");
        assert_eq!(fs::read_to_string(&backup).unwrap(), SAMPLE);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_overwrites_previous_enabled_set() {
        let (dir, status) = fixture("overwrite");
        // 先把三条全部启用，模拟“玩家自己攒了一套配置”
        for (id, path) in [
            (Some(20505u64), "subscribed//20505_A"),
            (Some(38825), "subscribed//38825_B"),
            (Some(0), "local//9_Local"),
        ] {
            let sel = ModSelector {
                workshop_id: id,
                path: path.to_string(),
            };
            set_enabled(&status, &dir.join("backups"), &sel, true, true).unwrap();
        }

        // 只应用 B：A 与 local 必须被覆盖禁用
        let items = vec![PresetItem {
            workshop_id: Some(38825),
            path: "subscribed//38825_B".to_string(),
            title: "B".to_string(),
            priority: Some(2),
            kind: "subscribed".to_string(),
        }];
        let report = apply_items(&status, &dir.join("backups"), &items, true).unwrap();
        assert_eq!(report.restored, 0, "B 已经是启用状态");
        assert_eq!(report.already_enabled, 1);
        assert_eq!(report.disabled, 2, "A 与 local 必须被覆盖禁用");
        assert_eq!(report.total_enabled_after, 1);
        assert!(report.wrote);
        assert!(report.backup_path.is_some());

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods[0]["Enabled"], Value::Bool(false));
        assert_eq!(mods[1]["Enabled"], Value::Bool(true));
        assert_eq!(mods[2]["Enabled"], Value::Bool(false));
        // 覆盖写入不得动其它字段
        assert_eq!(mods[0]["CheckSum"], Value::String("3591523155".to_string()));
        assert_eq!(mods[2]["Priority"], serde_json::json!(3));
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn matches_local_mod_by_path_and_reports_missing_records() {
        let (dir, status) = fixture("local");
        let items = vec![
            PresetItem {
                workshop_id: Some(0),
                path: "local//9_Local".to_string(),
                title: "L".to_string(),
                priority: Some(3),
                kind: "local".to_string(),
            },
            PresetItem {
                workshop_id: Some(777),
                path: "subscribed//777_Gone".to_string(),
                title: "Gone".to_string(),
                priority: None,
                kind: "subscribed".to_string(),
            },
        ];
        let report = apply_items(&status, &dir.join("backups"), &items, true).unwrap();
        assert_eq!(report.requested, 2);
        assert_eq!(report.restored, 0); // local 那条本来就是启用状态
        assert_eq!(report.disabled, 0, "另外两条本来就已禁用，无需改动");
        assert_eq!(report.already_enabled, 1);
        assert_eq!(report.not_in_status.len(), 1);
        assert_eq!(report.not_in_status[0].workshop_id, Some(777));
        assert_eq!(report.total_enabled_after, 1);
        assert!(!report.wrote, "现状已与预设一致时不得写文件");
        assert!(report.backup_path.is_none());

        // 第二次应用：依旧不写文件
        let again = apply_items(&status, &dir.join("backups"), &items, true).unwrap();
        assert!(!again.wrote);
        assert_eq!(again.restored, 0);
        assert_eq!(again.disabled, 0);
        assert_eq!(again.already_enabled, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_overwrites_same_name_and_keeps_created_at() {
        let mut store = Store::default();
        let item = PresetItem {
            workshop_id: Some(1),
            path: "subscribed//1_A".to_string(),
            title: "A".to_string(),
            priority: None,
            kind: "subscribed".to_string(),
        };
        let first = upsert(&mut store, "  日常  ", vec![item.clone()]).unwrap();
        assert_eq!(first.name, "日常");
        let created = first.created_at_ms;
        assert_eq!(store.presets.len(), 1);

        let second = upsert(&mut store, "日常", vec![item.clone(), item.clone()]).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.created_at_ms, created);
        assert_eq!(second.items.len(), 1, "重复路径应去重");
        assert_eq!(store.presets.len(), 1);

        assert!(upsert(&mut store, "   ", vec![item.clone()]).is_err());
        assert!(upsert(&mut store, "空", vec![]).is_err());
    }

    #[test]
    fn store_round_trips_and_delete_works() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-store-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let mut store = Store::default();
        let item = PresetItem {
            workshop_id: Some(20505),
            path: "subscribed//20505_A".to_string(),
            title: "A".to_string(),
            priority: Some(1),
            kind: "subscribed".to_string(),
        };
        let preset = upsert(&mut store, "日常配置", vec![item]).unwrap();
        save(&path, &store).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.presets.len(), 1);
        assert_eq!(loaded.presets[0].items[0].workshop_id, Some(20505));

        let mut loaded = loaded;
        delete(&mut loaded, &preset.id).unwrap();
        assert!(loaded.presets.is_empty());
        assert!(delete(&mut loaded, &preset.id).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_status_file_without_writing() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-bad-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let status = dir.join(STATUS_FILE);
        fs::write(&status, "{not json").unwrap();
        let items = vec![PresetItem {
            workshop_id: Some(1),
            path: String::new(),
            title: "x".to_string(),
            priority: None,
            kind: String::new(),
        }];
        let err = apply_items(&status, &dir.join("backups"), &items, true).unwrap_err();
        assert!(err.contains("不是合法 JSON"));
        assert_eq!(fs::read_to_string(&status).unwrap(), "{not json");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_status_file_is_reported_clearly() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-nofile-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let items = vec![PresetItem {
            workshop_id: Some(1),
            path: "subscribed//1_A".to_string(),
            title: "A".to_string(),
            priority: None,
            kind: "subscribed".to_string(),
        }];
        let err = apply_items(&dir.join(STATUS_FILE), &dir.join("backups"), &items, true).unwrap_err();
        assert!(err.contains("未找到 mod-status.json"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_enabled_only_touches_the_target_record() {
        let (dir, status) = fixture("toggle");
        let sel = ModSelector {
            workshop_id: Some(38825),
            path: "subscribed//38825_B".to_string(),
        };

        let out = set_enabled(&status, &dir.join("backups"), &sel, true, true).unwrap();
        assert!(out.changed);
        assert_eq!(out.previous_enabled, Some(false));
        assert_eq!(out.total_enabled_after, 2);

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods[0]["Enabled"], Value::Bool(false), "不得动其它记录");
        assert_eq!(mods[1]["Enabled"], Value::Bool(true));
        assert_eq!(mods[1]["Priority"], serde_json::json!(2));
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));

        // 备份必须是原始字节
        assert_eq!(fs::read_to_string(out.backup_path.unwrap()).unwrap(), SAMPLE);

        // 再设一次 true：不改文件、不产生备份
        let again = set_enabled(&status, &dir.join("backups"), &sel, true, true).unwrap();
        assert!(!again.changed);
        assert_eq!(again.previous_enabled, Some(true));
        assert!(again.backup_path.is_none());

        // 反向切回停用
        let off = set_enabled(&status, &dir.join("backups"), &sel, false, true).unwrap();
        assert!(off.changed);
        assert_eq!(off.total_enabled_after, 1);

        // 找不到记录：明确报错，且不改文件
        let before = fs::read_to_string(&status).unwrap();
        let missing = ModSelector {
            workshop_id: Some(777),
            path: "subscribed//777_X".to_string(),
        };
        let err = set_enabled(&status, &dir.join("backups"), &missing, true, true).unwrap_err();
        assert!(err.contains("没有该模组的记录"), "实际错误：{err}");
        assert_eq!(fs::read_to_string(&status).unwrap(), before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_record_drops_only_that_entry() {
        let (dir, status) = fixture("remove");
        let sel = ModSelector {
            workshop_id: Some(38825),
            path: "subscribed//38825_B".to_string(),
        };

        let out = remove_record(&status, &dir.join("backups"), &sel, true).unwrap();
        assert!(out.removed);
        assert!(!out.unsub_cleared, "Unsub 里没有该 ID 时不得报成已清理");
        assert!(out.backup_path.is_some());

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods.len(), 2, "只应少一条");
        assert!(
            mods.iter().all(|r| r["WorkshopID"] != serde_json::json!(38825)),
            "目标记录必须消失"
        );
        assert_eq!(mods[0]["WorkshopID"], serde_json::json!(20505), "其它记录按原顺序保留");
        assert_eq!(mods[1]["WorkshopID"], serde_json::json!(0));
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));

        // 再删一次：本来就没有 → removed=false，不写文件
        let before = fs::read_to_string(&status).unwrap();
        let again = remove_record(&status, &dir.join("backups"), &sel, true).unwrap();
        assert!(!again.removed);
        assert!(again.backup_path.is_none());
        assert_eq!(fs::read_to_string(&status).unwrap(), before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_record_clears_unsub_residue() {
        let (dir, status) = fixture("remove-unsub");
        // 手工把该 ID 塞进 Unsub，模拟“游戏自己记过的残留”
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        value["Unsub"] = serde_json::json!(["38825", "999"]);
        fs::write(&status, serde_json::to_vec(&value).unwrap()).unwrap();

        let sel = ModSelector {
            workshop_id: Some(38825),
            path: "subscribed//38825_B".to_string(),
        };
        let out = remove_record(&status, &dir.join("backups"), &sel, true).unwrap();
        assert!(out.removed);
        assert!(out.unsub_cleared, "Unsub 里的该 ID 必须被清掉");

        let after: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        assert_eq!(after["Unsub"], serde_json::json!(["999"]), "只清自己的 ID");
        assert_eq!(after["Mods"].as_array().unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn localize_record_rewrites_path_and_clears_unsub() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-localize-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let status = dir.join(STATUS_FILE);
        const RAW: &str = r#"{"Mods":[{"CheckSum":"12","Enabled":false,"LastUpdate":"1","Path":"subscribed//20505_A","Priority":1,"PublishID":0,"Title":"A","WorkshopID":20505}],"Unsub":["20505","999"]}"#;
        fs::write(&status, RAW).unwrap();

        let sel = ModSelector {
            workshop_id: Some(20505),
            path: "local//A".to_string(),
        };
        let out = localize_record(&status, &dir.join("backups"), &sel, "A", "A", true).unwrap();
        assert!(out.path_updated);
        assert!(!out.record_added);
        assert!(out.workshop_id_cleared, "local 记录的 WorkshopID 必须置 0");
        assert!(out.unsub_cleared);

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0]["Path"], Value::String("local//A".to_string()));
        assert_eq!(mods[0]["Enabled"], Value::Bool(true));
        assert_eq!(
            mods[0]["WorkshopID"],
            serde_json::json!(0),
            "local 记录的 WorkshopID 必须为 0（否则游戏会反向同步为订阅）"
        );
        assert_eq!(
            mods[0]["CheckSum"],
            Value::String("12".to_string()),
            "CheckSum 不得改写"
        );
        assert_eq!(value["Unsub"], serde_json::json!(["999"]), "只清掉自己的 ID");

        // 已就位后再跑：不动文件
        let again = localize_record(&status, &dir.join("backups"), &sel, "A", "A", true).unwrap();
        assert!(
            !again.path_updated && !again.record_added && !again.workshop_id_cleared && !again.unsub_cleared
        );
        assert!(again.backup_path.is_none());

        // 记录不存在（游戏把它清了）：按游戏格式新建一条，WorkshopID 写 0
        let sel2 = ModSelector {
            workshop_id: Some(4242),
            path: "local//B".to_string(),
        };
        let added = localize_record(&status, &dir.join("backups"), &sel2, "B", "B", true).unwrap();
        assert!(added.record_added);
        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let hit = value["Mods"].as_array().unwrap()
            .iter()
            .find(|r| r["Path"] == serde_json::json!("local//B"))
            .unwrap();
        assert_eq!(hit["WorkshopID"], serde_json::json!(0));
        assert_eq!(hit["Enabled"], Value::Bool(true));
        assert_eq!(hit["CheckSum"], Value::String("0".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_mod_appends_once_and_is_idempotent() {
        let (dir, status) = fixture("register");
        let rec = NewRecord {
            workshop_id: 424242,
            title: "New Mod".to_string(),
            path: "subscribed//424242_New Mod".to_string(),
        };

        let first = register_mod(&status, &dir.join("backups"), &rec, true).unwrap();
        assert!(first.added);
        assert!(!first.already_present);
        assert!(first.path_fixed.is_none());
        assert!(first.backup_path.is_some());

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods.len(), 4, "只追加一条");
        let added = mods.last().unwrap();
        assert_eq!(added["CheckSum"], Value::String("0".to_string()));
        assert_eq!(added["Enabled"], Value::Bool(true), "新装模组默认启用");
        assert_eq!(
            added["Path"],
            Value::String("subscribed//424242_New Mod".to_string())
        );
        assert_eq!(added["Priority"], serde_json::json!(1));
        assert_eq!(added["PublishID"], serde_json::json!(0));
        assert_eq!(added["Title"], Value::String("New Mod".to_string()));
        assert_eq!(added["WorkshopID"], serde_json::json!(424242));
        let last_update = added["LastUpdate"].as_str().expect("LastUpdate 必须是字符串");
        assert!(last_update.parse::<i64>().unwrap() > 0);
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));

        // 幂等：第二次不写文件、不备份
        let before = fs::read_to_string(&status).unwrap();
        let second = register_mod(&status, &dir.join("backups"), &rec, true).unwrap();
        assert!(!second.added);
        assert!(second.already_present);
        assert!(second.backup_path.is_none());
        assert_eq!(fs::read_to_string(&status).unwrap(), before);

        // 标题变了 → 目录名变了 → 只修 Path/Title，CheckSum 等字段一律不动
        let renamed = NewRecord {
            workshop_id: 424242,
            title: "New Mod v2".to_string(),
            path: "subscribed//424242_New Mod v2".to_string(),
        };
        let third = register_mod(&status, &dir.join("backups"), &renamed, true).unwrap();
        assert_eq!(
            third.path_fixed.as_deref(),
            Some("subscribed//424242_New Mod v2")
        );
        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods.len(), 4);
        let hit = mods
            .iter()
            .find(|r| r["WorkshopID"] == serde_json::json!(424242))
            .unwrap();
        assert_eq!(
            hit["Path"],
            Value::String("subscribed//424242_New Mod v2".to_string())
        );
        assert_eq!(hit["Title"], Value::String("New Mod v2".to_string()));
        assert_eq!(hit["CheckSum"], Value::String("0".to_string()));
        assert_eq!(hit["Enabled"], Value::Bool(true));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实 mod-status.json 上验证「安装登记」：只在临时副本上操作，绝不触碰游戏目录
    #[test]
    fn real_status_file_register_on_copy() {
        let real = PathBuf::from(r"F:\Games\AoE2DE\mod-status.json");
        let Ok(raw) = fs::read(&real) else {
            eprintln!("跳过：本机没有 {}", real.display());
            return;
        };
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-real-reg-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let status = dir.join(STATUS_FILE);
        fs::write(&status, &raw).unwrap();

        let before: Value = serde_json::from_slice(strip_bom(&raw)).unwrap();
        let before_mods = before["Mods"].as_array().unwrap().clone();

        let rec = NewRecord {
            workshop_id: 999_999_991,
            title: "Aoe2MM Register Probe".to_string(),
            path: "subscribed//999999991_Aoe2MM Register Probe".to_string(),
        };
        let out = register_mod(&status, &dir.join("backups"), &rec, true).unwrap();
        assert!(out.added, "真实文件上应新增一条记录");
        assert!(out.backup_path.is_some());

        let after: Value = serde_json::from_slice(strip_bom(&fs::read(&status).unwrap())).unwrap();
        let after_mods = after["Mods"].as_array().unwrap();
        assert_eq!(after_mods.len(), before_mods.len() + 1, "只能多一条");
        assert_eq!(after["Unsub"], before["Unsub"], "Unsub 必须原样保留");

        // 原有记录必须逐条一致（不得重写、不得丢掉未知字段）
        for (index, old) in before_mods.iter().enumerate() {
            assert_eq!(&after_mods[index], old, "第 {index} 条记录被意外修改");
        }

        let added = after_mods.last().unwrap();
        assert_eq!(added["WorkshopID"], serde_json::json!(999_999_991));
        assert_eq!(
            added["Path"],
            Value::String("subscribed//999999991_Aoe2MM Register Probe".to_string())
        );
        assert_eq!(added["Enabled"], Value::Bool(true));
        assert_eq!(added["CheckSum"], Value::String("0".to_string()));
        assert_eq!(added["Priority"], serde_json::json!(1));
        assert_eq!(added["PublishID"], serde_json::json!(0));

        // 重复登记：不写文件
        let again = register_mod(&status, &dir.join("backups"), &rec, true).unwrap();
        assert!(!again.added);
        assert!(again.backup_path.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实 mod-status.json 回归：只在临时副本上操作，绝不触碰游戏目录
    #[test]
    fn real_status_file_round_trip_on_copy() {
        let real = PathBuf::from(r"F:\Games\AoE2DE\mod-status.json");
        let Ok(raw) = fs::read(&real) else {
            eprintln!("跳过：本机没有 {}", real.display());
            return;
        };
        let dir = std::env::temp_dir().join(format!("aoe2mm-presets-real-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let status = dir.join(STATUS_FILE);
        fs::write(&status, &raw).unwrap();

        let before: Value = serde_json::from_slice(strip_bom(&raw)).unwrap();
        let records = before
            .get("Mods")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(!records.is_empty(), "真实文件里应有模组记录");
        let target = records
            .iter()
            .find(|r| r.get("Enabled").and_then(|v| v.as_bool()) == Some(false))
            .expect("真实文件里应当有被禁用的模组");
        let workshop_id = target.get("WorkshopID").and_then(as_u64).unwrap();
        let path = target.get("Path").and_then(|p| p.as_str()).unwrap().to_string();
        let checksum = target.get("CheckSum").cloned().unwrap();
        let last_update = target.get("LastUpdate").cloned().unwrap();
        let priority = target.get("Priority").cloned().unwrap();

        let items = vec![PresetItem {
            workshop_id: Some(workshop_id),
            path: path.clone(),
            title: target.get("Title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            priority: None,
            kind: "subscribed".to_string(),
        }];
        let report = apply_items(&status, &dir.join("backups"), &items, true).unwrap();
        assert_eq!(report.restored, 1);
        assert_eq!(report.already_enabled, 0);
        assert!(report.not_in_status.is_empty());

        let after_raw = fs::read(&status).unwrap();
        // 覆盖式：写入后整个文件里只有预设那一条是启用的
        assert_eq!(report.total_enabled_after, 1, "覆盖式应用后只应剩下预设中的模组启用");
        let before_enabled = records
            .iter()
            .filter(|r| r.get("Enabled").and_then(|v| v.as_bool()) == Some(true))
            .count();
        assert_eq!(report.disabled, before_enabled, "原有启用项（不含目标）应全部被禁用");
        let after: Value = serde_json::from_slice(&after_raw).unwrap();
        let after_mods = after.get("Mods").and_then(|m| m.as_array()).unwrap();
        assert_eq!(after_mods.len(), records.len(), "记录条数不得变化");
        assert_eq!(after.get("Unsub"), before.get("Unsub"), "Unsub 必须原样保留");
        let hit = after_mods
            .iter()
            .find(|r| r.get("Path").and_then(|p| p.as_str()) == Some(path.as_str()))
            .unwrap();
        assert_eq!(hit.get("Enabled"), Some(&Value::Bool(true)));
        assert_eq!(hit.get("CheckSum"), Some(&checksum));
        assert_eq!(hit.get("LastUpdate"), Some(&last_update));
        assert_eq!(hit.get("Priority"), Some(&priority));

        let backup = report.backup_path.unwrap();
        assert_eq!(fs::read(&backup).unwrap(), raw, "备份必须是原始字节");

        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------- v0.2：拖拽排序 ----------------

    #[test]
    fn reorder_writes_contiguous_priority_and_keeps_other_fields() {
        let (dir, status) = fixture("order");
        // 只提交两条（模拟另有一条没被前端列出），它必须被挪到末尾而不是丢失
        let ordered = vec![
            "local:9_Local".to_string(),
            "subscribed:20505_A".to_string(),
        ];
        let out = reorder_priority(&status, &dir.join("backups"), &ordered, true).unwrap();
        assert!(out.wrote);
        assert_eq!(out.updated, 2);
        assert_eq!(out.total, 3);
        assert_eq!(out.unlisted, vec!["subscribed//38825_B".to_string()]);
        assert!(out.backup_path.is_some());

        let value: Value = serde_json::from_str(&fs::read_to_string(&status).unwrap()).unwrap();
        let mods = value["Mods"].as_array().unwrap();
        assert_eq!(mods[2]["Priority"], serde_json::json!(1), "local 被拖到第一位");
        assert_eq!(mods[0]["Priority"], serde_json::json!(2));
        assert_eq!(mods[1]["Priority"], serde_json::json!(3), "未提交的记录排在末尾");
        // Priority 之外一切原样透传
        assert_eq!(mods[0]["Enabled"], Value::Bool(false));
        assert_eq!(mods[0]["CheckSum"], Value::String("3591523155".to_string()));
        assert_eq!(mods[0]["Extra"], serde_json::json!({"Keep": 1}));
        assert_eq!(mods[2]["Enabled"], Value::Bool(true));
        assert_eq!(value["Unsub"], serde_json::json!(["999"]));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reorder_is_noop_when_order_already_matches() {
        let (dir, status) = fixture("noop");
        let ordered = vec![
            "subscribed:20505_A".to_string(),
            "subscribed:38825_B".to_string(),
            "local:9_Local".to_string(),
        ];
        let out = reorder_priority(&status, &dir.join("backups"), &ordered, true).unwrap();
        assert!(!out.wrote, "顺序没变就不该写盘");
        assert!(out.backup_path.is_none());
        assert_eq!(out.updated, 0);
        assert_eq!(fs::read_to_string(&status).unwrap(), SAMPLE);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reorder_rejects_invalid_ids_without_writing() {
        let (dir, status) = fixture("reject");
        let backups = dir.join("backups");

        let err = reorder_priority(&status, &backups, &["local:不存在".to_string()], true)
            .unwrap_err();
        assert!(err.contains("没有记录"), "{err}");

        let err = reorder_priority(
            &status,
            &backups,
            &["local:9_Local".to_string(), "local:9_Local".to_string()],
            true,
        )
        .unwrap_err();
        assert!(err.contains("重复"), "{err}");

        let err = reorder_priority(&status, &backups, &["../evil:9_Local".to_string()], true)
            .unwrap_err();
        assert!(err.contains("无法识别"), "{err}");

        assert_eq!(fs::read_to_string(&status).unwrap(), SAMPLE, "报错时不得写盘");
        let _ = fs::remove_dir_all(&dir);
    }
}
