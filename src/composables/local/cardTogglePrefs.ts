/**
 * 本地 Mod 卡片「启用/禁用按钮」的显示与样式偏好。
 *
 * - 全局单例（模块级 reactive），卡片与设置页读同一份，不存在两套状态。
 * - 只落 localStorage，不进 Rust settings：新增配置不会触碰既有 settings.json，
 *   旧版本用户缺少这两个键时自动回落到默认值（显示 + 圆形按钮）。
 * - 只控制「怎么显示控件」，不参与启用/禁用业务逻辑；隐藏时 toggleEnabled 依然原样存在。
 */
import { reactive, watch } from "vue";

export type CardToggleStyle = "circle" | "switch";

export interface CardTogglePrefs {
  /** 是否显示卡片上的启用/禁用控件 */
  show: boolean;
  /** 控件样式：原有圆形按钮 / Apple 风格开关 */
  style: CardToggleStyle;
}

const STORAGE_KEY = "aoe2mm:cardTogglePrefs";

/** 出厂默认：不显示按钮；样式仍默认原有圆形按钮（显示开关重新打开时按上次样式恢复） */
export const CARD_TOGGLE_DEFAULTS: CardTogglePrefs = { show: false, style: "circle" };

export function normalizeCardTogglePrefs(
  input: Partial<Record<keyof CardTogglePrefs, unknown>> | null | undefined,
): CardTogglePrefs {
  return {
    show: typeof input?.show === "boolean" ? input.show : CARD_TOGGLE_DEFAULTS.show,
    style: input?.style === "switch" ? "switch" : "circle",
  };
}

function readCardTogglePrefs(): CardTogglePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...CARD_TOGGLE_DEFAULTS };
    return normalizeCardTogglePrefs(JSON.parse(raw) as Partial<Record<keyof CardTogglePrefs, unknown>>);
  } catch {
    return { ...CARD_TOGGLE_DEFAULTS };
  }
}

/** 全局唯一状态：ModCard 直接读，设置页改这里立即反映到卡片 */
export const cardTogglePrefs = reactive<CardTogglePrefs>(readCardTogglePrefs());

/** 测试与设置页统一入口：合并写入（隐藏开关不会清掉已选样式） */
export function setCardTogglePrefs(patch: Partial<CardTogglePrefs>) {
  const next = normalizeCardTogglePrefs({ ...cardTogglePrefs, ...patch });
  cardTogglePrefs.show = next.show;
  cardTogglePrefs.style = next.style;
}

watch(
  cardTogglePrefs,
  () => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ show: cardTogglePrefs.show, style: cardTogglePrefs.style }),
      );
    } catch {
      /* 忽略：写不进去也不影响本次会话的即时生效 */
    }
  },
  { deep: true },
);
