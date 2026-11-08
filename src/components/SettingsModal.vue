<script setup lang="ts">
/**
 * v0.4 独立设置弹窗：通用（语言 + 检查更新）/ 网络（代理 + 记住登录）/ 关于。
 *
 * 代理与语言从原来的「顶栏语言下拉 + 在线页侧栏折叠面板」整体迁移到这里：
 * - 语言：applyLocale 立即生效，再 setLocale 写 settings.json（失败只报错，不回滚 UI）
 * - 代理：复用 set_network_settings（Rust 侧会重建登录窗口让它立即生效）
 *
 * 15 秒冷却：lastCheckMs 放在模块作用域，关掉弹窗再打开也绕不过去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import ConfirmDialog from "./ConfirmDialog.vue";
import {
  appVersion,
  checkUpdate,
  detectGameRoot,
  diagnosticsInfo,
  fetchGithubReleases,
  getSettings,
  openExternalUrl,
  openLogsDir,
  renderReleaseMarkdown,
  setEnableIndexing,
  setEnableLocalSearch,
  setGameRootDir,
  setLocale,
} from "../api";
import type { GithubRelease } from "../api";
import { translateBackendMessage } from "../format";
import { applyLocale, LOCALE_OPTIONS, type Locale } from "../i18n";
import { getNetworkSettings, setNetworkSettings, setRememberLogin } from "../online/service";
import {
  getTranslateSettings,
  setTranslateSettings,
  titleTranslateStart,
  titleTranslateStatus,
  titleTranslateStop,
  translationCacheStat,
} from "../online/service";
import {
  applyTranslateSettings,
  languageName,
} from "../online/translation";
import { localSearchEnabled } from "../sessionState";
import {
  canCheck as modCanCheck,
  checking as modChecking,
  cooldownLeft as modCooldown,
  error as modError,
  report as modReport,
  resumeCooldown as resumeModCooldown,
  runModUpdateCheck,
} from "../modUpdates";
import type { NetworkSettingsView, TitleJobStatus, TranslateSettingsView, TranslationCacheStat } from "../online/types";
import type { DataDirView, UpdateInfo } from "../types";
import { CARD_SIZE_MAX, CARD_SIZE_MIN, CARD_SIZE_STEP, clampCardSize } from "../composables/useViewPrefs";
import {
  CARD_FONT_SIZE_MAX,
  CARD_FONT_SIZE_MIN,
  CARD_FONT_WEIGHT_OPTIONS,
  GLOBAL_SCALE_MAX,
  GLOBAL_SCALE_MIN,
  GLOBAL_SCALE_STEP,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_FONT_WEIGHT_OPTIONS,
  READER_LINE_HEIGHT_OPTIONS,
  TYPOGRAPHY_DEFAULTS,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_WEIGHT_OPTIONS,
  clampCardFontSize,
  clampGlobalScale,
  clampReaderFontSize,
  normalizeReaderFontWeight,
  normalizeReaderLineHeight,
  normalizeCardFontWeight,
  normalizeUiFontWeight,
  type UiFontFamily,
} from "../api";

/** 全局视图偏好：卡片大小与主界面用同一个 v-model（设置里拖完，列表立即跟着变） */
const props = withDefaults(
  defineProps<{
    /** 当前根目录（只用于展示，不参与业务） */
    rootPath?: string;
    /** 打开时直接切到哪个 Tab（顶栏「启动游戏」缺配置时传 general） */
    initialTab?: "general" | "appearance" | "network" | "local" | "online" | "storage" | "about";
    /** 打开后滚动并高亮「游戏根目录」一行 */
    focusGameRoot?: boolean;
  }>(),
  {
    rootPath: "",
    initialTab: "general",
    focusGameRoot: false,
  },
);

const emit = defineEmits<{ close: []; "change-root": [] }>();
const { t, locale } = useI18n();

/**
 * 提示文本统一存「key + 参数」，渲染时才翻译。
 *
 * 为什么不是存翻译结果：ref 里一旦存了译文，切换语言后这段旧文字不会跟着变，
 * 用户就会在英文 / 西语界面里看到上一条中文提示（反馈里的「游戏根目录已保存」
 * 「已保存：127.0.0.1:7897」「已打开日志文件夹」都是这个原因）。
 * string 分支留给后端原始错误串（本身不随界面语言变化）。
 */
type Msg = { key: string; params?: Record<string, unknown> } | string;

function msgText(m: Msg | null | undefined): string {
  if (!m) return "";
  if (typeof m === "string") return m;
  const params: Record<string, unknown> = { ...(m.params ?? {}) };
  // 「直连」也是文案的一部分，同样按当前语言现算
  if (m.key === "online.netSaved" && !params.proxy) params.proxy = t("online.netDirectWord");
  return String(t(m.key, params));
}

type Tab = "general" | "appearance" | "network" | "local" | "online" | "storage" | "about";
const tab = ref<Tab>(props.initialTab);

/** 卡片最小宽度：与主界面滑块、Rust 侧 clamp 同口径 */
const cardSize = defineModel<number>("cardSize", { default: 200 });

/** 界面主题："dark"（默认）| "light"；主界面 App.vue 持有真值并负责落盘 */
const theme = defineModel<string>("theme", { default: "dark" });

/** 主题选项（文案跟随界面语言，不新增 i18n key） */
const THEME_OPTIONS = computed(() => [
  { value: "dark", label: t("settingsUi.themeDark") },
  { value: "light", label: t("settingsUi.themeLight") },
]);

/** 取整到 20 的倍数并夹进 160..=320：与 useViewPrefs / Rust 侧完全一致 */
function snapCardSize() {
  cardSize.value = clampCardSize(Number(cardSize.value));
}

/**
 * v2.4：三层排版（界面 / 正文阅读 / 卡片列表）。
 * 真值由 App.vue 持有，改动会立即写到 <html> 的 CSS 变量上（不重建组件树），
 * 落盘由 App.vue 统一防抖（300ms）调用 api.saveTypographyPrefs。
 */

// 【界面】字体种类 + 界面字重 + 全局缩放
const uiFontFamily = defineModel<UiFontFamily>("uiFontFamily", { default: "hei" });
const uiFontWeight = defineModel<number>("uiFontWeight", { default: 400 });
const globalFontScale = defineModel<number>("globalFontScale", { default: 100 });

// 【正文阅读】字号 + 行距 + 字重
const readerFontSize = defineModel<number>("readerFontSize", { default: 14 });
const readerLineHeight = defineModel<number>("readerLineHeight", { default: 1.6 });
const readerFontWeight = defineModel<number>("readerFontWeight", { default: 400 });

// 【卡片列表】字号 + 字重（v3.3 新增字重）
const cardFontSize = defineModel<number>("cardFontSize", { default: 12 });
const cardFontWeight = defineModel<number>("cardFontWeight", { default: 400 });

/**
 * v3.5：英文界面专用西文字体栈开关。
 * 只对英文界面有意义（中文界面由中文字体优先），所以设置项在中文界面下不渲染，
 * 值本身照常保存，切回英文后仍是用户上次的选择。
 */
const latinFont = defineModel<boolean>("latinFont", { default: true });
/** 当前是否英文界面（决定「西文字体」这一行是否出现） */
const isEnglishUi = computed(() => String(locale.value) === "en");

/** 字体种类下拉项（文案跟随界面语言） */
const FONT_FAMILY_OPTIONS_LABELED = computed(() =>
  UI_FONT_FAMILY_OPTIONS.map((value) => ({
    value,
    label:
      value === "youyuan"
        ? t("settingsUi.fontFamilyYouyuan")
        : value === "system"
          ? t("settingsUi.fontFamilySystem")
          : value === "serif"
            ? t("settingsUi.fontFamilySerif")
            : t("settingsUi.fontFamilyHei"),
  })),
);

/** 字重档位的文案（400 常规 / 700 加粗） */
function weightLabel(value: number): string {
  return value >= 700 ? t("settingsUi.weightBold") : t("settingsUi.weightNormal");
}

/** 行距档位的文案（1.4 紧凑 / 1.6 标准 / 1.8 宽松） */
function lineHeightLabel(value: number): string {
  return value === 1.4
    ? t("settingsUi.lineHeightCompact")
    : value === 1.8
      ? t("settingsUi.lineHeightLoose")
      : t("settingsUi.lineHeightStandard");
}

/** 在固定档位序列里左 / 右挪一格；到头就停住（按钮同时 disabled） */
function stepBy(current: number, options: readonly number[], dir: -1 | 1): number {
  const idx = options.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = Math.min(options.length - 1, Math.max(0, base + dir));
  return options[next] ?? current;
}

function stepUiFontWeight(dir: -1 | 1) {
  uiFontWeight.value = normalizeUiFontWeight(stepBy(uiFontWeight.value, UI_FONT_WEIGHT_OPTIONS, dir));
}
function stepLineHeight(dir: -1 | 1) {
  readerLineHeight.value = normalizeReaderLineHeight(
    stepBy(readerLineHeight.value, READER_LINE_HEIGHT_OPTIONS, dir),
  );
}
function stepReaderFontWeight(dir: -1 | 1) {
  readerFontWeight.value = normalizeReaderFontWeight(
    stepBy(readerFontWeight.value, READER_FONT_WEIGHT_OPTIONS, dir),
  );
}
function stepCardFontWeight(dir: -1 | 1) {
  cardFontWeight.value = normalizeCardFontWeight(
    stepBy(cardFontWeight.value, CARD_FONT_WEIGHT_OPTIONS, dir),
  );
}

/** 「高级排版」是否展开：默认收起，外观页首屏只留字体种类 + 界面字重 */
const showAdvancedTypography = ref(false);

/** 滑块松手时夹回合法档位（拖动过程中已经是合法值，这里只是兑底） */
function snapGlobalScale() {
  globalFontScale.value = clampGlobalScale(Number(globalFontScale.value));
}
function snapReaderFontSize() {
  readerFontSize.value = clampReaderFontSize(Number(readerFontSize.value));
}
function snapCardFontSize() {
  cardFontSize.value = clampCardFontSize(Number(cardFontSize.value));
}

/** 下拉框回写的值再归一化一次：坏值一律改成最近的合法档位 */
function applyFontFamily(event: Event) {
  const raw = (event.target as HTMLSelectElement).value;
  uiFontFamily.value = (
    UI_FONT_FAMILY_OPTIONS as readonly string[]
  ).includes(raw)
    ? (raw as UiFontFamily)
    : "hei";
}

/** 恢复默认排版的二次确认开关 */
const showResetConfirm = ref(false);

