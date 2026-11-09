/**
 * 三层排版（界面 / 正文阅读 / 卡片列表）
 *
 * settings.json 是唯一真源，localStorage 只做首帧防闪缓存。
 * 变量写在 <html> 的 inline style 上 —— 只有一处真源，且必然盖住 :root / [data-theme] 里的默认值，
 * 因此拖动滑块时全站（侧边栏 / 顶栏 / 设置弹窗 / 卡片 / 详情正文）都是逐帧联动的。
 */
import { ref, watch, type Ref } from "vue";
import {
  FONT_FAMILY_VARS,
  TYPOGRAPHY_DEFAULTS,
  normalizeTypography,
  saveTypographyPrefs,
  type TypographyPrefs,
  type UiFontFamily,
} from "../api";

const TYPO_CACHE_KEY = "aoe2mm.typography.v2";

/** 读首帧缓存；缺失 / 损坏 / 隐私模式抛错 → 全部回出厂默认值 */
function readCachedTypography(): TypographyPrefs {
  try {
    const raw = window.localStorage.getItem(TYPO_CACHE_KEY);
    if (!raw) return { ...TYPOGRAPHY_DEFAULTS };
    return normalizeTypography(JSON.parse(raw));
  } catch {
    return { ...TYPOGRAPHY_DEFAULTS };
  }
}

