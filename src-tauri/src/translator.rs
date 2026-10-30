//! 在线模组「一键翻译」+ 本地译文缓存。
//!
//! 设计要点（与 cache.rs 保持同一套心智模型，便于排查）：
//! 1. **请求全部在 Rust 端**：前端只 `invoke("translate_mod_text")`，与 CSP / CORS 无关；
//!    代理复用 [`crate::net`]（手动 > 系统注册表 > 环境变量 > 直连）。
//! 2. **免 key 两级链路**：Google 免费端点 → MyMemory，都不需要注册或申请额度。
//!    有代理时 Google 优先（译文质量最好）；直连时 MyMemory 优先（国内多数可直连）。
//! 3. **单飞 + 全局 FIFO 队列 + 1 req/s**：同一 modId 同时只跑一个任务；
//!    全局严格串行排队，且任意两次外部请求至少隔 1 秒 —— 10 次连点也不会触发限流。
//! 4. **本地缓存（v2，按语言隔离）**：`%APPDATA%\com.aoe2.modmanager\translation_cache.json`
//!    结构 `{version:2, entries: {modId: {语言代码: {...}}}}`，各语言互不覆盖；
//!    v1 的扁平结构（只有中文）读盘时自动迁移到 `zh-cn` 并写回文件。
//! 5. **originalHash（FNV-1a 64）**：作者改了标题或描述 → 哈希变化 → 整条重译并覆盖，
//!    绝不把旧译文贴到新文本上。哈希只用于变化检测，**不引入 md5 crate**（红线：不加依赖）。
//! 6. **绝不自动翻译**：本模块只在用户点击时被调用。
//! 7. **目标语言与 UI 语言解耦**：语言由设置（`target_language`）决定，缺省时跟随界面语言；
//!    前端每次调用都显式传 `targetLang`，Rust 读设置兜底，不写死任何语言。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::net;
use crate::online::ApiFailure;
use crate::settings;

pub const FILE_NAME: &str = "translation_cache.json";
/// 可选配置（不存在 = 自动选择接口）；与其它配置同目录，**不动 settings.rs**
pub const CONFIG_FILE: &str = "translate_config.json";
/// 1 = 扁平 `{modId: entry}`（只可能是中文）；2 = 按语言隔离 `{modId: {lang: entry}}`
pub const CURRENT_VERSION: u32 = 2;
/// 找不到任何语言线索时的兼底语言（也是 v1 缓存迁移到的语言）
pub const DEFAULT_LANG: &str = "zh-cn";
/// 旧版缓存全是中文，迁移时统一放进这个 key
const LEGACY_LANG: &str = "zh-cn";
/// 设置页可选的目标语言（与前端下拉框一致；顺序不影响逻辑）
pub const SUPPORTED_LANGS: [&str; 9] = ["zh-cn", "zh-tw", "en", "ja", "ko", "ru", "fr", "de", "es"];
/// 单次翻译的原文上限（字符）：描述动辄上万字，超出部分截断并提示，避免一次点击发几十个请求
const MAX_TOTAL_CHARS: usize = 6_000;
/// 描述少于此字符数就**拒绝翻译**（详情还没加载完 / 本来就没描述）。
/// 历史 bug：空描述会被当成原文算进 hash，存进缓存后永远不再翻译。
const MIN_DESC_CHARS: usize = 5;
/// 批量只读探测一次最多接受多少条（列表一页也就几十条）
const MAX_BATCH_PROBES: usize = 400;
/// 分块数量上限（安全阀，正常描述远低于此值）
const MAX_CHUNKS: usize = 12;
/// Google gtx 端点的单次 q 长度上限（保守值）
const GOOGLE_CHUNK: usize = 1_500;
/// MyMemory 匿名调用单次上限约 500 字节，取 450 字符保守值
const MYMEMORY_CHUNK: usize = 450;
/// 两次外部翻译请求之间的**硬性**最小间隔。
/// 10 次连点、或一个长描述被拆成多块，实测出口都只会是「每秒最多 1 个请求」。
const MIN_REQUEST_GAP_MS: u64 = 1_000;

// ---------------- 数据结构 ----------------

/// 翻译结果（前端直接使用）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub mod_id: i64,
    /// 目标语言（小写：zh-cn / ja …）
    pub lang: String,
    /// FNV-1a 64 的 16 位 hex，来自 title + description
    pub original_hash: String,
    /// 译文标题（字段名不再带 zh 前缀：目标语言是任意的）
    pub title: String,
    pub desc: String,
    /// google | mymemory
    pub provider: String,
    /// 实际送去翻译的字符数（标题 + 描述）
    pub char_count: u64,
    pub saved_at_ms: u64,
    /// true = 直接命中本地缓存，一个 HTTP 都没发
    pub cached: bool,
    /// true = 描述过长被截断，只翻译了前 MAX_TOTAL_CHARS 个字符
    pub truncated: bool,
}

/// 缓存里的一条译文（键 = modId → 语言代码）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(default)]
    pub original_hash: String,
    /// 只由标题算出的哈希。列表卡片拿不到描述（官方列表不带 description），
    /// 重启后靠它把译文标题接回来，而不必等详情。
    #[serde(default)]
    pub title_hash: String,
    /// v1 的 `zhTitle` 靠 alias 兼容读入
    #[serde(default, alias = "zhTitle")]
    pub title: String,
    /// v1 的 `zhDesc` 靠 alias 兼容读入
    #[serde(default, alias = "zhDesc")]
    pub desc: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub char_count: u64,
    #[serde(default)]
    pub saved_at_ms: u64,
}

impl Entry {
    /// 空内容脏数据：描述或标题为空、哈希不是 16 位 hex —— 一律视为无效条目。
    /// （历史 bug：详情未加载完就点翻译，会把空描述存进缓存，导致永远不再翻译）
    fn is_dirty(&self) -> bool {
        self.title.trim().is_empty()
            || self.desc.trim().is_empty()
            || self.original_hash.trim().len() != 16
    }
    fn into_translation(self, mod_id: i64, lang: &str, cached: bool, truncated: bool) -> Translation {
        Translation {
            mod_id,
            lang: lang.to_string(),
            original_hash: self.original_hash,
            title: self.title,
            desc: self.desc,
            provider: self.provider,
            char_count: self.char_count,
            saved_at_ms: self.saved_at_ms,
            cached,
            truncated,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default = "default_version")]
    pub version: u32,
    /// modId（字符串）→ 语言代码 → 译文。按语言隔离：切目标语言不会互相覆盖。
    #[serde(default)]
    pub entries: BTreeMap<String, BTreeMap<String, Entry>>,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}

impl Default for Store {
    fn default() -> Self {
        Self { version: CURRENT_VERSION, entries: BTreeMap::new() }
    }
}