/**
 * 恢复默认排版：只重置「字体种类 / 界面字重 / 缩放 / 正文字号·行距·字重 / 卡片字号·字重 /
 * 英文西文栈开关」九个排版变量；卡片大小（cardSize）与主题模式（theme）不在其中，绝不会被误伤。
 * 九个值一次性同步赋值 → App.vue 的 watch 会合并成一次 300ms 防抖写盘。
 */
function resetTypography() {
  uiFontFamily.value = TYPOGRAPHY_DEFAULTS.fontFamily;
  uiFontWeight.value = TYPOGRAPHY_DEFAULTS.uiFontWeight;
  globalFontScale.value = TYPOGRAPHY_DEFAULTS.globalScale;
  readerFontSize.value = TYPOGRAPHY_DEFAULTS.readerFontSize;
  readerLineHeight.value = TYPOGRAPHY_DEFAULTS.readerLineHeight;
  readerFontWeight.value = TYPOGRAPHY_DEFAULTS.readerFontWeight;
  cardFontSize.value = TYPOGRAPHY_DEFAULTS.cardFontSize;
  cardFontWeight.value = TYPOGRAPHY_DEFAULTS.cardFontWeight;
  latinFont.value = TYPOGRAPHY_DEFAULTS.latinFont;
  showResetConfirm.value = false;
}

const REPO_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager";
/** 反馈入口：GitHub Issues（原「作者主页」链接按用户要求下线，替换为反馈入口） */
const ISSUES_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager/issues";
/** 蓝奏云网盘（备用下载 / 资源）：界面上不显示明文链接，只能点按钮走系统浏览器 */
const LANZOU_URL = "https://wwblm.lanzouv.com/b01i5yfj5e";

function describe(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return String(e);
  }
}

// ---------------- 通用：语言 ----------------

const currentLocale = computed(() => String(locale.value));
const localeSaving = ref(false);
const localeError = ref<string | null>(null);

async function changeLocale(event: Event) {
  const next = (event.target as HTMLSelectElement).value as Locale;
  // 先切 UI（立即生效），再落盘；写盘失败只提示，不把界面弹回去
  applyLocale(next);
  localeSaving.value = true;
  localeError.value = null;
  try {
    await setLocale(next);
  } catch (e) {
    localeError.value = describe(e);
  } finally {
    localeSaving.value = false;
  }
}

// ---------------- 通用：本地中文搜索与自动索引（v1.2） ----------------

/** 开关状态：默认关闭（settings.json 缺字段也是 false） */
const indexingEnabled = ref(false);
const indexingSaving = ref(false);
const indexingError = ref<string | null>(null);

async function loadIndexing() {
  try {
    const settings = await getSettings();
    indexingEnabled.value = settings.enableIndexing === true;
  } catch (e) {
    indexingError.value = describe(e);
  }
}

/**
 * 切换开关：先切界面再落盘（失败回滚）。
 * 开启 = Rust 立即在后台补建一次索引；关闭 = 本轮爬取在下一页之前停下。
 */
async function toggleIndexing(event: Event) {
  const next = (event.target as HTMLInputElement).checked;
  indexingEnabled.value = next;
  indexingSaving.value = true;
  indexingError.value = null;
  try {
    await setEnableIndexing(next);
  } catch (e) {
    indexingEnabled.value = !next;
    indexingError.value = describe(e);
  } finally {
    indexingSaving.value = false;
  }
}

// ---------------- 通用：在线页的本地搜索框（v1.2） ----------------

const localSearchOn = ref(false);
const localSearchSaving = ref(false);
const localSearchError = ref<string | null>(null);

async function loadLocalSearch() {
  try {
    const settings = await getSettings();
    localSearchOn.value = settings.enableLocalSearch === true;
  } catch (e) {
    localSearchError.value = describe(e);
  }
}

/** 纯界面开关：写 settings.json + 同步运行时镜像（在线页立即生效） */
async function toggleLocalSearch(event: Event) {
  const next = (event.target as HTMLInputElement).checked;
  localSearchOn.value = next;
  localSearchSaving.value = true;
  localSearchError.value = null;
  try {
    await setEnableLocalSearch(next);
    localSearchEnabled.value = next;
  } catch (e) {
    localSearchOn.value = !next;
    localSearchError.value = describe(e);
  } finally {
    localSearchSaving.value = false;
  }
}

// ---------------- 通用：版本 + 检查更新 ----------------

const version = ref("—");
const currentVersionText = computed(() => t("settings.currentVersion", { version: version.value }));

/** 冷却时长：15 秒内不允许再次请求 GitHub（同时防止 403 限流） */
const COOLDOWN_MS = 15_000;
/** 模块作用域：弹窗关闭再打开仍然记住上次检查时间 */
let lastCheckMs = 0;

const checking = ref(false);
const checkError = ref<string | null>(null);
const latest = ref<UpdateInfo | null>(null);
const cooldownLeft = ref(0);
let cooldownTimer: number | null = null;

const canCheck = computed(() => !checking.value && cooldownLeft.value === 0);
const hasUpdate = computed(() => latest.value?.hasUpdate === true);

/** 冷却倒计时：250ms 一跳，归零后自动清掉定时器 */
function startCooldownTimer() {
  const tick = () => {
    const left = COOLDOWN_MS - (Date.now() - lastCheckMs);
    if (left <= 0) {
      cooldownLeft.value = 0;
      if (cooldownTimer !== null) {
        window.clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      return;
    }
    cooldownLeft.value = Math.ceil(left / 1000);
  };
  if (cooldownTimer !== null) window.clearInterval(cooldownTimer);
  tick();
  if (cooldownLeft.value > 0) cooldownTimer = window.setInterval(tick, 250);
}

/** 成功或失败都进冷却：GitHub 匿名接口被刷会直接 403 */
function enterCooldown() {
  lastCheckMs = Date.now();
  startCooldownTimer();
}

/** 状态机文案：idle → loading → cooldown（✓已是最新）/ error */
const checkStatusText = computed(() => {
  if (checking.value) return t("settings.checking");
  if (checkError.value) return checkError.value;
  if (latest.value?.hasUpdate) return t("settings.found", { version: latest.value.latestVersion });
  if (cooldownLeft.value > 0) return t("settings.cooldown", { s: cooldownLeft.value });
  if (latest.value) return t("settings.upToDate");
  return t("settings.checkIdle");
});

async function runCheck() {
  if (!canCheck.value) return;
  checking.value = true;
  checkError.value = null;
  latest.value = null;
  try {
    const info = await checkUpdate();
    latest.value = info;
    version.value = info.currentVersion || version.value;
    enterCooldown();
    // 手动点“检查更新”属于明确意图：发现新版本就直接拉起系统浏览器
    if (info.hasUpdate) {
      try {
        await openExternalUrl(info.releaseUrl);
      } catch (e) {
        checkError.value = describe(e);
      }
    }
  } catch (e) {
    checkError.value = describe(e);
    enterCooldown();
  } finally {
    checking.value = false;
  }
}

async function openRelease() {
  const url = latest.value?.releaseUrl ?? `${REPO_URL}/releases/latest`;
  try {
    await openExternalUrl(url);
  } catch (e) {
    checkError.value = describe(e);
  }
}

async function openRepo() {
  try {
    await openExternalUrl(REPO_URL);
  } catch (e) {
    checkError.value = describe(e);
  }
}

async function openIssues() {
  try {
    await openExternalUrl(ISSUES_URL);
  } catch (e) {
    checkError.value = describe(e);
  }
}

// ---------------- 关于：蓝奏云网盘 + GitHub 更新历史（v3.1） ----------------

/** 蓝奏云备用下载：地址不进界面，错误统一进关于页的提示行 */
async function openCloud() {
  try {
    await openExternalUrl(LANZOU_URL);
  } catch (e) {
    checkError.value = describe(e);
  }
}

/** 更新历史：第一次展开才拉取，之后本地缓存（不重复消耗 GitHub 匿名配额） */
const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref<string | null>(null);
const history = ref<GithubRelease[]>([]);
let historyLoaded = false;

async function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  if (!historyOpen.value) return;
  if (historyLoaded || historyLoading.value) return;
  await loadHistory();
}

async function loadHistory() {
  historyLoading.value = true;
  historyError.value = null;
  try {
    const list = await fetchGithubReleases();
    // 后端已按发布时间倒序；这里再兜一次，避免 JSON 顺序异常
    history.value = [...list].sort((a, b) =>
      String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")),
    );
    historyLoaded = true;
  } catch (e) {
    historyError.value = describe(e);
  } finally {
    historyLoading.value = false;
  }
}

