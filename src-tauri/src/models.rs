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
    /// 是否数据模组：模组内含游戏核心数据库文件（如 empires2_x2_p1.dat）。
    /// 游戏同一时间只能加载一个数据模组，前端启用前必须做互斥拦截。
    pub is_data_mod: bool,
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
    /// 记住登录 7 天：开启后把会话 Cookie 续命成持久 Cookie 并用 DPAPI 加密缓存。
    /// **默认关闭**——关闭时冷启动不落盘任何 AoE 凭证，改为隐藏窗口静默重登兜底。
    #[serde(default)]
    pub remember_login: bool,
    /// 界面语言："en" | "zh"；空字符串 = 尚未选择（前端按系统语言推断后回写）
    #[serde(default)]
    pub locale: String,
    /// 翻译目标语言（小写：zh-cn / zh-tw / en / ja / ru …）；空字符串 = 跟随界面语言
    #[serde(default)]
    pub target_language: String,
    /// 翻译引擎：auto（默认）| google | mymemory | custom
    /// （custom 只落库，当前版本仍走 auto）
    #[serde(default = "default_translate_provider")]
    pub translate_provider: String,
    /// 自定义翻译接口地址（预留，开发中）
    #[serde(default)]
    pub translate_custom_url: Option<String>,
    /// 自定义翻译接口的 Key（预留，开发中；只存不读）
    #[serde(default)]
    pub translate_custom_key: Option<String>,
    /// 最后一次「自动」检查软件更新的毫秒时间戳；0 / 缺字段 = 从未检查过。
    /// 启动静默检查前比对该值，24 小时内不再请求 GitHub（手动检查不受限）。
    #[serde(default)]
    pub last_auto_update_check_ms: i64,
    /// 是否允许后台静默建立本地中文搜索索引（**默认关闭**）。
    /// 关闭时 Rust 端一个爬取请求都不发，本地搜索只查 online_cache.json 已缓存条目。
    #[serde(default)]
    pub enable_indexing: bool,
    /// 是否在「在线模组」页显示本地搜索框（**默认关闭**）。
    /// 只是一个界面开关：关闭时本地搜索入口会整个隐藏（不影响已有索引数据）。
    #[serde(default)]
    pub enable_local_search: bool,
    /// 本地列表视图模式：“grid”（大图网格，默认）| “list”（紧凑列表）。
    /// 纯界面偏好，越界值由 `set_view_prefs` 命令夹回合法档位。
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
    /// 网格模式下卡片的**最小宽度**（px，160..=320，步长 20）；列表模式不读取该值。
    #[serde(default = "default_card_size")]
    pub card_size: u32,
    /// 界面主题："dark"（默认，深色羊皮纸）| "light"（明亮米白）。
    /// 纯界面偏好，越界值由 `set_theme` 命令夹回 dark；老 settings.json 缺字段走默认值。
    #[serde(default = "default_theme")]
    pub theme: String,
    /// v3.0：界面字体种类 —— "hei"（黑体，默认）| "youyuan"（幼圆）| "system"（跟随系统）。
    /// 纯界面偏好：前端把它翻译成 CSS 变量 --app-font-family，不影响任何业务逻辑。
    /// v2.4 旧值 "sans-serif" / "serif" 载入时静默归一化为 hei，"system-ui" 归一化为 system。
    #[serde(default = "default_ui_font_family")]
    pub ui_font_family: String,
    /// v3.0：界面字重（400 常规 / 700 加粗，默认 400）—— 对应 CSS 变量 --ui-font-weight。
    /// v2.4 的遗留字段同名且为 `Option<u32>`，已升级为本字段（兼容旧文件里的 null）。
    #[serde(default = "default_ui_font_weight", deserialize_with = "de_ui_font_weight")]
    pub ui_font_weight: u32,
    /// v2.4：全局缩放（百分比，80..=150，默认 100）—— 对应 CSS 变量 --global-scale（值 ÷ 100）。
    /// 只放大 / 缩小「界面层」（侧边栏、顶栏、设置弹窗等）；正文与卡片各有独立字号。
    #[serde(default = "default_global_font_scale")]
    pub global_font_scale: u32,
    /// v2.4：正文基准字号（px，12..=24，默认 14）—— 对应 CSS 变量 --reader-font-size。
    #[serde(default = "default_reader_font_size")]
    pub reader_font_size: u32,
    /// v2.4：正文行距（1.4 / 1.6 / 1.8，默认 1.6）—— 对应 CSS 变量 --reader-line-height。
    #[serde(default = "default_reader_line_height")]
    pub reader_line_height: f32,
    /// v2.4：正文字重（400 常规 / 700 加粗，默认 400）—— 对应 CSS 变量 --reader-font-weight。
    #[serde(default = "default_reader_font_weight")]
    pub reader_font_weight: u32,
    /// v2.4：卡片列表字号（px，10..=16，默认 12）—— 对应 CSS 变量 --card-font-size。
    #[serde(default = "default_card_font_size")]
    pub card_font_size: u32,
    /// v3.2：三类本地缓存的自定义存放目录（**None = 用默认 AppData 位置**）。
    /// 只存用户明确选过的路径；目录不存在 / 空串一律回退默认，判定统一在
    /// [`crate::get_cache_dir`] 里做，本结构不碰文件系统。
    #[serde(default)]
    pub image_cache_dir: Option<String>,
    /// 在线模组信息缓存（online_cache.json）的存放目录；None = 应用配置目录
    #[serde(default)]
    pub mod_info_cache_dir: Option<String>,
    /// 译文缓存（translation_cache.json / online_titles_zh.json）的存放目录；None = 应用配置目录
    #[serde(default)]
    pub translation_cache_dir: Option<String>,
    /// v2.3 遗留：扁平的界面字号。v2.4 起只作为一次性迁移来源，
    /// 由 `migrate_legacy_typography` 搬进 reader_* 后置空；之后写入一律为 null。
    #[serde(default)]
    pub ui_font_size: Option<u32>,
    /// v2.3 遗留：扁平行距（迁移后置空）
    #[serde(default)]
    pub ui_line_height: Option<f32>,
}