/// 可选配置文件（`translate_config.json`）。
/// 不存在时全部走默认值 —— **不配 key 也能完整使用**。
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// auto（默认） | google | mymemory
    pub provider: String,
    /// 预留：百度通用翻译需要 appId + 密钥 + MD5 签名，当前版本未启用（不加 md5 依赖）
    #[allow(dead_code)]
    pub baidu: BaiduKeys,
    /// 预留：彩云小译需要 token，当前版本未启用
    #[allow(dead_code)]
    pub caiyun: CaiyunKeys,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BaiduKeys {
    pub app_id: String,
    pub secret: String,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CaiyunKeys {
    pub token: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Provider {
    Google,
    MyMemory,
}

impl Provider {
    fn name(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::MyMemory => "mymemory",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Provider::Google => "Google 翻译（免费端点）",
            Provider::MyMemory => "MyMemory",
        }
    }

    fn chunk_chars(self) -> usize {
        match self {
            Provider::Google => GOOGLE_CHUNK,
            Provider::MyMemory => MYMEMORY_CHUNK,
        }
    }
}

// ---------------- 队列与限速 ----------------

/// 全局翻译队列状态。
///
/// 语义（用户 10 秒内点 10 个模组也不会碰限流）：
/// 1. **严格 FIFO**：一次只跑一个翻译任务，后来者拿票排队（ticket 队列，不饿死）；
/// 2. **发送间隔**：任意两次外部 HTTP 请求之间至少 [`MIN_REQUEST_GAP_MS`]（1 秒），
///    包括同一个模组描述分段时产生的多块请求。
///
/// 为什么不再用「2 并发 + 250ms 间隔」：10 次连点会在 1 秒内凑出 4 个请求，
/// 免费接口（MyMemory 匿名额度、Google 出口 IP）对突发非常敏感，
/// 一旦 429 就得等很久，反而更慢。
struct Queue {
    /// 下一个要发的票号
    next_ticket: u64,
    /// 当前轮到的票号
    serving: u64,
    /// 下一次允许对外发请求的时间点（毫秒）
    next_allowed_ms: u64,
}

static QUEUE: Mutex<Queue> = Mutex::new(Queue { next_ticket: 0, serving: 0, next_allowed_ms: 0 });
static QUEUE_CV: Condvar = Condvar::new();

/// 队列里的一个位置：拿到即独占执行权，`drop` 时自动把执行权交给下一位
struct Slot {
    ticket: u64,
}

impl Slot {
    fn acquire() -> Slot {
        let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let ticket = queue.next_ticket;
        queue.next_ticket = queue.next_ticket.saturating_add(1);
        while queue.serving != ticket {
            queue = QUEUE_CV.wait(queue).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        log::debug!(target: "translate", "获得翻译队列执行权：ticket={ticket}");
        Slot { ticket }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.serving = queue.serving.saturating_add(1);
        log::debug!(target: "translate", "交还翻译队列执行权：ticket={}", self.ticket);
        QUEUE_CV.notify_all();
    }
}

/// 每个外部请求前调用：把「下一次允许发送的时间」推到 1 秒后。
///
/// 只有持有 [`Slot`] 的任务会走到这里（全局串行），所以这里的 sleep
/// 不会拖慢别人 —— 他们本来就在排队。
fn throttle() {
    let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    if queue.next_allowed_ms > now {
        let wait = queue.next_allowed_ms - now;
        // 睡之前放开队列锁：排队者不会因为这一秒被卡在互斥量上
        drop(queue);
        std::thread::sleep(Duration::from_millis(wait));
        queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    queue.next_allowed_ms = now_ms().saturating_add(MIN_REQUEST_GAP_MS);
}

/// 单飞：同一个 modId 同时只允许一个翻译任务（多入口 / 连点 / 多窗口都挡得住）
struct Inflight {
    mod_id: i64,
}

static INFLIGHT: Mutex<Vec<i64>> = Mutex::new(Vec::new());

impl Inflight {
    fn acquire(mod_id: i64) -> Result<Inflight, ApiFailure> {
        let mut list = INFLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if list.contains(&mod_id) {
            return Err(ApiFailure::new("busy", "该模组正在翻译，请稍候", None));
        }
        list.push(mod_id);
        Ok(Inflight { mod_id })
    }
}

impl Drop for Inflight {
    fn drop(&mut self) {
        let mut list = INFLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        list.retain(|id| *id != self.mod_id);
    }
}

// ---------------- 小工具 ----------------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

/// FNV-1a 64：只用于「原文是否变了」的变化检测，不是安全哈希
fn fnv1a64(text: &str) -> u64 {
    let mut hash: u64 = 0xCBF2_9CE4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

/// 哈希前的归一化。
///
/// 同一个模组的描述文本在两处的来源不同：
/// - 在线页：API 的 HTML 经前端 `plainText()`（保留换行、不解 `&#39;`）；
/// - 本地页：info.json 经 `scan.rs clean_description()`（逐行 trim、解 `&#39;`）。
/// 空白与实体的差异是**系统性**的，不归一化就会出现「在线翻过、本地却认不出」
/// （更糟的是两个页面反复互相覆盖缓存）。所以算 hash 前先解实体、再去掉所有空白。
fn normalize_for_hash(text: &str) -> String {
    unescape_basic(text).chars().filter(|c| !c.is_whitespace()).collect()
}

/// 标题 + 描述拼起来算哈希：任一实质内容变化都会重译；
/// 仅空白/实体差异不算变化（避免两页互相失效）。
fn hash_of(title: &str, description: &str) -> String {
    format!(
        "{:016x}",
        fnv1a64(&format!(
            "{}{}{}",
            normalize_for_hash(title),
            '\u{1}',
            normalize_for_hash(description)
        ))
    )
}

/// 只由标题算出的哈希：列表卡片拿不到描述时用它匹配缓存（重启后标题不发回英文）
fn title_hash(title: &str) -> String {
    format!("{:016x}", fnv1a64(&normalize_for_hash(title)))
}

/// 语言代码规范化：小写、`_` → `-`、只留字母数字与连字符。
/// 非法/空 → 空串（由调用方决定兼底）。
fn normalize_lang(raw: &str) -> String {
    let lowered = raw.trim().to_lowercase().replace('_', "-");
    if !(2..=10).contains(&lowered.len()) {
        return String::new();
    }
    if !lowered.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return String::new();
    }
    lowered
}

/// 界面语言 → 翻译目标语言（设置里选「跟随界面语言」时用）。
/// zh → zh-cn；zh-tw/zh-hant → zh-tw；其它同码即目标码。
fn lang_from_locale(locale: &str) -> String {
    match normalize_lang(locale).as_str() {
        "" => DEFAULT_LANG.to_string(),
        "zh" | "zh-hans" | "zh-cn" | "zh-sg" => "zh-cn".to_string(),
        "zh-tw" | "zh-hk" | "zh-hant" => "zh-tw".to_string(),
        other => other.to_string(),
    }
}

/// 供应商要求的语言字串（MyMemory / 部分 Google 入口要大写区）
fn provider_target(lang: &str) -> String {
    match lang {
        "zh-cn" => "zh-CN".to_string(),
        "zh-tw" => "zh-TW".to_string(),
        other => other.to_string(),
    }
}

/// 解析本次翻译的目标语言：命令参数 → settings.target_language → 界面语言 → zh-cn
fn resolve_lang(app: &tauri::AppHandle, requested: Option<&str>) -> String {
    if let Some(lang) = requested {
        let normalized = normalize_lang(lang);
        if !normalized.is_empty() {
            return normalized;
        }
    }
    let settings = settings::load_for_app(app);
    let from_settings = normalize_lang(&settings.target_language);
    if !from_settings.is_empty() {
        return from_settings;
    }
    lang_from_locale(&settings.locale)
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    (text.chars().take(max).collect(), true)
}

fn snippet(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(max).collect::<String>())
}

/// 按行装箱分块：每块不超过 `max` 字符，超长行硬切；
/// 块与块之间用 "\n" 拼回，保证段落结构不塌陷。
fn chunk_text(text: &str, max: usize) -> Vec<String> {
    // 上限由调用方按 provider 决定（Google 1500 / MyMemory 450），这里只防 0 造成的死循环
    let max = max.max(1);
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.chars().count() > max {
            if !buf.trim().is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            let mut piece = String::new();
            for ch in line.chars() {
                piece.push(ch);
                if piece.chars().count() >= max {
                    out.push(std::mem::take(&mut piece));
                    if out.len() >= MAX_CHUNKS {
                        return out;
                    }
                }
            }
            if !piece.trim().is_empty() {
                out.push(piece);
            }
            if out.len() >= MAX_CHUNKS {
                return out;
            }
            continue;
        }
        let need = if buf.is_empty() { 0 } else { 1 };
        if !buf.is_empty() && buf.chars().count() + need + line.chars().count() > max {
            out.push(std::mem::take(&mut buf));
            if out.len() >= MAX_CHUNKS {
                return out;
            }
        }
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(line);
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

/// MyMemory 会把引号等转成 HTML 实体，这里做最小还原（绝不注入 v-html）
fn unescape_basic(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

// ---------------- 译文缓存 ----------------

struct Memory {
    path: PathBuf,
    store: Store,
}

static MEM: Mutex<Option<Memory>> = Mutex::new(None);
/// 写盘互斥：同一进程内绝不能同时动临时文件
static IO_LOCK: Mutex<()> = Mutex::new(());
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

/// 读盘结果：除内存快照外，还告诉调用方要不要把文件重写一遍
struct LoadOutcome {
    store: Store,
    /// 被剔除的脏条目数
    dropped: usize,
    /// 是否从 v1 扁平结构迁移过来
    migrated: bool,
}

/// 读缓存：自动迁移 v1 → v2，并剔除脏条目（空标题 / 空描述 / 哈希格式不对）
fn read_store(path: &Path) -> LoadOutcome {
    let (mut store, migrated) = read_store_raw(path);

    let mut dropped = 0usize;
    for langs in store.entries.values_mut() {
        let before = langs.len();
        langs.retain(|lang, entry| !lang.trim().is_empty() && !entry.is_dirty());
        dropped += before.saturating_sub(langs.len());
    }
    store.entries.retain(|_, langs| !langs.is_empty());

    if dropped > 0 {
        log::warn!(target: "translate", "剔除 {dropped} 条空内容脏译文（历史 bug 残留）");
    }
    LoadOutcome { store, dropped, migrated }
}

fn read_store_raw(path: &Path) -> (Store, bool) {
    let Ok(bytes) = fs::read(path) else { return (Store::default(), false) };
    let stripped = strip_bom(&bytes);
    let Ok(value) = serde_json::from_slice::<Value>(stripped) else {
        log::warn!(target: "translate", "译文缓存不是合法 JSON，已按空缓存处理");
        return (Store::default(), false);
    };

    if is_v2_shape(&value) {
        let store = match serde_json::from_value::<Store>(value) {
            Ok(store) => {
                if store.version != CURRENT_VERSION {
                    log::info!(
                        target: "translate",
                        "译文缓存版本 {} 与当前 {} 不同，按同名结构继续读取",
                        store.version,
                        CURRENT_VERSION
                    );
                }
                Store { version: CURRENT_VERSION, entries: store.entries }
            }
            Err(e) => {
                log::warn!(target: "translate", "译文缓存结构无法解析（{e}），已按空缓存处理");
                Store::default()
            }
        };
        return (store, false);
    }

    // 其余情况都是 v1：`{version:1, entries:{modId: Entry}}` 或无包裹裸 map
    let flat: BTreeMap<String, Entry> = match value.get("entries") {
        Some(entries) => serde_json::from_value(entries.clone()).unwrap_or_default(),
        None => serde_json::from_value(value.clone()).unwrap_or_default(),
    };
    if flat.is_empty() {
        return (Store::default(), false);
    }
    let mut entries: BTreeMap<String, BTreeMap<String, Entry>> = BTreeMap::new();
    for (mod_id, entry) in flat {
        let mut langs = BTreeMap::new();
        // 旧缓存一定是用中文翻的，统一迁到 zh-cn，不丢数据
        langs.insert(LEGACY_LANG.to_string(), entry);
        entries.insert(mod_id, langs);
    }
    log::info!(
        target: "translate",
        "译文缓存是 v1 结构，已迁移 {} 个模组到 `{LEGACY_LANG}`",
        entries.len()
    );
    (Store { version: CURRENT_VERSION, entries }, true)
}

/// 判定是否为 v2 结构：`entries[modId]` 是一个「语言代码 → Entry」的对象，
/// 而不是一个 Entry（后者含 originalHash / title / zhTitle 这些字段）。
fn is_v2_shape(value: &Value) -> bool {
    let Some(first) = value.get("entries").and_then(|v| v.as_object()).and_then(|o| o.values().next())
    else {
        return false;
    };
    let Some(obj) = first.as_object() else { return false };
    !obj.keys().any(|key| {
        matches!(
            key.as_str(),
            "originalHash" | "titleHash" | "title" | "desc" | "zhTitle" | "zhDesc"
        )
    })
}

fn unique_tmp(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| FILE_NAME.to_string());
    path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()))
}

/// 先写唯一临时文件，再原子替换；rename 失败退 copy；都失败也**绝不删旧缓存**
fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_vec(store).map_err(|e| format!("译文缓存序列化失败：{e}"))?;
    let _io = IO_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let tmp = unique_tmp(path);
    fs::write(&tmp, &text).map_err(|e| format!("写入临时译文缓存失败（{}）：{e}", tmp.display()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first) => match fs::copy(&tmp, path) {
            Ok(_) => {
                let _ = fs::remove_file(&tmp);
                log::warn!(target: "translate", "rename 失败（{first}），已用 copy 兜底写入译文缓存");
                Ok(())
            }
            Err(second) => {
                let _ = fs::remove_file(&tmp);
                Err(format!(
                    "rename 失败（{first}）；copy 兜底也失败（{second}）；tmp={} target={}",
                    tmp.display(),
                    path.display()
                ))
            }
        },
    }
}

