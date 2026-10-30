//! 在线模组全量索引（`online_index.json`）—— 中文搜索的底座。
//!
//! ## 为什么需要它
//! 官方 `/Find` 的 `q` 只认英文：搜「车」永远 0 条。所以把每个模组的
//! **纯文本骨架**（ID / 英文标题 / 作者 / 分类）静默存到本地，配合
//! `translation_cache.json` 里的中文标题，就能做纯离线的中文搜索。
//!
//! ## 四条硬规则（都是踩过的坑）
//! 1. **绝不走 `online_find` 命令**：那个命令每次成功都会把整页写进
//!    `online_cache.json`。200 页 × 128KB 会把真正的搜索结果挤掉
//!    （`cache.rs` MAX_ENTRIES=10000 / MAX_BYTES=200MB）。这里直接调
//!    [`ApiClient::find`]，只写自己的文件。
//! 2. **宁慢勿封**：两次请求之间硬性 1.2s + 0~300ms 抖动；单次运行最多
//!    [`MAX_PAGES_PER_RUN`] 页，跑不完下次启动接着来。快几秒换来 IP 被拉黑不值。
//! 3. **不拉长描述**：列表接口本来就不带 description，天然满足；`raw`
//!    （接口原始 JSON，占 90%+ 体积）在写索引前就丢掉，单条约 200 字节。
//! 4. **写盘绝不能每页一次**：整文件原子替换很贵（1 万条 ≈ 2.5MB），
//!    所以每 [`FLUSH_EVERY_PAGES`] 页 + 结束时各落一次盘。
//!
//! ## 断点与增量（v2 分区模型）
//! 服务端**深翻页有截断**：`recentpopular` 从 start=851 起直接返回空页。
//! 所以单游标永远只能扫到前 ~850 条（v1 的 bug：把空页当成「全网扫完」，
//! 于是 `done=true` 卡在 850 条，每次启动都原地重扫）。
//!
//! - `partitions` = 7 个排序窗口 + 每个分类一个窗口，每个分区**独立游标**；
//! - 空页只把当前分区标成 `exhausted`，继续下一个窗口（并集覆盖全网）；
//! - 全部窗口走完才算 `done`；下次启动只看全局总量与时效决定要不要重扫。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};

use crate::online::api::{ApiClient, ApiFailure, GAME_AOE2DE};
use crate::online::models::{pick_str, FindResult, OnlineModSummary};

pub const FILE_NAME: &str = "online_index.json";
/// 索引进度事件名：每写入一批数据推一次，前端据此实时刷新进度（不再轮询）
pub const PROGRESS_EVENT: &str = "online://index-progress";
/// Cookie 失效 / 未登录时的统一文案（界面红点直接用这句）
pub const NEED_LOGIN_MESSAGE: &str = "索引同步失败：请先登录";
/// 2 = 分区遍历（v1 的单游标模型会把「深翻页截断」误判成「全网扫完」）
pub const CURRENT_VERSION: u32 = 2;

/// 官方 `/Find` 单页上限（与命令层 `count.clamp(1, 50)` 一致）
const PAGE_SIZE: i64 = 50;
/// 两次请求之间的硬性间隔：宁可慢，也不能被限流
const REQUEST_GAP_MS: u64 = 1_200;
/// 间隔抖动上限（避免固定节奏被识别成脚本）
const JITTER_MAX_MS: u64 = 300;
/// 硬上限：10 万条。官方总量 4 万+ 且仍在增长，一步到位留足余量避免漏搜；
/// 纯文本单条约 200 字节，10 万条 ≈ 20MB，内存与写盘都不成问题。
/// 到顶仍会停止增长，绝不让异常数据把磁盘撑爆。
pub const MAX_ITEMS: usize = 100_000;
/// 单次运行最多拉几页（400 × 50 = 2 万条），到上限暂停，下次启动继续
const MAX_PAGES_PER_RUN: u32 = 400;
/// 每多少页落一次盘
const FLUSH_EVERY_PAGES: u32 = 20;
/// 完整扫描的刷新周期：订阅数 / 下载量会漂移
const FULL_SYNC_INTERVAL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// 距上次更新不足这个时间 → 启动时一个请求都不发
const INCREMENTAL_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
/// 被限流后的冷却时间（本轮内不再尝试）
const COOLDOWN_MS: u64 = 30 * 60 * 1000;
/// 启动后等多久才开始后台同步：让首屏、登录校验、更新检查先跑
const BG_START_DELAY_SECS: u64 = 8;
/// 分区遍历的排序窗口。
///
/// **服务端对深翻页有截断**（实测 `recentpopular` 从 start=851 起直接返回空页），
/// 单排序永远只能扫到前 ~850 条；而官方总量是 4 万+。所以必须用多个互不相同的
/// 窗口取并集：按「价值顺序」排，前几个窗口扫完就能覆盖用户最常搜到的模组。
const SORTS: [&str; 7] = [
    "lastUpdate",
    "recentpopular",
    "popular",
    "createDate",
    "rating",
    "modName",
    "creatorName",
];
/// 标签分区用「最多订阅」：每个标签只取最热门的那一截
const TAG_SORT: &str = "popular";
const ORDER: &str = "DESC";
/// 搜索一次最多返回多少条（前端按 24 分页，这里留余量）
const SEARCH_LIMIT_MAX: i64 = 60;

// ---------------- 数据结构 ----------------

/// 一次遍历分区（一个排序窗口，或「某个分类 + 某个排序」）。
///
/// 每个分区**独立游标**：某个窗口被服务端截断（空页）时，只把这个分区标成
/// exhausted，然后继续下一个窗口——这才是绕开深翻页限制的正确姿势。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    pub sort: String,
    #[serde(default)]
    pub tags: Vec<i64>,
    /// 可读名称（日志与状态展示用）
    #[serde(default)]
    pub label: String,
    /// 下一页 start（从 1 起）
    #[serde(default = "partition_default_cursor")]
    pub cursor: i64,
    /// 该分区服务端总量（0 = 未知）
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub exhausted: bool,
}

fn partition_default_cursor() -> i64 {
    1
}