/** ISO8601 → 本地 YYYY-MM-DD（解析失败就直接截前 10 位） */
function formatReleaseDate(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw.slice(0, 10);
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------- 关于：本地日志 + 复制诊断信息给 AI（v0.4.5） ----------------

/** 用户填写的问题描述（可空，空则用默认文案） */
const diagProblem = ref("");
const diagBusy = ref(false);
const diagError = ref<Msg | null>(null);
const diagMessage = ref<Msg | null>(null);
/** 「已复制」提示弹窗 */
const diagCopied = ref(false);

/**
 * 写系统剪贴板。
 *
 * 优先用 WebView2 的 Clipboard API（tauri.localhost 属安全上下文，用户手势下可用）；
 * 失败再退回 textarea + execCommand，保底不出现「点了没反应」。
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略，走下面的兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 打开日志文件夹：目录由后端创建并拉起资源管理器 */
async function openLogsFolder() {
  diagError.value = null;
  diagMessage.value = null;
  try {
    const path = await openLogsDir();
    diagMessage.value = { key: "settings.diagOpenLogsDone", params: { path } };
  } catch (e) {
    diagError.value = describe(e);
  }
}

/** 拼 Prompt → 写剪贴板 → 弹「已复制」引导 */
async function copyDiagnostics() {
  diagBusy.value = true;
  diagError.value = null;
  diagMessage.value = null;
  try {
    const info = await diagnosticsInfo();
    const problem = diagProblem.value.trim() || t("settings.diagProblemFallback");
    const logs = info.logLines.length
      ? info.logLines.join("\n")
      : t("settings.diagNoLog");
    const text = t("settings.diagPrompt", {
      version: info.version,
      problem,
      os: info.os,
      logFile: info.logFile || info.logDir,
      logs,
    });
    const ok = await copyTextToClipboard(text);
    if (!ok) {
      diagError.value = { key: "settings.diagCopyFailed", params: { error: "clipboard rejected" } };
      return;
    }
    diagCopied.value = true;
  } catch (e) {
    diagError.value = { key: "settings.diagCopyFailed", params: { error: describe(e) } };
  } finally {
    diagBusy.value = false;
  }
}

// ---------------- 通用：本地模组批量更新检测（用户点击才触发） ----------------

const modStatusText = computed(() => {
  if (modChecking.value) return t("settings.modUpdateChecking");
  if (modError.value) return modError.value;
  const rep = modReport.value;
  if (!rep) return t("settings.modUpdateIdle");
  const base =
    rep.updateCount > 0
      ? t("settings.modUpdateResult", {
          n: rep.updateCount,
          total: rep.totalLocal,
          pages: rep.pages,
        })
      : t("settings.modUpdateAllCurrent", { total: rep.totalLocal, pages: rep.pages });
  const unknown =
    rep.unknownCount > 0 ? ` ${t("settings.modUpdateUnknown", { n: rep.unknownCount })}` : "";
  const cooldown =
    modCooldown.value > 0 ? ` ${t("settings.modUpdateCooldown", { s: modCooldown.value })}` : "";
  return `${base}${unknown}${cooldown}`;
});

async function runModCheck() {
  await runModUpdateCheck();
}

// ---------------- 网络：代理 + 记住登录 ----------------

const netView = ref<NetworkSettingsView | null>(null);
const netAuto = ref(true);
const netUrl = ref("");
const netRemember = ref(false);
const netSaving = ref(false);
const netError = ref<string | null>(null);
const netMessage = ref<Msg | null>(null);
const netLoading = ref(false);

// ---------------- 通用：字节数格式化（数据目录体积等共用） ----------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// ---------------- v1.x：数据与缓存总目录（设置 → 缓存与存储） ----------------
//
// 心智模型：图片/在线数据/索引/译文/收藏/预设/队列/登录凭证共用一个根目录。
// 前端只负责展示与触发；路径裁决、目标体检、迁移与回滚全在 Rust（data_dir.rs）。

const dataDirView = ref<DataDirView | null>(null);
const dataDirBusy = ref(false);
const dataDirMessage = ref<Msg | null>(null);
const dataDirError = ref<Msg | null>(null);
/** 已选好、等待二次确认的目标目录（null = 没有待确认的迁移） */
const migrateTarget = ref<string | null>(null);
const migrateError = ref<string | null>(null);

const dataDirSizeText = computed(() => {
  const view = dataDirView.value;
  if (!view) return t("cache.reading");
  const total = t("settings.dataDirSize", { size: formatBytes(view.totalBytes) });
  return view.imagesBytes > 0
    ? total + " · " + t("settings.dataDirImageSize", { size: formatBytes(view.imagesBytes) })
    : total;
});

async function loadDataDir() {
  try {
    dataDirView.value = await invoke<DataDirView>("data_dir_view");
  } catch {
    dataDirView.value = null;
  }
}

/** 打开目录：Rust 用 explorer.exe 拉起，目录不存在会先建出来 */
async function openDataDir() {
  if (dataDirBusy.value) return;
  dataDirError.value = null;
  dataDirMessage.value = null;
  try {
    await invoke<string>("open_data_dir");
  } catch (e) {
    dataDirError.value = { key: "settings.dataDirFailed", params: { msg: describe(e) } };
  }
}

/**
 * 迁移第一步：只选目录，**不立刻搬**。
 * 迁移含 session.bin（登录凭证）等敏感文件，必须先经过二次确认弹窗。
 */
async function migrateDataDir() {
  if (dataDirBusy.value || migrateTarget.value) return;
  dataDirError.value = null;
  dataDirMessage.value = null;
  migrateError.value = null;
  try {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: t("settings.dataDirPickTitle"),
      defaultPath: dataDirView.value?.path || undefined,
    });
    if (typeof picked !== "string" || !picked) return; // 用户取消
    migrateTarget.value = picked;
  } catch (e) {
    dataDirError.value = { key: "settings.dataDirFailed", params: { msg: describe(e) } };
  }
}

function cancelMigrate() {
  if (dataDirBusy.value) return;
  migrateTarget.value = null;
  migrateError.value = null;
}

/** 迁移第二步：用户确认后才真正执行；Rust 侧任何失败都会自动回滚并回传原因 */
async function runMigrate() {
  const target = migrateTarget.value;
  if (!target || dataDirBusy.value) return;
  dataDirBusy.value = true;
  dataDirError.value = null;
  dataDirMessage.value = null;
  migrateError.value = null;
  try {
    const view = await invoke<DataDirView>("migrate_data_dir", { newPath: target });
    dataDirView.value = view;
    dataDirMessage.value = { key: "settings.dataDirMigrated", params: { path: view.path } };
    migrateTarget.value = null;
    // 卡片上的封面 URL 是按旧目录拼的，重载一次让它们全部指向新目录
    // （确认弹窗本来就承诺「迁移后会重新加载」）
    window.setTimeout(() => window.location.reload(), 600);
  } catch (e) {
    // Rust 已给出中文原因（含「已回滚」与回滚失败清单），留在弹窗里展示
    migrateError.value = describe(e);
    void loadDataDir();
  } finally {
    dataDirBusy.value = false;
  }
}

// ---------------- v3.3：游戏根目录（启动游戏走 Steam 协议） ----------------

/** 当前配置的游戏根目录（null = 未配置）；保存后以后端回传的 Settings 为准 */
const gameRoot = ref<string | null>(null);
const gameRootBusy = ref(false);
const gameRootMessage = ref<Msg | null>(null);
const gameRootError = ref<Msg | null>(null);
/** 从顶栏「启动游戏」跳过来时，短暂高亮这一行 */
const gameRootFlash = ref(false);
const gameRootRow = ref<HTMLElement | null>(null);
const gameRootBtn = ref<HTMLButtonElement | null>(null);
let gameRootFlashTimer: number | null = null;

function clearGameRootFlash(): void {
  if (gameRootFlashTimer !== null) {
    window.clearTimeout(gameRootFlashTimer);
    gameRootFlashTimer = null;
  }
  gameRootFlash.value = false;
}

/** 滚到「游戏根目录」一行并高亮 2 秒，告诉用户「就是这里」 */
async function focusGameRootRow(): Promise<void> {
  tab.value = "general";
  await nextTick();
  gameRootRow.value?.scrollIntoView({ block: "center", behavior: "smooth" });
  gameRootBtn.value?.focus({ preventScroll: true });
  clearGameRootFlash();
  gameRootFlash.value = true;
  gameRootFlashTimer = window.setTimeout(() => {
    gameRootFlash.value = false;
    gameRootFlashTimer = null;
  }, 2000);
}

async function loadGameRoot(): Promise<void> {
  try {
    const settings = await getSettings();
    gameRoot.value = settings.gameRootDir ?? null;
  } catch {
    gameRoot.value = null;
  }
}

/** 选择文件夹 → 后端校验（必须有 AoE2DE_s.exe）并落盘；取消 / 校验失败都不改配置 */
async function pickGameRoot(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  try {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: t("settings.gameRootPickTitle"),
      defaultPath: gameRoot.value ?? undefined,
    });
    if (typeof picked !== "string" || !picked) return; // 用户取消
    gameRootBusy.value = true;
    const saved = await setGameRootDir(picked);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootSaved" };
  } catch (e) {
    gameRootError.value = describe(e);
  } finally {
    gameRootBusy.value = false;
  }
}

/** 自动检测：复用 Rust 的 detect_game_exe（Steam 库 / 注册表 / 盘符），命中后直接保存 */
async function detectGameRootDir(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  gameRootBusy.value = true;
  try {
    const found = await detectGameRoot();
    if (!found) {
      gameRootError.value = { key: "settings.gameRootDetectFailed" };
      return;
    }
    const saved = await setGameRootDir(found);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootSaved" };
  } catch (e) {
    gameRootError.value = describe(e);
  } finally {
    gameRootBusy.value = false;
  }
}

/** 清除配置：写回 null，不动任何游戏文件 */
async function clearGameRoot(): Promise<void> {
  if (gameRootBusy.value) return;
  gameRootError.value = null;
  gameRootMessage.value = null;
  gameRootBusy.value = true;
  try {
    const saved = await setGameRootDir(null);
    gameRoot.value = saved.gameRootDir ?? null;
    gameRootMessage.value = { key: "settings.gameRootCleared" };
  } catch (e) {
    gameRootError.value = describe(e);
  } finally {
    gameRootBusy.value = false;
  }
}

/** 弹窗已经打开时再次请求聚焦（例如用户又点了一次「启动游戏」） */
watch(
  () => props.focusGameRoot,
  (next) => {
    if (next) void focusGameRootRow();
  },
);

/** 折叠面板里那句“当前走哪条链路” *//** 折叠面板里那句“当前走哪条链路” */
const netSummary = computed(() => {
  const view = netView.value;
  if (!view) return t("online.netReading");
  if (view.error) return t("online.netConfigError");
  const proxy = view.effectiveProxy;
  switch (view.source) {
    case "manual":
      return t("online.netManual", { proxy: proxy ?? t("online.netNotSet") });
    case "system":
      return t("online.netSystem", { proxy: proxy ?? t("online.netDirectWord") });
    case "env":
      return t("online.netEnv", { proxy: proxy ?? t("online.netUnknownWord") });
    default:
      return t("online.netDirect");
  }
});

async function loadNetwork() {
  netLoading.value = true;
  netError.value = null;
  try {
    const view = await getNetworkSettings();
    netView.value = view;
    netAuto.value = view.auto;
    netRemember.value = view.rememberLogin;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? view.effectiveProxy ?? "");
    if (view.error) netError.value = view.error;
  } catch (e) {
    netError.value = describe(e);
  } finally {
    netLoading.value = false;
  }
}

/**
 * 「记住登录 7 天」开关：改动立即落库（`set_remember_login` 只写配置，
 * 真正的 Cookie 门控在 Rust 侧），不依赖后面的「保存」按钮。
 */
async function applyRememberLogin() {
  if (netSaving.value) return;
  netError.value = null;
  netMessage.value = null;
  try {
    const enabled = await setRememberLogin(netRemember.value);
    netRemember.value = enabled;
    netMessage.value = { key: enabled ? "online.rememberOn" : "online.rememberOff" };
  } catch (e) {
    netError.value = describe(e);
  }
}

