/**
 * 强调色主题注册表：应用内唯一的强调色定义来源。
 *
 * 新增预设强调色只需在此追加一项；设置页选项、CSS 变量注入、合法值归一化都从这里推导，
 * 不需要再到多个 Vue 组件重复添加颜色选项或映射。
 *
 * - 现有八档色值；原四档逐字节保留，未重新设计。
 * - 成功 / 警告 / 错误 / 信息等状态语义色不在此表，各自使用独立 CSS 变量族。
 * - 稳定 ID 必须与 Rust `models::normalize_accent` 合法值一致。
 */

/** 单个明暗档位的强调色调色板（与 style.css 的 `--accent-*` 变量一一对应） */
export interface AccentPalette {
  /** `--accent` 主强调色 */
  accent: string;
  /** `--accent-bright` 高光 */
  bright: string;
  /** `--accent-dim` 暗调 */
  dim: string;
  /** `--accent-light` 浅调 */
  light: string;
  /** `--accent-text` 强调色文字 */
  text: string;
  /** `--accent-rgb` "r, g, b" 三元组，供 `rgba()` 透明叠加 */
  rgb: string;
  /** `--installed-card-bg` 已安装卡片信息区底色 */
  installedCardBg: string;
}

export interface AccentTheme {
  /** 稳定 ID，与 Rust `normalize_accent` 合法值一致 */
  id: string;
  /** 设置页显示名的 i18n key（`settingsUi.accent*`） */
  labelKey: string;
  dark: AccentPalette;
  light: AccentPalette;
}

/** 字段 → CSS 变量名映射；App.vue 按此把调色板写进根节点样式 */
export const ACCENT_CSS_VARS: ReadonlyArray<{
  field: keyof AccentPalette;
  cssVar: string;
}> = [
  { field: "accent", cssVar: "--accent" },
  { field: "bright", cssVar: "--accent-bright" },
  { field: "dim", cssVar: "--accent-dim" },
  { field: "light", cssVar: "--accent-light" },
  { field: "text", cssVar: "--accent-text" },
  { field: "rgb", cssVar: "--accent-rgb" },
  { field: "installedCardBg", cssVar: "--installed-card-bg" },
];

