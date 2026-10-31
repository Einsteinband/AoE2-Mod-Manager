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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import ConfirmDialog from "./ConfirmDialog.vue";
import { appVersion, checkUpdate, fetchGithubReleases, getSettings, openExternalUrl, renderReleaseMarkdown, setEnableIndexing, setEnableLocalSearch, setLocale } from "../api";
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
  translationCacheClear,
  translationCacheStat,
} from "../online/service";
import {
  applyTranslateSettings,
  languageName,
  resetTranslations,
} from "../online/translation";
import { clearOnlineCache, onlineCacheStat } from "../online/cache";
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
import type { CacheOverview, NetworkSettingsView, TitleJobStatus, TranslateSettingsView, TranslationCacheStat } from "../online/types";
import type { UpdateInfo } from "../types";
import { CARD_SIZE_MAX, CARD_SIZE_MIN, CARD_SIZE_STEP, clampCardSize } from "../composables/useViewPrefs";
import {
  CARD_FONT_SIZE_MAX,
  CARD_FONT_SIZE_MIN,
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
  normalizeUiFontWeight,
  type UiFontFamily,
} from "../api";

/** 全局视图偏好：卡片大小与主界面用同一个 v-model（设置里拖完，列表立即跟着变） */
const props = withDefaults(defineProps<{ /** 当前根目录（只用于展示，不参与业务） */ rootPath?: string }>(), {
  rootPath: "",
});

const emit = defineEmits<{ close: []; "change-root": [] }>();
const { t, locale } = useI18n();

type Tab = "general" | "appearance" | "network" | "local" | "online" | "about";
const tab = ref<Tab>("general");

/**
 * 仅本弹窗使用的补充文案（本次改造不改语言包文件）。
 */
const ui = computed(() =>
  String(locale.value).toLowerCase().startsWith("zh")
    ? {
        tabAppearance: "外观",
        themeTitle: "主题模式",
        themeNote: "切换后立即生效，不重启界面；选择会写进 settings.json",
        themeDark: "深色",
        themeLight: "明亮",
        cardSize: "卡片大小",
        cardSizeNote: "拖动后立即生效，只影响网格视图（160–320px）；设置会写进 settings.json",
        cardSizeHint: "列表视图不受影响；顶栏的「网格 / 列表」按钮就在列表抬头右侧的批量操作组里。",
        groupUi: "界面",
        groupReader: "正文阅读",
        groupCard: "卡片列表",
        fontFamilyTitle: "字体种类",
        fontFamilyNote: "切换后立即生效并写入设置",
        fontFamilyHei: "黑体",
        fontFamilyYouyuan: "幼圆",
        fontFamilySystem: "跟随系统",
        uiFontWeightTitle: "界面字重",
        uiFontWeightNote: "导航、按钮与设置界面的描边粗细",
        globalScaleTitle: "全局缩放",
        globalScaleNote: "80%–150%：侧边栏、顶栏与设置界面同步缩放",
        readerFontSizeTitle: "正文字号",
        readerFontSizeNote: "12–24px：只作用于模组描述正文",
        lineHeightTitle: "行距",
        lineHeightNote: "只影响正文行间空白，不改变控件尺寸",
        lineHeightCompact: "紧凑 1.4",
        lineHeightStandard: "标准 1.6",
        lineHeightLoose: "宽松 1.8",
        fontWeightTitle: "正文字重",
        fontWeightNote: "只影响模组描述正文的描边粗细",
        weightNormal: "常规 400",
        weightBold: "加粗 700",
        resetTypography: "恢复默认排版",
        resetTypographyTitle: "恢复默认排版",
        resetTypographyMessage: "确定要将所有字体、字号、行距和字重恢复为默认吗？",
        resetTypographyConfirm: "恢复默认",
        cardFontSizeTitle: "卡片字号",
        cardFontSizeNote: "10–16px：只影响卡片标题与元信息",
        typographyHint: "界面、正文、卡片三层互不干扰，深色与明亮主题同样生效。",
        rootTitle: "模组根目录",
        rootNote: "更换后会自动重新扫描，并写入 settings.json；主界面信息栏会同步刷新。",
        changeRoot: "更换根目录",
        rootEmpty: "尚未设置根目录",
        rootPath:
          "模组扫描路径（根目录）已统一到「通用」Tab 里的「更换根目录」按钮管理。",
      }
    : {
        tabAppearance: "Appearance",
        themeTitle: "Theme",
        themeNote: "Applies instantly without reloading; the choice is saved to settings.json",
        themeDark: "Dark",
        themeLight: "Light",
        cardSize: "Card size",
        cardSizeNote: "Applies instantly, grid view only (160–320px); saved to settings.json",
        cardSizeHint:
          "List view is unaffected; the Grid / List switch lives in the batch group at the right of the list heading.",
        groupUi: "Interface",
        groupReader: "Reading text",
        groupCard: "Card list",
        fontFamilyTitle: "Font family",
        fontFamilyNote: "Applies instantly and is saved to settings",
        fontFamilyHei: "Hei (SimHei)",
        fontFamilyYouyuan: "YouYuan",
        fontFamilySystem: "Follow system",
        uiFontWeightTitle: "Interface weight",
        uiFontWeightNote: "Stroke weight of navigation, buttons and settings",
        globalScaleTitle: "Global scale",
        globalScaleNote: "80%–150%: sidebar, toolbar and settings scale together",
        readerFontSizeTitle: "Reader font size",
        readerFontSizeNote: "12–24px: mod description body only",
        lineHeightTitle: "Line height",
        lineHeightNote: "Changes only the spacing of body text, not control sizes",
        lineHeightCompact: "Compact 1.4",
        lineHeightStandard: "Standard 1.6",
        lineHeightLoose: "Loose 1.8",
        fontWeightTitle: "Body weight",
        fontWeightNote: "Applies to mod description text only",
        weightNormal: "Normal 400",
        weightBold: "Bold 700",
        resetTypography: "Restore default layout",
        resetTypographyTitle: "Restore default layout",
        resetTypographyMessage:
          "Reset every font, size, line height and weight to its default value?",
        resetTypographyConfirm: "Restore defaults",
        cardFontSizeTitle: "Card font size",
        cardFontSizeNote: "10–16px: card title and meta only",
        typographyHint:
          "Interface, reading text and cards are independent layers, and both dark and light themes are supported.",
        rootTitle: "Mod root folder",
        rootNote: "Changing the root rescans automatically and is saved to settings.json.",
        changeRoot: "Change root folder",
        rootEmpty: "No root folder set yet",
        rootPath:
          "The mod scan root is now managed by \"Change root folder\" in the General tab.",
      },
);