async function saveNetwork() {
  if (netSaving.value) return;
  netSaving.value = true;
  netError.value = null;
  netMessage.value = null;
  try {
    const view = await setNetworkSettings({
      auto: netAuto.value,
      proxyUrl: netAuto.value ? null : netUrl.value.trim(),
      rememberLogin: netRemember.value,
    });
    netView.value = view;
    netUrl.value = view.auto ? "" : (view.proxyUrl ?? "");
    if (view.error) {
      netError.value = view.error;
    } else {
      netMessage.value = {
        key: "online.netSaved",
        params: { proxy: view.effectiveProxy ?? "" },
      };
    }
  } catch (e) {
    netError.value = describe(e);
  } finally {
    netSaving.value = false;
  }
}

// ---------------- 翻译（目标语言 / 引擎 / 缓存） ----------------

const translateView = ref<TranslateSettingsView | null>(null);
const translateLoading = ref(false);
const translateSaving = ref(false);
const translateError = ref<Msg | null>(null);
const translateMessage = ref<Msg | null>(null);

/** 下拉框的值："" = 跟随界面语言 */
const targetChoice = ref("");
const engineChoice = ref("auto");

// ---------------- 翻译缓存（只读统计：不再提供前端清空入口） ----------------

const translationCache = ref<TranslationCacheStat | null>(null);

const supportedLangs = computed<string[]>(
  () => translateView.value?.supportedLanguages ?? ["zh-cn", "zh-tw", "en", "ja", "ko", "ru", "fr", "de", "es"],
);

/** 当前实际生效的语言名（跟随模式会随 UI 语言提示） */
const effectiveTargetLabel = computed(() =>
  languageName(translateView.value?.resolvedLanguage ?? "zh-cn"),
);

/** 下拉候选：Rust 预设列表 + 已保存但不在预设里的自定义值（防止回显成空白项） */
const targetOptions = computed<string[]>(() => {
  const list = [...supportedLangs.value];
  const saved = (translateView.value?.targetLanguage ?? "").trim();
  if (saved && !list.includes(saved)) list.push(saved);
  return list;
});

/** 上一次**成功落盘**的值：切换失败时用它把下拉框退回去 */
const savedTargetChoice = ref("");
const savedEngineChoice = ref("auto");

/** 两个下拉框的 DOM 引用：Vue 只在 ref 变化时回写 value，回退时需要显式对齐 */
const targetSelect = ref<HTMLSelectElement | null>(null);
const engineSelect = ref<HTMLSelectElement | null>(null);

function syncSelectDom() {
  if (targetSelect.value) targetSelect.value.value = targetChoice.value;
  if (engineSelect.value) engineSelect.value.value = engineChoice.value;
}

const translationCacheText = computed(() => {
  const stat = translationCache.value;
  if (!stat) return t("translateCache.reading");
  if (stat.entries <= 0) return t("translateCache.empty");
  const langs = stat.byLanguage
    .map((item) => `${languageName(item.lang)} ${item.count}`)
    .join(" · ");
  return t("translateCache.stat", {
    n: stat.entries,
    mods: stat.mods,
    size: formatBytes(stat.bytes),
    langs,
  });
});

function pickSelect(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

/**
 * 引擎下拉只剩 Auto / Google：历史配置里的 mymemory 一律按「自动」显示
 * （auto 在直连时本来就走 MyMemory，实际行为不变）。
 */
function engineForSelect(provider: string): string {
  return provider.trim().toLowerCase() === "google" ? "google" : "auto";
}

async function loadTranslate() {
  translateLoading.value = true;
  translateError.value = null;
  try {
    const view = await getTranslateSettings();
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = engineForSelect(view.provider);
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = engineForSelect(view.provider);
  } catch (e) {
    translateError.value = describe(e);
  } finally {
    translateLoading.value = false;
  }
}

/**
 * 保存并**立即生效**：解析出具体语言、清空预热，列表会自己重新接缓存。
 * 返回 true = 已落盘；false = 失败（调用方负责把下拉框退回旧值）。
 */
async function saveTranslate(): Promise<boolean> {
  if (translateSaving.value) return false;
  translateSaving.value = true;
  translateError.value = null;
  translateMessage.value = null;
  try {
    const view = await setTranslateSettings({
      targetLanguage: targetChoice.value,
      provider: engineChoice.value,
      // 自定义接口已下线：仍传 null，Rust 命令签名保持不变
      customUrl: null,
      customKey: null,
    });
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = engineForSelect(view.provider);
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = engineForSelect(view.provider);
    // 全局状态：立即更新 targetLang + langEpoch++，详情页/列表按钮文案同步刷新
    applyTranslateSettings(view, String(locale.value));
    translateMessage.value = { key: "settings.translateSaved" };
    return true;
  } catch (e) {
    translateError.value = describe(e);
    return false;
  } finally {
    translateSaving.value = false;
  }
}

/**
 * 下拉框**即时保存**：改完立刻落盘 + 同步全局状态。
 * 失败（写盘异常 / 后端拒绝）→ 把两个下拉框都退回上次成功的值，界面与磁盘保持一致。
 */
async function commitTranslate(pick: "target" | "engine", next: string) {
  // 上一次保存还没回来：忽略这次切换，并把下拉框的 DOM 值退回当前状态
  if (translateSaving.value) {
    syncSelectDom();
    return;
  }
  if (pick === "target") targetChoice.value = next;
  else engineChoice.value = next;
  const prevTarget = savedTargetChoice.value;
  const prevEngine = savedEngineChoice.value;
  const ok = await saveTranslate();
  if (ok) return;
  // 回退：下拉框回到上一次成功保存的值，并在下方显示错误
  targetChoice.value = prevTarget;
  engineChoice.value = prevEngine;
  await nextTick();
  syncSelectDom();
  translateError.value = { key: "favorites.failSave", params: { msg: msgText(translateError.value) } };
}

function onTargetChange(event: Event) {
  void commitTranslate("target", pickSelect(event));
}

function onEngineChange(event: Event) {
  void commitTranslate("engine", pickSelect(event));
}

async function loadTranslationCache() {
  try {
    translationCache.value = await translationCacheStat();
  } catch {
    translationCache.value = null;
  }
}

// ---------------- 生命周期 ----------------

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

// ---------------- v1.0：批量标题翻译（索引里的英文标题 → 当前目标语言） ----------------
//
// 刻意**不做自动启动**：与「一键翻译只由用户点击触发」的既有铁律一致。
// 任务本身跑在 Rust 后台线程里，这里只负责展示进度与开始/停止。

const titleJob = ref<TitleJobStatus | null>(null);
const titleJobBusy = ref(false);
const titleJobError = ref<string | null>(null);
/** 进度轮询（运行中每 2 秒刷一次，纯内存读，开销可忽略） */
let titleJobTimer: number | null = null;

function stopTitleJobPoll(): void {
  if (titleJobTimer !== null) {
    window.clearInterval(titleJobTimer);
    titleJobTimer = null;
  }
}

function scheduleTitleJobPoll(): void {
  if (titleJobTimer !== null) return;
  titleJobTimer = window.setInterval(() => {
    void (async () => {
      try {
        titleJob.value = await titleTranslateStatus();
      } catch {
        return;
      }
      if (!titleJob.value?.running) stopTitleJobPoll();
    })();
  }, 2000);
}

async function loadTitleJob(): Promise<void> {
  try {
    titleJob.value = await titleTranslateStatus();
    titleJobError.value = null;
  } catch (e) {
    titleJobError.value = describe(e);
  }
  if (titleJob.value?.running) scheduleTitleJobPoll();
}

async function startTitleJob(): Promise<void> {
  if (titleJobBusy.value) return;
  titleJobBusy.value = true;
  titleJobError.value = null;
  try {
    titleJob.value = await titleTranslateStart();
    scheduleTitleJobPoll();
  } catch (e) {
    titleJobError.value = describe(e);
  } finally {
    titleJobBusy.value = false;
  }
}

async function stopTitleJob(): Promise<void> {
  try {
    titleJob.value = await titleTranslateStop();
  } catch (e) {
    titleJobError.value = describe(e);
  }
  stopTitleJobPoll();
}

/** 进度文案：只讲结论，不展示底层术语 */
const titleJobText = computed(() => {
  const job = titleJob.value;
  if (!job) return t("titleTranslate.reading");
  if (!job.indexReady) return t("titleTranslate.needIndex");
  const base = job.running
    ? t("titleTranslate.running", { done: job.done, total: job.total })
    : t("titleTranslate.idle", { done: job.done, total: job.total });
  return job.failed > 0 ? `${base} · ${t("titleTranslate.failed", { n: job.failed })}` : base;
});

// ---------------- v3.4：设置改为可拖动浮动面板（去掉全屏遮罩，主界面可继续操作） ----------------
//
// 面板不再铺满遮罩：只把 .modal 本体固定在视口上，标题栏可拖，
// 位置写进 localStorage，下次打开回到原处；拖出屏幕时按视口夹紧。

const PANEL_POS_KEY = "aoe2mm:settings-panel-pos";
/** 面板左上角（px）。null = 没拖过，走 CSS 的居中定位 */
const panelPos = ref<{ x: number; y: number } | null>(null);
const dragging = ref(false);
const panelRef = ref<HTMLElement | null>(null);

const panelStyle = computed<Record<string, string>>((): Record<string, string> => {
  const pos = panelPos.value;
  if (!pos) return {};
  return { left: `${pos.x}px`, top: `${pos.y}px`, transform: "none" };
});

const PANEL_MARGIN = 8;

/** 夹在视口内，四边各留 8px，避免拖到屏幕外面找不回来 */
function clampPanelPos(x: number, y: number): { x: number; y: number } {
  const rect = panelRef.value?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  const maxX = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

let dragOrigin = { pointerX: 0, pointerY: 0, panelX: 0, panelY: 0 };

function onDragStart(event: PointerEvent) {
  if (event.button !== 0) return;
  // 标题栏上的关闭按钮不该把面板拖起来
  if ((event.target as HTMLElement).closest("button")) return;
  const rect = panelRef.value?.getBoundingClientRect();
  if (!rect) return;
  dragOrigin = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    panelX: rect.left,
    panelY: rect.top,
  };
  dragging.value = true;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  event.preventDefault();
}

function onDragMove(event: PointerEvent) {
  panelPos.value = clampPanelPos(
    dragOrigin.panelX + (event.clientX - dragOrigin.pointerX),
    dragOrigin.panelY + (event.clientY - dragOrigin.pointerY),
  );
}

function onDragEnd() {
  dragging.value = false;
  window.removeEventListener("pointermove", onDragMove);
  if (!panelPos.value) return;
  try {
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos.value));
  } catch {
    /* 存储不可用就只保留本次会话的位置 */
  }
}

