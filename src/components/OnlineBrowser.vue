<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import OnlineModCard from "./OnlineModCard.vue";
import {
  FALLBACK_TAGS,
  SORT_OPTIONS,
  isApiFailure,
  localizedTagName,
  tagLabel,
  type DownloadProgress,
  type InstallOutcome,
  type LoginTarget,
  type ModTag,
  type OnlineMod,
  type SessionStatus,
} from "../online/types";
import {
  cancelInstall,
  clearLoginCache,
  closeLoginWindow,
  findMods,
  installMod,
  installedMods,
  loginTargets,
  modDetail,
  modTags,
  onDownloadProgress,
  openLogin,
  openLoginSilent,
  openModWebpage,
  probeAccountWindow,
  sessionStatus,
  uiLog,
} from "../online/service";
import {
  readDetailCache,
  readFindCache,
  readInstalledCache,
  usableDetailCache,
  usableListCache,
} from "../online/cache";
import {
  ensureSession,
  markOnline,
  markUnauthenticated,
  sessionEpoch,
  sessionError as sharedSessionError,
  sessionInfo,
  sessionPhase,
  setStatusMessage,
} from "../sessionState";
import ConfirmDialog from "./ConfirmDialog.vue";
import { deleteModFiles, installedLocalIndex } from "../api";
import { sourceLabel, translateBackendMessage } from "../format";
import {
  customNameOf,
  displayTitle,
  ensureUserData,
  favoriteCount,
  isFavorite,
  setCustomName,
  setFavorite,
} from "../userData";
import RenameDialog from "./RenameDialog.vue";
import type { InstalledIndexEntry } from "../types";
import type { CacheHit, FindResult } from "../online/types";

/** 每批加载数量：本地网格每行 6 个（约 197px 列宽），24 = 4 行 */
const PAGE_SIZE = 24;

const { t, te } = useI18n();

const session = ref<SessionStatus | null>(null);
const sessionError = ref<string | null>(null);
const waitingLogin = ref(false);
const probing = ref(false);
const probeResult = ref<string | null>(null);

/**
 * 共享会话状态（底栏同源）的镜像：
 * 本组件绝不再发起第二份探测，只把 sessionState 的结果同步到本地 ref，
 * 原有的 session?.xxx 判断全部保持不变。
 *
 * immediate 必须为 true：本组件被 KeepAlive 缓存，用户可能在 App.vue 已完成静默校验
 * 之后才第一次切到在线页——此时 sessionInfo 早已有值，普通 watch 永远收不到。
 */
watch(
  sessionInfo,
  (info) => {
    session.value = info;
  },
  { immediate: true },
);

/** 登录平台（Steam / 微软 / PSN），由 Rust 侧提供 URL */
const platforms = ref<LoginTarget[]>([]);
const platform = ref("microsoft");

/** 会话 / 退出登录的临时提示（代理与登录项已迁到 SettingsModal） */
const netClearing = ref(false);
const netError = ref<string | null>(null);
const netMessage = ref<string | null>(null);

/** 列表（无限滚动累加） */
const items = ref<OnlineMod[]>([]);
const totalCount = ref<number | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const moreError = ref<string | null>(null);
const hasMore = ref(true);
/** 下一次请求的 start（官方接口 1 起；按已取回条数偏移，抗数据变动） */
const cursor = ref(1);

// ---------- 筛选状态由顶栏（App.vue）持有，这里通过 v-model:query / :sort / :order 双向绑定 ----------
const query = defineModel<string>("query", { required: true });
const sort = defineModel<string>("sort", { required: true });
const order = defineModel<"DESC" | "ASC">("order", { required: true });

/** 排序/升降序：立即重新查询（顶栏下拉已直接写入 model） */
watch([sort, order], () => {
  void reload();
});

/** 搜索：300ms 防抖，避免每敲一个字就打一次官方接口 */
let queryTimer: number | null = null;
watch(query, () => {
  if (queryTimer !== null) window.clearTimeout(queryTimer);
  queryTimer = window.setTimeout(() => {
    queryTimer = null;
    void reload();
  }, 300);
});
onUnmounted(() => {
  if (queryTimer !== null) window.clearTimeout(queryTimer);
});

/** 顶栏“刷新”按钮只能走组件内部逻辑：仅暴露这一个方法 */
defineExpose({ refresh: manualRefresh });

const onlySubscribed = ref(false);
/** v0.5：只看收藏（按 WorkshopID 匹配 user_data.json；只过滤已加载的条目） */
const favoritesOnly = ref(false);

/** 左侧分类（官方 /api/v4/mods/Tags） */
const tags = ref<ModTag[]>([]);
const tagsError = ref<string | null>(null);
const activeTag = ref<number | null>(null);

const selected = ref<OnlineMod | null>(null);
const detail = ref<Record<string, unknown> | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

const progress = ref<DownloadProgress | null>(null);
/** 下载过程中量到的真实体积（服务端详情缺 modFileSize 时兜底） */
const measuredBytes = ref<number | null>(null);
const installing = ref(false);
const installError = ref<string | null>(null);
const installNote = ref<string | null>(null);
const needForce = ref(false);
const forceOverwrite = ref(false);
const actionBusy = ref(false);
const actionMessage = ref<string | null>(null);
/** 右下角轻提示：局部状态变更的即时反馈，不触发列表重载 */
const toast = ref<{ text: string; kind: "ok" | "error" } | null>(null);
let toastTimer: number | null = null;
const openingWeb = ref(false);

// ---------------- v0.5：收藏 / 备注名（在线侧，只和 modId 绑定） ----------------
const canFavorite = computed(() => (selected.value?.modId ?? 0) > 0);
const favorited = computed(() => isFavorite(selected.value?.modId));
const customName = computed(() => customNameOf(selected.value?.modId));
const favBusy = ref(false);
const favError = ref<string | null>(null);
const renameOpen = ref(false);
const renameBusy = ref(false);
const renameError = ref<string | null>(null);

async function toggleFavorite() {
  const mod = selected.value;
  if (!mod || favBusy.value) return;
  favBusy.value = true;
  favError.value = null;
  try {
    const next = await setFavorite(mod.modId, !favorited.value);
    showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
  } catch (e) {
    favError.value = messageOf(e);
  } finally {
    favBusy.value = false;
  }
}

function openRename() {
  if (!selected.value) return;
  renameError.value = null;
  renameOpen.value = true;
}

async function applyRename(name: string) {
  const mod = selected.value;
  if (!mod || renameBusy.value) return;
  renameBusy.value = true;
  renameError.value = null;
  try {
    await setCustomName(mod.modId, name);
    renameOpen.value = false;
    showToast(t("favorites.savedToast"));
  } catch (e) {
    renameError.value = messageOf(e);
  } finally {
    renameBusy.value = false;
  }
}

/** 本机已安装索引：WorkshopID → 目录/来源（磁盘事实，与服务器订阅标记无关） */
const localIndex = ref<Record<number, InstalledIndexEntry>>({});
const localIndexError = ref<string | null>(null);
/** 删除本地文件前的二次确认 */
const confirmDeleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);

const scrollEl = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);

let unlisten: (() => void) | null = null;
let pollTimer: number | null = null;
let observer: IntersectionObserver | null = null;
/** 请求序号：筛选条件变化时自增，丢弃过期响应 */
let seq = 0;

const heading = computed(() => {
  if (favoritesOnly.value) return t("favorites.heading");
  if (onlySubscribed.value) return t("online.headingSubscribed");
  return query.value.trim() ? t("online.headingSearch") : t("online.headingAll");
});