/// 索引里的一条模组（只存搜索与卡片渲染需要的纯文本骨架）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexItem {
    pub mod_id: i64,
    pub title: String,
    #[serde(default)]
    pub creator: String,
    #[serde(default)]
    pub thumbnail: String,
    #[serde(default)]
    pub installs: i64,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    #[serde(default)]
    pub tag_names: Vec<String>,
    #[serde(default)]
    pub last_update: String,
    #[serde(default)]
    pub first_seen_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u32,
    #[serde(default)]
    pub game: i64,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub order: String,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
    /// 服务端报的全局总量（前端据此显示「已收录 N / M」）
    #[serde(default)]
    pub total_count: i64,
    /// 遍历计划：排序窗口 + 每个分类各一个分区
    #[serde(default)]
    pub partitions: Vec<Partition>,
    /// 当前分区下标（== partitions.len() 表示全部扫完）
    #[serde(default)]
    pub active: usize,
    #[serde(default)]
    pub done: bool,
    /// 上一次完整扫描完成的时间（>7 天触发全量重扫）
    #[serde(default)]
    pub full_synced_at_ms: u64,
    /// modId 字符串 → 条目：增量补充天然幂等，不会出现重复
    #[serde(default)]
    pub items: BTreeMap<String, IndexItem>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            game: GAME_AOE2DE,
            sort: SORTS[0].to_string(),
            order: ORDER.to_string(),
            created_at_ms: 0,
            updated_at_ms: 0,
            total_count: 0,
            partitions: Vec::new(),
            active: 0,
            done: false,
            full_synced_at_ms: 0,
            items: BTreeMap::new(),
        }
    }
}

/// 索引状态（设置页 / 搜索拦截都会读）
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// 已收录条数
    pub indexed: usize,
    /// 服务端报的总量（0 = 还没拿到）
    pub total_count: i64,
    /// 已顺序消费的条数
    pub scanned: i64,
    /// 是否已完整扫描过一遍
    pub done: bool,
    /// 是否有同步在进行
    pub syncing: bool,
    /// 是否已开启「本地中文搜索与自动索引」（settings.json 的 `enable_indexing`）
    pub indexing_enabled: bool,
    /// idle | checking | syncing | done | paused | needLogin | error
    pub phase: String,
    /// 一行可读状态（前端直接展示，不含底层术语）
    pub message: String,
    pub updated_at_ms: u64,
    pub full_synced_at_ms: u64,
    pub cooldown_until_ms: u64,
    pub path: String,
    pub max_items: usize,
}

/// 一轮同步的结果
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 本轮写入 / 更新的条目数
    pub fetched: usize,
    pub pages: u32,
    pub scanned: i64,
    pub total_count: i64,
    pub indexed: usize,
    pub done: bool,
    /// true = 因新鲜度闸门跳过，一个请求都没发
    pub skipped: bool,
    /// true = 触到 3 万条硬上限
    pub capped: bool,
    pub message: String,
}

/// 搜索命中的一条（字段与 `OnlineModSummary` 对齐，前端可直接喂给现有卡片组件）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub mod_id: i64,
    pub title: String,
    pub creator: Option<String>,
    pub thumbnail: Option<String>,
    pub installs: Option<i64>,
    pub installs_truncated: bool,
    pub rating: Option<f64>,
    pub mod_status: Option<String>,
    pub user_installed: bool,
    pub user_downloaded: bool,
    pub update_available: bool,
    pub game_title_id: Option<i64>,
    pub tag_ids: Vec<i64>,
    pub tag_names: Vec<String>,
    pub file_size: Option<i64>,
    pub raw: Value,
    /// 本地译文标题（中文命中时非空，前端直接上屏）
    pub zh_title: Option<String>,
    /// 命中字段：zhTitle | title | creator | tag | modId
    pub matched_by: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub total: usize,
    pub offset: i64,
    pub limit: i64,
    /// 索引当前条数
    pub indexed: usize,
    /// 服务端总量（0 = 未知）
    pub total_count: i64,
    pub index_done: bool,
    /// 索引尚未建完（后台还在爬）：前端据此提示「后台仍在努力同步」
    pub index_pending: bool,
    /// 本次检索额外并入了多少条缓存池条目（`online_cache.json`）
    pub cached: usize,
    /// 查询里是否含汉字（前端据此切「本地搜索」文案与空态）
    pub has_cjk: bool,
    pub lang: String,
    pub items: Vec<SearchItem>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub removed: bool,
    pub path: String,
    pub items_before: usize,
}

// ---------------- 进程内存储 ----------------

struct Memory {
    path: PathBuf,
    store: Store,
    dirty: bool,
}

/// 整个进程只从磁盘读一次
static MEM: Mutex<Option<Memory>> = Mutex::new(None);
/// 写盘互斥：同一进程内绝不能两个线程同时动同一个临时文件
static IO_LOCK: Mutex<()> = Mutex::new(());
/// 临时文件名序号
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

struct Runtime {
    syncing: bool,
    phase: String,
    message: String,
    cooldown_until_ms: u64,
}

static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime {
    syncing: false,
    phase: String::new(),
    message: String::new(),
    cooldown_until_ms: 0,
});

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock_runtime() -> std::sync::MutexGuard<'static, Runtime> {
    RUNTIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn path_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| format!("无法定位应用配置目录：{e}"))
}

fn read_store(path: &Path) -> Store {
    let Ok(bytes) = fs::read(path) else { return Store::default() };
    let stripped = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut store = match serde_json::from_slice::<Store>(stripped) {
        Ok(store) => store,
        Err(e) => {
            log::warn!(target: "index", "online_index.json 解析失败（{e}），已重建空索引");
            return Store::default();
        }
    };
    if store.version != CURRENT_VERSION {
        log::info!(
            target: "index",
            "索引结构版本不匹配（文件={} 期望={}），已丢弃重建",
            store.version,
            CURRENT_VERSION
        );
        return Store::default();
    }
    // 脏条目剔除：modId 与键不一致 / 标题为空的条目没有任何搜索价值
    store
        .items
        .retain(|key, item| item.mod_id > 0 && !item.title.trim().is_empty() && key.parse::<i64>().is_ok());
    if store.created_at_ms == 0 {
        store.created_at_ms = now_ms();
    }
    store
}