impl Settings {
    /// v2.4：把 v2.3 的扁平排版字段一次性迁移到「正文阅读」层。
    ///
    /// - 只有当分层字段仍是出厂默认值时才采纳旧值（用户已经调过新滑块就绝不覆盖）；
    /// - 迁移后旧字段一律清空，因此反复读写 settings.json 不会重复迁移；
    /// - v3.0：`ui_font_weight` 已改为界面层必填字段，v2.3 的扁平字重不再迁移；
    /// - 返回 true 表示内存里的结构被改动过（调用方可决定是否立即写盘）。
    pub fn migrate_legacy_typography(&mut self) -> bool {
        if self.ui_font_size.is_none() && self.ui_line_height.is_none() {
            return false;
        }
        let untouched = self.reader_font_size == READER_FONT_SIZE_DEFAULT
            && (self.reader_line_height - READER_LINE_HEIGHT_DEFAULT).abs() < f32::EPSILON;
        if untouched {
            if let Some(size) = self.ui_font_size {
                // v2.3 的取值范围 12..=20 完全落在 12..=24 之内，直接夹一次即可
                self.reader_font_size = clamp_reader_font_size(size);
            }
            if let Some(line) = self.ui_line_height {
                self.reader_line_height = normalize_reader_line_height(line);
            }
        }
        self.ui_font_size = None;
        self.ui_line_height = None;
        true
    }
}

// ---------------- v2.4：三层排版（界面 / 正文阅读 / 卡片列表） ----------------

fn default_ui_font_family() -> String {
    UI_FONT_FAMILY_DEFAULT.to_string()
}

fn default_ui_font_weight() -> u32 {
    UI_FONT_WEIGHT_DEFAULT
}

/// 兼容 v2.4 写下的 `"ui_font_weight": null`（当时是 Option<u32>）：
/// null / 缺省 → 默认 400；数字（含 v2.4 的 500）→ 归一化为 400 / 700。
fn de_ui_font_weight<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<u32>::deserialize(deserializer)?;
    Ok(raw.map(normalize_ui_font_weight).unwrap_or(UI_FONT_WEIGHT_DEFAULT))
}

fn default_global_font_scale() -> u32 {
    GLOBAL_SCALE_DEFAULT
}

fn default_reader_font_size() -> u32 {
    READER_FONT_SIZE_DEFAULT
}

fn default_reader_line_height() -> f32 {
    READER_LINE_HEIGHT_DEFAULT
}

fn default_reader_font_weight() -> u32 {
    READER_FONT_WEIGHT_DEFAULT
}

fn default_card_font_size() -> u32 {
    CARD_FONT_SIZE_DEFAULT
}