/** 收藏过滤后的可见列表（列表按页加载，只过滤已加载条目，绝不重新请求） */
const visibleItems = computed<OnlineMod[]>(() =>
  favoritesOnly.value ? items.value.filter((m) => isFavorite(m.modId)) : items.value,
);

const activeTagName = computed(() => {
  if (activeTag.value === null) return t("sidebar.allContent");
  const hit = tags.value.find((item) => item.modTypeId === activeTag.value);
  return hit ? tagLabel(hit) : t("online.tagFallback", { id: activeTag.value });
});

const detailTags = computed<string[]>(() => selected.value?.tagNames ?? []);

function pickDetailText(keys: string[]): string | null {
  const raw = detail.value;
  if (!raw) return null;
  for (const key of keys) {
    const value = raw[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return text;
    } else if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

function pickDetailNumber(keys: string[]): number | null {
  const raw = detail.value;
  if (!raw) return null;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 字节数：详情 modFileSize → 列表 modFileSize → 下载实测 */
const sizeText = computed(() => {
  const fromDetail = pickDetailNumber(["modFileSize", "fileSize"]);
  const fromList = selected.value?.fileSize ?? null;
  const bytes = fromDetail ?? (fromList && fromList > 0 ? fromList : null);
  const text = formatBytes(bytes);
  if (text) return text;
  const measured = formatBytes(measuredBytes.value);
  if (measured) return t("online.measured", { size: measured });
  return t("online.calcOnDownload");
});

const diskText = computed(
  () => formatBytes(pickDetailNumber(["modDiskSize"])) ?? t("labels.notProvided"),
);

const ratingText = computed(() => {
  if (selected.value?.rating !== null && selected.value?.rating !== undefined) {
    return String(selected.value.rating);
  }
  const avg = detail.value?.currentRating;
  const total = detail.value?.totalRatings;
  if (typeof avg === "number" && avg > 0) {
    return typeof total === "number" && total > 0
      ? t("online.ratingsCount", { avg: avg.toFixed(1), n: total })
      : avg.toFixed(1);
  }
  return t("labels.notProvided");
});

const versionText = computed(() => pickDetailText(["modVersion"]) ?? t("labels.notProvided"));

const createdText = computed(() => formatDate(pickDetailText(["createDate"])));

const updatedText = computed(() => formatDate(pickDetailText(["lastUpdate"])));

const descriptionText = computed(() => {
  const raw = pickDetailText(["description", "modDescription"]);
  return raw ? plainText(raw) : null;
});

/** 传给后端的原始描述：游戏 info.json 里存的就是这段 HTML，原样写回最接近官方产物 */
const rawDescription = computed(() => pickDetailText(["description", "modDescription"]));

function formatDate(text: string | null): string | null {
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 服务端描述是 HTML，这里只做纯文本化，绝不注入 v-html */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageOf(e: unknown): string {
  if (isApiFailure(e)) return translateBackendMessage(e.message);
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  return t("labels.unknown");
}

/** 登录入口按钮：后端只给平台 key，文案走 i18n（后端 label/hint 作为兜底） */
function loginLabel(target: LoginTarget): string {
  const key = `online.login.${target.key}.label`;
  return te(key) ? t(key) : target.label;
}

function loginHint(target: LoginTarget): string {
  const key = `online.login.${target.key}.hint`;
  return te(key) ? t(key) : target.hint;
}

function kindOf(e: unknown): string | null {
  return isApiFailure(e) ? e.kind : null;
}

/** 给可能卡住的 invoke 加超时，避免界面永远停在“检查中” */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(
        new Error(
          t("online.timeout", { what, sec: Math.round(ms / 1000) }),
        ),
      );
    }, ms);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

/** 手动「重新检查登录状态」：强制再探一次；成功后由 sessionEpoch 统一触发刷新 */
async function refreshSession() {
  sessionError.value = null;
  await ensureSession(true);
  session.value = sessionInfo.value;
  sessionError.value = sharedSessionError.value;
}

/** 分类字典：GET /api/v4/mods/Tags（匿名可读）；失败时用内置 17 项兜底 */
async function loadTags() {
  tagsError.value = null;
  // 离线 / 未登录：官方字典接口需要登录态，直接用内置 17 项兜底，不打网络
  if (sessionPhase.value !== "online") {
    tags.value = FALLBACK_TAGS;
    return;
  }
  try {
    const list = await withTimeout(modTags(), 20000, t("sidebar.officialTags"));
    if (list.length) {
      tags.value = list;
    } else {
      tags.value = FALLBACK_TAGS;
      tagsError.value = t("online.tagsEmpty");
    }
  } catch (e) {
    tags.value = FALLBACK_TAGS;
    tagsError.value = t("online.tagsFailed", { msg: messageOf(e) });
  }
}

/** 诊断：让后端显式创建隐藏会话窗口，把真实结果或错误显示出来 */
async function runProbe() {
  probing.value = true;
  probeResult.value = null;
  sessionError.value = null;
  try {
    probeResult.value = await withTimeout(probeAccountWindow(), 25000, t("online.probe"));
  } catch (e) {
    probeResult.value = t("online.probeFailed", { msg: messageOf(e) });
  } finally {
    probing.value = false;
  }
}

async function doLogout() {
  if (netClearing.value) return;
  netClearing.value = true;
  netError.value = null;
  netMessage.value = null;
  try {
    const text = await withTimeout(clearLoginCache(), 30000, t("online.clearCache"));
    netMessage.value = text;
    session.value = null;
    resetList();
    await refreshSession();
  } catch (e) {
    netError.value = messageOf(e);
  } finally {
    netClearing.value = false;
  }
}

async function startLogin(target = platform.value) {
  waitingLogin.value = true;
  actionMessage.value = null;
  sessionError.value = null;
  const chosen = platforms.value.find((p) => p.key === target);
  void uiLog("info", `用户点击登录：platform=${target} url=${chosen?.url ?? "(未加载)"}`);
  try {
    await withTimeout(openLogin(target), 25000, t("online.openLogin"));
  } catch (e) {
    waitingLogin.value = false;
    sessionError.value = messageOf(e);
    void uiLog("error", `打开登录窗口失败：${messageOf(e)}`);
    return;
  }
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    try {
      const status = await withTimeout(sessionStatus(), 15000, t("online.recheck"));
      session.value = status;
      if (status.error) sessionError.value = status.error;
      void uiLog(
        "info",
        `轮询登录状态：loggedIn=${status.loggedIn} cookieCount=${status.cookieCount} windowReady=${status.windowReady}`,
      );
      if (!status.loggedIn) return;

      // Cookie 存在不代表真有权限，先跑一次最小请求验证，通过才关闭登录窗口
      try {
        const probe = await withTimeout(
          findMods({ query: "", start: 1, count: 1, sort: SORT_OPTIONS[0].value, order: "DESC" }),
          20000,
          t("online.probe"),
        );
        void uiLog("info", `验证通过（返回 ${probe.items.length} 条），关闭登录窗口并加载列表`);
        waitingLogin.value = false;
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = null;
        await closeLoginWindow();
        // 不在这里直接 reload：bump epoch 后由 handleSessionEpoch 统一刷新，避免重复请求
        markOnline(status);
        setStatusMessage(t("statusbar.loginDone"));
      } catch (e) {
        const text = messageOf(e);
        sessionError.value = t("online.cookieButFailed", { text });
        void uiLog("warn", `Cookie 存在但接口失败，保持窗口打开：${text}`);
      }
    } catch (e) {
      sessionError.value = messageOf(e);
      void uiLog("warn", `轮询异常：${messageOf(e)}`);
    }
  }, 2500);
}