/// 同目录 + 进程号 + 序号：rename 不会跨盘符，也不会和并发写撞名
fn unique_tmp(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| FILE_NAME.to_string());
    path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()))
}

/// 先写唯一临时文件，再原子替换；rename 失败用 copy 兜底，**绝不删除旧文件**
fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    }
    let text = serde_json::to_vec(store).map_err(|e| format!("索引序列化失败：{e}"))?;
    let _io = IO_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let tmp = unique_tmp(path);
    fs::write(&tmp, &text).map_err(|e| format!("写入临时索引失败（{}）：{e}", tmp.display()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first) => match fs::copy(&tmp, path) {
            Ok(_) => {
                let _ = fs::remove_file(&tmp);
                log::warn!(target: "index", "rename 失败（{first}），已用 copy 兜底写入");
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

fn ensure_loaded(app: &tauri::AppHandle) -> Result<std::sync::MutexGuard<'static, Option<Memory>>, String> {
    let path = path_for(app)?;
    let mut guard = MEM.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let need_reload = match guard.as_ref() {
        Some(mem) => mem.path != path,
        None => true,
    };
    if need_reload {
        let store = read_store(&path);
        log::info!(
            target: "index",
            "在线索引已载入内存：{} 条（{}）",
            store.items.len(),
            path.display()
        );
        *guard = Some(Memory { path, store, dirty: false });
    }
    Ok(guard)
}

fn flush(app: &tauri::AppHandle) {
    let Ok(mut guard) = ensure_loaded(app) else { return };
    let Some(mem) = guard.as_mut() else { return };
    if !mem.dirty {
        return;
    }
    mem.dirty = false;
    let snapshot = mem.store.clone();
    let path = mem.path.clone();
    // 序列化期间必须放开锁：几 MB 的 clone 不能挡住搜索
    drop(guard);
    if let Err(e) = write_store(&path, &snapshot) {
        log::warn!(target: "index", "写入在线索引失败：{e}");
    }
}

/// 超过硬上限时按订阅数保留最能被搜到的那些（其余丢弃，绝不无限增长）
fn prune(store: &mut Store) {
    if store.items.len() <= MAX_ITEMS {
        return;
    }
    let mut ranked: Vec<(String, i64)> =
        store.items.iter().map(|(key, item)| (key.clone(), item.installs)).collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    let keep: std::collections::HashSet<String> =
        ranked.into_iter().take(MAX_ITEMS).map(|(key, _)| key).collect();
    let before = store.items.len();
    store.items.retain(|key, _| keep.contains(key));
    log::info!(target: "index", "索引超过 {MAX_ITEMS} 条硬上限，按订阅数保留该数量（{} → {}）", before, store.items.len());
}

// ---------------- 网络：匿名 / 登录两套通道 ----------------

fn api_client(app: &tauri::AppHandle, anonymous: bool) -> Result<ApiClient, ApiFailure> {
    // 未登录时 current_cookie_header 会返回 Err：索引同步允许匿名，所以这里不当作错误
    let cookie = if anonymous {
        String::new()
    } else {
        crate::online::session::current_cookie_header(app).unwrap_or_default()
    };
    let settings = crate::settings::load_for_app(app);
    let resolved = crate::net::resolve(&crate::net::NetConfig::from_settings(&settings))
        .map_err(|e| ApiFailure::new("network", format!("网络配置无效：{e}"), None))?;
    let proxy = crate::net::ureq_proxy(&resolved)
        .map_err(|e| ApiFailure::new("network", e, None))?;
    Ok(ApiClient::new(cookie, proxy))
}

/// `/Find` 拉页器。
///
/// **Cookie 失效（401）立即中止整轮同步**：官方 `/Find` 对匿名请求同样返回 401，
/// 所以「降级到匿名通道重试」只会白打一次请求、把日志刷满（v1.1 的老逻辑）。
/// 现在记下 `auth_failed`，本轮后续请求一个都不发，直接让上层把状态改成
/// 「索引同步失败：请先登录」，等用户重新登录后由前端重新触发。
struct Fetcher {
    client: ApiClient,
    auth_failed: bool,
}

/// 401 的统一错误：文案直接可展示
fn auth_failed_error() -> ApiFailure {
    ApiFailure::new("unauthenticated", NEED_LOGIN_MESSAGE, Some(401))
}

impl Fetcher {
    fn new(app: &tauri::AppHandle) -> Result<Self, ApiFailure> {
        let client = api_client(app, false)?;
        Ok(Self { client, auth_failed: false })
    }

    fn find(&mut self, start: i64, sort: &str, tags: &[i64]) -> Result<FindResult, ApiFailure> {
        // 本轮已经确认失权：一个请求都不再发（彻底断掉 401 刷屏）
        if self.auth_failed {
            return Err(auth_failed_error());
        }
        match self.client.find("", start, PAGE_SIZE, sort, ORDER, tags) {
            Ok(result) => Ok(result),
            Err(err) if err.kind == "unauthenticated" => {
                self.auth_failed = true;
                log::warn!(
                    target: "index",
                    "索引请求返回 401（Cookie 已失效，start={start}）：立即停止本轮同步，不再重试"
                );
                Err(auth_failed_error())
            }
            Err(err) => Err(err),
        }
    }

    /// 分类字典（构建遍历计划用，一次请求）
    fn tags(&mut self) -> Result<Vec<crate::online::models::ModTag>, ApiFailure> {
        if self.auth_failed {
            return Err(auth_failed_error());
        }
        match self.client.tags() {
            Ok(list) => Ok(list),
            Err(err) if err.kind == "unauthenticated" => {
                self.auth_failed = true;
                log::warn!(target: "index", "分类字典请求返回 401：立即停止本轮同步");
                Err(auth_failed_error())
            }
            Err(err) => Err(err),
        }
    }
}

/// 把当前索引进度推给前端（纯内存读，每批一次，开销可忽略）
pub fn emit_progress(app: &tauri::AppHandle) {
    let status = status_for_app(app);
    if let Err(err) = app.emit(PROGRESS_EVENT, status) {
        log::debug!(target: "index", "索引进度事件发送失败：{err}");
    }
}

/// 开关状态：settings.json 的 `enable_indexing`（默认关闭）
pub fn is_enabled(app: &tauri::AppHandle) -> bool {
    crate::settings::load_for_app(app).enable_indexing
}

/// 设置里刚把开关打开：立刻在后台补建一次索引（不阻塞命令返回）
pub fn spawn_now(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(err) = sync_blocking(&app, "settings") {
            log::info!(
                target: "index",
                "开关触发的索引同步未执行：{}（kind={}）",
                err.message,
                err.kind
            );
        }
    });
}