/// 界面字体种类：黑体
pub const UI_FONT_FAMILY_HEI: &str = "hei";
/// 界面字体种类：幼圆
pub const UI_FONT_FAMILY_YOUYUAN: &str = "youyuan";
/// 界面字体种类：跟随系统
pub const UI_FONT_FAMILY_SYSTEM: &str = "system";
pub const UI_FONT_FAMILY_DEFAULT: &str = UI_FONT_FAMILY_HEI;

/// 界面字重两档：常规 / 加粗（对应 CSS 变量 --ui-font-weight）
pub const UI_FONT_WEIGHT_NORMAL: u32 = 400;
pub const UI_FONT_WEIGHT_BOLD: u32 = 700;
pub const UI_FONT_WEIGHT_DEFAULT: u32 = UI_FONT_WEIGHT_NORMAL;

/// 字体种类归一化：只认 hei / youyuan / system，其余一律回黑体。
/// v2.4 旧值静默改写："sans-serif" / "serif" → hei；"system-ui" → system（语义不变）。
pub fn normalize_ui_font_family(family: &str) -> String {
    let trimmed = family.trim();
    if trimmed.eq_ignore_ascii_case(UI_FONT_FAMILY_YOUYUAN) {
        UI_FONT_FAMILY_YOUYUAN.to_string()
    } else if trimmed.eq_ignore_ascii_case(UI_FONT_FAMILY_SYSTEM)
        || trimmed.eq_ignore_ascii_case("system-ui")
    {
        UI_FONT_FAMILY_SYSTEM.to_string()
    } else {
        UI_FONT_FAMILY_DEFAULT.to_string()
    }
}

/// 界面字重归一化：只保留 400 / 700，阈值 600（与前端 normalizeUiFontWeight 一致）。
pub fn normalize_ui_font_weight(weight: u32) -> u32 {
    if weight >= 600 {
        UI_FONT_WEIGHT_BOLD
    } else {
        UI_FONT_WEIGHT_NORMAL
    }
}

/// 全局缩放档位（百分比，与前端滑块 min/max/step 保持一致）
pub const GLOBAL_SCALE_MIN: u32 = 80;
pub const GLOBAL_SCALE_MAX: u32 = 150;
pub const GLOBAL_SCALE_DEFAULT: u32 = 100;

/// 把任意缩放值夹进 80..=150（不报错，避免 0% / 1000% 这种坏值把界面撑爆）。
pub fn clamp_global_font_scale(scale: u32) -> u32 {
    scale.clamp(GLOBAL_SCALE_MIN, GLOBAL_SCALE_MAX)
}

/// 正文基准字号档位（px）
pub const READER_FONT_SIZE_MIN: u32 = 12;
pub const READER_FONT_SIZE_MAX: u32 = 24;
pub const READER_FONT_SIZE_DEFAULT: u32 = 14;

/// 正文行距三档：紧凑 / 标准 / 宽松
pub const READER_LINE_HEIGHT_COMPACT: f32 = 1.4;
pub const READER_LINE_HEIGHT_NORMAL: f32 = 1.6;
pub const READER_LINE_HEIGHT_LOOSE: f32 = 1.8;
pub const READER_LINE_HEIGHT_DEFAULT: f32 = 1.6;

/// 正文字重两档：常规 / 加粗（v3.0 起 500 改为真加粗 700）
pub const READER_FONT_WEIGHT_NORMAL: u32 = 400;
pub const READER_FONT_WEIGHT_BOLD: u32 = 700;
pub const READER_FONT_WEIGHT_DEFAULT: u32 = 400;

/// 把任意字号夹进 12..=24（正文允许比界面基准更大，方便阅读）。
pub fn clamp_reader_font_size(size: u32) -> u32 {
    size.clamp(READER_FONT_SIZE_MIN, READER_FONT_SIZE_MAX)
}

/// 正文行距归一化：取最接近的合法档位；NaN / 非有限值一律回默认。
pub fn normalize_reader_line_height(value: f32) -> f32 {
    if !value.is_finite() {
        return READER_LINE_HEIGHT_DEFAULT;
    }
    let mut best = READER_LINE_HEIGHT_NORMAL;
    let mut best_diff = f32::MAX;
    for candidate in [
        READER_LINE_HEIGHT_COMPACT,
        READER_LINE_HEIGHT_NORMAL,
        READER_LINE_HEIGHT_LOOSE,
    ] {
        let diff = (value - candidate).abs();
        if diff < best_diff {
            best_diff = diff;
            best = candidate;
        }
    }
    best
}