/** 打开时恢复上次位置（脏数据直接忽略，不影响打开） */
function restorePanelPos() {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof saved.x !== "number" || typeof saved.y !== "number") return;
    panelPos.value = clampPanelPos(saved.x, saved.y);
  } catch {
    /* 位置记忆损坏不阻塞设置面板 */
  }
}

/** 窗口尺寸变小后，原来记的位置可能越界，重新夹紧 */
function onWindowResize() {
  if (panelPos.value) panelPos.value = clampPanelPos(panelPos.value.x, panelPos.value.y);
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  restorePanelPos();
  void loadIndexing();
  void loadLocalSearch();
  void loadNetwork();
  void loadDataDir();
  void loadGameRoot();
  void loadTranslate();
  void loadTranslationCache();
  void loadTitleJob();
  try {
    version.value = await appVersion();
  } catch {
    /* 版本号拿不到就保持占位符，不影响其它功能 */
  }
  // 上次检查还在冷却期内：接着倒计时，按钮保持禁用
  if (lastCheckMs > 0 && Date.now() - lastCheckMs < COOLDOWN_MS) startCooldownTimer();
  // 模组批量检测的冷却同样跨弹窗保留
  resumeModCooldown();
  // 从顶栏「启动游戏」跳过来：滚动到「游戏根目录」一行并高亮
  if (props.focusGameRoot) void focusGameRootRow();
});

onBeforeUnmount(() => {
  clearGameRootFlash();
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("pointermove", onDragMove);
  stopTitleJobPoll();
  if (cooldownTimer !== null) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
});
</script>