/** 后台静默登录：不阻塞首屏，失败也不打断用户 */
const silentAuth = ref(false);
const silentAuthNote = ref<string | null>(null);
let silentTried = false;
let silentTimer: number | null = null;

function stopSilentTimer() {
  if (silentTimer !== null) {
    window.clearInterval(silentTimer);
    silentTimer = null;
  }
}

/**
 * 静默免密登录：用隐藏窗口打开登录入口，靠平台 SSO 的持久 Cookie 自动跑完跳转链；
 * 每 2 秒查一次，拿到“Cookie 存在 + Find 真的调通”才算成功，最多 24 秒。
 */
async function silentReauth(reason: string) {
  if (silentTried || silentAuth.value || waitingLogin.value) return;
  silentTried = true;
  silentAuth.value = true;
  silentAuthNote.value = t("online.silentNote", { reason });
  void uiLog("info", `后台免密登录开始：${reason}`);
  try {
    await withTimeout(openLoginSilent(platform.value), 15000, t("online.openLogin"));
  } catch (e) {
    silentAuth.value = false;
    silentAuthNote.value = t("online.silentFailedStart", { msg: messageOf(e) });
    return;
  }

  let ticks = 0;
  stopSilentTimer();
  silentTimer = window.setInterval(async () => {
    ticks += 1;
    let ok = false;
    try {
      const status = await withTimeout(sessionStatus(), 15000, t("online.recheck"));
      if (status.loggedIn) {
        // Cookie 存在不代表有权限，必须真的调通一次 Find
        const probe = await withTimeout(
          findMods({ query: "", start: 1, count: 1, sort: SORT_OPTIONS[0].value, order: "DESC" }),
          20000,
          t("online.probe"),
        );
        ok = true;
        void uiLog("info", `后台免密登录成功（返回 ${probe.items.length} 条）`);
        stopSilentTimer();
        silentAuth.value = false;
        silentAuthNote.value = null;
        sessionError.value = null;
        await closeLoginWindow();
        // markOnline 会 bump sessionEpoch → handleSessionEpoch 统一负责刷新列表
        markOnline(status);
        setStatusMessage(t("statusbar.loginDone"));
      }
    } catch (e) {
      void uiLog("info", `后台免密登录第 ${ticks} 次未完成：${messageOf(e)}`);
    }
    if (!ok && ticks >= 12) {
      stopSilentTimer();
      silentAuth.value = false;
      silentAuthNote.value = t("online.silentFailed");
    }
  }, 2000);
}

async function stopWaiting() {
  waitingLogin.value = false;
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  void uiLog("info", "用户取消等待登录：隐藏登录窗口（前端主动 close）");
  await closeLoginWindow();
}

function exceedsTagFilter(mod: OnlineMod): boolean {
  if (activeTag.value === null) return true;
  // 已订阅接口不支持 tags 过滤，这里按官方 modTagIds 前端过滤
  return mod.tagIds.includes(activeTag.value);
}

function requestChunk(start: number) {
  if (onlySubscribed.value) return installedMods(start, PAGE_SIZE);
  return findMods({
    query: query.value.trim(),
    start,
    count: PAGE_SIZE,
    sort: sort.value,
    order: order.value,
    tags: activeTag.value === null ? [] : [activeTag.value],
  });
}

function resetList() {
  items.value = [];
  totalCount.value = null;
  error.value = null;
  moreError.value = null;
  hasMore.value = true;
  cursor.value = 1;
  selected.value = null;
  detail.value = null;
  measuredBytes.value = null;
  // 列表被清空重建，旧的滚动位置已无意义
  savedScrollTop = 0;
  restorePending = false;
}

function mergeChunk(list: OnlineMod[]): number {
  const known = new Set(items.value.map((m) => m.modId));
  const fresh = list.filter((m) => !known.has(m.modId) && exceedsTagFilter(m));
  if (fresh.length) items.value = [...items.value, ...fresh];
  return fresh.length;
}

/** 首屏 / 切换筛选：清空后从第 1 条重新加载 */
async function manualRefresh() {
  // 手动刷新：强制重探登录态，成功后由 sessionEpoch 统一触发 reload
  await refreshSession();
}

// ---------------- v0.6：缓存优先（SWR 秒开） ----------------

/** 缓存最多连续重放几页（把上次看到的列表拼回来） */
const CACHE_PAGE_LIMIT = 4;

