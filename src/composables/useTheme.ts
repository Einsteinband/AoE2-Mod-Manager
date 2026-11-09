/**
 * 主题切换（dark 深色羊皮纸 / light 明亮米白）
 *
 * settings.json 是唯一真源；localStorage 只做首帧防闪缓存：
 * script setup 在首次渲染前同步执行，先打上缓存主题，onMounted 再用 settings.json 校正。
 */
import { ref, watch } from "vue";
import { setTheme } from "../api";

export type Theme = "dark" | "light";
const THEME_CACHE_KEY = "aoe2mm.theme";

/** 主题归一化：只认 light，其余一律 dark（与 Rust 侧 models::normalize_theme 同口径） */
export function normalizeTheme(raw: unknown): Theme {
  return String(raw ?? "").toLowerCase() === "light" ? "light" : "dark";
}

/** 读首帧缓存（隐私模式下 localStorage 可能抛错：静默回落 dark） */
function readCachedTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_CACHE_KEY));
  } catch {
    return "dark";
  }
}

/**
 * 应用主题：只改 <html data-theme>，CSS 变量整体换值，
 * 不重载页面、不重建组件树、不动滚动位置。
 */
export function applyTheme(next: Theme) {
  document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, next);
  } catch {
    /* 忽略：settings.json 仍是唯一真源 */
  }
}

export function useTheme() {
  const theme = ref<Theme>(readCachedTheme());
  /** 首屏回填 settings.json 期间禁止回写，避免"读 → 写 → 再读"的无谓往返 */
  let themeReady = false;

  // 脚本建立阶段就把主题打到 <html> 上（早于首帧渲染，避免开屏闪一下另一个主题）
  applyTheme(theme.value);

  /** 切换主题：先改 DOM（瞬间生效），再异步落盘；写盘失败只提示，不回滚界面 */
  watch(theme, (next) => {
    applyTheme(next);
    if (!themeReady) return;
    // v2.3：invoke 统一收口到 api.ts（setTheme），App.vue 不再直接碰 Tauri 命令
    void setTheme(next).catch((e) => {
      console.warn("[theme] failed to save theme", e);
    });
  });

  /** onMounted 回填 settings.json 后调用，开启落盘 */
  function markThemeReady() {
    themeReady = true;
  }

  return {
    theme,
    applyTheme,
    normalizeTheme,
    markThemeReady,
  };
}