<template>
  <div
    ref="panelRef"
    class="modal settings-modal settings-floating"
    :class="{ 'is-dragging': dragging }"
    :style="panelStyle"
  >
    <header class="modal-head settings-drag-handle" @pointerdown="onDragStart">
      <h2>{{ t("settings.title") }}</h2>
      <span class="modal-sub">{{ t("settings.subtitle") }}</span>
      <button type="button" class="modal-x" :title="t('settings.close')" @click="emit('close')">
        ✕
      </button>
    </header>

      <div class="settings-layout">
        <nav class="settings-tabs">
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'general' }"
            @click="tab = 'general'"
          >
            ⚙ {{ t("settings.tabGeneral") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'appearance' }"
            @click="tab = 'appearance'"
          >
            🎨 {{ t("settingsUi.tabAppearance") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'network' }"
            @click="tab = 'network'"
          >
            🌐 {{ t("settings.tabNetwork") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'local' }"
            @click="tab = 'local'"
          >
            🧩 {{ t("nav.local") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'online' }"
            @click="tab = 'online'"
          >
            ☁ {{ t("settings.tabTranslate") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'storage' }"
            @click="tab = 'storage'"
          >
            🗂 {{ t("settings.tabStorage") }}
          </button>
          <button
            type="button"
            class="settings-tab"
            :class="{ active: tab === 'about' }"
            @click="tab = 'about'"
          >
            ℹ {{ t("settings.tabAbout") }}
          </button>
        </nav>

        <div class="settings-pane">
          <!-- 通用 -->
          <section v-if="tab === 'general'" class="settings-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.language") }}</span>
                <span class="row-note">{{ t("settings.languageNote") }}</span>
              </div>
              <select
                class="settings-select"
                :value="currentLocale"
                :disabled="localeSaving"
                :aria-label="t('settings.language')"
                @change="changeLocale"
              >
                <option v-for="option in LOCALE_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="localeError" class="settings-msg error">{{ localeError }}</div>

            <div class="settings-sep"></div>

            <!-- v2.1：模组根目录从「外观」搬回「通用」 -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settingsUi.rootTitle") }}</span>
                <span class="row-note mono">{{ props.rootPath || t("settingsUi.rootEmpty") }}</span>
              </div>
              <button type="button" class="settings-check" @click="emit('change-root')">
                {{ t("settingsUi.changeRoot") }}
              </button>
            </div>

            <p class="settings-hint">{{ t("settingsUi.rootNote") }}</p>

            <div class="settings-sep"></div>

            <!-- v3.3：游戏根目录 —— 「启动游戏」走 Steam 协议，必须知道游戏装在哪 -->
            <div
              ref="gameRootRow"
              class="settings-row game-root-row"
              :class="{ 'game-root-flash': gameRootFlash }"
            >
              <div class="row-label">
                <span class="row-title">{{ t("settings.gameRoot") }}</span>
                <span class="row-note mono game-root-path" :title="gameRoot ?? ''">
                  {{ gameRoot || t("settings.gameRootEmpty") }}
                </span>
                <span v-if="gameRootError" class="game-root-warn">{{ msgText(gameRootError) }}</span>
                <span v-else-if="gameRootMessage" class="game-root-ok">{{ msgText(gameRootMessage) }}</span>
              </div>
              <div class="game-root-actions">
                <button
                  ref="gameRootBtn"
                  type="button"
                  class="settings-check"
                  :disabled="gameRootBusy"
                  @click="pickGameRoot"
                >
                  <span v-if="gameRootBusy" class="spinner"></span>
                  {{ t("settings.gameRootPick") }}
                </button>
                <button
                  type="button"
                  class="settings-check"
                  :disabled="gameRootBusy"
                  @click="detectGameRootDir"
                >
                  {{ t("settings.gameRootDetect") }}
                </button>
                <button
                  v-if="gameRoot"
                  type="button"
                  class="cache-dir-reset"
                  :disabled="gameRootBusy"
                  @click="clearGameRoot"
                >
                  {{ t("settings.gameRootClear") }}
                </button>
              </div>
            </div>

            <p class="settings-hint">{{ t("settings.gameRootNote") }}</p>
          </section>

          <!-- 外观（v2.0 新增）：主题模式 + 卡片大小滑块 -->
          <section v-else-if="tab === 'appearance'" class="settings-card">
            <!-- v2.2：主题模式（深色 / 明亮），点一下立即换肤，不重载页面 -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settingsUi.themeTitle") }}</span>
                <span class="row-note">{{ t("settingsUi.themeNote") }}</span>
              </div>
              <div class="settings-segment" role="radiogroup" :aria-label="t('settingsUi.themeTitle')">
                <button
                  v-for="option in THEME_OPTIONS"
                  :key="option.value"
                  type="button"
                  role="radio"
                  class="settings-segment-btn"
                  :class="{ active: theme === option.value }"
                  :aria-checked="theme === option.value"
                  @click="theme = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>

            <div class="settings-sep"></div>

            <!-- 【外观】：首屏只留「字体种类 + 界面字重」，其余 6 项收进「更多排版选项」 -->
            <h3 class="settings-group-title">{{ t("settingsUi.groupUi") }}</h3>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settingsUi.fontFamilyTitle") }}</span>
                <span class="row-note">{{ t("settingsUi.fontFamilyNote") }}</span>
              </div>
              <select
                class="settings-select typography-select"
                :value="uiFontFamily"
                :aria-label="t('settingsUi.fontFamilyTitle')"
                @change="applyFontFamily"
              >
                <option v-for="opt in FONT_FAMILY_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <!-- v3.5：英文界面专用的西文字体栈（只在英文界面出现；中文界面由中文字体优先，开关没有意义） -->
            <div v-if="isEnglishUi" class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settingsUi.latinFontTitle") }}</span>
                <span class="row-note">{{ t("settingsUi.latinFontNote") }}</span>
              </div>
              <input
                v-model="latinFont"
                type="checkbox"
                class="latin-font-check"
                :aria-label="t('settingsUi.latinFontTitle')"
              />
            </div>

            <!-- 界面字重：左右切换（400 常规 ↔ 700 加粗） -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settingsUi.uiFontWeightTitle") }}</span>
                <span class="row-note">{{ t("settingsUi.uiFontWeightNote") }}</span>
              </div>
              <div class="seg-stepper" role="group" :aria-label="t('settingsUi.uiFontWeightTitle')">
                <button
                  type="button"
                  class="seg-stepper-btn"
                  :disabled="uiFontWeight <= 400"
                  :aria-label="`${t('settingsUi.uiFontWeightTitle')} −`"
                  @click="stepUiFontWeight(-1)"
                >
                  ‹
                </button>
                <span class="seg-stepper-value">{{ weightLabel(uiFontWeight) }}</span>
                <button
                  type="button"
                  class="seg-stepper-btn"
                  :disabled="uiFontWeight >= 700"
                  :aria-label="`${t('settingsUi.uiFontWeightTitle')} +`"
                  @click="stepUiFontWeight(1)"
                >
                  ›
                </button>
              </div>
            </div>

            <button
              type="button"
              class="typography-more"
              :aria-expanded="showAdvancedTypography"
              @click="showAdvancedTypography = !showAdvancedTypography"
            >
              <span>{{ t("settingsUi.moreTypography") }}</span>
              <span class="typography-more-arrow" :class="{ 'is-open': showAdvancedTypography }">▾</span>
            </button>

            <div v-show="showAdvancedTypography" class="typography-advanced">
              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.globalScaleTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.globalScaleNote") }}</span>
                </div>
                <div class="settings-range-wrap">
                  <input
                    v-model.number="globalFontScale"
                    class="settings-range"
                    type="range"
                    :min="GLOBAL_SCALE_MIN"
                    :max="GLOBAL_SCALE_MAX"
                    :step="GLOBAL_SCALE_STEP"
                    :aria-label="t('settingsUi.globalScaleTitle')"
                    :title="globalFontScale + '%'"
                    @change="snapGlobalScale"
                  />
                  <span class="settings-range-value">{{ globalFontScale }}%</span>
                </div>
              </div>

              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.cardSize") }}</span>
                  <span class="row-note">{{ t("settingsUi.cardSizeNote") }}</span>
                </div>
                <div class="settings-range-wrap">
                  <input
                    v-model.number="cardSize"
                    class="settings-range"
                    type="range"
                    :min="CARD_SIZE_MIN"
                    :max="CARD_SIZE_MAX"
                    :step="CARD_SIZE_STEP"
                    :title="t('toolbar.cardSize', { n: cardSize })"
                    :aria-label="t('toolbar.cardSize', { n: cardSize })"
                    @change="snapCardSize"
                  />
                  <span class="settings-range-value">{{ cardSize }}px</span>
                </div>
              </div>

              <p class="settings-hint">{{ t("settingsUi.cardSizeHint") }}</p>

              <div class="settings-sep"></div>

              <!-- 【正文阅读】：字号 12–24px / 行距 / 字重 -->
              <h3 class="settings-group-title">{{ t("settingsUi.groupReader") }}</h3>

              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.readerFontSizeTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.readerFontSizeNote") }}</span>
                </div>
                <div class="settings-range-wrap">
                  <input
                    v-model.number="readerFontSize"
                    class="settings-range"
                    type="range"
                    :min="READER_FONT_SIZE_MIN"
                    :max="READER_FONT_SIZE_MAX"
                    step="1"
                    :aria-label="t('settingsUi.readerFontSizeTitle')"
                    :title="readerFontSize + 'px'"
                    @change="snapReaderFontSize"
                  />
                  <span class="settings-range-value">{{ readerFontSize }}px</span>
                </div>
              </div>

              <!-- 行距：左右切换（1.4 紧凑 ↔ 1.6 标准 ↔ 1.8 宽松） -->
              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.lineHeightTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.lineHeightNote") }}</span>
                </div>
                <div class="seg-stepper" role="group" :aria-label="t('settingsUi.lineHeightTitle')">
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="readerLineHeight <= 1.4"
                    :aria-label="`${t('settingsUi.lineHeightTitle')} −`"
                    @click="stepLineHeight(-1)"
                  >
                    ‹
                  </button>
                  <span class="seg-stepper-value">{{ lineHeightLabel(readerLineHeight) }}</span>
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="readerLineHeight >= 1.8"
                    :aria-label="`${t('settingsUi.lineHeightTitle')} +`"
                    @click="stepLineHeight(1)"
                  >
                    ›
                  </button>
                </div>
              </div>

              <!-- 正文字重：左右切换（400 常规 ↔ 700 加粗） -->
              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.fontWeightTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.fontWeightNote") }}</span>
                </div>
                <div class="seg-stepper" role="group" :aria-label="t('settingsUi.fontWeightTitle')">
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="readerFontWeight <= 400"
                    :aria-label="`${t('settingsUi.fontWeightTitle')} −`"
                    @click="stepReaderFontWeight(-1)"
                  >
                    ‹
                  </button>
                  <span class="seg-stepper-value">{{ weightLabel(readerFontWeight) }}</span>
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="readerFontWeight >= 700"
                    :aria-label="`${t('settingsUi.fontWeightTitle')} +`"
                    @click="stepReaderFontWeight(1)"
                  >
                    ›
                  </button>
                </div>
              </div>

              <div class="settings-sep"></div>

              <!-- 【卡片列表】：字号 10–16px + 字重（v3.3 新增） -->
              <h3 class="settings-group-title">{{ t("settingsUi.groupCard") }}</h3>

              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.cardFontSizeTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.cardFontSizeNote") }}</span>
                </div>
                <div class="settings-range-wrap">
                  <input
                    v-model.number="cardFontSize"
                    class="settings-range"
                    type="range"
                    :min="CARD_FONT_SIZE_MIN"
                    :max="CARD_FONT_SIZE_MAX"
                    step="1"
                    :aria-label="t('settingsUi.cardFontSizeTitle')"
                    :title="cardFontSize + 'px'"
                    @change="snapCardFontSize"
                  />
                  <span class="settings-range-value">{{ cardFontSize }}px</span>
                </div>
              </div>

              <!-- 卡片字重：左右切换（400 常规 ↔ 700 加粗） -->
              <div class="settings-row">
                <div class="row-label">
                  <span class="row-title">{{ t("settingsUi.cardFontWeightTitle") }}</span>
                  <span class="row-note">{{ t("settingsUi.cardFontWeightNote") }}</span>
                </div>
                <div class="seg-stepper" role="group" :aria-label="t('settingsUi.cardFontWeightTitle')">
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="cardFontWeight <= 400"
                    :aria-label="`${t('settingsUi.cardFontWeightTitle')} −`"
                    @click="stepCardFontWeight(-1)"
                  >
                    ‹
                  </button>
                  <span class="seg-stepper-value">{{ weightLabel(cardFontWeight) }}</span>
                  <button
                    type="button"
                    class="seg-stepper-btn"
                    :disabled="cardFontWeight >= 700"
                    :aria-label="`${t('settingsUi.cardFontWeightTitle')} +`"
                    @click="stepCardFontWeight(1)"
                  >
                    ›
                  </button>
                </div>
              </div>
            </div>

            <p class="settings-hint">{{ t("settingsUi.typographyHint") }}</p>

            <!-- v3.0：恢复默认排版（只盖排版八项，不动卡片大小与主题） -->
            <div class="typography-reset-row">
              <button type="button" class="typography-reset" @click="showResetConfirm = true">
                {{ t("settingsUi.resetTypography") }}
              </button>
            </div>
          </section>

          <!-- 网络 -->
          <section v-else-if="tab === 'network'" class="settings-card">
            <p class="settings-summary">{{ netSummary }}</p>

            <label class="settings-check-line">
              <input v-model="netAuto" type="checkbox" :disabled="netSaving" />
              {{ t("online.followSystem") }}
            </label>

            <input
              v-if="!netAuto"
              v-model="netUrl"
              class="settings-input"
              type="text"
              placeholder="http://127.0.0.1:7897"
              spellcheck="false"
              :disabled="netSaving"
            />

            <label class="settings-check-line">
              <input
                v-model="netRemember"
                type="checkbox"
                :disabled="netSaving"
                @change="applyRememberLogin"
              />
              {{ t("online.rememberLogin") }}
            </label>
            <p class="settings-hint">{{ t("online.rememberLoginHint") }}</p>

            <div class="settings-actions">
              <button type="button" :disabled="netSaving" @click="saveNetwork">
                {{ netSaving ? t("online.saving") : t("online.save") }}
              </button>
              <button type="button" :disabled="netSaving || netLoading" @click="loadNetwork">
                {{ t("online.detect") }}
              </button>
            </div>

            <div v-if="netError" class="settings-msg error">{{ netError }}</div>
            <div v-else-if="netMessage" class="settings-msg">{{ msgText(netMessage) }}</div>
          </section>

          <!-- 本地模组：索引 / 搜索 / 批量更新检测 -->
          <section v-else-if="tab === 'local'" class="settings-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.indexing") }}</span>
                <span class="row-note">{{ t("settings.indexingNote") }}</span>
              </div>
              <label class="settings-check-line">
                <input
                  type="checkbox"
                  :checked="indexingEnabled"
                  :disabled="indexingSaving"
                  @change="toggleIndexing"
                />
                {{ indexingEnabled ? t("settings.indexingOn") : t("settings.indexingOff") }}
              </label>
            </div>
            <div v-if="indexingError" class="settings-msg error">{{ indexingError }}</div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.localSearch") }}</span>
                <span class="row-note">{{ t("settings.localSearchNote") }}</span>
              </div>
              <label class="settings-check-line">
                <input
                  type="checkbox"
                  :checked="localSearchOn"
                  :disabled="localSearchSaving"
                  @change="toggleLocalSearch"
                />
                {{ localSearchOn ? t("settings.localSearchOn") : t("settings.localSearchOff") }}
              </label>
            </div>
            <div v-if="localSearchError" class="settings-msg error">{{ localSearchError }}</div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.modUpdate") }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="!modCanCheck"
                :title="t('settings.modUpdateButton')"
                @click="runModCheck"
              >
                <span v-if="modChecking" class="spinner"></span>
                {{ modChecking ? t("settings.modUpdateChecking") : t("settings.modUpdateButton") }}
              </button>
            </div>

            <p
              class="settings-status"
              :class="{
                ok: !!modReport && !modError && modReport.updateCount === 0,
                bad: !!modError,
              }"
            >
              {{ modStatusText }}
            </p>

            <p v-if="modReport && modReport.updateCount > 0" class="settings-hint">
              {{ t("settings.modUpdateHint") }}
            </p>

            <div class="settings-sep"></div>

            <p class="settings-hint">{{ t("settingsUi.rootPath") }}</p>
          </section>

          <!-- 模组翻译：目标语言 / 翻译引擎 / 批量标题翻译 / 翻译缓存统计（只读） -->
          <section v-else-if="tab === 'online'" class="settings-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.translateTarget") }}</span>
                <span class="row-note">{{ t("settings.translateTargetNote", { lang: effectiveTargetLabel }) }}</span>
              </div>
              <select
                ref="targetSelect"
                class="settings-select"
                :value="targetChoice"
                :disabled="translateLoading || translateSaving"
                :aria-label="t('settings.translateTarget')"
                @change="onTargetChange"
              >
                <option value="">
                  {{ t("settings.translateFollowUi", { lang: effectiveTargetLabel }) }}
                </option>
                <option v-for="code in targetOptions" :key="code" :value="code">
                  {{ languageName(code) }}
                </option>
              </select>
            </div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.translateEngine") }}</span>
                <span class="row-note">{{ t("settings.translateEngineNote") }}</span>
              </div>
              <select
                ref="engineSelect"
                class="settings-select"
                :value="engineChoice"
                :disabled="translateLoading || translateSaving"
                :aria-label="t('settings.translateEngine')"
                @change="onEngineChange"
              >
                <option value="auto">{{ t("settings.translateEngineAuto") }}</option>
                <option value="google">Google</option>
              </select>
            </div>

            <p class="settings-hint">{{ t("settings.translateAutoSave") }}</p>

            <div v-if="translateError" class="settings-msg error">{{ msgText(translateError) }}</div>
            <div v-else-if="translateMessage" class="settings-msg">{{ msgText(translateMessage) }}</div>

            <div class="settings-sep"></div>

            <!-- 批量翻译标题：默认关闭、手动开始（与「一键翻译不自动触发」保持同一套铁律） -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("titleTranslate.sectionTitle") }}</span>
                <span class="row-note">{{ t("titleTranslate.note") }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="titleJobBusy || (!titleJob?.running && !titleJob?.indexReady)"
                @click="titleJob?.running ? stopTitleJob() : startTitleJob()"
              >
                <span v-if="titleJobBusy" class="spinner"></span>
                {{ titleJob?.running ? t("titleTranslate.stop") : t("titleTranslate.start") }}
              </button>
            </div>

            <p class="settings-hint">{{ titleJobText }}</p>

            <div v-if="titleJobError" class="settings-msg error">{{ titleJobError }}</div>

            <div class="settings-sep"></div>

            <!-- 翻译缓存：只做只读统计展示，不再提供一键清空（容量很小，删了没意义） -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("translateCache.sectionTitle") }}</span>
                <span class="row-note">{{ translationCacheText }}</span>
              </div>
            </div>
          </section>

          <!-- 数据与缓存（v1.x）：单目录 + 二次确认迁移 -->
          <section v-else-if="tab === 'storage'" class="settings-card">
            <div class="cache-dir-row">
              <div class="row-label">
                <span class="row-title">
                  {{ t("settings.dataDirTitle") }}
                  <span class="cache-dir-badge">
                    {{
                      dataDirView?.isCustom
                        ? t("settings.dataDirCustomBadge")
                        : t("settings.dataDirDefaultBadge")
                    }}
                  </span>
                </span>
                <span class="row-note mono cache-dir-path" :title="dataDirView?.path || ''">
                  {{ dataDirView?.path || "—" }}
                </span>
                <span class="row-note data-dir-size">{{ dataDirSizeText }}</span>
                <span v-if="dataDirView && !dataDirView.exists" class="cache-dir-warn">
                  {{ t("settings.dataDirMissing") }}
                </span>
              </div>
              <div class="cache-dir-actions">
                <button
                  type="button"
                  class="settings-check"
                  :disabled="dataDirBusy"
                  @click="openDataDir"
                >
                  {{ t("settings.dataDirOpen") }}
                </button>
                <button
                  type="button"
                  class="settings-check"
                  :disabled="dataDirBusy"
                  @click="migrateDataDir"
                >
                  <span v-if="dataDirBusy" class="spinner"></span>
                  {{ dataDirBusy ? t("settings.dataDirMigrating") : t("settings.dataDirMigrate") }}
                </button>
              </div>
            </div>

            <p class="settings-hint">{{ t("settings.dataDirNote") }}</p>

            <div v-if="dataDirView?.legacy" class="settings-msg">
              {{ t("settings.dataDirLegacy") }}
            </div>
            <div v-if="dataDirError" class="settings-msg error">{{ msgText(dataDirError) }}</div>
            <div v-else-if="dataDirMessage" class="settings-msg">{{ msgText(dataDirMessage) }}</div>
          </section>

          <!-- 关于（v2.0）：「软件更新」从通用 Tab 整体搬到这里（版本号 / 检查更新 / 发布页） -->
          <section v-else class="settings-card about-card">
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("settings.update") }}</span>
                <span class="row-note">{{ currentVersionText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="!canCheck"
                :title="t('settings.checkUpdate')"
                @click="runCheck"
              >
                <span v-if="checking" class="spinner"></span>
                {{ checking ? t("settings.checking") : t("settings.checkUpdate") }}
              </button>
            </div>

            <p class="settings-status" :class="{ ok: cooldownLeft > 0 && !hasUpdate, bad: !!checkError }">
              {{ checkStatusText }}
            </p>

            <div v-if="hasUpdate" class="settings-update-note">
              <p>{{ t("settings.foundBody", { version: latest?.latestVersion ?? "" }) }}</p>
              <p v-if="latest?.publishedAt" class="note">
                {{ t("settings.publishedAt", { time: latest.publishedAt }) }}
              </p>
              <button type="button" class="settings-release" @click="openRelease">
                {{ t("settings.openRelease") }}
              </button>
            </div>

            <div class="settings-sep"></div>

            <div class="about-line">
              <span class="row-title">{{ t("settings.version") }}</span>
              <span class="about-value">v{{ version }}</span>
            </div>
            <div class="about-line">
              <span class="row-title">{{ t("settings.github") }}</span>
              <button type="button" class="about-link" @click="openRepo">{{ REPO_URL }}</button>
            </div>
            <div class="about-line">
              <span class="row-title">{{ t("settings.feedback") }}</span>
              <button type="button" class="about-link" @click="openIssues">
                {{ t("settings.feedbackButton") }}
              </button>
            </div>

            <div class="about-line about-cloud">
              <span class="row-title">{{ t("settings.cloudTitle") }}</span>
              <div class="about-cloud-actions">
                <button type="button" class="about-link" @click="openCloud">
                  {{ t("settings.cloudButton") }}
                </button>
                <span class="about-cloud-password">{{ t("settings.cloudPassword") }}</span>
              </div>
            </div>

            <div class="settings-sep"></div>

            <!-- v0.4.5：本地日志 — 不用再让用户自己翻文件夹找日志 -->
            <div class="diag-block">
              <div class="diag-head">
                <span class="row-title">{{ t("settings.diagTitle") }}</span>
                <span class="row-note">{{ t("settings.diagNote") }}</span>
              </div>
              <input
                v-model="diagProblem"
                type="text"
                class="diag-input"
                maxlength="200"
                :placeholder="t('settings.diagProblemPlaceholder')"
              />
              <div class="diag-actions">
                <button type="button" class="settings-check" :disabled="diagBusy" @click="openLogsFolder">
                  {{ t("settings.diagOpenLogs") }}
                </button>
                <button
                  type="button"
                  class="settings-check diag-copy"
                  :disabled="diagBusy"
                  :title="t('settings.diagCopyHint')"
                  @click="copyDiagnostics"
                >
                  <span v-if="diagBusy" class="spinner"></span>
                  {{ diagBusy ? t("settings.diagCopying") : t("settings.diagCopy") }}
                </button>
              </div>
              <p v-if="diagError" class="settings-status bad">{{ msgText(diagError) }}</p>
              <p v-else-if="diagMessage" class="settings-status ok">{{ msgText(diagMessage) }}</p>
            </div>

            <div class="settings-sep"></div>

            <!-- v3.1：更新历史（GitHub Releases，由 Rust 拉取，前端不直连 API） -->
            <div class="about-history-head">
              <span class="row-title">{{ t("settings.changelogTitle") }}</span>
              <button type="button" class="about-link" @click="toggleHistory">
                {{ historyOpen ? t("settings.changelogHide") : t("settings.changelogShow") }}
              </button>
            </div>

            <div v-if="historyOpen" class="about-history">
              <p v-if="historyLoading" class="about-history-note">
                {{ t("settings.changelogLoading") }}
              </p>
              <p v-else-if="historyError" class="about-history-note error">
                {{ historyError }}
                <button type="button" class="about-history-retry" @click="loadHistory">
                  {{ t("settings.changelogRetry") }}
                </button>
              </p>
              <template v-else-if="history.length">
                <article v-for="release in history" :key="release.tagName" class="about-history-item">
                  <header class="about-history-item-head">
                    <span class="about-history-version">v{{ release.version || release.tagName }}</span>
                    <span class="about-history-name">{{ release.name }}</span>
                    <span class="about-history-date">{{ formatReleaseDate(release.publishedAt) }}</span>
                  </header>
                  <div
                    v-if="release.body"
                    class="release-notes"
                    v-html="renderReleaseMarkdown(release.body)"
                  ></div>
                  <p v-else class="about-history-note">{{ t("settings.changelogEmptyBody") }}</p>
                </article>
              </template>
              <p v-else class="about-history-note">{{ t("settings.changelogEmpty") }}</p>
            </div>
          </section>
        </div>
      </div>

    <!-- v0.4.5：「已复制」引导（告诉玩家粘贴给 AI 就行，不用懂日志） -->
    <div v-if="diagCopied" class="modal-backdrop" @click.self="diagCopied = false">
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>{{ t("settings.diagCopiedTitle") }}</h2>
          <span class="modal-sub">{{ t("settings.diagCopiedSubtitle") }}</span>
          <button type="button" class="modal-x" @click="diagCopied = false">✕</button>
        </div>
        <div class="modal-body">
          <p class="confirm-text">{{ t("settings.diagCopiedMessage") }}</p>
          <div class="confirm-actions">
            <button type="button" class="primary" @click="diagCopied = false">
              {{ t("settings.diagCopiedOk") }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- v1.x：数据目录迁移的二次确认（含登录凭证，绝不能直接执行） -->
    <ConfirmDialog
      v-if="migrateTarget"
      :title="t('settings.dataDirConfirmTitle')"
      :message="t('settings.dataDirConfirmBody')"
      :detail="migrateTarget"
      :confirm-label="t('settings.dataDirConfirmOk')"
      :cancel-label="t('settings.dataDirConfirmCancel')"
      :busy="dataDirBusy"
      :error="migrateError"
      @confirm="runMigrate"
      @cancel="cancelMigrate"
    />

    <!-- v3.0：恢复默认排版的二次确认（叠在设置弹窗之上） -->
    <ConfirmDialog
      v-if="showResetConfirm"
      :title="t('settingsUi.resetTypographyTitle')"
      :message="t('settingsUi.resetTypographyMessage')"
      :confirm-label="t('settingsUi.resetTypographyConfirm')"
      :danger="false"
      @confirm="resetTypography"
      @cancel="showResetConfirm = false"
    />
  </div>
</template>

<style scoped>
.settings-modal {
  width: min(720px, 100%);
}

/* v3.4：设置改成可拖动浮动面板 —— 去掉全屏遮罩，主界面照常可点可滚。
   位置由 panelPos（left/top）驱动，没拖过时退回这里的居中定位。
   层级 32：高于主界面内容，低于 .modal-backdrop(40)，其它模态弹窗仍能盖住它。 */
.settings-floating {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 32;
  max-height: calc(100vh - 16px);
  box-shadow:
    0 18px 46px rgba(0, 0, 0, 0.55),
    var(--shadow),
    inset 0 0 0 1px rgba(var(--accent-rgb), 0.12);
}
/* 标题栏即拖动把手；关闭按钮在 onDragStart 里已被排除 */
.settings-drag-handle {
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.settings-floating.is-dragging .settings-drag-handle {
  cursor: grabbing;
}
.settings-floating.is-dragging {
  user-select: none;
}

/* 固定尺寸：左侧导航 + 右侧内容区都锁死在同一个高度里，
   切换标签时弹窗不再跟着内容长短抽动（本次要把 max-height / min-height 全部拿掉）。 */
.settings-layout {
  display: flex;
  height: 520px;
  overflow: hidden;
}

@media (max-height: 640px) {
  /* 屏幕真实高度不够时整体降一档，仍然是一个定高容器，不会因标签内容而变 */
  .settings-layout {
    height: 420px;
  }
}

/* 左栏：固定 180px，自身单独滚动 */
.settings-tabs {
  flex: 0 0 180px;
  width: 180px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 12px;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(var(--accent-rgb), 0.05), transparent);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.settings-tab {
  text-align: left;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: calc(12px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--muted);
}
.settings-tab:hover {
  color: var(--parch);
  background: var(--bg-panel);
  border-color: transparent;
}
.settings-tab.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: var(--ui-font-weight-strong);
}

/* 右栏：吃掉剩余宽度，横向不溢出，纵向自己滚；
   scrollbar-gutter: stable 保证从「没有滚动条」切到「有滚动条」时宽度不跳。 */
.settings-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 24px;
  scrollbar-gutter: stable;
}

.settings-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.06);
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
/* v2.4：排版三层的子分组标题（界面 / 正文阅读 / 卡片列表）——
   分组标题本身也跟随全局缩放，150% 时不会显得比正文还小 */
.settings-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  min-width: 0;
  font-size: calc(11px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: calc(2px * var(--ui-tracking));
  text-transform: uppercase;
  color: var(--gold-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.settings-group-title::after {
  content: "";
  flex: 1 1 auto;
  min-width: 12px;
  height: 1px;
  background: linear-gradient(90deg, var(--line), transparent);
}
.row-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-title {
  font-size: calc(12.5px * var(--global-scale));
  letter-spacing: calc(0.8px * var(--ui-tracking));
  color: var(--parch);
}
.row-note {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  line-height: 1.6;
}

.settings-select,
.settings-input {
  padding: 7px 9px;
  font-size: calc(12px * var(--global-scale));
}
.settings-select {
  min-width: 120px;
}
/* v2.3：排版下拉框固定窄宽，字号放大到 20px 时也不会把左侧标签挤掉 */
.typography-select {
  min-width: 108px;
  max-width: 132px;
}
.settings-input {
  width: 100%;
}

.settings-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 2px 0;
}

.settings-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  letter-spacing: calc(0.8px * var(--ui-tracking));
}
.settings-check:disabled {
  opacity: 0.6;
}

/* v2.2 外观 Tab：主题模式（分段按钮，深色 / 明亮）。
   激活态沿用「金底 + 深字」，与非激活态拉开层级但同样安静。 */
.settings-segment {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-lo);
}
.settings-segment-btn {
  min-width: 74px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--parch-dim);
  letter-spacing: calc(0.8px * var(--ui-tracking));
}
.settings-segment-btn:hover:not(.active) {
  color: var(--parch);
  background: var(--bg-hover);
}
.settings-segment-btn.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: var(--ui-font-weight-strong);
}

