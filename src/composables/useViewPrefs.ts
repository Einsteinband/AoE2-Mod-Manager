/**
 * 视图偏好（网格 / 列表、卡片大小）—— 全局唯一真源。
 *
 * 为什么单独抽出来：
 * - 本地页顶栏与在线页顶栏共用同一套控件，两个页面的切换与缩放必须**完全同步**；
 * - 落盘走 settings.json，拖滑块会连续触发，所以 350ms 防抖后再写；
 * - 首屏回填设置期间（`applyFromSettings` 之前）绝不写盘，避免“读 → 写 → 再读”的无效往返。
 *
 * 行为与原 App.vue 内联实现完全一致：只写偏好，不动扫描结果（列表不重排、滚动条不跳）。
 */
import { onBeforeUnmount, ref, watch } from "vue";
import { setViewPrefs } from "../api";

/** 卡片最小宽度（px）：与滑块 min/max/step 以及 Rust 侧 clamp 保持一致 */
export const CARD_SIZE_MIN = 160;
export const CARD_SIZE_MAX = 320;
export const CARD_SIZE_STEP = 20;
/** 默认卡片宽度（与 Rust 侧缺省值一致） */
export const CARD_SIZE_DEFAULT = 200;
/** 偏好落盘防抖 */
const PERSIST_DEBOUNCE_MS = 350;

/** 取整到 20 的倍数并夹进 160..=320（与 Rust 侧 models::clamp_card_size 同口径） */
export function clampCardSize(value: number): number {
  if (!Number.isFinite(value)) return CARD_SIZE_DEFAULT;
  const snapped = Math.round(value / CARD_SIZE_STEP) * CARD_SIZE_STEP;
  return Math.min(CARD_SIZE_MAX, Math.max(CARD_SIZE_MIN, snapped));
}

export function useViewPrefs() {
  /** 列表视图模式：grid = 大图网格（默认），list = 紧凑列表 */
  const viewMode = ref<"grid" | "list">("grid");
  /** 网格模式下卡片的**最小宽度**（px） */
  const cardSize = ref(CARD_SIZE_DEFAULT);

  /** 首屏回填 settings.json 期间不写盘 */
  let ready = false;
  let timer: number | undefined;

  /**
   * 视图偏好落盘：拖滑块会连续触发，所以 350ms 防抖后再写 settings.json。
   */
  watch([viewMode, cardSize], () => {
    if (!ready) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void setViewPrefs(viewMode.value, clampCardSize(cardSize.value)).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
  });

  /**
   * 用 settings.json 的回填值初始化（老版本缺字段时后端给 grid / 200）。
   * 调用之后才开始监听写盘。
   */
  function applyFromSettings(settings: { viewMode?: string | null; cardSize?: number | null }): void {
    viewMode.value = settings.viewMode === "list" ? "list" : "grid";
    if (typeof settings.cardSize === "number") cardSize.value = clampCardSize(settings.cardSize);
    ready = true;
  }

  onBeforeUnmount(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });

  return { viewMode, cardSize, applyFromSettings };
}

export type ViewPrefs = ReturnType<typeof useViewPrefs>;