fn lock_mem() -> std::sync::MutexGuard<'static, Option<Memory>> {
    MEM.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ensure_loaded(app: &tauri::AppHandle) -> Result<std::sync::MutexGuard<'static, Option<Memory>>, String> {
    let path = path_for(app)?;
    let mut guard = lock_mem();
    let need_reload = match guard.as_ref() {
        Some(mem) => mem.path != path,
        None => true,
    };
    if need_reload {
        let outcome = read_store(&path);
        let LoadOutcome { store, dropped, migrated } = outcome;
        log::info!(
            target: "translate",
            "译文缓存已载入内存：{} 个模组 / {} 条（{}）",
            store.entries.len(),
            store.entries.values().map(|langs| langs.len()).sum::<usize>(),
            path.display()
        );
        if migrated || dropped > 0 {
            match write_store(&path, &store) {
                Ok(()) => log::info!(
                    target: "translate",
                    "译文缓存已重写（迁移={migrated} 剔除={dropped} 条）"
                ),
                Err(e) => log::warn!(target: "translate", "重写译文缓存失败（下次写入会再试）：{e}"),
            }
        }
        *guard = Some(Memory { path, store });
    }
    Ok(guard)
}

/// 读缓存（只读，不刷新访问时间：译文没有 LRU 需求）
pub fn lookup(app: &tauri::AppHandle, mod_id: i64, lang: &str) -> Option<Entry> {
    let guard = ensure_loaded(app).ok()?;
    let mem = guard.as_ref()?;
    mem.store
        .entries
        .get(&mod_id.to_string())
        .and_then(|langs| langs.get(lang))
        .cloned()
}