/* v2.0 外观 Tab：卡片大小滑块（从主界面顶栏搬过来，尺寸口径与 useViewPrefs 一致） */
.settings-range-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.settings-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 0 1 150px;
  width: 150px;
  min-width: 90px;
  height: 4px;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  cursor: pointer;
}
.settings-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--gold-bright);
  background: var(--bg-panel-deep);
  box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.7);
}
.settings-range::-webkit-slider-thumb:hover {
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.95);
}
.settings-range-value {
  flex: 0 0 auto;
  min-width: 52px;
  text-align: right;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--gold-text);
  letter-spacing: calc(0.6px * var(--ui-tracking));
}
/* 根目录路径回显：等宽字体 + 允许折行，长路径不会把右侧按钮顶出去 */
.row-note.mono {
  font-family: var(--font-mono);
  font-size: calc(10.5px * var(--global-scale));
  word-break: break-all;
  color: var(--parch-dim);
}

.settings-status {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
  letter-spacing: calc(0.4px * var(--ui-tracking));
}
.settings-status.ok {
  color: var(--ok-text);
}
.settings-status.bad {
  color: var(--danger-text);
}

.settings-update-note {
  border: 1px solid rgba(var(--accent-rgb), 0.55);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(var(--accent-rgb), 0.06);
}
.settings-update-note p {
  margin: 0 0 6px;
  font-size: calc(12px * var(--global-scale));
  line-height: 1.7;
  color: var(--parch);
}
.settings-update-note p.note {
  color: var(--muted);
  font-size: calc(11px * var(--global-scale));
}
.settings-release {
  padding: 6px 12px;
  letter-spacing: calc(0.8px * var(--ui-tracking));
}