/** 底栏中间提示用的 HH:mm */
function clockText(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 读一页缓存。未命中 / 超过 24 小时（expired）/ 空页都返回 null。
 * key 由 Rust 侧统一计算，这里只传原始参数。
 */
async function readCachePage(start: number): Promise<OnlineMod[] | null> {
  let hit: CacheHit<FindResult> | null = null;
  try {
    hit = onlySubscribed.value
      ? await readInstalledCache(start, PAGE_SIZE)
      : await readFindCache({
          query: query.value.trim(),
          start,
          count: PAGE_SIZE,
          sort: sort.value,
          order: order.value,
          tags: activeTag.value === null ? [] : [activeTag.value],
        });
  } catch {
    // 缓存命令不可用（例如还跑着旧的后端二进制）时静默降级为“没有缓存”，绝不拖垮列表
    return null;
  }
  if (!usableListCache(hit)) return null;
  if (hit.value.totalCount !== null) totalCount.value = hit.value.totalCount;
  const list = (hit.value.items ?? []).filter((m) => typeof m?.modId === "number");
  return list.length ? list : null;
}

/**
 * 把缓存重放成当前列表：命中任意一页就返回 true。
 * 只改 items / cursor / hasMore，不动 loading（要不要转圈由调用方决定）。
 */
async function showFromCache(): Promise<boolean> {
  const pages: OnlineMod[] = [];
  let start = 1;
  let exhausted = false;
  for (let page = 0; page < CACHE_PAGE_LIMIT; page += 1) {
    const chunk = await readCachePage(start);
    if (!chunk) break;
    // /Installed 不支持 tags 过滤，缓存里是全集，这里按官方 tagIds 在本地筛
    const usable = onlySubscribed.value ? chunk.filter(exceedsTagFilter) : chunk;
    const fresh = usable.filter((m) => !pages.some((seen) => seen.modId === m.modId));
    pages.push(...fresh);
    start += chunk.length;
    if (chunk.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }
  if (!pages.length) return false;
  items.value = pages;
  cursor.value = start;
  hasMore.value = !exhausted;
  return true;
}

/** 离线翻页：只用缓存里的下一页；没有就当作到底（重新登录后 reload 会整体替换） */
async function appendCachePage(): Promise<boolean> {
  const chunk = await readCachePage(cursor.value);
  if (!chunk) return false;
  cursor.value += chunk.length;
  if (chunk.length < PAGE_SIZE) hasMore.value = false;
  return mergeChunk(chunk) > 0;
}

/**
 * 列表加载的唯一入口。顺序固定：
 * ① 清空 → ② 缓存铺屏（不看登录态，秒开）→ ③ 离线到此为止 → ④ 在线静默刷新并平滑替换。
 */
async function reload() {
  seq += 1;
  const mySeq = seq;
  loadingMore.value = false;
  resetList();

  // ② 缓存优先
  const cached = await showFromCache();
  if (mySeq !== seq) return;
  if (cached) {
    setStatusMessage(t("statusbar.cacheLoaded"));
    if (items.value.length) await selectMod(items.value[0]);
    if (mySeq !== seq) return;
  }

  // ③ 离线：有缓存就看缓存，没缓存就交给模板显示登录面板
  if (sessionPhase.value !== "online") {
    loading.value = false;
    if (!cached) setStatusMessage(t("statusbar.offlineHint"));
    return;
  }

  // ④ 在线：静默刷新（有缓存时不亮骨架，实现无闪烁替换）
  loading.value = !cached;
  setStatusMessage(cached ? t("statusbar.refreshing") : t("statusbar.fetching"));
  try {
    let guard = 0;
    while (mySeq === seq && guard < 4) {
      guard += 1;
      const result = await requestChunk(cursor.value);
      if (mySeq !== seq) return;
      if (result.totalCount !== null) totalCount.value = result.totalCount;
      if (result.serverMessage && result.items.length === 0) error.value = result.serverMessage;
      cursor.value += result.items.length;
      if (result.items.length < PAGE_SIZE) hasMore.value = false;
      const added = mergeChunk(result.items);
      if (added > 0 || !hasMore.value || result.items.length === 0) break;
    }
    if (mySeq !== seq) return;
    setStatusMessage(t("statusbar.freshAt", { time: clockText(Date.now()) }));
    if (items.value.length) await selectMod(items.value[0]);
  } catch (e) {
    if (mySeq === seq) {
      items.value = [];
      error.value = messageOf(e);
      if (kindOf(e) === "unauthenticated") {
        session.value = null;
        // 底栏立刻变灰，避免继续显示“已登录”
        markUnauthenticated(messageOf(e));
        // 缓存的会话 Cookie 已失效（会话 Cookie 不跨进程）：后台静默重新走一次 SSO
        void silentReauth(t("online.reasonUnauthorized"));
      }
    }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

/** 滚动到底部：追加下一批 */
async function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  if (error.value || !items.value.length) return;
  const mySeq = seq;
  // v0.6：离线只用缓存里的下一页，不再打网络
  if (sessionPhase.value !== "online") {
    if (!(await appendCachePage())) hasMore.value = false;
    return;
  }
  loadingMore.value = true;
  moreError.value = null;
  try {
    let guard = 0;
    while (mySeq === seq && hasMore.value && guard < 4) {
      guard += 1;
      const result = await requestChunk(cursor.value);
      if (mySeq !== seq) return;
      if (result.totalCount !== null) totalCount.value = result.totalCount;
      cursor.value += result.items.length;
      if (result.items.length < PAGE_SIZE) hasMore.value = false;
      if (result.items.length === 0) break;
      if (mergeChunk(result.items) > 0) break;
    }
  } catch (e) {
    if (mySeq === seq) moreError.value = messageOf(e);
  } finally {
    if (mySeq === seq) {
      loadingMore.value = false;
      keepFilling();
    }
  }
}

/** 一批加载完仍没填满视口时继续拉（IntersectionObserver 不会重复触发已相交的哨兵） */
function keepFilling() {
  const el = scrollEl.value;
  const marker = sentinel.value;
  if (!el || !marker || !hasMore.value || moreError.value) return;
  const box = el.getBoundingClientRect();
  const markerBox = marker.getBoundingClientRect();
  if (markerBox.top - box.bottom < 400) {
    window.setTimeout(() => void loadMore(), 0);
  }
}

let scrollHandler: (() => void) | null = null;

function detachObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scrollHandler && scrollEl.value) {
    scrollEl.value.removeEventListener("scroll", scrollHandler);
  }
  scrollHandler = null;
}

function attachObserver() {
  detachObserver();
  const el = scrollEl.value;
  const marker = sentinel.value;
  if (!el || !marker) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    },
    { root: el, rootMargin: "600px 0px", threshold: 0 },
  );
  observer.observe(marker);
  scrollHandler = () => {
    rememberScroll();
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
  };
  el.addEventListener("scroll", scrollHandler, { passive: true });
}

function pickTag(id: number | null) {
  if (activeTag.value === id) return;
  activeTag.value = id;
  void reload();
}

function pickSubscribed(value: boolean) {
  if (onlySubscribed.value === value) return;
  onlySubscribed.value = value;
  void reload();
}

async function selectMod(mod: OnlineMod) {
  selected.value = mod;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = sessionPhase.value === "online";
  installError.value = null;
  installNote.value = null;
  needForce.value = false;
  actionMessage.value = null;
  measuredBytes.value = null;
  favError.value = null;
  renameOpen.value = false;

  // ① 详情同样缓存优先：秒开上次看过的内容
  try {
    const hit = await readDetailCache(mod.modId);
    if (selected.value?.modId !== mod.modId) return;
    if (usableDetailCache(hit)) detail.value = hit.value;
  } catch {
    /* 缓存读失败不影响后续网络请求 */
  }

  // ② 离线：只用缓存，不发请求（避免 401 把详情刷成错误）
  if (sessionPhase.value !== "online") {
    detailLoading.value = false;
    return;
  }

  try {
    detail.value = await modDetail(mod.modId);
  } catch (e) {
    if (selected.value?.modId === mod.modId) detailError.value = messageOf(e);
  } finally {
    if (selected.value?.modId === mod.modId) detailLoading.value = false;
  }
}

// ---------------- 局部状态更新（绝不触发 reload） ----------------

/** 就地改列表里的对象：selected 引用同一个对象，详情面板会自动同步 */
function patchMod(modId: number, patch: Partial<OnlineMod>): void {
  const item = items.value.find((m) => m.modId === modId);
  if (item) Object.assign(item, patch);
  // 列表曾重建过时，详情可能持有另一份引用，这里兜底同步
  if (selected.value && selected.value.modId === modId && selected.value !== item) {
    Object.assign(selected.value, patch);
  }
}

function showToast(text: string, kind: "ok" | "error" = "ok"): void {
  toast.value = { text, kind };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
    toastTimer = null;
  }, 3200);
}

/**
 * 主按钮状态机（以磁盘事实为准，不看服务器的 userInstalled）：
 * 本地没有目录 → “下载并安装为本地模组”；已有目录（无论官方订阅还是本工具安装）→ “卸载本地模组”。
 * 不再向官方发退订请求：取消订阅请点「在网站浏览」到官网操作。
 */
const localEntry = computed<InstalledIndexEntry | null>(() => {
  const mod = selected.value;
  if (!mod) return null;
  return localIndex.value[mod.modId] ?? null;
});

const primaryAction = computed<"install" | "uninstall-local">(() =>
  localEntry.value ? "uninstall-local" : "install",
);

/** 主按钮文案：与 primaryAction 严格一一对应 */
const subscribeLabel = computed(() => {
  if (installing.value) return t("online.downloading");
  return primaryAction.value === "uninstall-local" ? t("online.uninstallLocal") : t("online.installLocal");
});

/** 读一次本机安装索引（只读目录名 + 元数据，不触发特征扫描） */
async function refreshLocalIndex() {
  try {
    const list = await installedLocalIndex();
    const map: Record<number, InstalledIndexEntry> = {};
    for (const entry of list) map[entry.workshopId] = entry;
    localIndex.value = map;
    localIndexError.value = null;
  } catch (e) {
    localIndexError.value = messageOf(e);
  }
}

function askDeleteLocal() {
  if (!localEntry.value || subscribeBusy.value) return;
  deleteError.value = null;
  confirmDeleteOpen.value = true;
}

