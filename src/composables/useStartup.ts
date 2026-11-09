/**
 * 启动引导：onMounted 时的全量初始化流程。
 *
 * 包括：登录态校验、下载队列初始化、收藏数据加载、设置回填（主题/排版/语言/翻译）、
 * 本地模组扫描、下载任务完成后的自动重扫、版本更新弹窗调度。
 */
import { onMounted, onBeforeUnmount, watch, type Ref } from "vue";
import {
  applyLocale,
  detectSystemLocale,
  normalizeLocale,
} from "../i18n";
import { getSettings, saveTypographyPrefs, setLocale as persistLocale, type TypographyPrefs } from "../api";
import {
  initDownloadQueue,
  onTaskSettled,
} from "../online/downloadQueue";
import { ensureStartupSession } from "../sessionState";
import { ensureUserData } from "../userData";
import { hydrateFavoriteMeta } from "../favoriteMeta";
import { getTranslateSettings } from "../online/service";
import { applyTranslateSettings, syncUiLocale } from "../online/translation";
import type { ModEntry } from "../types";

export function useStartup(options: {
  mode: Ref<"local" | "online">;
  localSearchEnabled: Ref<boolean>;
  locale: Ref<string>;
  scan: {
    loadCandidates: () => Promise<void>;
    report: Ref<{ rootExists: boolean; mods: ModEntry[] } | null>;
    errorRaw: Ref<string | null>;
    normalizeError: (e: unknown) => string;
    showWizard: Ref<boolean>;
  };
  refresh: (root?: string | null) => Promise<void>;
  applyViewPrefs: (settings: any) => void;
  theme: {
    value: string;
  };
  applyTheme: (next: any) => void;
  normalizeTheme: (raw: unknown) => any;
  markThemeReady: () => void;
  normalizeTypography: (raw: Record<string, unknown>) => TypographyPrefs;
  applyLoadedTypography: (prefs: TypographyPrefs) => void;
  markTypographyReady: (prefs: TypographyPrefs) => void;
  sort: {
    blocksRescan: Ref<boolean>;
    exitSortMode: () => void;
  };
  showToast: (text: string, kind?: "ok" | "error") => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  onSortHotkey: (e: KeyboardEvent) => void;
  runStartupUpdateCheck: () => void;
  scheduleVersionNotes: () => void;
}) {
  const {
    mode,
    localSearchEnabled,
    locale,
    scan,
    refresh,
    applyViewPrefs,
    theme,
    applyTheme,
    normalizeTheme,
    markThemeReady,
    normalizeTypography,
    applyLoadedTypography,
    markTypographyReady,
    sort,
    showToast,
    t,
    onSortHotkey,
    runStartupUpdateCheck,
    scheduleVersionNotes,
  } = options;

  /** 下载任务落地订阅（只在本地页需要：装完重扫，占位卡才会变回真实卡片） */
  let offDownloadSettled: (() => void) | null = null;

  onMounted(async () => {
    // v1.3：启动即静默校验登录态——持久登录关闭时 Rust 侧会自己跑一次隐藏窗口静默重登，
    // 同样不 await、不阻塞首屏，底栏先显示「正在恢复登录…」再变 🟢/⚪
    void ensureStartupSession();
    // 下载队列：全应用只注册一次进度事件（与在线页是否挂载无关）
    void initDownloadQueue();
    // v0.5：收藏/备注只读一次磁盘，失败不阻塞本地页
    void ensureUserData().catch(() => undefined);
    // v0.6：已卸载 / 未安装收藏的标题与分类先用在线缓存补一次（零网络，等收藏表读完再补）
    void ensureUserData()
      .then(() => hydrateFavoriteMeta())
      .catch(() => undefined);
    // v0.6：下载队列里任何一个模组安装完成 → 重扫一次，让「未安装」占位卡变回真实卡片
    offDownloadSettled = onTaskSettled((task) => {
      if (task.status !== "done") return;
      if (mode.value !== "local") return;
      void refresh();
    });
    // 启动即检查一次新版本（只此一次，失败静默）
    void runStartupUpdateCheck();
    try {
      await scan.loadCandidates();
      const settings: any = await getSettings();
      // v1.2：在线页本地搜索框开关（默认关闭，设置页可改）
      localSearchEnabled.value = settings.enableLocalSearch === true;
      // v1.6：视图模式与卡片大小（老 settings.json 缺字段 → 后端给 grid / 200）
      applyViewPrefs(settings);
      // v2.2：主题（老 settings.json 缺字段 → 后端给 dark）；缓存与设置不一致时以设置为准
      theme.value = normalizeTheme(settings.theme) as "dark" | "light";
      applyTheme(theme.value);
      markThemeReady();
      // v2.4：三层排版（老 settings.json 缺字段 → 后端已给默认值；
      // v2.3 的扁平字段由 Rust 侧 migrate_legacy_typography 一次性搬进 reader_*）
      const typoPrefs = normalizeTypography({
        fontFamily: settings.uiFontFamily,
        uiFontWeight: settings.uiFontWeight,
        globalScale: settings.globalScale,
        readerFontSize: settings.readerFontSize,
        readerLineHeight: settings.readerLineHeight,
        readerFontWeight: settings.readerFontWeight,
        cardFontSize: settings.cardFontSize,
        cardFontWeight: settings.cardFontWeight,
      });
      applyLoadedTypography(typoPrefs);
      // 回填后同步"已落盘值"，避免监听器把刚读到的值又写回去
      markTypographyReady(typoPrefs);
      // v3.0：旧字体名（sans-serif / serif / system-ui）静默重写成 hei / system，
      // 顺手把 settings.json 里的旧值覆盖掉（否则每次启动都要重新归一化一遍）。
      if (String(settings.uiFontFamily ?? "").trim().toLowerCase() !== typoPrefs.fontFamily) {
        void saveTypographyPrefs(typoPrefs).catch((e) => {
          console.warn("[typography] failed to rewrite the legacy font config", e);
        });
      }
      // 语言：已保存的优先，否则按系统语言决定（并把结果回写，以后不再依赖 navigator）
      const savedLocale = normalizeLocale(settings.locale);
      applyLocale(savedLocale ?? detectSystemLocale());
      if (!savedLocale) {
        void persistLocale(locale.value).catch(() => undefined);
      }
      // 翻译目标语言：空串 = 跟随界面语言（此时取刚应用完的 UI 语言）
      try {
        const translateView = await getTranslateSettings();
        applyTranslateSettings(translateView, String(locale.value));
      } catch (e) {
        console.warn("[translation] failed to read translation settings", e);
      }
      if (settings.modRoot) {
        await refresh(settings.modRoot);
        // 记录的路径被移动 / 磁盘未连接时，直接回到引导而不是只留一个错误面板
        if (!scan.report.value || !scan.report.value.rootExists) scan.showWizard.value = true;
      } else {
        scan.showWizard.value = true;
      }
    } catch (e) {
      scan.errorRaw.value = scan.normalizeError(e);
      scan.showWizard.value = true;
    }
    // v3.1：版本变了才弹「新版本特性」（首次启动同样算一次，走兜底文案）
    scheduleVersionNotes();
  });

  /**
   * UI 语言变化 → 「跟随界面语言」模式下，翻译目标语言立即联动，
   * 列表与详情会因 langEpoch 自增而重新只读预热（无需重启、不发网络）。
   */
  watch(locale, (next) => {
    syncUiLocale(String(next));
  });

  /** 切到在线页时强制退出排序模式（本地网格会被销毁） */
  watch(mode, (next) => {
    if (next === "local") return;
    // 有未保存改动就不让切页：切走会销毁本地网格，等于静默丢弃
    if (sort.blocksRescan.value) {
      mode.value = "local";
      showToast(t("sort.unsavedBlock"), "error");
      return;
    }
    sort.exitSortMode();
  });

  /** 排序模式下 Ctrl+S 手动保存 */
  window.addEventListener("keydown", onSortHotkey);

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onSortHotkey);
    offDownloadSettled?.();
  });
}