/// 开关被关闭：立刻把状态切成「未开启」并推给前端（指示灯变 ⚪）
pub fn mark_disabled(app: &tauri::AppHandle) {
    set_phase("disabled", "本地索引未开启");
    emit_progress(app);
}

/// 两次请求之间的等待：固定间隔 + 轻量抖动（不引入 rand 依赖）
fn sleep_gap() {
    let jitter = now_ms() % (JITTER_MAX_MS + 1);
    std::thread::sleep(Duration::from_millis(REQUEST_GAP_MS + jitter));
}

// ---------------- 进度读写 ----------------

struct Snapshot {
    items: usize,
    partitions: usize,
    active: usize,
    total: i64,
    done: bool,
    updated_at_ms: u64,
    full_synced_at_ms: u64,
}

fn snapshot(app: &tauri::AppHandle) -> Result<Snapshot, ApiFailure> {
    let guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_ref()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    Ok(Snapshot {
        items: mem.store.items.len(),
        partitions: mem.store.partitions.len(),
        active: mem.store.active,
        total: mem.store.total_count,
        done: mem.store.done,
        updated_at_ms: mem.store.updated_at_ms,
        full_synced_at_ms: mem.store.full_synced_at_ms,
    })
}

fn index_item_from(summary: &OnlineModSummary) -> IndexItem {
    IndexItem {
        mod_id: summary.mod_id,
        title: summary.title.trim().to_string(),
        creator: summary.creator.clone().unwrap_or_default(),
        thumbnail: summary.thumbnail.clone().unwrap_or_default(),
        installs: summary.installs.unwrap_or(0),
        rating: summary.rating,
        tag_ids: summary.tag_ids.clone(),
        tag_names: summary.tag_names.clone(),
        last_update: pick_str(&summary.raw, &["lastUpdate", "lastUpdateDate", "updateDate"])
            .unwrap_or_default(),
        first_seen_ms: now_ms(),
    }
}

/// upsert 一页数据（只动 items，不动进度）
fn upsert_items(store: &mut Store, items: &[OnlineModSummary]) -> usize {
    let mut written = 0usize;
    for summary in items {
        if summary.mod_id <= 0 || summary.title.trim().is_empty() {
            continue;
        }
        let key = summary.mod_id.to_string();
        let mut next = index_item_from(summary);
        // 首次出现时间保持不变（用于观察老模组是否被服务端下线）
        if let Some(previous) = store.items.get(&key) {
            next.first_seen_ms = previous.first_seen_ms;
        }
        store.items.insert(key, next);
        written += 1;
    }
    written
}

/// 把一页写进内存索引，并把**当前分区**的游标往前推
fn apply_partition_page(
    app: &tauri::AppHandle,
    items: &[OnlineModSummary],
    cursor_after: i64,
    part_total: i64,
    global_total: i64,
) -> Result<usize, ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    let written = upsert_items(&mut mem.store, items);
    if let Some(part) = mem.store.partitions.get_mut(mem.store.active) {
        part.cursor = cursor_after;
        if part_total > 0 {
            part.total = part_total;
        }
    }
    if global_total > 0 {
        mem.store.total_count = global_total;
    }
    mem.store.updated_at_ms = now_ms();
    mem.dirty = true;
    Ok(written)
}

/// 刷新用：只 upsert 一个窗口的第 1 页（不推进分区游标）
fn apply_global_page(
    app: &tauri::AppHandle,
    items: &[OnlineModSummary],
    global_total: i64,
) -> Result<usize, ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    let written = upsert_items(&mut mem.store, items);
    if global_total > 0 {
        mem.store.total_count = global_total;
    }
    mem.store.updated_at_ms = now_ms();
    mem.dirty = true;
    Ok(written)
}

/// 重建遍历计划：7 个排序窗口 + 每个分类一个窗口
fn build_plan(app: &tauri::AppHandle, fetcher: &mut Fetcher) -> Result<(), ApiFailure> {
    let mut partitions: Vec<Partition> = SORTS
        .iter()
        .map(|sort| Partition {
            sort: (*sort).to_string(),
            tags: Vec::new(),
            label: (*sort).to_string(),
            cursor: 1,
            total: 0,
            exhausted: false,
        })
        .collect();
    match fetcher.tags() {
        Ok(tags) => {
            let mut seen = std::collections::HashSet::new();
            for tag in tags {
                if tag.mod_type_id <= 0 || !seen.insert(tag.mod_type_id) {
                    continue;
                }
                partitions.push(Partition {
                    sort: TAG_SORT.to_string(),
                    tags: vec![tag.mod_type_id],
                    label: tag.mod_type_name.clone(),
                    cursor: 1,
                    total: 0,
                    exhausted: false,
                });
            }
        }
        Err(err) => log::warn!(
            target: "index",
            "拉取分类字典失败（{}），本轮只扫排序窗口",
            err.message
        ),
    }
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    log::info!(target: "index", "索引遍历计划已重建：{} 个窗口", partitions.len());
    mem.store.partitions = partitions;
    mem.store.active = 0;
    mem.store.done = false;
    mem.store.updated_at_ms = now_ms();
    mem.dirty = true;
    Ok(())
}

/// 全量重扫：所有分区游标归零（条目保留，只是重走一遍把旧数据刷新）
fn reset_plan(app: &tauri::AppHandle) -> Result<(), ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    for part in mem.store.partitions.iter_mut() {
        part.cursor = 1;
        part.total = 0;
        part.exhausted = false;
    }
    mem.store.active = 0;
    mem.store.done = false;
    mem.store.updated_at_ms = now_ms();
    mem.dirty = true;
    Ok(())
}

fn current_partition(app: &tauri::AppHandle) -> Result<Option<Partition>, ApiFailure> {
    let guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_ref()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    Ok(mem.store.partitions.get(mem.store.active).cloned())
}