/** 只删本机文件（不向官方发任何请求，也不动服务器订阅状态） */
async function confirmDeleteLocal() {
  const mod = selected.value;
  const entry = localEntry.value;
  if (!mod || !entry || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = null;
  try {
    const report = await deleteModFiles(entry.kind, entry.folderName, mod.modId);
    confirmDeleteOpen.value = false;
    installNote.value = translateBackendMessage(report.message);
    actionMessage.value = t("online.deletedLocal");
    showToast(t("online.deletedLocalToast"));
    await refreshLocalIndex();
  } catch (e) {
    deleteError.value = messageOf(e);
  } finally {
    deleteBusy.value = false;
  }
}

const subscribeBusy = computed(() => actionBusy.value || installing.value);

function installNoteText(outcome: InstallOutcome): string {
  return [
    outcome.install.updated ? t("online.installUpdated") : t("online.installed"),
    t("online.finalDir", { dir: outcome.finalDir, path: outcome.finalPath }),
    t("online.fileStats", {
      n: outcome.install.fileCount,
      mb: (outcome.install.bytes / 1024 / 1024).toFixed(1),
    }),
    outcome.install.backupDir ? t("online.backupDir", { dir: outcome.install.backupDir }) : "",
    outcome.assets ? t("online.assets", { msg: translateBackendMessage(outcome.assets.message) }) : "",
    outcome.statusNote ? t("online.statusNote", { msg: translateBackendMessage(outcome.statusNote) }) : "",
    outcome.statusBackupPath ? t("online.statusBackup", { path: outcome.statusBackupPath }) : "",
    translateBackendMessage(outcome.note),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 主按钮：直接下载并安装为本地模组（Rust 侧在同一条管线里完成
 * 下载 → 解压 → 装入 subscribed → 补 info.json/缩略图 → 移到 local → 一次写 mod-status.json）。
 * 前端只负责进度显示与结果呈现，不再做"订阅"这一步。
 */
async function downloadAndInstall() {
  const mod = selected.value;
  if (!mod || subscribeBusy.value) return;
  // v0.6：离线拦截（本地收藏 / 备注不受影响，只有下载被挡）
  if (sessionPhase.value !== "online") {
    showToast(t("online.offlineBlocked"), "error");
    return;
  }
  actionBusy.value = true;
  actionMessage.value = null;
  installError.value = null;
  installNote.value = null;

  installing.value = true;
  progress.value = null;
  try {
    const outcome = await installMod(
      mod.modId,
      mod.title,
      forceOverwrite.value,
      mod.tagIds,
      mod.tagNames,
      mod.creator,
      rawDescription.value,
      mod.thumbnail,
    );
    installNote.value = installNoteText(outcome);
    needForce.value = false;
    // 本地模组：服务器订阅状态不参与判断
    patchMod(mod.modId, { userInstalled: false, updateAvailable: false });
    if (outcome.localized) {
      actionMessage.value = t("online.installDone");
      showToast(t("online.installDoneToast"));
    } else {
      actionMessage.value = t("online.installKeepSubscribed");
      showToast(t("online.installKeepSubscribedToast"), "error");
    }
  } catch (e) {
    installError.value = messageOf(e);
    if (kindOf(e) === "install" && installError.value.includes("允许覆盖")) {
      needForce.value = true;
    }
    actionMessage.value = t("online.installFailed");
    showToast(t("online.installFailedToast", { msg: messageOf(e) }), "error");
  } finally {
    installing.value = false;
    progress.value = null;
    actionBusy.value = false;
    void refreshLocalIndex();
  }
}

/** 用系统默认浏览器打开官方模组页面（URL 由后端拼装），在那里取消订阅 */
async function openWebpage() {
  const mod = selected.value;
  if (!mod || openingWeb.value) return;
  openingWeb.value = true;
  try {
    const url = await openModWebpage(mod.modId);
    showToast(t("online.openedBrowser", { url }));
  } catch (e) {
    showToast(t("online.openFailed", { msg: messageOf(e) }), "error");
  } finally {
    openingWeb.value = false;
  }
}

async function doInstall() {
  const mod = selected.value;
  if (!mod || installing.value) return;
  // v0.6：离线拦截（重新安装 / 覆盖安装同样需要登录态去取签名下载地址）
  if (sessionPhase.value !== "online") {
    showToast(t("online.offlineBlocked"), "error");
    return;
  }
  installing.value = true;
  installError.value = null;
  installNote.value = null;
  progress.value = null;
  try {
    const outcome = await installMod(
      mod.modId,
      mod.title,
      forceOverwrite.value,
      mod.tagIds,
      mod.tagNames,
      mod.creator,
      rawDescription.value,
      mod.thumbnail,
    );
    installNote.value = installNoteText(outcome);
    needForce.value = false;
    showToast(t("online.installDoneShort"));
  } catch (e) {
    installError.value = messageOf(e);
    if (kindOf(e) === "install" && installError.value.includes("允许覆盖")) {
      needForce.value = true;
    }
  } finally {
    installing.value = false;
    progress.value = null;
    void refreshLocalIndex();
  }
}

async function stopInstall() {
  try {
    await cancelInstall();
  } catch {
    /* 忽略 */
  }
}

function rawEntries(): { key: string; value: string }[] {
  if (!detail.value) return [];
  return Object.entries(detail.value).map(([key, value]) => {
    let text: string;
    if (value === null || value === undefined) text = "null";
    else if (typeof value === "object") text = JSON.stringify(value);
    else text = String(value);
    if (text.length > 300) text = `${text.slice(0, 300)}…`;
    return { key, value: text };
  });
}

watch([scrollEl, sentinel], attachObserver, { flush: "post" });

/** 首次挂载只跑一次；被 KeepAlive 缓存后不会再触发 */
let booted = false;

/**
 * 登录态确认有效的统一刷新入口。
 * boot 与 watch(sessionEpoch) 都走它，用 epoch 去重，保证同一个信号只刷一次。
 */
let handledEpoch = 0;
async function handleSessionEpoch() {
  const current = sessionEpoch.value;
  if (current === handledEpoch) return;
  handledEpoch = current;
  if (sessionPhase.value !== "online") return;
  await loadTags();
  await reload();
}
watch(sessionEpoch, () => {
  void handleSessionEpoch();
});

async function boot() {
  if (booted) return;
  booted = true;
  unlisten = await onDownloadProgress((payload) => {
    progress.value = payload;
    if (payload.total > 0) measuredBytes.value = payload.total;
  });
  // v0.5：收藏 / 备注只读一次磁盘（失败不阻塞在线页）
  void ensureUserData().catch(() => undefined);

  // ① 缓存优先：没登录也要能秒开上次的列表
  const cached = await showFromCache();
  if (cached) {
    setStatusMessage(t("statusbar.cacheLoaded"));
    if (items.value.length) void selectMod(items.value[0]);
  }

  // ② 平台清单（后端本地常量，不走网络）
  try {
    platforms.value = await loginTargets();
    if (!platforms.value.some((p) => p.key === platform.value)) {
      platform.value = platforms.value[0]?.key ?? "microsoft";
    }
  } catch (e) {
    netError.value = t("online.loginTargetsFailed", { msg: messageOf(e) });
  }

  // ③ 静默校验登录态：App.vue 启动时已发起，这里复用同一个 Promise（并发去重）
  const online = await ensureSession();
  if (online) {
    await handleSessionEpoch();
    return;
  }

  // ④ 离线：分类字典用内置兜底，并后台静默尝试一次 SSO（隐藏窗口，不阻塞）
  await loadTags();
  setStatusMessage(t("statusbar.offlineHint"));
  void silentReauth(t("online.reasonNoSession"));
}

onMounted(() => {
  void refreshLocalIndex();
  void boot();
});

/** 被 KeepAlive 切走时的滚动位置（仅组件内部状态，不触发渲染） */
let savedScrollTop = 0;
let restorePending = false;

/**
 * 关键：KeepAlive 把子树移出文档后，元素的 clientHeight/scrollHeight 都变 0，
 * 此时读 scrollTop 永远得到 0（这正是“记下的位置总是顶部”的原因）。
 * 所以在滚动事件里持续记录，且只在容器确实有滚动高度时才覆写。
 */
function rememberScroll() {
  const el = scrollEl.value;
  if (!el) return;
  if (el.scrollHeight > el.clientHeight) savedScrollTop = el.scrollTop;
}

/** 被 KeepAlive 再次显示：只恢复滚动位置与观察器，不发任何网络请求 */
onActivated(() => {
  // 本地页可能删过模组，重新读一次索引（只读目录名，不发网络请求）
  void refreshLocalIndex();
  void nextTick(restoreScroll);
});

/** 切走时先记位置再销毁观察器（deactivated 在移出文档之后触发，不能在这里读 scrollTop） */
onDeactivated(() => {
  rememberScroll();
  restorePending = true;
  detachObserver();
});

/**
 * 先把 scrollTop 还原、再挂观察器：顺序反过来会让哨兵先被判相交，误触发一次 loadMore，
 * 新批量一追加页面就会跳。attachObserver 内部有 loadMore 各项互斥保护（loading/loadingMore/hasMore/error）。
 */
function restoreScroll() {
  const el = scrollEl.value;
  if (!el || !restorePending) {
    attachObserver();
    return;
  }
  restorePending = false;
  const target = savedScrollTop;
  if (target > 0) {
    el.scrollTop = target;
    // 缩略图 / 字体回流会让高度暂时不足导致 scrollTop 被截断，下一帧补一次
    if (el.scrollTop < target) {
      requestAnimationFrame(() => {
        const again = scrollEl.value;
        if (again && again.scrollTop < target) again.scrollTop = target;
      });
    }
  }
  attachObserver();
}

onUnmounted(() => {
  detachObserver();
  stopSilentTimer();
  if (unlisten) unlisten();
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <!-- 与本地模组完全相同的三栏骨架：.body-grid / .sidebar / .content / .detail -->
  <div class="body-grid">
    <!-- 左侧：分类筛选（复用本地 .side-group / .side-item） -->
    <aside class="sidebar">
      <div class="side-group">
        <div class="side-title">{{ t("sidebar.source") }}</div>
        <button
          type="button"
          class="side-item"
          :class="{ active: !onlySubscribed }"
          @click="pickSubscribed(false)"
        >
          <span class="label">{{ t("sidebar.allMods") }}</span>
        </button>
        <button
          type="button"
          class="side-item"
          :class="{ active: onlySubscribed }"
          @click="pickSubscribed(true)"
        >
          <span class="label">{{ t("sidebar.subscribed") }}</span>
        </button>
      </div>

      <!-- v0.5：我的收藏（只过滤 isFavorite，按 modId 匹配 user_data.json） -->
      <div class="side-group">
        <div class="side-title">{{ t("favorites.groupTitle") }}</div>
        <button
          type="button"
          class="side-item"
          :class="{ active: favoritesOnly }"
          :title="t('favorites.noteOnline')"
          @click="favoritesOnly = !favoritesOnly"
        >
          <span class="label">⭐ {{ t("favorites.label") }}</span>
          <span class="count">{{ favoriteCount }}</span>
        </button>
        <div class="side-note note">{{ t("favorites.noteOnline") }}</div>
      </div>

      <div class="side-group">
        <div class="side-title">{{ t("sidebar.officialTags") }}</div>
        <button
          type="button"
          class="side-item"
          :class="{ active: activeTag === null }"
          @click="pickTag(null)"
        >
          <span class="label">{{ t("sidebar.allContent") }}</span>
        </button>
        <button
          v-for="item in tags"
          :key="item.modTypeId"
          type="button"
          class="side-item"
          :class="{ active: activeTag === item.modTypeId }"
          :title="item.modTypeName"
          @click="pickTag(item.modTypeId)"
        >
          <span class="label">{{ tagLabel(item) }}</span>
        </button>
        <div v-if="!tags.length" class="side-note note">{{ t("online.tagsLoading") }}</div>
        <div v-else-if="tagsError" class="side-note note">{{ tagsError }}</div>
      </div>

      <div class="side-group">
        <div class="side-title">{{ t("online.account") }}</div>
        <div class="side-note note">
          {{ session?.loggedIn ? t("online.signedIn") : t("online.signedOut") }} ·
          {{ session?.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview") }}
          <template v-if="session?.cookieCount">· {{ session.cookieCount }} Cookie</template>
        </div>
        <button type="button" class="side-item" @click="refreshSession">
          <span class="label">{{ t("online.recheck") }}</span>
        </button>
        <button type="button" class="side-item" :disabled="netClearing" @click="doLogout">
          <span class="label">{{ netClearing ? t("online.clearing") : t("online.clearCache") }}</span>
        </button>
        <div v-if="netError" class="side-msg error">{{ netError }}</div>
        <div v-else-if="netMessage" class="side-msg">{{ netMessage }}</div>
      </div>

      <!-- 代理 / 记住登录已迁到顶栏齿轮里的设置弹窗（SettingsModal → 网络） -->
      <div class="side-group">
        <div class="side-title">{{ t("settings.tabNetwork") }}</div>
        <div class="side-note note">{{ t("settings.networkMoved") }}</div>
      </div>

      <div class="side-group">
        <div class="side-title">{{ t("online.dataSource") }}</div>
        <div class="side-note note">api.ageofempires.com /api/v4/mods</div>
      </div>
    </aside>

    <!-- 中间：与本地一致的 .content + .grid-scroll + .card-grid -->
    <section class="content">
      <div class="content-head">
        <h2>{{ heading }}</h2>
        <span class="hint">
          {{ activeTagName }} ·
          {{ items.length
          }}<template v-if="totalCount !== null">{{ t("online.totalSuffix", { n: totalCount }) }}</template>
          <template v-if="loading">{{ t("online.loadingSuffix") }}</template>
        </span>
      </div>

      <!-- 搜索 / 排序 / 刷新已统一到 App.vue 的顶栏，这里只保留标题条与列表 -->
      <div ref="scrollEl" class="grid-scroll">
        <!-- v0.6：已删除全屏「正在检查登录状态」蒙层。有缓存就直接出列表；
             既没缓存又没登录才显示登录面板，校验进行中只在面板里加一行 🟡 提示。 -->
        <div v-if="!items.length && !session?.loggedIn" class="state-panel">
          <h2>{{ t("online.sessionConnectTitle") }}</h2>
          <p>{{ t("online.sessionConnectBody") }}</p>
          <p v-if="sessionPhase === 'checking'" class="online-silent">
            <span class="spinner"></span>{{ t("statusbar.checking") }}
          </p>
          <p v-else-if="silentAuth" class="online-silent">
            <span class="spinner"></span>{{ silentAuthNote }}
          </p>
          <p v-else-if="silentAuthNote" class="online-silent note">{{ silentAuthNote }}</p>
          <div class="login-targets">
            <button
              v-for="target in platforms"
              :key="target.key"
              type="button"
              class="login-target"
              :class="{ active: platform === target.key }"
              :disabled="waitingLogin"
              @click="platform = target.key"
            >
              <span class="lt-label">{{ loginLabel(target) }}</span>
              <span class="lt-hint">{{ loginHint(target) }}</span>
            </button>
          </div>
          <div class="login-actions">
            <button type="button" :disabled="waitingLogin" @click="startLogin()">
              {{ waitingLogin ? t("online.waitingLogin") : t("online.openLogin") }}
            </button>
            <button v-if="waitingLogin" type="button" @click="stopWaiting">{{ t("online.cancel") }}</button>
            <button type="button" :disabled="probing" @click="runProbe">
              {{ probing ? t("online.probing") : t("online.probe") }}
            </button>
            <button type="button" @click="refreshSession">{{ t("online.recheck") }}</button>
          </div>
          <p v-if="sessionError" class="online-error">{{ sessionError }}</p>
          <pre v-if="probeResult" class="online-note-box">{{ probeResult }}</pre>
        </div>

        <template v-else>
          <div v-if="error" class="state-panel">
            <h2>{{ t("online.requestFailedTitle") }}</h2>
            <p>{{ error }}</p>
            <div class="login-actions">
              <button type="button" @click="reload()">{{ t("online.retry") }}</button>
              <button type="button" @click="startLogin()">{{ t("online.signInAgain") }}</button>
            </div>
          </div>

          <div v-else-if="!items.length && loading" class="state-panel">
            <h2><span class="spinner"></span>{{ t("online.listLoadingTitle") }}</h2>
            <p class="note">{{ t("online.listLoadingBody", { n: PAGE_SIZE }) }}</p>
          </div>

          <div v-else-if="!items.length" class="state-panel">
            <h2>{{ t("online.listEmptyTitle") }}</h2>
            <p>{{ t("online.listEmptyBody") }}</p>
            <div class="login-actions">
              <button type="button" @click="reload()">{{ t("online.reload") }}</button>
            </div>
          </div>

          <template v-else>
            <!-- 离线 + 有缓存：列表照常展示，只在上方加一条不可下载的提示 -->
            <div v-if="!session?.loggedIn" class="offline-strip">
              ⚪ {{ t("online.offlineCacheNotice") }}
            </div>

            <div v-if="favoritesOnly && !visibleItems.length" class="state-panel">
              <h2>⭐ {{ t("favorites.empty") }}</h2>
              <p>{{ t("favorites.loadingOnline") }}</p>
            </div>

            <div v-else class="card-grid">
              <OnlineModCard
                v-for="mod in visibleItems"
                :key="mod.modId"
                :mod="mod"
                :active="selected?.modId === mod.modId"
                @select="selectMod"
              />
            </div>

            <div ref="sentinel" class="scroll-foot">
              <template v-if="moreError">
                <span class="err">{{ moreError }}</span>
                <button type="button" @click="loadMore()">{{ t("online.retry") }}</button>
              </template>
              <template v-else-if="loadingMore">
                <span class="spinner"></span>{{ t("online.loadingMore") }}
              </template>
              <template v-else-if="hasMore">{{ t("online.scrollMore") }}</template>
              <template v-else>{{ t("online.endOfList", { n: items.length }) }}</template>
            </div>
          </template>
        </template>
      </div>
    </section>

    <!-- 右侧：与本地相同的 .detail 宽度（372px） -->
    <aside class="detail">
      <div class="detail-header">
        <h2>{{ t("online.detailTitle") }}</h2>
        <span v-if="selected" class="badge">#{{ selected.modId }}</span>
      </div>

      <div v-if="!selected" class="detail-empty">
        {{ t("online.detailEmpty") }}<br />
        <span class="note">{{ t("online.detailEmptyNote") }}</span>
      </div>

      <div v-else class="detail-body">
        <img v-if="selected.thumbnail" class="detail-cover" :src="selected.thumbnail" alt="" />
        <div v-else class="no-cover-box">{{ t("online.noThumbnail") }}</div>

        <h3 class="detail-title">{{ displayTitle(selected.modId, selected.title) }}</h3>
        <div v-if="customName" class="detail-title-orig">
          {{ t("favorites.originalTitle") }}: {{ selected.title }}
        </div>

        <!-- v0.5：收藏 / 备注名 -->
        <div class="fav-row">
          <button
            type="button"
            class="fav-btn"
            :class="{ active: favorited }"
            :disabled="!canFavorite || favBusy"
            :title="t('favorites.favoriteTitle')"
            @click="toggleFavorite"
          >
            <span class="fav-star">{{ favorited ? "⭐" : "☆" }}</span>
            {{ favorited ? t("favorites.favorited") : t("favorites.favorite") }}
          </button>
          <button
            type="button"
            class="fav-btn"
            :disabled="!canFavorite || renameBusy"
            :title="t('favorites.renameTitle')"
            @click="openRename"
          >
            <span class="fav-star">📝</span>
            {{ t("favorites.rename") }}
          </button>
        </div>
        <div v-if="favError" class="online-error">{{ favError }}</div>

        <div v-if="detailTags.length" class="detail-badges">
          <span v-for="name in detailTags" :key="name" class="badge">{{ localizedTagName(name) }}</span>
        </div>

        <div class="field">
          <span class="k">{{ t("online.author") }}</span>
          <span class="v" :class="{ missing: !selected.creator }">
            {{ selected.creator ?? t("labels.notProvided") }}
          </span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.installs") }}</span>
          <span class="v">
            {{ selected.installs ?? t("labels.notProvided") }}
            <template v-if="selected.installsTruncated">{{ t("online.installsTruncated") }}</template>
          </span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.rating") }}</span>
          <span class="v">{{ ratingText }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.modSize") }}</span>
          <span class="v">{{ sizeText }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.diskSize") }}</span>
          <span class="v">{{ diskText }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.version") }}</span>
          <span class="v">{{ versionText }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.created") }}</span>
          <span class="v" :class="{ missing: !createdText }">{{ createdText ?? t("labels.notProvided") }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.updated") }}</span>
          <span class="v" :class="{ missing: !updatedText }">{{ updatedText ?? t("labels.notProvided") }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.status") }}</span>
          <span class="v">{{ selected.modStatus ?? t("labels.notProvided") }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.subscribed") }}</span>
          <span class="v">{{ selected.userInstalled ? t("online.yesOfficial") : t("online.no") }}</span>
        </div>
        <div class="field">
          <span class="k">{{ t("online.localState") }}</span>
          <span class="v source-cell" :class="{ missing: !localEntry }">
            <template v-if="localEntry">
              <span class="badge" :class="'source-' + localEntry.source">
                {{ sourceLabel(localEntry.source) }}
              </span>
              <span class="note" style="margin: 0">
                {{ localEntry.kind }} / {{ localEntry.folderName }}
              </span>
            </template>
            <template v-else>{{ t("online.notInstalled") }}</template>
          </span>
        </div>
        <div v-if="localIndexError" class="online-error">
          {{ t("online.localIndexError", { err: localIndexError }) }}
        </div>
        <div class="field">
          <span class="k">{{ t("online.updateAvailable") }}</span>
          <span class="v">{{ selected.updateAvailable ? t("online.yes") : t("online.yesOrUnknown") }}</span>
        </div>

        <div class="detail-actions">
          <button
            v-if="primaryAction === 'install'"
            type="button"
            class="primary"
            :disabled="subscribeBusy"
            @click="downloadAndInstall"
          >
            {{ subscribeLabel }}
          </button>
          <button v-else type="button" class="danger" :disabled="subscribeBusy" @click="askDeleteLocal">
            {{ subscribeLabel }}
          </button>
          <button v-if="localEntry" type="button" :disabled="subscribeBusy" @click="doInstall">
            {{ installing ? t("online.installing") : selected.updateAvailable ? t("online.updateLocal") : t("online.reinstallLocal") }}
          </button>
          <button v-if="installing" type="button" @click="stopInstall">{{ t("online.cancelDownload") }}</button>
          <button type="button" :disabled="openingWeb" @click="openWebpage">{{ t("online.browseSite") }}</button>
        </div>

        <div v-if="actionMessage" class="online-message">{{ actionMessage }}</div>

        <div v-if="installing || progress" class="online-progress">
          <div class="bar">
            <div class="fill" :style="{ width: (progress?.percent ?? 0) + '%' }"></div>
          </div>
          <div class="note">
            {{ progress?.phase ?? t("online.preparing") }} ·
            {{ ((progress?.received ?? 0) / 1024 / 1024).toFixed(1) }} MB
            <template v-if="progress && progress.total > 0">
              / {{ (progress.total / 1024 / 1024).toFixed(1) }} MB
            </template>
          </div>
        </div>

        <label v-if="needForce" class="online-force">
          <input v-model="forceOverwrite" type="checkbox" />
          {{ t("online.overwriteConfirm") }}
        </label>

        <div v-if="installError" class="online-error">{{ installError }}</div>
        <pre v-if="installNote" class="online-note-box">{{ installNote }}</pre>

        <div v-if="descriptionText" class="section">
          <h3>{{ t("online.description") }}</h3>
          <div class="desc">{{ descriptionText }}</div>
        </div>

        <details class="section raw-details">
          <summary>{{ t("online.rawFields", { id: selected.modId }) }}</summary>
          <div v-if="detailLoading" class="note">{{ t("online.loading") }}</div>
          <div v-else-if="detailError" class="note">{{ detailError }}</div>
          <template v-else-if="detail">
            <div v-for="entry in rawEntries()" :key="entry.key" class="field">
              <span class="k">{{ entry.key }}</span>
              <span class="v mono">{{ entry.value }}</span>
            </div>
          </template>
          <div v-else class="note">{{ t("online.noDetail") }}</div>
        </details>
      </div>
    </aside>

    <!-- 右下角轻提示：局部状态变更的即时反馈，不触发列表重载 -->
    <div v-if="toast" class="online-toast" :class="toast.kind">{{ toast.text }}</div>

    <!-- v0.5：备注名弹窗 -->
    <RenameDialog
      v-if="renameOpen && selected"
      :original="selected.title"
      :initial="customName"
      :busy="renameBusy"
      :error="renameError"
      @save="applyRename"
      @cancel="renameOpen = false"
    />

    <!-- 删除本地文件前的二次确认 -->
    <ConfirmDialog
      v-if="confirmDeleteOpen"
      :title="t('online.uninstallTitle')"
      :message="t('online.uninstallMessage')"
      :detail="localEntry ? localEntry.kind + '/' + localEntry.folderName : null"
      :confirm-label="t('confirm.defaultConfirm')"
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDeleteLocal"
      @cancel="confirmDeleteOpen = false"
    />
  </div>
</template>

<style scoped>
/* 只补充本地界面没有的元素；布局全部复用 style.css 的本地类 */
/* 搜索/排序控件已统一到 App.vue 顶栏（.search-box / .toolbar），此处不再保留 */
.side-note {
  padding: 2px 10px 4px;
  line-height: 1.6;
  word-break: break-all;
}
.side-form {
  padding: 2px 0 4px;
}
.side-check {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  font-size: 11.5px;
  color: var(--parch-dim);
  line-height: 1.5;
}
.side-input {
  display: block;
  width: calc(100% - 20px);
  margin: 2px 10px;
  padding: 4px 7px;
  font-size: 11px;
}
.side-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px 2px;
}
.side-btns button {
  padding: 4px 9px;
  font-size: 11px;
}
.side-msg {
  padding: 2px 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--gold);
}
.side-msg.error {
  color: #d98a72;
}
.side-item .caret {
  color: var(--gold-dim);
  font-size: 10px;
}
.offline-strip {
  margin: 10px 0 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--gold-dim);
  border-radius: 3px;
  background: rgba(201, 162, 77, 0.06);
  color: var(--gold);
  font-size: 11.5px;
  line-height: 1.6;
}
.scroll-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 0 8px;
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.4px;
}
.scroll-foot .err {
  color: #d98a72;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scroll-foot button {
  padding: 3px 10px;
  font-size: 11px;
}
.login-targets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
  margin: 12px 0 4px;
}
.login-target {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  padding: 9px 11px;
  text-align: left;
  line-height: 1.5;
}
.login-target.active {
  border-color: var(--gold);
  box-shadow: inset 0 0 0 1px rgba(201, 162, 77, 0.35);
  background: linear-gradient(180deg, #2a2118, #1c1610);
}
.lt-label {
  font-family: var(--serif);
  font-size: 12.5px;
  color: var(--parch);
}
.login-target.active .lt-label {
  color: var(--gold-bright);
}
.lt-hint {
  font-size: 10.5px;
  color: var(--muted);
}
.login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.online-silent {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--gold-dim);
  border-radius: 3px;
  background: rgba(201, 162, 77, 0.06);
  color: var(--gold);
  font-size: 11.5px;
  line-height: 1.7;
}
.online-message {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--gold);
}
.online-error {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(180, 85, 63, 0.45);
  border-radius: 3px;
  background: rgba(180, 85, 63, 0.08);
  color: #d98a72;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.online-note-box {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: #0f0c08;
  color: var(--parch-dim);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  font-family: Consolas, monospace;
}
.online-progress {
  margin-top: 10px;
}
.online-progress .bar {
  height: 6px;
  border-radius: 3px;
  background: #1d1712;
  border: 1px solid var(--line);
  overflow: hidden;
}
.online-progress .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  transition: width 0.2s ease;
}
.online-force {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #d98a72;
}
.raw-details summary {
  cursor: pointer;
  font-family: var(--serif);
  font-size: 11px;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--gold-dim);
  padding: 4px 0;
  list-style: none;
}
.raw-details summary::-webkit-details-marker {
  display: none;
}
.raw-details summary::before {
  content: "▸ ";
  color: var(--gold-dim);
}
.raw-details[open] summary::before {
  content: "▾ ";
}
.raw-details .field {
  margin-top: 2px;
}

/* 右下角轻提示（固定定位，不参与三栏布局） */
.online-toast {
  position: fixed;
  right: 24px;
  bottom: 22px;
  z-index: 60;
  max-width: 420px;
  padding: 9px 14px;
  border-radius: 4px;
  border: 1px solid var(--gold-dim);
  background: linear-gradient(180deg, #241d12, #171208);
  color: var(--parch);
  font-family: var(--serif);
  font-size: 12px;
  letter-spacing: 0.6px;
  line-height: 1.6;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
  animation: toast-in 0.18s ease-out;
  pointer-events: none;
}
.online-toast.error {
  border-color: var(--danger);
  color: #f0d3c8;
  background: linear-gradient(180deg, #2e1a14, #1c110d);
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