.settings-summary {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--gold-text);
}

.settings-check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch-dim);
}

/* v3.5：英文界面「西文字体栈」开关（单独占 .settings-row 的右列） */
.latin-font-check {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--gold);
  cursor: pointer;
}

.settings-actions {
  display: flex;
  gap: 8px;
}

.settings-hint {
  margin: 0;
  font-size: calc(11px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
}

/* v3.3：字重 / 行距的左右切换控件（‹ 值 ›，替代原来的下拉框） */
.seg-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-panel-deep);
}
.seg-stepper-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--parch-dim);
  font-family: inherit;
  font-size: calc(14px * var(--global-scale));
  line-height: 1;
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.seg-stepper-btn:hover:not(:disabled) {
  color: var(--gold-bright);
  background: rgba(var(--accent-rgb), 0.1);
}
.seg-stepper-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.seg-stepper-value {
  min-width: 56px;
  text-align: center;
  font-size: calc(12px * var(--global-scale));
  color: var(--parch);
  white-space: nowrap;
}

/* v3.3：「更多排版选项」折叠开关 —— 外观页首屏只留两项，其余按需展开 */
.typography-more {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 0 2px;
  padding: 6px 10px;
  border: 1px dashed var(--line);
  border-radius: 7px;
  background: transparent;
  color: var(--gold-dim);
  font-family: inherit;
  font-size: calc(11px * var(--global-scale));
  font-weight: var(--ui-font-weight-strong);
  letter-spacing: calc(1px * var(--ui-tracking));
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease;
}
.typography-more:hover {
  color: var(--gold-bright);
  border-color: var(--gold-dim);
}
.typography-more-arrow {
  font-size: calc(11px * var(--global-scale));
  transition: transform 0.16s ease;
}
.typography-more-arrow.is-open {
  transform: rotate(180deg);
}

/* v3.0：恢复默认排版按钮（排版区块右下角，Ghot 风格，hover 点亮金色） */
.typography-reset-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.typography-reset {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--parch-dim);
  font-size: calc(12.5px * var(--global-scale));
  padding: 5px 12px;
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}
.typography-reset:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
  background: rgba(var(--accent-rgb), 0.08);
}

.settings-msg {
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--ok-text);
}
.settings-msg.error {
  color: var(--danger-text);
}

.about-card {
  gap: 14px;
}
.about-line {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.about-value {
  font-size: calc(13px * var(--global-scale));
  color: var(--gold-text);
  letter-spacing: calc(1px * var(--ui-tracking));
}
.about-link {
  justify-self: start;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--parch-dim);
  font-size: calc(11.5px * var(--global-scale));
  word-break: break-all;
  text-align: left;
}
.about-link:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
}

/* v3.1：蓝奏云网盘行（右侧按钮 + 灰色密码提示） */
.about-line.about-cloud {
  grid-template-columns: minmax(0, 1fr) auto;
}
.about-cloud-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.about-cloud-password {
  font-size: calc(11px * var(--global-scale));
  letter-spacing: calc(0.6px * var(--ui-tracking));
  color: var(--muted);
  white-space: nowrap;
}

/* v3.1：更新历史折叠面板（面板内单独滚动，不拉长整个关于卡片） */
.about-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* v0.4.5 关于页：日志诊断区（问题描述输入框 + 两枚按钮） */
.diag-block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.diag-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.diag-input {
  width: 100%;
  font-size: calc(12px * var(--global-scale));
  padding: 7px 9px;
}
.diag-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 主按钮：金色描边高亮，和「检查更新」区分开 */
.diag-copy {
  border-color: var(--gold-dim);
  color: var(--gold-text);
}
.diag-copy:hover:not(:disabled) {
  border-color: var(--gold-text);
  background: rgba(var(--accent-rgb), 0.1);
}
.about-history {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-panel-deep);
}
.about-history-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}
.about-history-item:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
.about-history-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.about-history-version {
  font-size: calc(12.5px * var(--global-scale));
  letter-spacing: calc(1px * var(--ui-tracking));
  color: var(--gold-text);
}
.about-history-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: calc(11.5px * var(--global-scale));
  color: var(--parch-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-history-date {
  font-size: calc(11px * var(--global-scale));
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.about-history-note {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
}
.about-history-note.error {
  color: var(--danger-text);
}
.about-history-retry {
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--parch-dim);
  font-size: calc(11px * var(--global-scale));
}
.about-history-retry:hover {
  color: var(--gold-text);
  border-color: var(--gold-dim);
}

/* v3.2：缓存与存储 —— 一行一类缓存，路径单行省略、悬浮看全路径 */
.cache-dir-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 10px 0;
}
.cache-dir-row + .cache-dir-row {
  border-top: 1px solid var(--line);
}
/* 优先级要压过 .row-note.mono 的 break-all，否则长路径会把按钮顶出卡片 */
.row-note.mono.cache-dir-path {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: normal;
  color: var(--parch-dim);
}
.cache-dir-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}
.cache-dir-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  border-radius: 3px;
  font-size: calc(10px * var(--global-scale));
  letter-spacing: calc(0.5px * var(--ui-tracking));
  color: var(--gold-text);
}
.cache-dir-warn {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--danger-text);
}
.cache-dir-reset {
  padding: 4px 2px;
  border: none;
  background: none;
  font-size: calc(11px * var(--global-scale));
  letter-spacing: calc(0.5px * var(--ui-tracking));
  color: var(--muted);
  cursor: pointer;
}
.cache-dir-reset:hover:not(:disabled) {
  color: var(--gold-text);
}
.cache-dir-reset:disabled {
  opacity: 0.5;
  cursor: default;
}

/* v1.x：总目录单行 —— 复用 v3.2 的 .cache-dir-* 骨架，只补体积行 */
.data-dir-size {
  color: var(--parch-dim);
}

/* v3.3：游戏根目录一行 —— 复用 .settings-row 的两列布局，
   只补「长路径单行省略」与「从顶栏跳过来时的金色高亮」。 */
.settings-row.game-root-row {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  row-gap: 10px;
  scroll-margin-block: 28px;
  border-radius: 4px;
  transition: background 0.25s ease, box-shadow 0.25s ease;
}
.settings-row.game-root-flash {
  background: rgba(var(--accent-rgb), 0.1);
  box-shadow: 0 0 0 1px var(--gold), 0 0 14px rgba(var(--accent-rgb), 0.4);
}
/* 优先级压过 .row-note.mono 的 break-all，否则长路径会把按钮顶出卡片 */
.row-note.mono.game-root-path {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: normal;
  color: var(--parch-dim);
}
.game-root-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}
.game-root-warn {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--danger-text);
}
.game-root-ok {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--ok-text-strong);
}
</style>