fn advance_partition(app: &tauri::AppHandle) -> Result<(), ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    mem.store.active += 1;
    mem.dirty = true;
    Ok(())
}

/// 标记当前分区扫完（空页 = 该窗口被服务端截断，**不是**全网扫完）
fn mark_partition_exhausted(app: &tauri::AppHandle, part_total: i64) -> Result<(), ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    if let Some(part) = mem.store.partitions.get_mut(mem.store.active) {
        part.exhausted = true;
        if part_total > 0 {
            part.total = part_total;
        }
    }
    mem.dirty = true;
    Ok(())
}

fn finalize(app: &tauri::AppHandle, done: bool) -> Result<(), ApiFailure> {
    let mut guard = ensure_loaded(app).map_err(|e| ApiFailure::new("internal", e, None))?;
    let mem = guard
        .as_mut()
        .ok_or_else(|| ApiFailure::new("internal", "索引存储未就绪", None))?;
    let now = now_ms();
    mem.store.done = done;
    mem.store.updated_at_ms = now;
    if done {
        mem.store.full_synced_at_ms = now;
    }
    mem.dirty = true;
    prune(&mut mem.store);
    Ok(())
}

fn set_phase(phase: &str, message: &str) {
    let mut rt = lock_runtime();
    rt.phase = phase.to_string();
    rt.message = message.to_string();
}

// ---------------- 同步主流程 ----------------

fn begin_run() -> Result<(), ApiFailure> {
    let mut rt = lock_runtime();
    if rt.syncing {
        return Err(ApiFailure::new("busy", "索引同步已在进行中", None));
    }
    let now = now_ms();
    if rt.cooldown_until_ms > now {
        let minutes = (rt.cooldown_until_ms - now + 59_999) / 60_000;
        return Err(ApiFailure::new(
            "cooling",
            format!("服务端限流，索引同步将在约 {minutes} 分钟后重试"),
            None,
        ));
    }
    rt.syncing = true;
    rt.phase = "checking".to_string();
    rt.message = "正在准备索引同步".to_string();
    Ok(())
}

fn end_run(phase: &str, message: &str, cooldown_ms: u64) {
    let mut rt = lock_runtime();
    rt.syncing = false;
    rt.phase = phase.to_string();
    rt.message = message.to_string();
    if cooldown_ms > 0 {
        rt.cooldown_until_ms = now_ms().saturating_add(cooldown_ms);
    }
}

fn is_rate_limited(err: &ApiFailure) -> bool {
    if err.status == Some(429) {
        return true;
    }
    let text = err.message.to_lowercase();
    text.contains("429") || text.contains("too many") || text.contains("quota") || text.contains("rate limit")
}

fn phase_for(err: &ApiFailure) -> &'static str {
    if err.kind == "unauthenticated" {
        "needLogin"
    } else if err.kind == "network" {
        "paused"
    } else {
        "error"
    }
}

/// 一轮同步（阻塞，调用方负责丢进 `spawn_blocking` 或后台线程）。
///
/// `reason` 只用于日志：startup | manual | login。
pub fn sync_blocking(app: &tauri::AppHandle, reason: &str) -> Result<SyncReport, ApiFailure> {
    // 开关关闭：一个请求都不发（本地搜索仍然可用，只是只查已缓存的条目）
    if !is_enabled(app) {
        return Err(ApiFailure::new("disabled", "本地索引未开启", None));
    }
    begin_run()?;
    let started = now_ms();
    // 无论成功失败都把已拿到的进度落盘：断点续传的前提
    let mut result = scan(app);
    flush(app);
    match &mut result {
        Ok(report) => {
            let phase = if report.done || report.skipped { "done" } else { "paused" };
            log::info!(
                target: "index",
                "索引同步结束（{reason}）：{}（本轮 {} 页 / {} 条，总计 {} 条，用时 {}ms）",
                report.message,
                report.pages,
                report.fetched,
                report.indexed,
                now_ms().saturating_sub(started)
            );
            end_run(phase, &report.message, 0);
            emit_progress(app);
            result
        }
        Err(err) => {
            let cooldown = if is_rate_limited(err) { COOLDOWN_MS } else { 0 };
            log::warn!(
                target: "index",
                "索引同步中断（{reason}）：{}（{}ms，冷却={}ms）",
                err.message,
                now_ms().saturating_sub(started),
                cooldown
            );
            let phase = phase_for(err);
            // 401 一律给可执行的一句话（界面红点直接用），不把底层英文错误推给用户
            let message = if phase == "needLogin" {
                NEED_LOGIN_MESSAGE.to_string()
            } else {
                err.message.clone()
            };
            end_run(phase, &message, cooldown);
            emit_progress(app);
            result
        }
    }
}