/** 卡片最小宽度：与主界面滑块、Rust 侧 clamp 同口径 */
const cardSize = defineModel<number>("cardSize", { default: 200 });

/** 界面主题："dark"（默认）| "light"；主界面 App.vue 持有真值并负责落盘 */
const theme = defineModel<string>("theme", { default: "dark" });

/** 主题选项（文案跟随界面语言，不新增 i18n key） */
const THEME_OPTIONS = computed(() => [
  { value: "dark", label: ui.value.themeDark },
  { value: "light", label: ui.value.themeLight },
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

// 【卡片列表】字号
const cardFontSize = defineModel<number>("cardFontSize", { default: 12 });

/** 字体种类下拉项（文案跟随界面语言） */
const FONT_FAMILY_OPTIONS_LABELED = computed(() =>
  UI_FONT_FAMILY_OPTIONS.map((value) => ({
    value,
    label:
      value === "youyuan"
        ? ui.value.fontFamilyYouyuan
        : value === "system"
          ? ui.value.fontFamilySystem
          : ui.value.fontFamilyHei,
  })),
);

/** 行距下拉项（文案跟随界面语言） */
const LINE_HEIGHT_OPTIONS_LABELED = computed(() =>
  READER_LINE_HEIGHT_OPTIONS.map((value) => ({
    value,
    label:
      value === 1.4
        ? ui.value.lineHeightCompact
        : value === 1.8
          ? ui.value.lineHeightLoose
          : ui.value.lineHeightStandard,
  })),
);

/** 字重下拉项（400 常规 / 700 加粗） */
const FONT_WEIGHT_OPTIONS_LABELED = computed(() =>
  READER_FONT_WEIGHT_OPTIONS.map((value) => ({
    value,
    label: value >= 700 ? ui.value.weightBold : ui.value.weightNormal,
  })),
);

/** 界面字重下拉项（同上文案，但作用于 --ui-font-weight） */
const UI_FONT_WEIGHT_OPTIONS_LABELED = computed(() =>
  UI_FONT_WEIGHT_OPTIONS.map((value) => ({
    value,
    label: value >= 700 ? ui.value.weightBold : ui.value.weightNormal,
  })),
);

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
function applyLineHeight(event: Event) {
  readerLineHeight.value = normalizeReaderLineHeight(Number((event.target as HTMLSelectElement).value));
}
function applyFontWeight(event: Event) {
  readerFontWeight.value = normalizeReaderFontWeight(Number((event.target as HTMLSelectElement).value));
}
function applyUiFontWeight(event: Event) {
  uiFontWeight.value = normalizeUiFontWeight(Number((event.target as HTMLSelectElement).value));
}

/** 恢复默认排版的二次确认开关 */
const showResetConfirm = ref(false);

/**
 * 恢复默认排版：只重置「字体种类 / 界面字重 / 缩放 / 正文字号·行距·字重 / 卡片字号」
 * 七个排版变量；卡片大小（cardSize）与主题模式（theme）不在其中，绝不会被误伤。
 * 七个值一次性同步赋值 → App.vue 的 watch 会合并成一次 300ms 防抖写盘。
 */
function resetTypography() {
  uiFontFamily.value = TYPOGRAPHY_DEFAULTS.fontFamily;
  uiFontWeight.value = TYPOGRAPHY_DEFAULTS.uiFontWeight;
  globalFontScale.value = TYPOGRAPHY_DEFAULTS.globalScale;
  readerFontSize.value = TYPOGRAPHY_DEFAULTS.readerFontSize;
  readerLineHeight.value = TYPOGRAPHY_DEFAULTS.readerLineHeight;
  readerFontWeight.value = TYPOGRAPHY_DEFAULTS.readerFontWeight;
  cardFontSize.value = TYPOGRAPHY_DEFAULTS.cardFontSize;
  showResetConfirm.value = false;
}

const REPO_URL = "https://github.com/Einsteinband/AoE2-Mod-Manager";
const AUTHOR_URL = "https://github.com/Einsteinband";
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

async function openAuthor() {
  try {
    await openExternalUrl(AUTHOR_URL);
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
const netMessage = ref<string | null>(null);
const netLoading = ref(false);

// ---------------- 网络：在线数据缓存（v0.6） ----------------

const cacheStat = ref<CacheOverview | null>(null);
const cacheBusy = ref(false);
const cacheMessage = ref<string | null>(null);
const cacheError = ref<string | null>(null);

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

/** 缓存概览文案：JSON 记录 + 封面图分开报，0 条时明确说“暂无缓存” */
const cacheStatusText = computed(() => {
  const stat = cacheStat.value;
  if (!stat) return t("cache.reading");
  if (stat.entries <= 0 && stat.imageEntries <= 0) return t("cache.empty");
  const json = t("cache.stat", { n: stat.entries, size: formatBytes(stat.bytes) });
  const images = t("cache.imageLine", {
    n: stat.imageEntries,
    size: formatBytes(stat.imageBytes),
  });
  return `${json} · ${images}`;
});

async function loadCacheStat() {
  try {
    cacheStat.value = await onlineCacheStat();
  } catch {
    cacheStat.value = null;
  }
}

/** 清理：Rust 同时删 online_cache.json 与 image_cache，完成后重读概览 */
async function doClearCache() {
  if (cacheBusy.value) return;
  cacheBusy.value = true;
  cacheError.value = null;
  cacheMessage.value = null;
  try {
    const report = await clearOnlineCache();
    const removed = report.entriesRemoved > 0 || report.imagesRemoved > 0 || report.removed;
    cacheMessage.value = removed
      ? t("cache.cleared", { n: report.entriesRemoved, images: report.imagesRemoved })
      : t("cache.clearedEmpty");
    await loadCacheStat();
  } catch (e) {
    cacheError.value = t("cache.error", { msg: describe(e) });
  } finally {
    cacheBusy.value = false;
  }
}

/** 折叠面板里那句“当前走哪条链路” */
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
    netMessage.value = t(enabled ? "online.rememberOn" : "online.rememberOff");
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
      netMessage.value = t("online.netSaved", {
        proxy: view.effectiveProxy ?? t("online.netDirectWord"),
      });
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
const translateError = ref<string | null>(null);
const translateMessage = ref<string | null>(null);

/** 下拉框的值："" = 跟随界面语言 */
const targetChoice = ref("");
const engineChoice = ref("auto");
const customUrl = ref("");
/** 只输入新 key；留空 = 不修改已保存的 key */
const customKey = ref("");

const translationCache = ref<TranslationCacheStat | null>(null);
const translationCacheBusy = ref(false);
const translationCacheMessage = ref<string | null>(null);
const translationCacheError = ref<string | null>(null);

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

async function loadTranslate() {
  translateLoading.value = true;
  translateError.value = null;
  try {
    const view = await getTranslateSettings();
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = view.provider;
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = view.provider;
    customUrl.value = view.customUrl ?? "";
    customKey.value = "";
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
      customUrl: customUrl.value.trim() || null,
      customKey: customKey.value.trim() || null,
    });
    translateView.value = view;
    targetChoice.value = view.targetLanguage;
    engineChoice.value = view.provider;
    savedTargetChoice.value = view.targetLanguage;
    savedEngineChoice.value = view.provider;
    customKey.value = "";
    // 全局状态：立即更新 targetLang + langEpoch++，详情页/列表按钮文案同步刷新
    applyTranslateSettings(view, String(locale.value));
    translateMessage.value = t("settings.translateSaved");
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
  translateError.value = t("favorites.failSave", { msg: translateError.value ?? "" });
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

async function doClearTranslationCache() {
  if (translationCacheBusy.value) return;
  translationCacheBusy.value = true;
  translationCacheError.value = null;
  translationCacheMessage.value = null;
  try {
    const report = await translationCacheClear();
    translationCacheMessage.value = report.removed
      ? t("translateCache.cleared", { n: report.entriesRemoved })
      : t("translateCache.clearedEmpty");
    // 内存里的译文也要清，否则卡片还显示已删除的译文
    resetTranslations();
    await loadTranslationCache();
  } catch (e) {
    translationCacheError.value = t("translateCache.error", { msg: describe(e) });
  } finally {
    translationCacheBusy.value = false;
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

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  void loadIndexing();
  void loadLocalSearch();
  void loadNetwork();
  void loadCacheStat();
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
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  stopTitleJobPoll();
  if (cooldownTimer !== null) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal settings-modal">
      <header class="modal-head">
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
            🎨 {{ ui.tabAppearance }}
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
            ☁ {{ t("nav.online") }}
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
                <span class="row-title">{{ ui.rootTitle }}</span>
                <span class="row-note mono">{{ props.rootPath || ui.rootEmpty }}</span>
              </div>
              <button type="button" class="settings-check" @click="emit('change-root')">
                {{ ui.changeRoot }}
              </button>
            </div>

            <p class="settings-hint">{{ ui.rootNote }}</p>
          </section>

          <!-- 外观（v2.0 新增）：主题模式 + 卡片大小滑块 -->
          <section v-else-if="tab === 'appearance'" class="settings-card">
            <!-- v2.2：主题模式（深色 / 明亮），点一下立即换肤，不重载页面 -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.themeTitle }}</span>
                <span class="row-note">{{ ui.themeNote }}</span>
              </div>
              <div class="settings-segment" role="radiogroup" :aria-label="ui.themeTitle">
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

            <!-- 【界面】：字体种类 + 全局缩放（卡片大小仍归这一层） -->
            <h3 class="settings-group-title">{{ ui.groupUi }}</h3>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.fontFamilyTitle }}</span>
                <span class="row-note">{{ ui.fontFamilyNote }}</span>
              </div>
              <select
                class="settings-select typography-select"
                :value="uiFontFamily"
                :aria-label="ui.fontFamilyTitle"
                @change="applyFontFamily"
              >
                <option v-for="opt in FONT_FAMILY_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.uiFontWeightTitle }}</span>
                <span class="row-note">{{ ui.uiFontWeightNote }}</span>
              </div>
              <select
                class="settings-select typography-select"
                :value="uiFontWeight"
                :aria-label="ui.uiFontWeightTitle"
                @change="applyUiFontWeight"
              >
                <option v-for="opt in UI_FONT_WEIGHT_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.globalScaleTitle }}</span>
                <span class="row-note">{{ ui.globalScaleNote }}</span>
              </div>
              <div class="settings-range-wrap">
                <input
                  v-model.number="globalFontScale"
                  class="settings-range"
                  type="range"
                  :min="GLOBAL_SCALE_MIN"
                  :max="GLOBAL_SCALE_MAX"
                  :step="GLOBAL_SCALE_STEP"
                  :aria-label="ui.globalScaleTitle"
                  :title="globalFontScale + '%'"
                  @change="snapGlobalScale"
                />
                <span class="settings-range-value">{{ globalFontScale }}%</span>
              </div>
            </div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.cardSize }}</span>
                <span class="row-note">{{ ui.cardSizeNote }}</span>
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

            <p class="settings-hint">{{ ui.cardSizeHint }}</p>

            <div class="settings-sep"></div>

            <!-- 【正文阅读】：字号 12–24px / 行距 / 字重 -->
            <h3 class="settings-group-title">{{ ui.groupReader }}</h3>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.readerFontSizeTitle }}</span>
                <span class="row-note">{{ ui.readerFontSizeNote }}</span>
              </div>
              <div class="settings-range-wrap">
                <input
                  v-model.number="readerFontSize"
                  class="settings-range"
                  type="range"
                  :min="READER_FONT_SIZE_MIN"
                  :max="READER_FONT_SIZE_MAX"
                  step="1"
                  :aria-label="ui.readerFontSizeTitle"
                  :title="readerFontSize + 'px'"
                  @change="snapReaderFontSize"
                />
                <span class="settings-range-value">{{ readerFontSize }}px</span>
              </div>
            </div>

            <div class="settings-sep"></div>

            <!-- 行距（1.4 / 1.6 / 1.8） -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.lineHeightTitle }}</span>
                <span class="row-note">{{ ui.lineHeightNote }}</span>
              </div>
              <select
                class="settings-select typography-select"
                :value="readerLineHeight"
                :aria-label="ui.lineHeightTitle"
                @change="applyLineHeight"
              >
                <option v-for="opt in LINE_HEIGHT_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="settings-sep"></div>

            <!-- 字重（400 / 500） -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.fontWeightTitle }}</span>
                <span class="row-note">{{ ui.fontWeightNote }}</span>
              </div>
              <select
                class="settings-select typography-select"
                :value="readerFontWeight"
                :aria-label="ui.fontWeightTitle"
                @change="applyFontWeight"
              >
                <option v-for="opt in FONT_WEIGHT_OPTIONS_LABELED" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="settings-sep"></div>

            <!-- 【卡片列表】：字号 10–16px -->
            <h3 class="settings-group-title">{{ ui.groupCard }}</h3>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ ui.cardFontSizeTitle }}</span>
                <span class="row-note">{{ ui.cardFontSizeNote }}</span>
              </div>
              <div class="settings-range-wrap">
                <input
                  v-model.number="cardFontSize"
                  class="settings-range"
                  type="range"
                  :min="CARD_FONT_SIZE_MIN"
                  :max="CARD_FONT_SIZE_MAX"
                  step="1"
                  :aria-label="ui.cardFontSizeTitle"
                  :title="cardFontSize + 'px'"
                  @change="snapCardFontSize"
                />
                <span class="settings-range-value">{{ cardFontSize }}px</span>
              </div>
            </div>

            <p class="settings-hint">{{ ui.typographyHint }}</p>

            <!-- v3.0：恢复默认排版（只盖排版七项，不动卡片大小与主题） -->
            <div class="typography-reset-row">
              <button type="button" class="typography-reset" @click="showResetConfirm = true">
                {{ ui.resetTypography }}
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
            <div v-else-if="netMessage" class="settings-msg">{{ netMessage }}</div>
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

            <p class="settings-hint">{{ ui.rootPath }}</p>
          </section>

          <!-- 在线模组：翻译 / 翻译缓存 / 批量标题翻译 / 在线数据缓存 -->
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
                <option value="mymemory">MyMemory</option>
                <option value="custom">{{ t("settings.translateEngineCustom") }}</option>
              </select>
            </div>

            <template v-if="engineChoice === 'custom'">
              <input
                v-model="customUrl"
                class="settings-input"
                type="text"
                placeholder="https://api.example.com/translate"
                spellcheck="false"
                :disabled="translateSaving"
              />
              <input
                v-model="customKey"
                class="settings-input"
                type="password"
                :placeholder="
                  translateView?.customKeySet ? t('settings.translateCustomKeyKept') : t('settings.translateCustomKey')
                "
                spellcheck="false"
                autocomplete="off"
                :disabled="translateSaving"
              />
            </template>

            <div class="settings-actions">
              <button type="button" :disabled="translateSaving || translateLoading" @click="saveTranslate">
                {{ translateSaving ? t("online.saving") : t("online.save") }}
              </button>
            </div>
            <p class="settings-hint">{{ t("settings.translateAutoSave") }}</p>

            <div v-if="translateError" class="settings-msg error">{{ translateError }}</div>
            <div v-else-if="translateMessage" class="settings-msg">{{ translateMessage }}</div>

            <div class="settings-sep"></div>

            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("translateCache.sectionTitle") }}</span>
                <span class="row-note">{{ translationCacheText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="translationCacheBusy"
                :title="t('translateCache.clearButton')"
                @click="doClearTranslationCache"
              >
                <span v-if="translationCacheBusy" class="spinner"></span>
                {{ translationCacheBusy ? t("translateCache.clearing") : t("translateCache.clearButton") }}
              </button>
            </div>

            <div v-if="translationCacheError" class="settings-msg error">{{ translationCacheError }}</div>
            <div v-else-if="translationCacheMessage" class="settings-msg">{{ translationCacheMessage }}</div>

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

            <!-- v0.6：在线数据缓存（SWR）清理入口 -->
            <div class="settings-row">
              <div class="row-label">
                <span class="row-title">{{ t("cache.sectionTitle") }}</span>
                <span class="row-note">{{ cacheStatusText }}</span>
              </div>
              <button
                type="button"
                class="settings-check"
                :disabled="cacheBusy"
                :title="t('cache.clearButton')"
                @click="doClearCache"
              >
                <span v-if="cacheBusy" class="spinner"></span>
                {{ cacheBusy ? t("cache.clearing") : t("cache.clearButton") }}
              </button>
            </div>

            <div v-if="cacheError" class="settings-msg error">{{ cacheError }}</div>
            <div v-else-if="cacheMessage" class="settings-msg">{{ cacheMessage }}</div>
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
              <span class="row-title">{{ t("settings.author") }}</span>
              <button type="button" class="about-link" @click="openAuthor">{{ AUTHOR_URL }}</button>
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
    </div>

    <!-- v3.0：恢复默认排版的二次确认（叠在设置弹窗之上） -->
    <ConfirmDialog
      v-if="showResetConfirm"
      :title="ui.resetTypographyTitle"
      :message="ui.resetTypographyMessage"
      :confirm-label="ui.resetTypographyConfirm"
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
  letter-spacing: 0.8px;
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
  font-weight: 600;
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
  font-weight: 500;
  letter-spacing: 2px;
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
  letter-spacing: 0.8px;
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
  letter-spacing: 0.8px;
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
  letter-spacing: 0.8px;
}
.settings-segment-btn:hover:not(.active) {
  color: var(--parch);
  background: var(--bg-hover);
}
.settings-segment-btn.active {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-dim);
  font-weight: 600;
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
  letter-spacing: 0.6px;
}
/* 根目录路径回显：等宽字体 + 允许折行，长路径不会把右侧按钮顶出去 */
.row-note.mono {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: calc(10.5px * var(--global-scale));
  word-break: break-all;
  color: var(--parch-dim);
}

.settings-status {
  margin: 0;
  font-size: calc(11.5px * var(--global-scale));
  line-height: 1.7;
  color: var(--muted);
  letter-spacing: 0.4px;
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
  letter-spacing: 0.8px;
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
  letter-spacing: 1px;
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
  letter-spacing: 0.6px;
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
  letter-spacing: 1px;
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
</style>