/// 写缓存：成功返回 path 便于日志；失败只记日志，绝不影响翻译结果。
/// **只写当前语言的槽位**，其它语言的译文原样保留。
pub fn put(app: &tauri::AppHandle, mod_id: i64, lang: &str, entry: Entry) -> Result<PathBuf, String> {
    let mut guard = ensure_loaded(app)?;
    let Some(mem) = guard.as_mut() else {
        return Err("译文缓存未初始化".to_string());
    };
    mem.store
        .entries
        .entry(mod_id.to_string())
        .or_default()
        .insert(lang.to_string(), entry);
    let snapshot = mem.store.clone();
    let path = mem.path.clone();
    drop(guard);
    if let Err(e) = write_store(&path, &snapshot) {
        log::warn!(target: "translate", "写入译文缓存失败：{e}");
        return Err(e);
    }
    Ok(path)
}

// ---------------- 配置 ----------------

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

fn load_config(app: &tauri::AppHandle) -> Config {
    let Ok(path) = config_path(app) else { return Config::default() };
    let Ok(bytes) = fs::read(&path) else { return Config::default() };
    serde_json::from_slice::<Config>(strip_bom(&bytes)).unwrap_or_else(|e| {
        log::warn!(target: "translate", "translate_config.json 解析失败（{e}），已按自动选择接口处理");
        Config::default()
    })
}

/// 接口顺序：设置里显式指定就用指定的；`custom` 暂未实现（只落库），实际按 auto 走；
/// 否则「有代理 → Google 优先，直连 → MyMemory 优先」。
/// 兼容旧 `translate_config.json` 的 provider 字段（settings 未写时生效）。
fn plan(provider_setting: &str, config: &Config, resolved: &net::NetResolution) -> Vec<Provider> {
    let chosen = if provider_setting.trim().is_empty() {
        config.provider.trim().to_ascii_lowercase()
    } else {
        provider_setting.trim().to_ascii_lowercase()
    };
    match chosen.as_str() {
        "google" => vec![Provider::Google],
        "mymemory" => vec![Provider::MyMemory],
        "custom" => {
            log::warn!(
                target: "translate",
                "自定义翻译接口尚未实现，本次按 auto 链路执行（后续版本会接入）"
            );
            auto_plan(resolved)
        }
        _ => auto_plan(resolved),
    }
}

fn auto_plan(resolved: &net::NetResolution) -> Vec<Provider> {
    if resolved.proxy_url.is_some() {
        vec![Provider::Google, Provider::MyMemory]
    } else {
        vec![Provider::MyMemory, Provider::Google]
    }
}

fn build_agent(proxy: Option<ureq::Proxy>) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(20))
        .timeout_write(Duration::from_secs(10))
        .user_agent("AoE2ModManager/0.2 (mod translator)");
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    builder.build()
}

// ---------------- 具体接口 ----------------

fn status_failure(provider: Provider, code: u16, body: &str) -> ApiFailure {
    let kind = match code {
        401 | 403 => "blocked",
        429 => "quota",
        400 | 413 | 414 => "invalid",
        _ => "http",
    };
    ApiFailure::new(
        kind,
        format!("{} 返回 HTTP {code}：{}", provider.label(), snippet(body, 120)),
        Some(code),
    )
}

/// 传输层错误统一归为 kind="network"（DNS / 超时 / 拒绝连接 / TLS 都一样），
/// 前端据此提示「请检查代理或网络」，并在底栏点亮断网标志。
fn transport_failure(provider: Provider, error: ureq::Transport) -> ApiFailure {
    let msg = error.to_string();
    let lower = msg.to_lowercase();
    let hint = if lower.contains("dns")
        || lower.contains("lookup")
        || lower.contains("resolve")
        || lower.contains("name or service")
    {
        "域名解析失败（该接口可能需要代理）"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "连接超时"
    } else if lower.contains("refused") || lower.contains("unreachable") {
        "连接被拒绝"
    } else if lower.contains("reset") {
        "连接被重置"
    } else {
        "网络请求失败"
    };
    ApiFailure::new(
        "network",
        format!("{} 请求失败：{hint}（{msg}）", provider.label()),
        None,
    )
}

/// Google 免费翻译端点（实测 2026-10：`client=gtx` 在代理出口 IP 上返回 429，
/// `client=dict-chrome-ex` 正常；两个域名都试一遍，谁通用谁）
const GOOGLE_ENDPOINTS: [&str; 2] = [
    "https://translate.googleapis.com/translate_a/single",
    "https://clients5.google.com/translate_a/t",
];

/// Google 译文解析。两个端点的嵌套层级不同，按形状自适应：
/// - `single`：`[[["译文","原文",…],…],null,"en"]` → 第 0 项是「片段数组的数组」
/// - `t`：`[["译文","en"]]` → 第 0 项本身就是 `[译文, 源语言]`
fn parse_google_body(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let top = value.get(0)?.as_array()?;
    let out = match top.first() {
        // 形状 A：每个元素是 [译文, 原文, …]，逐段拼接
        Some(Value::Array(_)) => {
            let mut joined = String::new();
            for item in top {
                if let Some(text) = item.as_array().and_then(|arr| arr.first()).and_then(|v| v.as_str()) {
                    joined.push_str(text);
                }
            }
            joined
        }
        // 形状 B：顶层就是 [译文, 源语言]，只取译文
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Google 免费端点：逐端点尝试，任何一个成功即返回。`target` 为供应商要求的语言串。
fn google(agent: &ureq::Agent, text: &str, target: &str) -> Result<String, ApiFailure> {
    let mut last: Option<ApiFailure> = None;
    for url in GOOGLE_ENDPOINTS {
        let call = agent
            .get(url)
            .query("client", "dict-chrome-ex")
            .query("sl", "auto")
            .query("tl", target)
            .query("dt", "t")
            .query("q", text)
            .set("Accept", "application/json")
            .call();

        let body = match call {
            Ok(resp) => resp
                .into_string()
                .map_err(|e| ApiFailure::parse(format!("读取 Google 译文失败：{e}")))?,
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                log::warn!(target: "translate", "Google {url} 返回 HTTP {code}，尝试下一个端点");
                last = Some(status_failure(Provider::Google, code, &body));
                continue;
            }
            Err(ureq::Error::Transport(t)) => {
                last = Some(transport_failure(Provider::Google, t));
                continue;
            }
        };

        match parse_google_body(&body) {
            Some(text) => return Ok(text),
            None => {
                last = Some(ApiFailure::parse(format!(
                    "Google 返回了空译文（{}）",
                    snippet(&body, 120)
                )));
            }
        }
    }
    Err(last.unwrap_or_else(|| ApiFailure::parse("Google 翻译不可用")))
}

/// MyMemory 免费接口：返回 `{responseData:{translatedText}, responseStatus, responseDetails}`
/// 源语言固定 en（模组标题/描述以英文为主）；目标语言由 `target` 决定。
fn mymemory(agent: &ureq::Agent, text: &str, target: &str) -> Result<String, ApiFailure> {
    let langpair = format!("en|{target}");
    let call = agent
        .get("https://api.mymemory.translated.net/get")
        .query("q", text)
        .query("langpair", &langpair)
        .set("Accept", "application/json")
        .call();

    let body = match call {
        Ok(resp) => resp
            .into_string()
            .map_err(|e| ApiFailure::parse(format!("读取 MyMemory 译文失败：{e}")))?,
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            return Err(status_failure(Provider::MyMemory, code, &body));
        }
        Err(ureq::Error::Transport(t)) => return Err(transport_failure(Provider::MyMemory, t)),
    };

    let value: Value = serde_json::from_str(&body)
        .map_err(|e| ApiFailure::parse(format!("MyMemory 译文不是合法 JSON：{e}")))?;
    let translated = value
        .get("responseData")
        .and_then(|d| d.get("translatedText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if translated.is_empty() || translated.to_ascii_uppercase().contains("MYMEMORY WARNING") {
        let status = value.get("responseStatus").and_then(|v| v.as_i64());
        let detail = value
            .get("responseDetails")
            .and_then(|v| v.as_str())
            .unwrap_or("接口未返回译文")
            .to_string();
        let kind = if status == Some(429) || detail.to_ascii_uppercase().contains("QUOTA") {
            "quota"
        } else {
            "parse"
        };
        return Err(ApiFailure::new(
            kind,
            format!("MyMemory：{detail}"),
            status.map(|s| s.clamp(0, 65535) as u16),
        ));
    }

    Ok(unescape_basic(&translated))
}

fn translate_chunk(
    agent: &ureq::Agent,
    provider: Provider,
    text: &str,
    target: &str,
) -> Result<String, ApiFailure> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    throttle();
    match provider {
        Provider::Google => google(agent, text, target),
        Provider::MyMemory => mymemory(agent, text, target),
    }
}