/** 强调色注册表（blue / amber / gold / brick / purple / green / cyan / pink，顺序与设置页选项一致） */
export const ACCENT_THEMES: readonly AccentTheme[] = [
  {
    id: "blue",
    labelKey: "settingsUi.accentBlue",
    dark: {
      accent: "#5b8fc9",
      bright: "#82b3e6",
      dim: "#3f6a96",
      light: "#9cc6ec",
      text: "#82b3e6",
      rgb: "91, 143, 201",
      installedCardBg: "#243344",
    },
    light: {
      accent: "#3c6a99",
      bright: "#4f7fae",
      dim: "#2f5578",
      light: "#6392bd",
      text: "#3c6a99",
      rgb: "60, 106, 153",
      installedCardBg: "#d8e7f3",
    },
  },
  {
    id: "amber",
    labelKey: "settingsUi.accentAmber",
    dark: {
      accent: "#d98a3d",
      bright: "#f0ab5e",
      dim: "#9c6128",
      light: "#f7c487",
      text: "#f0ab5e",
      rgb: "217, 138, 61",
      installedCardBg: "#332717",
    },
    light: {
      accent: "#b56a28",
      bright: "#cf7f36",
      dim: "#8f541f",
      light: "#db9249",
      text: "#b56a28",
      rgb: "181, 106, 40",
      installedCardBg: "#f2e2ca",
    },
  },
  {
    id: "gold",
    labelKey: "settingsUi.accentGold",
    dark: {
      accent: "#c9a24d",
      bright: "#e8c97a",
      dim: "#8a6f33",
      light: "#f3d994",
      text: "#e8c97a",
      rgb: "201, 162, 77",
      installedCardBg: "#30281a",
    },
    light: {
      accent: "#8a6f33",
      bright: "#a8823a",
      dim: "#6f5a29",
      light: "#b08a3c",
      text: "#8a6f33",
      rgb: "138, 111, 51",
      installedCardBg: "#eee2c4",
    },
  },
  {
    id: "brick",
    labelKey: "settingsUi.accentBrick",
    dark: {
      accent: "#c25b4a",
      bright: "#dd7d68",
      dim: "#8f3f33",
      light: "#ea9684",
      text: "#dd7d68",
      rgb: "194, 91, 74",
      installedCardBg: "#32221e",
    },
    light: {
      accent: "#a44434",
      bright: "#b85644",
      dim: "#83362a",
      light: "#c96a58",
      text: "#a44434",
      rgb: "164, 68, 52",
      installedCardBg: "#f0d9d4",
    },
  },
  {
    id: "purple",
    labelKey: "settingsUi.accentPurple",
    dark: {
      accent: "#8b72c4",
      bright: "#ac93e0",
      dim: "#5f4d8a",
      light: "#c2b0ec",
      text: "#ac93e0",
      rgb: "139, 114, 196",
      installedCardBg: "#2c2638",
    },
    light: {
      accent: "#6a55a3",
      bright: "#7d67b5",
      dim: "#534180",
      light: "#9783c4",
      text: "#6a55a3",
      rgb: "106, 85, 163",
      installedCardBg: "#e7e1f3",
    },
  },
  {
    id: "green",
    labelKey: "settingsUi.accentGreen",
    dark: {
      accent: "#6fa85f",
      bright: "#93c983",
      dim: "#4d7a41",
      light: "#a9d69a",
      text: "#93c983",
      rgb: "111, 168, 95",
      installedCardBg: "#26331f",
    },
    light: {
      accent: "#4f8043",
      bright: "#639457",
      dim: "#3d6534",
      light: "#7ea872",
      text: "#4f8043",
      rgb: "79, 128, 67",
      installedCardBg: "#e2edda",
    },
  },
  {
    id: "cyan",
    labelKey: "settingsUi.accentCyan",
    dark: {
      accent: "#55a6b0",
      bright: "#7dc4cd",
      dim: "#3c7680",
      light: "#9ed6dc",
      text: "#7dc4cd",
      rgb: "85, 166, 176",
      installedCardBg: "#1f3236",
    },
    light: {
      accent: "#3d828c",
      bright: "#5197a1",
      dim: "#2f656d",
      light: "#6fa9b1",
      text: "#3d828c",
      rgb: "61, 130, 140",
      installedCardBg: "#dbecee",
    },
  },
  {
    id: "pink",
    labelKey: "settingsUi.accentPink",
    dark: {
      accent: "#c9779b",
      bright: "#e197b6",
      dim: "#8f5370",
      light: "#ecadc6",
      text: "#e197b6",
      rgb: "201, 119, 155",
      installedCardBg: "#352129",
    },
    light: {
      accent: "#a85679",
      bright: "#bd6c8d",
      dim: "#87435f",
      light: "#cf87a3",
      text: "#a85679",
      rgb: "168, 86, 121",
      installedCardBg: "#f3dce5",
    },
  },
];

export const ACCENT_THEME_IDS: readonly string[] = ACCENT_THEMES.map((theme) => theme.id);

/** 强调色类型：从注册表推导，不在其他前端文件重复维护联合字面量 */
export type UiAccent = string;

/** 默认强调色（与 Rust `default_accent` 一致） */
export const DEFAULT_ACCENT: UiAccent = "gold";

export function isAccentId(value: string): value is UiAccent {
  return ACCENT_THEME_IDS.includes(value);
}

/** 非法 / 未知值安全回退到默认 gold（与 Rust `normalize_accent` 口径一致） */
export function normalizeAccentTheme(raw: unknown): UiAccent {
  const v = String(raw ?? "").trim().toLowerCase();
  return isAccentId(v) ? v : DEFAULT_ACCENT;
}

export function getAccentTheme(id: UiAccent): AccentTheme {
  return (
    ACCENT_THEMES.find((theme) => theme.id === id) ??
    ACCENT_THEMES.find((theme) => theme.id === DEFAULT_ACCENT)!
  );
}

/** 取某明暗档位的调色板 */
export function getAccentPalette(id: UiAccent, mode: "dark" | "light"): AccentPalette {
  const theme = getAccentTheme(id);
  return mode === "light" ? theme.light : theme.dark;
}