fn scan(app: &tauri::AppHandle) -> Result<SyncReport, ApiFailure> {
    let mut report = SyncReport::default();
    let snap = snapshot(app)?;
    report.indexed = snap.items;
    report.total_count = snap.total;
    report.done = snap.done;

    // ① 新鲜度闸门：完整扫过一轮且在 24h 内 → 一个请求都不发
    if snap.done && now_ms().saturating_sub(snap.updated_at_ms) < INCREMENTAL_INTERVAL_MS {
        report.skipped = true;
        report.message = format!("索引已是最新（{} 条）", snap.items);
        return Ok(report);
    }

    set_phase("syncing", "正在连接官方接口");
    // 让界面立刻从「未开始 / 旧进度」切到 🟡 同步中，不用等第一页回来
    emit_progress(app);
    // v1.2：未登录就别浪费请求了。官方 `/Find` 匿名一律 401，
    // 「先打一次再降级」只会把日志刷满；直接给出可执行状态，等用户登录。
    if crate::online::session::current_cookie_header(app).is_err() {
        set_phase("needLogin", NEED_LOGIN_MESSAGE);
        emit_progress(app);
        return Err(auth_failed_error());
    }
    let mut fetcher = Fetcher::new(app)?;
    let mut global_total = snap.total;

    // ② 计划：没有就建一个；完整扫过一轮则先探一个窗口，判断要不要重扫
    if snap.partitions == 0 {
        build_plan(app, &mut fetcher)?;
        report.pages += 1; // /Tags 也算一次请求
    } else if snap.done {
        sleep_gap();
        let probe = fetcher.find(1, SORTS[0], &[])?;
        report.pages += 1;
        if let Some(total) = probe.total_count {
            global_total = total;
        }
        report.fetched += apply_global_page(app, &probe.items, global_total)?;
        let stale_full = now_ms().saturating_sub(snap.full_synced_at_ms) >= FULL_SYNC_INTERVAL_MS;
        let grown = global_total != snap.total;
        if !stale_full && !grown {
            report.indexed = snapshot(app).map(|s| s.items).unwrap_or(report.indexed);
            report.total_count = global_total;
            report.done = true;
            report.message = format!("索引已是最新（{} 条）", report.indexed);
            return Ok(report);
        }
        log::info!(
            target: "index",
            "索引需要重扫（距上次完整扫描过久={stale_full}，全局总量变化={grown}：现在={global_total} 上次={}）",
            snap.total
        );
        reset_plan(app)?;
    }

    // ③ 分区遍历：每个窗口独立游标；空页只代表「这个窗口到头了」
    let mut capped = false;
    let mut stop_note = String::new();
    let mut done = false;
    loop {
        if report.pages >= MAX_PAGES_PER_RUN {
            stop_note = "本次同步已达单轮上限，剩余部分下次启动继续".to_string();
            break;
        }
        // v1.2：用户在设置里把开关关掉 → 立刻停下，不再发任何请求
        if !is_enabled(app) {
            stop_note = "本地索引已被关闭".to_string();
            break;
        }
        if snapshot(app).map(|s| s.items).unwrap_or(0) >= MAX_ITEMS {
            capped = true;
            stop_note = format!("已达 {MAX_ITEMS} 条上限，索引不再增长");
            break;
        }
        let Some(part) = current_partition(app)? else {
            done = true;
            break;
        };
        if part.exhausted {
            advance_partition(app)?;
            continue;
        }
        if part.total > 0 && part.cursor > part.total {
            mark_partition_exhausted(app, part.total)?;
            advance_partition(app)?;
            continue;
        }
        if report.pages > 0 {
            sleep_gap();
        }
        let result = match fetcher.find(part.cursor, &part.sort, &part.tags) {
            Ok(result) => result,
            Err(err) => {
                flush(app);
                return Err(err);
            }
        };
        report.pages += 1;
        let part_total = result.total_count.unwrap_or(0);
        if part.tags.is_empty() && part_total > 0 {
            global_total = part_total;
        }
        if result.items.is_empty() {
            // 深翻页截断：只把这个窗口标成结束，绝不当作「全网扫完」
            log::info!(
                target: "index",
                "窗口「{}」在 start={} 处返回空页，该窗口结束（服务端深翻页截断）",
                part.label,
                part.cursor
            );
            mark_partition_exhausted(app, part_total)?;
            advance_partition(app)?;
            continue;
        }
        let batch = result.items.len() as i64;
        report.fetched +=
            apply_partition_page(app, &result.items, part.cursor + batch, part_total, global_total)?;
        let current = snapshot(app)?;
        report.indexed = current.items;
        report.total_count = global_total;
        set_phase(
            "syncing",
            &format!(
                "正在建立索引 {} 条（窗口 {}/{}）",
                current.items,
                (current.active + 1).min(current.partitions),
                current.partitions
            ),
        );
        // 每批成功入库就推一次进度：前端边爬边搜，不用等全部爬完
        emit_progress(app);
        if report.pages % FLUSH_EVERY_PAGES == 0 {
            flush(app);
        }
        if part_total > 0 && part.cursor + batch > part_total {
            mark_partition_exhausted(app, part_total)?;
            advance_partition(app)?;
        }
    }

    let finished = done && !capped;
    finalize(app, finished)?;
    report.done = finished;
    report.capped = capped;
    report.indexed = snapshot(app).map(|s| s.items).unwrap_or(report.indexed);
    report.total_count = snapshot(app).map(|s| s.total).unwrap_or(global_total);
    report.scanned = report.indexed as i64;
    report.message = if finished {
        format!("索引建立完成（{} 条）", report.indexed)
    } else if !stop_note.is_empty() {
        stop_note
    } else {
        format!("已收录 {} 条，后台会继续补充", report.indexed)
    };
    Ok(report)
}

/// 启动时的后台同步：等首屏稳定后跑一轮，失败只记日志（绝不弹窗、绝不重试刷屏）
pub fn spawn_background(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(BG_START_DELAY_SECS));
        // v1.2：开关未开 → 启动后一个爬取请求都不发，只把状态标成「未开启」
        if !is_enabled(&app) {
            set_phase("disabled", "本地索引未开启");
            emit_progress(&app);
            log::info!(target: "index", "本地索引未开启（设置 → 通用），跳过后台同步");
            return;
        }
        // v1.2：未登录 → 一个请求都不发，直接把状态标成「请先登录」推给前端
        // （页面上的红点 + 登录按钮就是从此处来的），登录后由前端重新触发
        if crate::online::session::current_cookie_header(&app).is_err() {
            set_phase("needLogin", NEED_LOGIN_MESSAGE);
            emit_progress(&app);
            log::info!(target: "index", "未登录，跳过后台索引同步（登录后会自动继续）");
            return;
        }
        match sync_blocking(&app, "startup") {
            Ok(_) => {}
            Err(err) => log::info!(
                target: "index",
                "启动索引同步未执行：{}（kind={}）",
                err.message,
                err.kind
            ),
        }
    });
}

// ---------------- 对外命令实现 ----------------

pub fn status_for_app(app: &tauri::AppHandle) -> IndexStatus {
    let (indexed, total, scanned, done, updated_at_ms, full_synced_at_ms) = match snapshot(app) {
        Ok(snap) => (
            snap.items,
            snap.total,
            snap.items as i64,
            snap.done,
            snap.updated_at_ms,
            snap.full_synced_at_ms,
        ),
        Err(_) => (0, 0, 0, false, 0, 0),
    };
    let rt = lock_runtime();
    // v1.2：开关关闭时一律报「disabled」，前端指示灯直接用 ⚪（不展示同步中）
    let enabled = is_enabled(app);
    let phase = if !enabled {
        "disabled".to_string()
    } else if rt.phase.is_empty() {
        "idle".to_string()
    } else {
        rt.phase.clone()
    };
    IndexStatus {
        indexed,
        total_count: total,
        scanned,
        done,
        syncing: rt.syncing,
        indexing_enabled: enabled,
        phase,
        message: rt.message.clone(),
        updated_at_ms,
        full_synced_at_ms,
        cooldown_until_ms: rt.cooldown_until_ms,
        path: path_for(app).map(|p| p.display().to_string()).unwrap_or_default(),
        max_items: MAX_ITEMS,
    }
}

