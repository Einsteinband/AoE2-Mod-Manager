/**
 * 「一键翻译」的前端状态层（Rust translator.rs 的薄封装）。
 *
 * 三条硬规则：
 * 1. **绝不自动翻译**：只有用户点按钮才会调用 `ensureTranslation`，打开软件、
 *    切分类、滚动列表都不会触发任何翻译请求。
 * 2. **单飞 + 防抖**：同一个 modId 在途时复用同一个 Promise，连点只发一次 invoke；
 *    Rust 端还有第二层 single-flight 兜底（多窗口/多入口也挡得住）。
 * 3. **重启不丢译文**：前端不持久化译文，但渲染列表后会调 `hydrateTranslations`
 *    **批量只读** translation_cache.json（零网络），把译文标题接回来。
 * 4. **目标语言与 UI 语言解耦**：所有请求都带 `targetLang`（小写 zh-cn / ja …）；
 *    设置里选「跟随界面语言」时，UI 语言一变 `syncUiLocale` 立刻切成对应目标语言，
 *    并递增 `langEpoch` 让各页面重新预热缓存。
 */
import { reactive, ref } from "vue";
import { i18n, translate } from "../i18n";
import { isApiFailure, type Translation } from "./types";
import { cachedTranslation, cachedTranslations, translateModText } from "./service";

/** 找不到任何语言线索时的兼底（与 Rust DEFAULT_LANG 一致） */
export const DEFAULT_TARGET_LANG = "zh-cn";

/** modId → 已拿到的译文（含"来自缓存"标记） */
const translations = reactive(new Map<number, Translation>());
/** 正在真正发起请求的 modId（按钮显示“翻译中…”） */
const translating = reactive(new Set<number>());
/** 已排队但还没轮到发请求的 modId（按钮显示“排队中…”） */
const queued = reactive(new Set<number>());
/** 用户点了「显示原文」的 modId（临时切回英文，不丢译文） */
const showingOriginal = reactive(new Set<number>());
/** 前端单飞表：键 = `modId|lang`，同一模组同一语言共享同一个 Promise */
const inFlight = new Map<string, Promise<Translation>>();
/** 已经做过批量缓存预热的 modId（避免重复 invoke） */
const hydratedIds = new Set<number>();
/** 已经做过「带描述」严格探测的键：modId|描述长度，避免详情页反复 invoke */
const strictProbed = new Set<string>();
/** 等待批量预热的条目（同一帧内多次调用会合并成一次 invoke） */
const pendingProbes = new Map<number, TranslationProbeInput>();
let probeTimer: number | null = null;

// ---------------- 目标语言状态 ----------------

/** 当前生效的翻译目标语言（小写） */
const targetLang = ref<string>(DEFAULT_TARGET_LANG);
/** 语言变更计数器：组件 watch 它就能重新预热缓存 */
const langEpoch = ref(0);
/** 设置里是否选了「跟随界面语言」 */
let followUi = true;

/** 语言代码 → 本地化名称（英文界面下也能显示“日本語”） */
export function languageName(code: string): string {
  const key = `translate.langName.${code}`;
  const label = translate(key);
  return label === key ? code.toUpperCase() : label;
}

/** 当前目标语言的展示名，供「🌐 翻译为 {lang}」使用 */
export function currentTargetLanguage(): string {
  return targetLang.value;
}

export function currentTargetLanguageName(): string {
  return languageName(targetLang.value);
}

/** 语言变更计数器（组件里 watch 它做重新预热） */
export function translationLangEpoch(): number {
  return langEpoch.value;
}

/**
 * 解析「设置里的值 + UI 语言」→ 实际目标语言。
 * 空串/preference 为空 = 跟随界面语言：zh → zh-cn，zh-tw/zh-hant → zh-tw，其它同码。
 */
