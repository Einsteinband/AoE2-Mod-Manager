/**
 * 在线页的「详情面板」数据层：详情请求（缓存优先 + 单飞 + 冷却）、字段格式化、译文投影。
 *
 * 请求纪律（原样保留，这是“同一模组几秒内被请求三四次”的修复成果）：
 * 1. 本地已有 Detail 缓存 → 直接渲染，**一个请求都不发**；
 * 2. 同一个 modId 正在请求中（单飞）→ 直接返回；
 * 3. 同一个 modId 3 秒内请求过 → 直接返回（防连点 / 滚轮误触）。
 *
 * 只有用户点击卡片才会走到 `loadDetail`（不再自动选第一条 —— 自动选中会在切分类/刷新时
 * 顺带发 Detail 请求）。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { readDetailCache, usableDetailCache } from "../../online/cache";
import { messageOf } from "../../online/errors";
import { modDetail } from "../../online/service";
import {
  activeTranslation,
  canTranslateText,
  currentTargetLanguageName,
  ensureTranslation,
  isQueued,
  isShowingOriginal,
  isTranslating,
  toggleOriginal,
  translationErrorKind,
  translationOf,
  translatedTitleOf,
} from "../../online/translation";
import { localizedTagName, type OnlineMod } from "../../online/types";
import { sessionPhase } from "../../sessionState";
import { customNameOf } from "../../userData";
import type { OnlineSelection } from "./useOnlineSelection";

/** 详情请求冷却：同一个 modId 3 秒内绝不重复请求 */
const DETAIL_COOLDOWN_MS = 3_000;

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