/// 按 provider 顺序逐个尝试；任一块失败就整体换下一个 provider（不重试同一家）
fn translate_text(
    agent: &ureq::Agent,
    text: &str,
    providers: &[Provider],
    target: &str,
) -> Result<(String, Provider), ApiFailure> {
    let mut last: Option<ApiFailure> = None;
    for provider in providers {
        let chunks = chunk_text(text, provider.chunk_chars());
        if chunks.is_empty() {
            return Ok((String::new(), *provider));
        }
        let mut parts: Vec<String> = Vec::with_capacity(chunks.len());
        let mut ok = true;
        for chunk in &chunks {
            match translate_chunk(agent, *provider, chunk, target) {
                Ok(part) => parts.push(part),
                Err(err) => {
                    log::warn!(
                        target: "translate",
                        "{} 分块翻译失败（{}）：{}",
                        provider.name(),
                        chunk.chars().count(),
                        err.message
                    );
                    last = Some(err);
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            let joined = parts.join("\n");
            if !joined.trim().is_empty() {
                log::info!(target: "translate", "{} 翻译完成：{} 块", provider.name(), chunks.len());
                return Ok((joined, *provider));
            }
            last = Some(ApiFailure::parse(format!("{} 返回了空译文", provider.label())));
        }
    }
    Err(last.unwrap_or_else(|| ApiFailure::new("network", "翻译失败：没有可用的翻译接口", None)))
}

// ---------------- 主流程 ----------------

fn run_translation(
    app: &tauri::AppHandle,
    mod_id: i64,
    title: &str,
    description: &str,
    hash: &str,
    truncated: bool,
    lang: &str,
) -> Result<Translation, ApiFailure> {
    // 信号量在阻塞线程里获取：不会把异步运行时的工作线程堵住
    let _slot = Slot::acquire();

    let settings = settings::load_for_app(app);
    let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
        .map_err(|e| ApiFailure::new("network", format!("网络配置无效：{e}"), None))?;
    let proxy = net::ureq_proxy(&resolved).map_err(|e| ApiFailure::new("network", e, None))?;
    let config = load_config(app);
    let providers = plan(&settings.translate_provider, &config, &resolved);
    let agent = build_agent(proxy);
    let target = provider_target(lang);

    log::info!(
        target: "translate",
        "开始翻译 modId={mod_id} → {lang}：接口顺序={:?}，代理={:?}",
        providers.iter().map(|p| p.name()).collect::<Vec<_>>(),
        resolved.proxy_url
    );

    let (translated_title, title_provider) = if title.is_empty() {
        (String::new(), providers[0])
    } else {
        translate_text(&agent, title, &providers, &target)?
    };

    let (translated_desc, desc_provider) = if description.is_empty() {
        (String::new(), title_provider)
    } else {
        translate_text(&agent, description, &providers, &target)?
    };

    let provider = if description.is_empty() { title_provider } else { desc_provider };
    let char_count = (title.chars().count() + description.chars().count()) as u64;
    let saved_at_ms = now_ms();

    let entry = Entry {
        original_hash: hash.to_string(),
        title_hash: title_hash(title),
        title: translated_title.clone(),
        desc: translated_desc.clone(),
        provider: provider.name().to_string(),
        char_count,
        saved_at_ms,
    };

    match put(app, mod_id, lang, entry) {
        Ok(path) => log::info!(
            target: "translate",
            "译文已写入缓存：{}（modId={mod_id} lang={lang}）",
            path.display()
        ),
        Err(e) => log::warn!(target: "translate", "译文缓存写入失败（不影响本次结果）：{e}"),
    }

    Ok(Translation {
        mod_id,
        lang: lang.to_string(),
        original_hash: hash.to_string(),
        title: translated_title,
        desc: translated_desc,
        provider: provider.name().to_string(),
        char_count,
        saved_at_ms,
        cached: false,
        truncated,
    })
}

/// 一键翻译：缓存命中即零请求返回；否则走免费接口翻译并写回缓存。
/// 默认**不会**被自动调用 —— 只有用户点按钮才会进来。
#[tauri::command]
pub async fn translate_mod_text(
    app: tauri::AppHandle,
    mod_id: i64,
    title: String,
    description: String,
    target_lang: Option<String>,
) -> Result<Translation, ApiFailure> {
    if mod_id <= 0 {
        return Err(ApiFailure::new("invalid", "模组 ID 无效，无法翻译", None));
    }
    let lang = resolve_lang(&app, target_lang.as_deref());
    let title = title.trim().to_string();
    let description = description.trim().to_string();
    if title.is_empty() {
        return Err(ApiFailure::new("invalid", "该模组没有可翻译的标题", None));
    }
    // 硬拦截：描述为空/过短说明详情还没加载完，绝不能拿空文本去翻译并写缓存
    // （否则 hash 被空描述占位，之后详情加载出来也永远不会再翻译）
    if description.chars().count() < MIN_DESC_CHARS {
        log::warn!(
            target: "translate",
            "拒绝翻译 modId={mod_id}：描述只有 {} 个字符（需要至少 {MIN_DESC_CHARS}）",
            description.chars().count()
        );
        return Err(ApiFailure::new(
            "not_ready",
            "模组描述还没加载完成，请稍候再点翻译",
            None,
        ));
    }

    let (description, truncated) = truncate_chars(&description, MAX_TOTAL_CHARS);
    let hash = hash_of(&title, &description);

    // ① 本地缓存命中且原文未变 → 直接返回，一个 HTTP 都不发（只看当前语言的槽位）
    if let Some(entry) = lookup(&app, mod_id, &lang) {
        if entry.original_hash == hash {
            log::info!(target: "translate", "译文缓存命中：modId={mod_id} lang={lang}（hash={hash}）");
            return Ok(entry.into_translation(mod_id, &lang, true, truncated));
        }
        log::info!(
            target: "translate",
            "原文已变化，重新翻译：modId={mod_id} lang={lang}（缓存 {} → 现在 {}）",
            entry.original_hash,
            hash
        );
    }

    // ② 单飞：同一模组同时只跑一个任务
    let _inflight = Inflight::acquire(mod_id)?;

    let handle = app.clone();
    let task_title = title.clone();
    let task_desc = description.clone();
    let task_hash = hash.clone();
    let task_lang = lang.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        run_translation(
            &handle,
            mod_id,
            &task_title,
            &task_desc,
            &task_hash,
            truncated,
            &task_lang,
        )
    })
    .await
    .map_err(|e| ApiFailure::new("internal", format!("翻译任务失败：{e}"), None))?;

    joined
}