export function resolveTargetLanguage(preference: string, uiLocale: string): string {
  const pref = (preference ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (pref) return pref;
  const locale = (uiLocale ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!locale) return DEFAULT_TARGET_LANG;
  if (locale === "zh" || locale === "zh-hans" || locale === "zh-sg") return "zh-cn";
  if (locale === "zh-tw" || locale === "zh-hk" || locale === "zh-hant") return "zh-tw";
  return locale;
}

/**
 * 切换目标语言：清空内存译文与预热记录，并递增 epoch。
 * 各页面 watch(epoch) → 重新只读预热，卡片立刻换成新语言（不发网络）。
 *
 * `force = true`（设置页保存成功时）：即使解析出的语言和当前一样也递增 epoch，
 * 让各页面重新预热一次；但**不清空**译文，避免界面无谓地闪回原文。
 */
export function setTargetLanguage(next: string, opts: { force?: boolean } = {}): void {
  const normalized = (next ?? "").trim().toLowerCase().replace(/_/g, "-");
  const resolved = normalized || DEFAULT_TARGET_LANG;
  const changed = resolved !== targetLang.value;
  if (!changed && !opts.force) return;
  targetLang.value = resolved;
  if (changed) {
    translations.clear();
    showingOriginal.clear();
    hydratedIds.clear();
    strictProbed.clear();
    pendingProbes.clear();
  }
  langEpoch.value += 1;
  console.info(`[translation] 目标语言切换为 ${resolved}（changed=${changed}）`);
}

/**
 * 清空内存译文（设置页「清理翻译缓存」后调用）。
 * 不改变目标语言，只让各页面重新预热（磁盘已空，所以什么都不会回来）。
 */
export function resetTranslations(): void {
  translations.clear();
  hydratedIds.clear();
  strictProbed.clear();
  pendingProbes.clear();
  showingOriginal.clear();
  langEpoch.value += 1;
}

/**
 * 应用设置（启动时 / 设置页保存后调用）。
 * `view.targetLanguage` 为空 = 跟随界面语言。
 *
 * 设置页保存成功属于明确意图 → force，保证 langEpoch 一定自增（各页面重算按钮文案/预热）。
 */
export function applyTranslateSettings(view: { targetLanguage: string }, uiLocale: string): void {
  followUi = !view.targetLanguage;
  setTargetLanguage(resolveTargetLanguage(view.targetLanguage, uiLocale), { force: true });
}

/**
 * UI 语言变化时调用：只有「跟随界面语言」模式下才会跟着切，
 * 玩家手动钉死某个语言时不会被界面语言干扰。
 */
export function syncUiLocale(uiLocale: string): void {
  if (!followUi) return;
  setTargetLanguage(resolveTargetLanguage("", uiLocale));
}

/** 当前是否跟随界面语言（设置页展示用） */
export function isFollowingUiLanguage(): boolean {
  return followUi;
}

/** 当前 UI 语言（i18n 实例，语言切换时自动更新） */
export function currentUiLocale(): string {
  return String(i18n.global.locale.value ?? "");
}
/**
 * 前端请求队列（串行链）。
 *
 * 10 秒内点开 10 个模组并逐个点翻译时，这里保证 invoke **逐个发出**（前一个结束后才发下一个），
 * 同时在 Rust 端还有第二道保险：全局 FIFO 票据队列 + 任意两次外部请求间隔 ≥ 1 秒。
 * 任何一处都不依赖“用户不会连点”这种假设。
 */
let queueTail: Promise<unknown> = Promise.resolve();

function validId(modId: number | null | undefined): modId is number {
  return typeof modId === "number" && modId > 0;
}

/**
 * 已翻译过的译文（null = 没翻译过）。
 *
 * **语言槽位校验**：内存里的译文如果属于别的目标语言（用户在设置里换过语言，
 * 或切换时旧条目还没被清掉），一律当作“没翻译过”返回 null —— 这样所有按钮/标题
 * 都会自动回到「🌐 翻译为{新语言}」，点一次就会去请求新语言，而不是误判成
 * “已有译文”去偷偷切换原文。
 */
/**
 * 「只带标题」的占位条目：本地索引命中后灌进来的中文标题（`provider = "index"`）。
 *
 * 它不是一次真正的翻译（`desc` 为空），所以**绝不能**被当成「已翻译」：
 * 否则详情页按钮会显示「显示原文」，点了只是在原文/标题之间来回切，描述永远翻不出来。
 */
function isTitleOnly(tr: Translation): boolean {
  return tr.provider === "index" && !tr.desc.trim();
}

export function translationOf(modId: number | null | undefined): Translation | null {
  if (!validId(modId)) return null;
  const tr = translations.get(modId);
  if (!tr) return null;
  if (tr.lang && tr.lang !== targetLang.value) return null;
  // 索引标题占位不算译文：详情页按钮要回到「翻译为 {lang}」
  if (isTitleOnly(tr)) return null;
  return tr;
}

/** 本地索引灌进来的标题占位（只用于标题展示，不参与「已翻译」判断） */
function indexTitleOf(modId: number | null | undefined): Translation | null {
  if (!validId(modId)) return null;
  const tr = translations.get(modId);
  if (!tr || !isTitleOnly(tr)) return null;
  if (tr.lang && tr.lang !== targetLang.value) return null;
  return tr;
}

/** 已翻译的译文标题（卡片/侧栏用）。**尊重「显示原文」开关**，所以详情页切回原文时卡片也会跟着变。 */
export function translatedTitleOf(modId: number | null | undefined): string | null {
  const title = (activeTranslation(modId) ?? indexTitleOf(modId))?.title?.trim();
  return title ? title : null;
}

/**
 * 把「外部来源」的中文标题灌进内存译文表（v1.0 本地索引搜索用）。
 *
 * 为什么需要它：中文搜索由 Rust 在 `online_index.json` + `translation_cache.json`
 * 里完成匹配，命中的标题必须走**同一条展示通道**（`translations` 反应式 Map），
 * 否则会出现「搜到了中文、卡片却还显示英文」的割裂。
 *
 * 两条安全规则：
 * 1. 已有当前语言、且带描述的正规译文（详情页翻过）**绝不覆盖** —— 它信息更全；
 * 2. `lang` 显式给出且不是当前目标语言时直接跳过（防止切语言后旧结果回填）。
 */
export function applyExternalTitles(
  entries: { modId: number; title: string; lang?: string }[],
): void {
  const lang = targetLang.value;
  for (const entry of entries) {
    const modId = entry.modId;
    if (!validId(modId)) continue;
    const title = (entry.title ?? "").trim();
    if (!title) continue;
    if (entry.lang && entry.lang.toLowerCase() !== lang) continue;
    const existing = translations.get(modId);
    if (existing && existing.lang === lang && existing.desc.trim()) continue;
    translations.set(modId, {
      modId,
      lang,
      originalHash: existing?.originalHash ?? "",
      title,
      desc: existing?.desc ?? "",
      provider: existing?.provider ?? "index",
      charCount: existing?.charCount ?? 0,
      savedAtMs: existing?.savedAtMs ?? Date.now(),
      cached: true,
      truncated: existing?.truncated ?? false,
    });
  }
}

export function isTranslating(modId: number | null | undefined): boolean {
  return validId(modId) ? translating.has(modId) : false;
}

/** 已排队、等前一个模组翻完才能发请求 */
export function isQueued(modId: number | null | undefined): boolean {
  return validId(modId) ? queued.has(modId) : false;
}

/** 排队中的人数（可用于顶部提示，目前详情页只需要 isQueued） */
export function queuedCount(): number {
  return queued.size;
}

export function isShowingOriginal(modId: number | null | undefined): boolean {
  return validId(modId) ? showingOriginal.has(modId) : false;
}

/** 译文 / 原文之间来回切（只在已有译文时才有意义） */
export function toggleOriginal(modId: number): void {
  if (!validId(modId) || !translations.has(modId)) return;
  if (showingOriginal.has(modId)) {
    showingOriginal.delete(modId);
  } else {
    showingOriginal.add(modId);
  }
}

/** 已经翻译过、且当前要显示中文时才返回译文（供详情页/卡片判断） */
export function activeTranslation(modId: number | null | undefined): Translation | null {
  const tr = translationOf(modId);
  if (!tr) return null;
  return isShowingOriginal(modId) ? null : tr;
}

/**
 * 触发一次翻译（已翻译过 → 直接返回；在途 → 复用同一个 Promise）。
 * `description` 必须传**已纯文本化**的描述，Rust 侧会用它算 originalHash。
 *
 * `mod` 只要求最小字段 `{modId, title}`，所以在线模组（OnlineMod）
 * 和本地模组（ModEntry → 传 {modId: workshopId, title: displayName}）都能直接传。
 */
export function ensureTranslation(
  mod: { modId: number; title: string },
  description: string,
): Promise<Translation> {
  const modId = mod.modId;
  if (!validId(modId)) {
    return Promise.reject(new Error("invalid: modId"));
  }
  const lang = targetLang.value;

  const done = translations.get(modId);
  // 只有「当前目标语言」的**完整译文**才能直接复用；索引标题占位（desc 为空）要重新翻
  if (done && done.lang === lang && !isTitleOnly(done)) return Promise.resolve(done);
  if (done) {
    // 旧语言槽位：立刻丢进垃圾桶，避免它在请求返回前继续冒充当前译文
    translations.delete(modId);
    showingOriginal.delete(modId);
  }

  const flightKey = `${modId}|${lang}`;
  const running = inFlight.get(flightKey);
  if (running) return running;

  // 入队：先标成“排队中”，等前面的任务结束后才真正发 invoke
  queued.add(modId);
  const task = queueTail
    .catch(() => undefined)
    .then(async () => {
      queued.delete(modId);
      translating.add(modId);
      try {
        const tr = await translateModText(modId, mod.title ?? "", description ?? "", lang);
        // 排队期间用户可能又换了语言：只有仍是当前目标语言才写回内存
        if (tr.lang === targetLang.value) {
          translations.set(modId, tr);
          // 新译文默认显示译文；用户之前的「显示原文」偏好一并复位
          showingOriginal.delete(modId);
        }
        return tr;
      } finally {
        translating.delete(modId);
        inFlight.delete(flightKey);
      }
    });

  inFlight.set(flightKey, task);
  // 队列尾巴不能因为某一次失败而断掉
  queueTail = task.catch(() => undefined);
  return task;
}

/**
 * 只读缓存探测（**不发网络**）。
 *
 * 详情页拿到**真实描述**后调用：只接受 originalHash 完全一致的条目，
 * 作者改过标题/描述就不会把旧译文贴上去。
 */
export async function loadCachedTranslation(
  mod: { modId: number; title: string },
  description: string,
): Promise<Translation | null> {
  const modId = mod.modId;
  if (!validId(modId)) return null;
  const known = translations.get(modId);
  // 只有当前语言的**完整译文**才算命中；旧语言残留 / 索引标题占位都要重新探查
  if (known && known.lang === targetLang.value && !isTitleOnly(known)) return known;
  const key = `${modId}|${targetLang.value}|${(description ?? "").length}`;
  if (strictProbed.has(key)) return null;
  strictProbed.add(key);
  try {
    const tr = await cachedTranslation(modId, mod.title ?? "", description ?? "", targetLang.value);
    if (tr && tr.lang === targetLang.value) translations.set(modId, tr);
    return tr;
  } catch (error) {
    // 探测失败（IPC / 文件权限）不能让详情页报错，只记一笔就当作“没译文”
    console.warn("[translation] 读取译文缓存失败", error);
    return null;
  }
}

// ---------------- 缓存预热（重启后不发回英文的核心） ----------------

/** 与 Rust 的 MIN_DESC_CHARS 保持一致：描述过短 = 详情还没加载完，绝不允许拿去翻译 */
export const MIN_DESC_CHARS = 5;

export function canTranslateText(description: string | null | undefined): boolean {
  return (description ?? "").trim().length >= MIN_DESC_CHARS;
}

export interface TranslationProbeInput {
  modId: number;
  title: string;
  description: string;
}

/**
 * 批量预热已缓存译文：**只读本地缓存，绝不联网、绝不自动翻译**。
 *
 * 列表（在线/本地）渲染后调用一次即可。同一帧内的多次调用会被合并成一次 invoke，
 * 且只探查“还没翻译过、也没查过”的条目。
 */
export function hydrateTranslations(mods: TranslationProbeInput[]): void {
  let added = 0;
  for (const mod of mods) {
    if (!validId(mod.modId)) continue;
    // 已有「当前语言」的**完整译文**才跳过；索引标题占位 / 旧语言残留都要重新探查，
    // 否则列表会一直停在只带标题的状态
    const known = translations.get(mod.modId);
    if (known && known.lang === targetLang.value && !isTitleOnly(known)) continue;
    if (hydratedIds.has(mod.modId)) continue;
    pendingProbes.set(mod.modId, {
      modId: mod.modId,
      title: mod.title ?? "",
      description: mod.description ?? "",
    });
    added += 1;
  }
  if (!added) return;
  if (probeTimer !== null) return;
  probeTimer = window.setTimeout(() => {
    void flushProbes();
  }, 50);
}

async function flushProbes(): Promise<void> {
  probeTimer = null;
  const batch = [...pendingProbes.values()];
  pendingProbes.clear();
  if (!batch.length) return;
  for (const item of batch) hydratedIds.add(item.modId);
  try {
    const hits = await cachedTranslations(
      batch.map((item) => ({ ...item, targetLang: targetLang.value })),
    );
    // 预热期间可能又换了语言：只接受当前语言的命中
    for (const tr of hits) {
      if (tr.lang === targetLang.value) translations.set(tr.modId, tr);
    }
  } catch (error) {
    // 失败就撤销标记，下一次列表变化时再试（不让一次 IPC 抖动把中文永久丢掉）
    for (const item of batch) hydratedIds.delete(item.modId);
    console.warn("[translation] 批量读取译文缓存失败", error);
  }
}

/** 把 Rust 返回的错误归成前端可读的类别（Toast 文案由组件用 i18n 渲染） */
export function translationErrorKind(error: unknown): string {
  if (isApiFailure(error)) {
    const kind = (error.kind || "").toLowerCase();
    if (kind) return kind;
    return "http";
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/network|timeout|timed out|dns|refused|reset/i.test(text)) return "network";
  if (/quota|429/i.test(text)) return "quota";
  if (/busy|正在翻译/i.test(text)) return "busy";
  if (/not_ready|加载完成/i.test(text)) return "not_ready";
  return "other";
}

/** 便捷判断：译文是否来自本地缓存（用于 Toast 文案区分「缓存秒回 / 现译」） */
export function isCachedTranslation(tr: Translation | null | undefined): boolean {
  return tr?.cached === true;
}