export function useOnlineDetail(deps: {
  selection: OnlineSelection;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { selection } = deps;

  const detail = ref<Record<string, unknown> | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<string | null>(null);
  /** 下载过程中量到的真实体积（服务端详情缺 modFileSize 时兜底），由安装流程写入 */
  const measuredBytes = ref<number | null>(null);

  /** 正在请求详情的 modId（单飞） */
  const pendingDetailIds = new Set<number>();
  /** modId → 上次真正发详情请求的时间 */
  const lastDetailMs = new Map<number, number>();

  const selected = selection.selected;

  // 列表整体替换后选中项可能被清空：顺手把详情收起来，避免残留上一个模组的内容
  watch(selected, (next) => {
    if (next) return;
    detail.value = null;
    detailError.value = null;
    detailLoading.value = false;
  });

  /** 同一个 modId 是否已有请求在飞（页面选中拦截用） */
  function isPending(modId: number): boolean {
    return pendingDetailIds.has(modId);
  }

  /** 切换到另一个模组时清掉上一条详情（不发布请求） */
  function resetForSwitch(): void {
    detail.value = null;
    detailError.value = null;
    detailLoading.value = false;
    measuredBytes.value = null;
  }

  /** 拉取详情：缓存 → 离线判断 → 单飞 + 冷却 */
  async function loadDetail(mod: OnlineMod): Promise<void> {
    const id = mod.modId;
    detailLoading.value = false;

    // ① 本地缓存优先
    try {
      const hit = await readDetailCache(id);
      if (selection.selectedId.value !== id) return;
      if (usableDetailCache(hit)) {
        detail.value = hit.value;
        return;
      }
    } catch {
      /* 缓存不可用：继续走网络 */
    }

    // ② 离线：只用缓存，绝不发请求
    if (sessionPhase.value !== "online") return;

    // ③ 单飞 + 冷却
    if (pendingDetailIds.has(id)) return;
    const last = lastDetailMs.get(id) ?? 0;
    if (Date.now() - last < DETAIL_COOLDOWN_MS) return;

    pendingDetailIds.add(id);
    lastDetailMs.set(id, Date.now());
    detailLoading.value = true;
    try {
      const value = await modDetail(id);
      if (selection.selectedId.value === id) {
        detail.value = value;
        detailError.value = null;
      }
    } catch (e) {
      if (selection.selectedId.value === id) detailError.value = messageOf(e);
    } finally {
      pendingDetailIds.delete(id);
      if (selection.selectedId.value === id) detailLoading.value = false;
    }
  }

  // ---------------- 字段格式化（服务端字段名不统一，多个候选 key 依次取） ----------------

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

  const detailTags = computed<string[]>(() => selected.value?.tagNames?.map(localizedTagName) ?? []);

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

  // ---------------- v0.2.4：一键翻译（只由用户点击触发，绝不自动请求） ----------------

  const selectedTranslation = computed(() => activeTranslation(selected.value?.modId));
  const selectedTranslated = computed(() => translationOf(selected.value?.modId) !== null);
  const translateBusy = computed(() => isTranslating(selected.value?.modId));
  const translateQueued = computed(() => isQueued(selected.value?.modId));
  const showingOriginalText = computed(() => isShowingOriginal(selected.value?.modId));

  const canTranslate = computed(() => !!selected.value && canTranslateText(descriptionText.value));

  /** 详情还没拉回来 / 官方描述太短：不允许翻译（否则空文本会被写进缓存，永久漏翻） */
  const waitingDetail = computed(
    () => !!selected.value && !canTranslateText(descriptionText.value),
  );

  /** 详情标题优先级：备注名 > 中文译文 / 本地索引标题 > 官方原名 */
  const headerTitle = computed(() => {
    const mod = selected.value;
    if (!mod) return "";
    const custom = customNameOf(mod.modId);
    if (custom) return custom;
    const title = translatedTitleOf(mod.modId);
    return title ? title : mod.title;
  });

  /** 标题下小字：**只**用于备注名回显；译文不再叠英文原名 */
  const titleSub = computed(() => {
    const mod = selected.value;
    if (!mod || !customNameOf(mod.modId)) return null;
    return `${t("favorites.originalTitle")}: ${mod.title}`;
  });

  const translateLabel = computed(() => {
    if (translateBusy.value) return t("translate.busy");
    if (translateQueued.value) return t("translate.queued");
    if (!selectedTranslated.value) {
      return t("translate.trigger", { lang: currentTargetLanguageName() });
    }
    return showingOriginalText.value
      ? t("translate.showTranslated", { lang: currentTargetLanguageName() })
      : t("translate.showOriginal");
  });

  const translateProvider = computed(() => {
    const tr = translationOf(selected.value?.modId);
    if (!tr) return null;
    return tr.cached
      ? t("translate.fromCache", { name: tr.provider })
      : t("translate.provider", { name: tr.provider });
  });

  /** 描述：中文译文优先；切回原文或没翻译时用官方描述的纯文本 */
  const descText = computed(() => {
    const zh = selectedTranslation.value?.desc?.trim();
    return zh ? zh : descriptionText.value;
  });

  function translationErrorText(error: unknown): string {
    switch (translationErrorKind(error)) {
      case "network":
        return t("translate.failNetwork");
      case "busy":
        return t("translate.failBusy");
      case "quota":
        return t("translate.failQuota");
      case "not_ready":
        return t("translate.notReady");
      default:
        return t("translate.failGeneric", { msg: messageOf(error) });
    }
  }

  async function onTranslateClick(): Promise<void> {
    const mod = selected.value;
    if (!mod) return;
    // 已有译文：按钮变成「显示原文 / 显示中文」的开关，不再发请求
    if (translationOf(mod.modId)) {
      toggleOriginal(mod.modId);
      return;
    }
    if (!canTranslate.value || translateBusy.value || translateQueued.value) return;
    try {
      const tr = await ensureTranslation(mod, descriptionText.value ?? "");
      if (tr.truncated) {
        deps.showToast(t("translate.truncated", { chars: tr.charCount }), "ok");
      } else {
        deps.showToast(tr.cached ? t("translate.fromCacheToast") : t("translate.okToast"), "ok");
      }
    } catch (e) {
      deps.showToast(translationErrorText(e), "error");
    }
  }

  /** 原始字段表（详情页「原始字段」折叠区） */
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

  return {
    detail,
    detailLoading,
    detailError,
    measuredBytes,
    detailTags,
    headerTitle,
    titleSub,
    sizeText,
    diskText,
    ratingText,
    versionText,
    createdText,
    updatedText,
    rawDescription,
    descText,
    canTranslate,
    waitingDetail,
    selectedTranslated,
    showingOriginalText,
    translateBusy,
    translateQueued,
    translateLabel,
    translateProvider,
    onTranslateClick,
    rawEntries,
    loadDetail,
    isPending,
    resetForSwitch,
  };
}

export type OnlineDetail = ReturnType<typeof useOnlineDetail>;