/// 缓存条目是否可用于本次探测。
///
/// - 有完整描述（≥ [`MIN_DESC_CHARS`]）→ 严格比 `originalHash`；
/// - 只有标题（列表卡片）→ 比 `titleHash`；
/// - 旧条目（本字段引入前写入的，`title_hash` 为空）→ 按 modId 认下。
///   升级不能把用户已有的中文标题一次抹掉；下次重译会自动种上 titleHash。
fn entry_matches(entry: &Entry, title: &str, description: &str) -> bool {
    if description.trim().chars().count() >= MIN_DESC_CHARS {
        return entry.original_hash == hash_of(title, description);
    }
    if entry.title_hash.trim().is_empty() {
        return true;
    }
    entry.title_hash == title_hash(title)
}

/// 单个只读探测（本地模组详情页用）
/// 只读探测（**绝不发任何网络请求**），只看 `lang` 语言的槽位。
///
/// 匹配规则见 [`entry_matches`]：有描述就严格、只有标题就按 titleHash，
/// 保证重启后译文标题不会退回原文。
fn probe_cached(
    app: &tauri::AppHandle,
    mod_id: i64,
    title: &str,
    description: &str,
    lang: &str,
) -> Option<Translation> {
    if mod_id <= 0 {
        return None;
    }
    let title = title.trim();
    let (description, truncated) = truncate_chars(description.trim(), MAX_TOTAL_CHARS);
    if title.is_empty() && description.is_empty() {
        return None;
    }
    let entry = lookup(app, mod_id, lang)?;
    if !entry_matches(&entry, title, &description) {
        return None;
    }
    Some(entry.into_translation(mod_id, lang, true, truncated))
}

/// 单个只读探测（本地模组详情页用）
#[tauri::command]
pub async fn translation_cached(
    app: tauri::AppHandle,
    mod_id: i64,
    title: String,
    description: String,
    target_lang: Option<String>,
) -> Option<Translation> {
    let lang = resolve_lang(&app, target_lang.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        probe_cached(&app, mod_id, &title, &description, &lang)
    })
    .await
    .ok()
    .flatten()
}

/// 批量只读探测：列表渲染前一次性把已缓存的译文接回来（仍不联网、不写盘）。
///
/// 历史 bug：前端启动时从不查缓存，重启后整个列表又变回原文。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeItem {
    pub mod_id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// 不传则回到设置/界面语言
    #[serde(default)]
    pub target_lang: Option<String>,
}

#[tauri::command]
pub async fn translations_cached(app: tauri::AppHandle, items: Vec<ProbeItem>) -> Vec<Translation> {
    let items: Vec<ProbeItem> = items
        .into_iter()
        .filter(|item| item.mod_id > 0)
        .take(MAX_BATCH_PROBES)
        .collect();
    if items.is_empty() {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 语言只解析一次（避免每条都读一遍 settings.json）
        let lang = resolve_lang(&app, items.first().and_then(|item| item.target_lang.as_deref()));
        items
            .iter()
            .filter_map(|item| probe_cached(&app, item.mod_id, &item.title, &item.description, &lang))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
}

// ---------------- 设置与缓存管理（设置页「翻译」页签） ----------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSettingsView {
    /// 用户存下的值；空串 = 跟随界面语言
    pub target_language: String,
    /// 实际生效的语言（小写）
    pub resolved_language: String,
    /// auto | google | mymemory | custom
    pub provider: String,
    pub custom_url: Option<String>,
    /// 只告诉前端“有没有存 key”，绝不回传密钥本体
    pub custom_key_set: bool,
    pub supported_languages: Vec<String>,
}

fn translate_view(app: &tauri::AppHandle) -> TranslateSettingsView {
    let settings = settings::load_for_app(app);
    let resolved = if normalize_lang(&settings.target_language).is_empty() {
        lang_from_locale(&settings.locale)
    } else {
        normalize_lang(&settings.target_language)
    };
    TranslateSettingsView {
        target_language: normalize_lang(&settings.target_language),
        resolved_language: resolved,
        provider: if settings.translate_provider.trim().is_empty() {
            "auto".to_string()
        } else {
            settings.translate_provider.trim().to_ascii_lowercase()
        },
        custom_url: settings.translate_custom_url.clone().filter(|v| !v.trim().is_empty()),
        custom_key_set: settings
            .translate_custom_key
            .as_deref()
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false),
        supported_languages: SUPPORTED_LANGS.iter().map(|lang| lang.to_string()).collect(),
    }
}

#[tauri::command]
pub fn get_translate_settings(app: tauri::AppHandle) -> TranslateSettingsView {
    translate_view(&app)
}