export function useTypography(currentLocale: Ref<string>) {
  /**
   * 把三层排版写到 <html> 的 style 上（所见即所得的核心）：
   *   --app-font-family / --ui-font-weight / --global-scale   → 界面层（侧边栏、顶栏、设置弹窗…）
   *   --reader-font-size / -line-height / -font-weight → 正文阅读层（详情描述…）
   *   --card-font-size                                 → 卡片列表层（卡片标题 / 元信息）
   * 三者互不干扰；只改 CSS 变量，不重建组件树、不丢滚动位置。
   * 字体种类只切「用哪一套字体栈」，真字体名在 style.css 的 --font-* 里。
   */
  function applyTypography(next: TypographyPrefs) {
    const root = document.documentElement;
    const prefs = normalizeTypography(next);
    // v3.5：英文界面额外套一层「西文专用栈」—— "Segoe UI" 打头，再接用户选的中文字体做中文 fallback。
    // 中文界面永远忽略这个开关，字体顺序与改动前完全一致。
    const baseFamily = FONT_FAMILY_VARS[prefs.fontFamily];
    const useLatinStack = prefs.latinFont && currentLocale.value !== "zh";
    root.style.setProperty(
      "--app-font-family",
      useLatinStack ? `var(--font-latin), ${baseFamily}` : baseFamily,
    );
    root.style.setProperty("--ui-font-weight", String(prefs.uiFontWeight));
    // 强调层（标题 / 按钮）：常规时 600、加粗时 700。
    // 这样「界面字重」既作用于正文级文字，又不会把标题和正文拉成同一档粗度。
    root.style.setProperty("--ui-font-weight-strong", prefs.uiFontWeight >= 600 ? "700" : "600");
    root.style.setProperty("--global-scale", String(prefs.globalScale / 100));
    root.style.setProperty("--reader-font-size", `${prefs.readerFontSize}px`);
    root.style.setProperty("--reader-line-height", String(prefs.readerLineHeight));
    root.style.setProperty("--reader-font-weight", String(prefs.readerFontWeight));
    root.style.setProperty("--card-font-size", `${prefs.cardFontSize}px`);
    root.style.setProperty("--card-font-weight", String(prefs.cardFontWeight));
    try {
      window.localStorage.setItem(TYPO_CACHE_KEY, JSON.stringify(prefs));
    } catch {
      /* 忽略：settings.json 仍是唯一真源 */
    }
  }

  const cachedTypography = readCachedTypography();
  const uiFontFamily = ref<UiFontFamily>(cachedTypography.fontFamily);
  const uiFontWeight = ref<number>(cachedTypography.uiFontWeight);
  const globalFontScale = ref<number>(cachedTypography.globalScale);
  const readerFontSize = ref<number>(cachedTypography.readerFontSize);
  const readerLineHeight = ref<number>(cachedTypography.readerLineHeight);
  const readerFontWeight = ref<number>(cachedTypography.readerFontWeight);
  const cardFontSize = ref<number>(cachedTypography.cardFontSize);
  const cardFontWeight = ref<number>(cachedTypography.cardFontWeight);
  /** v3.5：英文界面西文专用字体栈开关（中文界面不生效，设置里也只在英文下显示） */
  const latinFont = ref<boolean>(cachedTypography.latinFont);

  /** 当前八项快照（归一化后的值，保证和 Rust 侧写盘结果一致） */
  function currentTypography(): TypographyPrefs {
    return normalizeTypography({
      fontFamily: uiFontFamily.value,
      uiFontWeight: uiFontWeight.value,
      globalScale: globalFontScale.value,
      readerFontSize: readerFontSize.value,
      readerLineHeight: readerLineHeight.value,
      readerFontWeight: readerFontWeight.value,
      cardFontSize: cardFontSize.value,
      cardFontWeight: cardFontWeight.value,
      latinFont: latinFont.value,
    });
  }

  /** 首屏回填 settings.json 期间禁止回写（与 themeReady 同理） */
  let typographyReady = false;
  /** 最近一次已经写进 settings.json 的值：避免"启动回填 → 监听器又写一遍"的无谓写盘 */
  let persistedTypography: TypographyPrefs = { ...cachedTypography };
  /** 连续拖动合并成一次落盘：300ms 内无新值才写 settings.json */
  let typographyTimer: ReturnType<typeof setTimeout> | null = null;

  function sameTypography(a: TypographyPrefs, b: TypographyPrefs): boolean {
    return (
      a.fontFamily === b.fontFamily &&
      a.uiFontWeight === b.uiFontWeight &&
      a.globalScale === b.globalScale &&
      a.readerFontSize === b.readerFontSize &&
      a.readerLineHeight === b.readerLineHeight &&
      a.readerFontWeight === b.readerFontWeight &&
      a.cardFontSize === b.cardFontSize &&
      a.cardFontWeight === b.cardFontWeight &&
      a.latinFont === b.latinFont
    );
  }

  // 脚本建立阶段先打上缓存值，避免开屏时字号 / 字体跳一下
  applyTypography(cachedTypography);

  /**
   * v3.5：语言切换不写盘，只影响「要不要用西文专用字体栈」这一个判断，
   * 所以切中 / 英时直接重算一次 CSS 变量即可（中文 → 回落到用户选的中文字体）。
   */
  watch(currentLocale, () => {
    applyTypography(currentTypography());
  });

  watch(
    [uiFontFamily, uiFontWeight, globalFontScale, readerFontSize, readerLineHeight, readerFontWeight, cardFontSize, cardFontWeight, latinFont],
    () => {
      const next = currentTypography();
      // 1）先改 DOM：即时预览（不重建组件树、不丢滚动位置）
      applyTypography(next);
      if (!typographyReady) return;
      // 2）值没变就不写盘
      if (sameTypography(next, persistedTypography)) return;
      // 3）合并连续拖动，300ms 后只写最后一次
      if (typographyTimer) clearTimeout(typographyTimer);
      typographyTimer = setTimeout(() => {
        if (sameTypography(next, persistedTypography)) return;
        persistedTypography = { ...next };
        void saveTypographyPrefs(next).catch((e) => {
          console.warn("[typography] failed to save typography prefs", e);
        });
      }, 300);
    },
  );

  /** onMounted 回填 settings.json 后调用，开启落盘 */
  function markTypographyReady(loadedPrefs: TypographyPrefs) {
    persistedTypography = { ...loadedPrefs };
    typographyReady = true;
  }

  /** 从 settings.json 回填排版值 */
  function applyLoadedTypography(loaded: TypographyPrefs) {
    uiFontFamily.value = loaded.fontFamily;
    uiFontWeight.value = loaded.uiFontWeight;
    globalFontScale.value = loaded.globalScale;
    readerFontSize.value = loaded.readerFontSize;
    readerLineHeight.value = loaded.readerLineHeight;
    readerFontWeight.value = loaded.readerFontWeight;
    cardFontSize.value = loaded.cardFontSize;
    cardFontWeight.value = loaded.cardFontWeight;
    applyTypography(loaded);
  }

  return {
    uiFontFamily,
    uiFontWeight,
    globalFontScale,
    readerFontSize,
    readerLineHeight,
    readerFontWeight,
    cardFontSize,
    cardFontWeight,
    latinFont,
    applyTypography,
    currentTypography,
    markTypographyReady,
    applyLoadedTypography,
    normalizeTypography,
  };
}
