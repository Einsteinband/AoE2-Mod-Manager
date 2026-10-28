import { createI18n } from "vue-i18n";

/**
 * 完全模块化的语言包加载：
 *   src/i18n/locales/<语言代码>.ts   —— 文件名（不含扩展名）就是语言代码，例如 de.ts -> "de"
 *   每个语言包必须：export const label = "Deutsch";  export default { ... };
 *
 * 新增语言只需要把一个 .ts 文件扔进 locales/，前端下拉、系统语言识别、
 * 持久化校验全部自动跟上，无需改动本文件或任何组件。
 */
interface LocaleModule {
  default: Record<string, unknown>;
  label?: string;
}

export interface LocaleOption {
  value: string;
  label: string;
}

/** 语言代码在运行时才知道，因此这里不再用字面量联合类型 */
export type Locale = string;

/** 首选项：没有 en 时自动退回第一个可用语言 */
export const DEFAULT_LOCALE = "en";

const modules = import.meta.glob<LocaleModule>("./locales/*.ts", { eager: true });

function codeFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.ts$/, "").toLowerCase();
}

/** 语言代码 → 语言包（供 createI18n 使用） */
export const messages: Record<string, Record<string, unknown>> = {};
/** 顶栏下拉的选项，完全由目录内容生成 */
export const LOCALE_OPTIONS: LocaleOption[] = [];

for (const [path, mod] of Object.entries(modules)) {
  const code = codeFromPath(path);
  if (!code) continue;
  messages[code] = mod.default ?? {};
  const declared = typeof mod.label === "string" ? mod.label.trim() : "";
  LOCALE_OPTIONS.push({ value: code, label: declared || code.toUpperCase() });
}

// 默认语言（en）永远排第一，其余按语言代码排序，新增语言不需要手动插位置
LOCALE_OPTIONS.sort((a, b) => {
  if (a.value === DEFAULT_LOCALE) return -1;
  if (b.value === DEFAULT_LOCALE) return 1;
  return a.value.localeCompare(b.value);
});

export const AVAILABLE_LOCALES: string[] = LOCALE_OPTIONS.map((option) => option.value);

/** 兜底语言：优先 DEFAULT_LOCALE，否则用第一个加载到的语言包 */
const FALLBACK_LOCALE = AVAILABLE_LOCALES.includes(DEFAULT_LOCALE)
  ? DEFAULT_LOCALE
  : (AVAILABLE_LOCALES[0] ?? DEFAULT_LOCALE);

export function isSupportedLocale(code: string | null | undefined): boolean {
  return !!code && AVAILABLE_LOCALES.includes(code.trim().toLowerCase());
}

/**
 * 把任意值规整成受支持的语言代码：
 * 先精确匹配（zh / de），再按主语言匹配（zh-CN -> zh，de-AT -> de），都不匹配返回 null。
 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (AVAILABLE_LOCALES.includes(raw)) return raw;
  const primary = raw.split(/[-_]/)[0];
  if (primary && AVAILABLE_LOCALES.includes(primary)) return primary;
  return null;
}

/** 系统语言 → 受支持的语言；识别不到就用兜底语言 */
export function detectSystemLocale(): Locale {
  const candidates: string[] = [];
  if (typeof navigator !== "undefined") {
    if (navigator.language) candidates.push(navigator.language);
    for (const item of navigator.languages ?? []) candidates.push(item);
  }
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return FALLBACK_LOCALE;
}

export const i18n = createI18n({
  legacy: false,
  locale: detectSystemLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  messages: messages as unknown as Record<string, never>,
});

/** 切换语言：立即生效（不重启），并同步 <html lang> 供 WebView2 与屏幕阅读器使用 */
export function applyLocale(locale: Locale) {
  const next = normalizeLocale(locale) ?? FALLBACK_LOCALE;
  i18n.global.locale.value = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/** 供非组件环境（例如表单校验回调）使用的翻译函数 */
export function translate(key: string, params?: Record<string, unknown>): string {
  return params ? i18n.global.t(key, params) : i18n.global.t(key);
}