/// 保存翻译设置。`target_language` 传空串 = 跟随界面语言。
#[tauri::command]
pub fn set_translate_settings(
    app: tauri::AppHandle,
    target_language: Option<String>,
    provider: Option<String>,
    custom_url: Option<String>,
    custom_key: Option<String>,
) -> Result<TranslateSettingsView, String> {
    let mut settings = settings::load_for_app(&app);

    if let Some(lang) = target_language {
        let trimmed = lang.trim().to_string();
        if trimmed.is_empty() {
            settings.target_language = String::new(); // 跟随界面语言
        } else {
            let normalized = normalize_lang(&trimmed);
            if normalized.is_empty() {
                return Err(format!("不支持的目标语言：{trimmed}"));
            }
            if !SUPPORTED_LANGS.contains(&normalized.as_str()) {
                log::warn!(
                    target: "translate",
                    "目标语言 {normalized} 不在预设列表内，仍按客户端支持处理"
                );
            }
            settings.target_language = normalized;
        }
    }

    if let Some(provider) = provider {
        let normalized = provider.trim().to_ascii_lowercase();
        let allowed = ["auto", "google", "mymemory", "custom"];
        if !allowed.contains(&normalized.as_str()) {
            return Err(format!("不支持的翻译引擎：{provider}"));
        }
        settings.translate_provider = normalized;
    }

    if let Some(url) = custom_url {
        let trimmed = url.trim().to_string();
        settings.translate_custom_url = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    // 空串 = 保持原值（前端不回传密钥本体，避免把已存的 key 抹掉）
    if let Some(key) = custom_key {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            settings.translate_custom_key = Some(trimmed);
        }
    }

    settings::save_for_app(&app, &settings)?;
    log::info!(
        target: "translate",
        "翻译设置已保存：语言={} 引擎={}",
        if settings.target_language.is_empty() { "跟随界面" } else { &settings.target_language },
        settings.translate_provider
    );
    Ok(translate_view(&app))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LangCount {
    pub lang: String,
    pub count: usize,
}

/// 翻译缓存总览：设置页显示条目数与语言分布
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCacheStat {
    pub path: String,
    /// 条目总数（模组 × 语言）
    pub entries: usize,
    /// 涉及多少个模组
    pub mods: usize,
    pub bytes: u64,
    pub by_language: Vec<LangCount>,
    pub oldest_ms: Option<u64>,
    pub newest_ms: Option<u64>,
}

#[tauri::command]
pub async fn translation_cache_stat(app: tauri::AppHandle) -> TranslationCacheStat {
    let path = path_for(&app).ok();
    let display = path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let bytes = path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);

    let (mods, entries, by_language, oldest, newest) = match ensure_loaded(&app) {
        Ok(guard) => match guard.as_ref() {
            Some(mem) => {
                let mut counts: BTreeMap<String, usize> = BTreeMap::new();
                let mut total = 0usize;
                for langs in mem.store.entries.values() {
                    for (lang, entry) in langs {
                        *counts.entry(lang.clone()).or_insert(0) += 1;
                        total += 1;
                        let _ = entry;
                    }
                }
                let oldest = mem
                    .store
                    .entries
                    .values()
                    .flat_map(|langs| langs.values())
                    .map(|entry| entry.saved_at_ms)
                    .min();
                let newest = mem
                    .store
                    .entries
                    .values()
                    .flat_map(|langs| langs.values())
                    .map(|entry| entry.saved_at_ms)
                    .max();
                let by_language = counts
                    .into_iter()
                    .map(|(lang, count)| LangCount { lang, count })
                    .collect();
                (mem.store.entries.len(), total, by_language, oldest, newest)
            }
            None => (0, 0, Vec::new(), None, None),
        },
        Err(_) => (0, 0, Vec::new(), None, None),
    };

    TranslationCacheStat {
        path: display,
        entries,
        mods,
        bytes,
        by_language,
        oldest_ms: oldest,
        newest_ms: newest,
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranslationClearReport {
    pub removed: bool,
    pub path: String,
    pub entries_removed: usize,
}

#[tauri::command]
pub async fn translation_cache_clear(app: tauri::AppHandle) -> Result<TranslationClearReport, String> {
    let path = path_for(&app)?;
    let display = path.display().to_string();
    let entries_removed = {
        let mut guard = lock_mem();
        let removed = guard
            .as_ref()
            .map(|mem| mem.store.entries.values().map(|langs| langs.len()).sum::<usize>())
            .unwrap_or(0);
        *guard = Some(Memory {
            path: path.clone(),
            store: Store::default(),
        });
        removed
    };
    let removed = if path.is_file() {
        let _io = IO_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        fs::remove_file(&path).map_err(|e| format!("删除翻译缓存失败：{e}"))?;
        true
    } else {
        false
    };
    log::info!(target: "translate", "翻译缓存已清理：{display}（{entries_removed} 条）");
    Ok(TranslationClearReport { removed, path: display, entries_removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_sensitive_to_both_fields() {
        let base = hash_of("Japanese Villager", "Replaces the sound.");
        assert_eq!(base, hash_of("  Japanese Villager  ", "Replaces the sound."));
        assert_eq!(base.chars().count(), 16);
        assert_ne!(base, hash_of("Japanese Villager 2", "Replaces the sound."));
        assert_ne!(base, hash_of("Japanese Villager", "Replaces the sound!"));
    }

    /// 在线（plainText）与本地（clean_description）拿到的文本空白/实体不同，
    /// 必须算出同一个 hash，否则同一个 modId 会在两个页面互相覆盖缓存。
    #[test]
    fn hash_ignores_whitespace_and_entity_differences() {
        let from_online = "Replaces the villager&#39;s sound.\n\n\nWorks in 1v1.";
        let from_local = "Replaces the villager's sound.\n\nWorks in 1v1.";
        assert_eq!(
            hash_of("Villager pack", from_online),
            hash_of("Villager pack", from_local),
            "空白与 &#39; 的差异不得让缓存失效"
        );
        // 实质内容变化仍然要能识别
        assert_ne!(
            hash_of("Villager pack", "Replaces the sound."),
            hash_of("Villager pack", "Replaces the music.")
        );
    }

    #[test]
    fn fnv1a64_matches_known_vector() {
        // FNV-1a 64 of empty string = offset basis
        assert_eq!(fnv1a64(""), 0xCBF2_9CE4_8422_2325);
        // "a" = 0xaf63dc4c8601ec8c
        assert_eq!(fnv1a64("a"), 0xAF63_DC4C_8601_EC8C);
    }

    #[test]
    fn chunk_text_respects_limit_and_keeps_order() {
        let text = "line one\nline two\nline three";
        let chunks = chunk_text(text, 12);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= 12, "{chunk:?} 超过上限");
        }
        let joined = chunks.join("\n");
        assert!(joined.contains("line one") && joined.contains("line three"));
    }

    #[test]
    fn chunk_text_hard_splits_long_line() {
        let long = "x".repeat(100);
        let chunks = chunk_text(&long, 30);
        assert!(chunks.len() >= 4);
        assert!(chunks.iter().all(|c| c.chars().count() <= 30));
        assert_eq!(chunks.concat().chars().count(), 100);
    }

    #[test]
    fn chunk_text_never_exceeds_max_chunks() {
        let text = (0..500).map(|i| format!("sentence {i}")).collect::<Vec<_>>().join("\n");
        assert!(chunk_text(&text, 80).len() <= MAX_CHUNKS);
    }

    #[test]
    fn truncate_chars_is_char_safe() {
        let (text, cut) = truncate_chars("替换了日本村民的音效", 3);
        assert!(cut);
        assert_eq!(text.chars().count(), 3);
        let (same, cut) = truncate_chars("短", 10);
        assert!(!cut);
        assert_eq!(same, "短");
    }

    #[test]
    fn read_store_accepts_wrapped_and_bare_formats() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-translate-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        // 裸 map（用户示例的旧形态）→ 迁移到 zh-cn
        fs::write(
            &path,
            br#"{"155009":{"originalHash":"0123456789abcdef","zhTitle":"\u65e5\u672c\u5973\u6751\u6c11\u97f3\u6548","zhDesc":"x"}}"#,
        )
        .unwrap();
        let outcome = read_store(&path);
        assert!(outcome.migrated, "v1 必须标记为已迁移并写回");
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.store.version, CURRENT_VERSION);
        assert_eq!(outcome.store.entries["155009"]["zh-cn"].title, "日本女村民音效");

        // 包裹的 v1 形态
        fs::write(
            &path,
            br#"{"version":1,"entries":{"42":{"originalHash":"fedcba9876543210","zhTitle":"t","zhDesc":"d"}}}"#,
        )
        .unwrap();
        let outcome = read_store(&path);
        assert_eq!(outcome.store.entries["42"]["zh-cn"].title, "t");

        // 已是 v2：不应重写
        fs::write(
            &path,
            br#"{"version":2,"entries":{"9":{"ja":{"originalHash":"0123456789abcdef","title":"\u65e5\u672c\u8a9e","desc":"d"}}}}"#,
        )
        .unwrap();
        let outcome = read_store(&path);
        assert!(!outcome.migrated);
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.store.entries["9"]["ja"].title, "日本語");

        // 损坏文件不能把界面搞崩
        fs::write(&path, b"\xEF\xBB\xBFnot json").unwrap();
        assert!(read_store(&path).store.entries.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 语言隔离：同一个模组的中日译文必须共存，切语言不互相覆盖。
    #[test]
    fn store_keeps_languages_isolated() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-translate-lang-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let mut store = Store::default();
        let mut langs = BTreeMap::new();
        langs.insert(
            "zh-cn".to_string(),
            Entry {
                original_hash: "0123456789abcdef".into(),
                title: "遗迹".into(),
                desc: "描述".into(),
                ..Default::default()
            },
        );
        langs.insert(
            "ja".to_string(),
            Entry {
                original_hash: "0123456789abcdef".into(),
                title: "遺跡".into(),
                desc: "説明".into(),
                ..Default::default()
            },
        );
        store.entries.insert("37614".to_string(), langs);
        write_store(&path, &store).unwrap();

        let reloaded = read_store(&path).store;
        assert_eq!(reloaded.entries["37614"]["zh-cn"].title, "遗迹");
        assert_eq!(reloaded.entries["37614"]["ja"].title, "遺跡");
        assert_eq!(reloaded.entries["37614"].len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_lang_and_locale_mapping() {
        assert_eq!(normalize_lang("  ZH_CN "), "zh-cn");
        assert_eq!(normalize_lang("ja"), "ja");
        assert_eq!(normalize_lang(""), "");
        assert_eq!(normalize_lang("!!"), "");
        // 跟随界面语言
        assert_eq!(lang_from_locale("zh"), "zh-cn");
        assert_eq!(lang_from_locale("zh-TW"), "zh-tw");
        assert_eq!(lang_from_locale("en"), "en");
        assert_eq!(lang_from_locale(""), DEFAULT_LANG);
        // 供应商字串
        assert_eq!(provider_target("zh-cn"), "zh-CN");
        assert_eq!(provider_target("ja"), "ja");
    }

    /// 历史 bug 的残留：详情未加载完就点翻译 → 空描述被写进缓存。
    /// 这些条目必须在读盘时就被剔除。
    #[test]
    fn read_store_drops_empty_content_entries() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-translate-dirty-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        fs::write(
            &path,
            br#"{"version":2,"entries":{"9":{
                "zh-cn":{"originalHash":"0123456789abcdef","title":"t","desc":""}
            },"10":{
                "zh-cn":{"originalHash":"0123456789abcdef","title":"  ","desc":"d"},
                "ja":{"originalHash":"bad","title":"t","desc":"d"},
                "en":{"originalHash":"0123456789abcdef","title":"t","desc":"d"}
            }}}"#,
        )
        .unwrap();
        let outcome = read_store(&path);
        assert_eq!(outcome.dropped, 3, "空描述 / 空标题 / 坏哈希都要剔除");
        assert_eq!(outcome.store.entries.len(), 1, "模组 9 整个被清空后应消失");
        assert_eq!(outcome.store.entries["10"].len(), 1);
        assert!(outcome.store.entries["10"].contains_key("en"));
    }

    #[test]
    fn write_store_is_atomic_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("aoe2mm-translate-w-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        let mut store = Store::default();
        let mut langs = BTreeMap::new();
        langs.insert(
            "zh-cn".to_string(),
            Entry {
                original_hash: "0123456789abcdef".into(),
                title_hash: title_hash("标题"),
                title: "标题".into(),
                desc: "描述".into(),
                ..Default::default()
            },
        );
        store.entries.insert("7".to_string(), langs);
        write_store(&path, &store).expect("写盘不得失败");

        let outcome = read_store(&path);
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.store.entries["7"]["zh-cn"].title, "标题");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不得留下临时文件");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_google_body_handles_both_shapes() {
        // single 端点
        let single = r#"[[["日本村民声音替换","Japanese villager sound replacement",null,null,3]],null,"en"]"#;
        assert_eq!(parse_google_body(single).unwrap(), "日本村民声音替换");
        // t 端点（平面结构）
        assert_eq!(
            parse_google_body(r#"[["日本村民声音替换","en"]]"#).unwrap(),
            "日本村民声音替换"
        );
        // 多片段要拼接
        assert_eq!(parse_google_body(r#"[[["A","a"],["B","b"]]]"#).unwrap(), "AB");
        // 不合法/空值一律 None，由上层换 provider
        assert!(parse_google_body("not json").is_none());
        assert!(parse_google_body("[]").is_none());
    }

    /// 真实联网验证：走当前系统代理调 Google / MyMemory（默认跳过）。
    /// 跑法：`cargo test --lib translator::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore = "需要访问 translate.googleapis.com / api.mymemory.translated.net"]
    fn live_translate_uses_real_endpoints() {
        let settings = crate::models::Settings::default();
        let resolved = net::resolve(&net::NetConfig::from_settings(&settings))
            .expect("默认设置必须能解析出网络配置");
        let proxy = net::ureq_proxy(&resolved).expect("代理应可用");
        let agent = build_agent(proxy);
        println!("代理：{:?}", resolved.proxy_url);

        match google(&agent, "Japanese villager sound replacement", "zh-CN") {
            Ok(text) => println!("Google OK: {text}"),
            Err(e) => println!("Google 失败：kind={} msg={}", e.kind, e.message),
        }
        match mymemory(&agent, "Japanese villager sound replacement", "zh-CN") {
            Ok(text) => println!("MyMemory OK: {text}"),
            Err(e) => println!("MyMemory 失败：kind={} msg={}", e.kind, e.message),
        }
    }

    #[test]
    fn queue_serves_tickets_in_fifo_order() {
        use std::sync::mpsc;
        let (tx, rx) = mpsc::channel::<u64>();
        let mut handles = Vec::new();
        for _ in 0..5 {
            let tx = tx.clone();
            handles.push(std::thread::spawn(move || {
                let slot = Slot::acquire();
                let ticket = slot.ticket;
                // 拿到执行权后立即上报票号：上报顺序 == 实际执行顺序
                tx.send(ticket).unwrap();
                std::thread::sleep(Duration::from_millis(5));
            }));
        }
        drop(tx);
        let served: Vec<u64> = rx.iter().collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(served.len(), 5, "五个任务必须都执行到");
        let base = served[0];
        let expected: Vec<u64> = (0..5).map(|i| base + i).collect();
        assert_eq!(served, expected, "队列必须严格 FIFO（不能饿死后来者）：{served:?}");
    }

    /// 10 次连点的安全底线：两次外部请求之间硬性隔 1 秒。
    #[test]
    fn throttle_spaces_requests_by_one_second() {
        throttle(); // 第一个请求立即放行
        let start = now_ms();
        throttle(); // 第二个必须等满
        let elapsed = now_ms().saturating_sub(start);
        assert!(
            elapsed >= MIN_REQUEST_GAP_MS - 50,
            "两次请求间隔不足 1 秒：{elapsed}ms"
        );
    }

    #[test]
    fn entry_matches_strict_and_title_level() {
        let title = "Villager pack";
        let desc = "Replaces the villager sound.";
        let entry = Entry {
            original_hash: hash_of(title, desc),
            title_hash: title_hash(title),
            title: "村民包".into(),
            desc: "替换村民音效".into(),
            ..Default::default()
        };
        // 带描述 → 严格匹配
        assert!(entry_matches(&entry, title, desc));
        assert!(!entry_matches(&entry, title, "Replaces the music."));
        // 只有标题（列表卡片）→ 按 titleHash
        assert!(entry_matches(&entry, title, ""));
        assert!(!entry_matches(&entry, "Another pack", ""));

        // 旧条目（没有 titleHash）：不能因为升级就把已有的中文标题抹掉
        let legacy = Entry {
            original_hash: hash_of(title, desc),
            title_hash: String::new(),
            title: "村民包".into(),
            desc: "替换村民音效".into(),
            ..Default::default()
        };
        assert!(entry_matches(&legacy, title, ""));
        // 但它仍要接受描述级严格校验
        assert!(!entry_matches(&legacy, title, "Replaces the music."));
    }

    #[test]
    fn plan_prefers_google_behind_proxy() {
        let config = Config::default();
        let via_proxy = net::NetResolution {
            mode: "system".into(),
            source: "system".into(),
            proxy_url: Some("http://127.0.0.1:7897".into()),
            note: None,
        };
        let direct = net::NetResolution {
            mode: "system".into(),
            source: "direct".into(),
            proxy_url: None,
            note: None,
        };
        // auto：有代理 Google 优先，直连 MyMemory 优先
        assert_eq!(plan("auto", &config, &via_proxy)[0], Provider::Google);
        assert_eq!(plan("auto", &config, &direct)[0], Provider::MyMemory);
        // 设置里写死的引擎优先
        assert_eq!(plan("mymemory", &config, &via_proxy)[0], Provider::MyMemory);
        assert_eq!(plan("google", &config, &direct)[0], Provider::Google);
        // custom 尚未实现 → 回落到 auto
        assert_eq!(plan("custom", &config, &via_proxy)[0], Provider::Google);
    }
}
