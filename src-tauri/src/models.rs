use serde::{Deserialize, Serialize};

/// 模组来源：只能由磁盘事实推导；无法确定时必须是 Unknown，不允许猜。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    /// 本工具安装（有 mod_metadata.json 记录，或明确在 local 目录且 WorkshopID > 0）
    Tool,
    /// 官方订阅（无记录，但在 subscribed 目录且 WorkshopID > 0）
    Official,
    /// 无法确定（无记录且无 WorkshopID：手动放入 / 手工整理过）
    Unknown,
}

impl ModSource {
    /// 唯一判定入口：scan 与在线页索引共用，避免两处规则漂移
    pub fn classify(kind: &str, workshop_id: Option<u64>, metadata_recorded: bool) -> Self {
        if metadata_recorded {
            return ModSource::Tool;
        }
        let has_id = workshop_id.map(|id| id > 0).unwrap_or(false);
        match (kind, has_id) {
            ("local", true) => ModSource::Tool,
            ("subscribed", true) => ModSource::Official,
            _ => ModSource::Unknown,
        }
    }
}

/// 单个模组的只读视图。所有字段都来自磁盘真实内容，
/// 无法确定的一律为 None，前端必须显示“未提供/未知”，不得填充假数据。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    /// 稳定标识：`local:文件夹名` / `subscribed:文件夹名`
    pub id: String,
    /// 磁盘上的文件夹名（原样）
    pub folder_name: String,
    /// 模组文件夹绝对路径
    pub path: String,
    /// "local" | "subscribed"
    pub kind: String,
    /// 文件夹名前缀里的数字（Workshop ID），无前缀为 None
    pub workshop_id: Option<u64>,
    /// 去掉数字前缀后的名称
    pub name_from_folder: String,
    /// 展示名称：优先 info.json 的 Title
    pub display_name: String,
    /// 名称来源："info.json" | "folder"
    pub display_name_source: String,
    pub author: Option<String>,
    pub description: Option<String>,
    /// thumbnail.jpg / .png 的绝对路径（真实存在才给出）
    pub thumbnail: Option<String>,
    /// 来自 mod-status.json；不存在该记录时为 None（状态未知，不猜测）
    pub enabled: Option<bool>,
    pub priority: Option<i64>,
    pub last_update_ms: Option<i64>,
    pub checksum: Option<String>,
    /// 详情页展示的内容类型：有官方标签时是官方中文名，否则是本地特征名
    pub content_tags: Vec<String>,
    /// 精准分类（左侧筛选用）：ui | audio | map | data，至少一项
    pub categories: Vec<String>,
    /// 分类依据："official"（软件记录过官方 Tag）| "heuristic"（本地特征扫描兜底）
    pub category_source: String,
    /// 官方 Tag 中文名；无元数据记录时为空数组
    pub official_tags: Vec<String>,
    /// 来源判定结果（见 ModSource::classify），前端徽章与删除提示用它
    pub source: ModSource,
    /// 软件自己的 mod_metadata.json 里是否有该模组的记录（source=tool 的可追溯依据）
    pub metadata_recorded: bool,
    /// 解析/读取过程中发现的问题，直接展示给用户
    pub issues: Vec<String>,
    pub info_json_present: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub root: Option<String>,
    pub root_exists: bool,
    pub scanned_at_ms: i64,
    pub local_dir: String,
    pub subscribed_dir: String,
    pub local_exists: bool,
    pub subscribed_exists: bool,
    pub mods: Vec<ModEntry>,
    pub warnings: Vec<String>,
}

/// 在线页用的“本地已安装索引”：只读目录名与元数据，不打开模组文件夹（不触发特征扫描）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIndexEntry {
    pub workshop_id: u64,
    /// "local" | "subscribed"
    pub kind: String,
    pub folder_name: String,
    pub source: ModSource,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModStats {
    pub size_bytes: u64,
    pub file_count: u64,
    /// 文件数达到上限时提前返回，体积为不完全统计
    pub truncated: bool,
}

/// 首次启动引导用：本机探测到的一个候选模组根目录（含来源说明，前端直接展示）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RootCandidate {
    /// 绝对路径（已去掉结尾反斜杠）
    pub path: String,
    /// 探测来源码：env | registry | steam_library | user_dir | documents | drive_scan
    /// （前端用 i18n 映射成当前语言的文案，后端不返回人类可读中文）
    pub source: String,
    /// 该目录下是否已有 local
    pub has_local: bool,
    /// 该目录下是否已有 subscribed
    pub has_subscribed: bool,
    /// 是否是游戏安装目录本身（含 AoE2DE_s.exe），此时 local/subscribed 可能尚未生成
    pub looks_like_game: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mod_root: Option<String>,
    pub last_scan_ms: Option<i64>,
    /// 代理模式："system"（默认，自动跟随 Windows 系统代理）| "manual"
    /// 旧版 settings.json 没有该字段，靠 `#[serde(default)]` 兼容
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    /// 手动代理地址（仅 proxy_mode == "manual" 时使用），形如 http://127.0.0.1:7897
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// 是否用 DPAPI 加密缓存会话 Cookie（体验优先，默认开启；可在高级设置里关闭）
    #[serde(default = "default_true")]
    pub remember_login: bool,
    /// 界面语言："en" | "zh"；空字符串 = 尚未选择（前端按系统语言推断后回写）
    #[serde(default)]
    pub locale: String,
}

fn default_proxy_mode() -> String {
    crate::net::MODE_SYSTEM.to_string()
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mod_root: None,
            last_scan_ms: None,
            proxy_mode: default_proxy_mode(),
            proxy_url: None,
            remember_login: true,
            locale: String::new(),
        }
    }
}