/// 批量标题翻译的候选：索引里的全部条目，**热门优先**（订阅数降序）。
/// 返回 `(modId, 标题)`；调用方自己过滤掉已经是中文的标题。
pub fn title_candidates(app: &tauri::AppHandle) -> Vec<(i64, String)> {
    let Ok(guard) = ensure_loaded(app) else { return Vec::new() };
    let Some(mem) = guard.as_ref() else { return Vec::new() };
    let mut ranked: Vec<(i64, String, i64)> = mem
        .store
        .items
        .values()
        .filter(|item| item.mod_id > 0 && !item.title.trim().is_empty())
        .map(|item| (item.mod_id, item.title.clone(), item.installs))
        .collect();
    ranked.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().map(|(mod_id, title, _)| (mod_id, title)).collect()
}

pub fn clear_for_app(app: &tauri::AppHandle) -> Result<ClearReport, String> {
    let path = path_for(app)?;
    let items_before = {
        let mut guard = ensure_loaded(app)?;
        let mem = guard.as_mut().ok_or_else(|| "索引存储未就绪".to_string())?;
        let before = mem.store.items.len();
        *mem = Memory { path: path.clone(), store: Store::default(), dirty: true };
        before
    };
    let snapshot_store = {
        let guard = ensure_loaded(app)?;
        guard.as_ref().map(|mem| mem.store.clone()).unwrap_or_default()
    };
    let removed = match write_store(&path, &snapshot_store) {
        Ok(()) => true,
        Err(e) => {
            log::warn!(target: "index", "清空索引写盘失败：{e}");
            false
        }
    };
    set_phase("idle", "索引已清空");
    Ok(ClearReport { removed, path: path.display().to_string(), items_before })
}

/// 中文检索：`query` 走本地索引 + 本地译文标题，**绝不发网络请求**。
///
/// v1.2 **边爬边搜**：检索范围 = 本地索引已入库的条目 ∪ `online_cache.json` 里所有
/// 已经见过的条目（用户浏览 / 翻页留下的），因此后台还在爬的时候也能立刻出结果，
/// 不用等 4 万条全部爬完。索引里已经有的 modId 以索引为准（字段更全）。
///
/// 匹配优先级：中文标题 > 英文标题 > 作者 > 分类 > `#ID`。
/// 排序：优先级升序 → 订阅数降序 → modId 降序（同订阅数时新的在前）。
pub fn search_for_app(
    app: &tauri::AppHandle,
    query: &str,
    offset: i64,
    limit: i64,
    lang: &str,
) -> SearchResult {
    let offset = offset.max(0);
    let limit = limit.clamp(1, SEARCH_LIMIT_MAX);
    let query_has_cjk = has_cjk(query);
    let term = normalize_term(query);
    let mut result = SearchResult {
        query: query.trim().to_string(),
        offset,
        limit,
        has_cjk: query_has_cjk,
        lang: lang.to_string(),
        ..SearchResult::default()
    };
    if term.is_empty() {
        return result;
    }

    let titles = crate::translator::search_titles(app, lang);
    let snap = match snapshot(app) {
        Ok(snap) => snap,
        Err(_) => return result,
    };
    result.indexed = snap.items;
    result.total_count = snap.total;
    result.index_done = snap.done;
    result.index_pending = !snap.done || (snap.total > 0 && (snap.items as i64) < snap.total);

    // 缓存池：online_cache.json 里全部已见过的条目（已去重、按订阅数降序）。
    // 必须在拿索引锁之前读，避免两个模块的锁交叉。
    let cache_rows = crate::cache::all_items_for_app(app);
    let cache_map: std::collections::HashMap<i64, &Value> = cache_rows
        .iter()
        .filter_map(|value| {
            value
                .get("modId")
                .and_then(|v| v.as_i64())
                .filter(|id| *id > 0)
                .map(|id| (id, value))
        })
        .collect();
    result.cached = cache_map.len();

    // `#409484` 或纯数字：直接按 ID 前缀命中，不参与文本匹配
    let numeric = term.trim_start_matches('#').to_string();
    let numeric_hit = !numeric.is_empty() && numeric.chars().all(|c| c.is_ascii_digit());
    // 查询含汉字时，纯 ASCII 标题/作者/分类不可能命中：省掉 3 万次 to_lowercase 分配
    let cjk_term = has_cjk(&term);

    /// 标题类命中：中文标题（0）> 英文标题（1）
    fn title_weight(
        term: &str,
        cjk_term: bool,
        zh: Option<&str>,
        title: &str,
    ) -> Option<(u8, &'static str)> {
        if let Some(text) = zh {
            if contains_fold(text, term) {
                return Some((0, "zhTitle"));
            }
        }
        if !(cjk_term && !has_cjk(title)) && contains_fold(title, term) {
            return Some((1, "title"));
        }
        None
    }

    /// 作者命中（2）
    fn creator_weight(term: &str, cjk_term: bool, creator: &str) -> Option<(u8, &'static str)> {
        if !(cjk_term && !has_cjk(creator)) && !creator.is_empty() && contains_fold(creator, term) {
            return Some((2, "creator"));
        }
        None
    }

    /// (优先级, 订阅数, modId, 中文标题, 命中字段, 是否来自缓存池)
    struct Hit {
        weight: u8,
        installs: i64,
        mod_id: i64,
        zh_title: Option<String>,
        matched_by: &'static str,
        from_cache: bool,
    }

    let mut hits: Vec<Hit> = Vec::new();
    {
        let Ok(guard) = ensure_loaded(app) else { return result };
        let Some(mem) = guard.as_ref() else { return result };

        // ① 索引里已入库的条目
        for item in mem.store.items.values() {
            let zh = titles.get(&item.mod_id).map(|text| text.as_str());
            let mut weight = title_weight(&term, cjk_term, zh, &item.title);
            if weight.is_none() {
                weight = creator_weight(&term, cjk_term, &item.creator);
            }
            if weight.is_none()
                && !cjk_term
                && item.tag_names.iter().any(|name| contains_fold(name, &term))
            {
                weight = Some((3, "tag"));
            }
            if weight.is_none() && numeric_hit && item.mod_id.to_string().starts_with(&numeric) {
                weight = Some((0, "modId"));
            }
            let Some((level, matched_by)) = weight else { continue };
            hits.push(Hit {
                weight: level,
                installs: item.installs,
                mod_id: item.mod_id,
                zh_title: zh.map(|text| text.to_string()),
                matched_by,
                from_cache: false,
            });
        }

        // ② 缓存池里索引还没有的条目（边爬边搜的另一半）
        for (mod_id, value) in &cache_map {
            if mem.store.items.contains_key(&mod_id.to_string()) {
                continue;
            }
            let title = value.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if title.trim().is_empty() {
                continue;
            }
            let creator = value.get("creator").and_then(|v| v.as_str()).unwrap_or("");
            let zh = titles.get(mod_id).map(|text| text.as_str());
            let mut weight = title_weight(&term, cjk_term, zh, title);
            if weight.is_none() {
                weight = creator_weight(&term, cjk_term, creator);
            }
            if weight.is_none() && !cjk_term && cache_tags_match(value, &term) {
                weight = Some((3, "tag"));
            }
            if weight.is_none() && numeric_hit && mod_id.to_string().starts_with(&numeric) {
                weight = Some((0, "modId"));
            }
            let Some((level, matched_by)) = weight else { continue };
            hits.push(Hit {
                weight: level,
                installs: value.get("installs").and_then(|v| v.as_i64()).unwrap_or(0),
                mod_id: *mod_id,
                zh_title: zh.map(|text| text.to_string()),
                matched_by,
                from_cache: true,
            });
        }

        // 排序：命中优先级 → 订阅数降序 → modId 降序（同订阅数时新模组在前）
        hits.sort_by(|a, b| {
            a.weight
                .cmp(&b.weight)
                .then_with(|| b.installs.cmp(&a.installs))
                .then_with(|| b.mod_id.cmp(&a.mod_id))
        });
        result.total = hits.len();

        let start = offset as usize;
        if start < hits.len() {
            let end = (start + limit as usize).min(hits.len());
            for hit in &hits[start..end] {
                if hit.from_cache {
                    if let Some(value) = cache_map.get(&hit.mod_id) {
                        result.items.push(cache_search_item(
                            value,
                            hit.zh_title.clone(),
                            hit.matched_by,
                        ));
                    }
                    continue;
                }
                let Some(item) = mem.store.items.get(&hit.mod_id.to_string()) else { continue };
                result.items.push(SearchItem {
                    mod_id: item.mod_id,
                    title: item.title.clone(),
                    creator: Some(item.creator.clone()).filter(|text| !text.trim().is_empty()),
                    thumbnail: Some(item.thumbnail.clone()).filter(|text| !text.trim().is_empty()),
                    installs: Some(item.installs).filter(|value| *value > 0),
                    installs_truncated: false,
                    rating: item.rating,
                    mod_status: None,
                    user_installed: false,
                    user_downloaded: false,
                    update_available: false,
                    game_title_id: Some(GAME_AOE2DE),
                    tag_ids: item.tag_ids.clone(),
                    tag_names: item.tag_names.clone(),
                    file_size: None,
                    raw: Value::Object(Map::new()),
                    zh_title: hit.zh_title.clone(),
                    matched_by: hit.matched_by.to_string(),
                });
            }
        }
    }
    result
}