/// 正文字重归一化：只保留 400 / 700，阈值 600（与前端下拉框一致）。
/// v2.4 的 500（“偏粗”）落回 400，避免老用户升级后正文突然变粗。
pub fn normalize_reader_font_weight(weight: u32) -> u32 {
    if weight >= 600 {
        READER_FONT_WEIGHT_BOLD
    } else {
        READER_FONT_WEIGHT_NORMAL
    }
}

/// 卡片列表字号档位（px）
pub const CARD_FONT_SIZE_MIN: u32 = 10;
pub const CARD_FONT_SIZE_MAX: u32 = 16;
pub const CARD_FONT_SIZE_DEFAULT: u32 = 12;

/// 把任意字号夹进 10..=16（卡片标题 / 元信息共用这一档）。
pub fn clamp_card_font_size(size: u32) -> u32 {
    size.clamp(CARD_FONT_SIZE_MIN, CARD_FONT_SIZE_MAX)
}

fn default_view_mode() -> String {
    VIEW_MODE_GRID.to_string()
}

fn default_theme() -> String {
    THEME_DARK.to_string()
}

/// 界面主题：深色（默认）
pub const THEME_DARK: &str = "dark";
/// 界面主题：明亮
pub const THEME_LIGHT: &str = "light";

/// 主题归一化：只认 light，其余一律 dark（不报错，避免坏值把界面卡死）。
pub fn normalize_theme(theme: &str) -> String {
    if theme.trim().eq_ignore_ascii_case(THEME_LIGHT) {
        THEME_LIGHT.to_string()
    } else {
        THEME_DARK.to_string()
    }
}

fn default_card_size() -> u32 {
    CARD_SIZE_DEFAULT
}

/// 视图模式：大图网格
pub const VIEW_MODE_GRID: &str = "grid";
/// 视图模式：紧凑列表
pub const VIEW_MODE_LIST: &str = "list";
/// 卡片宽度档位下限 / 上限 / 默认值（与前端滑块 min/max/step 保持一致）
pub const CARD_SIZE_MIN: u32 = 160;
pub const CARD_SIZE_MAX: u32 = 320;
pub const CARD_SIZE_STEP: u32 = 20;
/// 默认值取 200（紧贴旧版写死的 196px，且正好落在 20 的档位上）
pub const CARD_SIZE_DEFAULT: u32 = 200;

/// 把任意输入夹回合法档位：先取整到 20 的倍数，再夹进 160..=320。
pub fn clamp_card_size(size: u32) -> u32 {
    let snapped = ((size + CARD_SIZE_STEP / 2) / CARD_SIZE_STEP) * CARD_SIZE_STEP;
    snapped.clamp(CARD_SIZE_MIN, CARD_SIZE_MAX)
}

fn default_proxy_mode() -> String {
    crate::net::MODE_SYSTEM.to_string()
}

fn default_translate_provider() -> String {
    "auto".to_string()
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
            target_language: String::new(),
            translate_provider: default_translate_provider(),
            translate_custom_url: None,
            translate_custom_key: None,
            last_auto_update_check_ms: 0,
            // 默认关闭：不自动爬取官方列表，避免无谓流量与官方限流风险
            enable_indexing: false,
            // 默认不显示本地搜索框（需要时在设置里开启）
            enable_local_search: false,
            // 默认大图网格 + 200px（紧贴旧版写死的 196px，老用户升级后观感基本不变）
            view_mode: default_view_mode(),
            card_size: default_card_size(),
            theme: default_theme(),
            // v3.0 三层排版默认值（与 style.css :root 里的变量初值一一对应）：
            // 界面 黑体 / 400 字重 / 100% 缩放；正文 14px / 1.6 / 400；卡片 12px
            ui_font_family: default_ui_font_family(),
            ui_font_weight: default_ui_font_weight(),
            global_font_scale: default_global_font_scale(),
            reader_font_size: default_reader_font_size(),
            reader_line_height: default_reader_line_height(),
            reader_font_weight: default_reader_font_weight(),
            card_font_size: default_card_font_size(),
            // v3.2：三类缓存默认都放在 AppData 里（用户改过才写入具体路径）
            image_cache_dir: None,
            mod_info_cache_dir: None,
            translation_cache_dir: None,
            // v2.3 遗留字段：新装 / 默认值里一律为空
            ui_font_size: None,
            ui_line_height: None,
        }
    }
}