/// 缓存池条目的分类名是否命中
fn cache_tags_match(value: &Value, term: &str) -> bool {
    value
        .get("tagNames")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().any(|name| {
                name.as_str()
                    .map(|text| contains_fold(text, term))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 缓存池条目（`online_cache.json` 的列表项）→ 搜索结果行
fn cache_search_item(value: &Value, zh_title: Option<String>, matched_by: &str) -> SearchItem {
    let text = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let tag_ids = value
        .get("tagIds")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect::<Vec<i64>>())
        .unwrap_or_default();
    let tag_names = value
        .get("tagNames")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    SearchItem {
        mod_id: value.get("modId").and_then(|v| v.as_i64()).unwrap_or(0),
        title: text("title").unwrap_or_default(),
        creator: text("creator"),
        thumbnail: text("thumbnail"),
        installs: value.get("installs").and_then(|v| v.as_i64()),
        installs_truncated: value
            .get("installsTruncated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        rating: value.get("rating").and_then(|v| v.as_f64()),
        mod_status: text("modStatus"),
        user_installed: value.get("userInstalled").and_then(|v| v.as_bool()).unwrap_or(false),
        user_downloaded: value.get("userDownloaded").and_then(|v| v.as_bool()).unwrap_or(false),
        update_available: value.get("updateAvailable").and_then(|v| v.as_bool()).unwrap_or(false),
        game_title_id: value.get("gameTitleId").and_then(|v| v.as_i64()),
        tag_ids,
        tag_names,
        file_size: value.get("fileSize").and_then(|v| v.as_i64()),
        raw: Value::Object(Map::new()),
        zh_title,
        matched_by: matched_by.to_string(),
    }
}

/// 空白折叠 + 小写：中英混合的查询也能稳定命中
fn normalize_term(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// 大小写不敏感的子串判定（`needle` 必须已是小写）
fn contains_fold(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() || haystack.is_empty() {
        return false;
    }
    haystack.to_lowercase().contains(needle)
}

/// 汉字判定（CJK 统一表意 + 扩展A + 兼容区）：与前端正则保持完全一致
pub fn has_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_detection_covers_chinese_only() {
        assert!(has_cjk("车"));
        assert!(has_cjk("中国载具 pack"));
        assert!(!has_cjk("vehicle pack"));
        assert!(!has_cjk("#409484"));
    }

    #[test]
    fn term_normalization_folds_space_and_case() {
        assert_eq!(normalize_term("  Vehicle   Pack "), "vehicle pack");
        assert_eq!(normalize_term("车"), "车");
    }
}
