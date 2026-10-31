/**
 * 在线页的「列表数据层」：缓存优先 → 官方 /Find（或 /Installed）→ 无限滚动翻页。
 *
 * 三条硬约束（都是踩坑后定下来的，不要简化）：
 * 1. **缓存命中就彻底断网**：命中（哪怕是 0 条）立刻渲染，不再有任何后台 SWR 请求；
 *    只有「从未缓存过 / 用户手动刷新 / 缓存超过 24h（已订阅 10 分钟）」才发网络请求；
 * 2. **单飞 + 冷却**：同一筛选同一时刻只允许一个请求在飞，手动刷新也有 2 秒防连点；
 * 3. **换筛选 = replace，同筛选 = merge**：replace 复用已存在对象（不闪、选中项引用不失效），
 *    merge 逐条比对只 patch 真变的字段。
 *
 * 收藏视图是**纯本地**的：只拿 user_data.json 的收藏 ID 匹配「缓存池 + 当前列表」，
 * 绝不调用 /Find 或 /Installed，断网也完全可用。
 *
 * 官方搜索词 / 排序 / 升降序由顶栏（App.vue）持有，这里只通过 deps 读取，不自己维护一份。
 */
import { computed, ref, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { allCachedItems, readCachedPages, readInstalledPages } from "../../online/cache";
import { messageOf } from "../../online/errors";
import { isNetworkError, isNetworkFailure } from "../../online/networkError";
import { findMods, installedMods } from "../../online/service";
import { isApiFailure, type OnlineMod } from "../../online/types";
import { sessionPhase, setStatusMessage } from "../../sessionState";
import { ensureUserData, favoriteIdSet, isFavorite } from "../../userData";
import type { OnlineSelection } from "./useOnlineSelection";

/** 每批加载数量：本地网格每行 6 个（约 197px 列宽），24 = 4 行 */
export const PAGE_SIZE = 24;

/** 一次 invoke 最多读回几页缓存（每页 24 条 → 最多 192 条，覆盖一屏 + 多次翻页） */
const CACHE_PAGE_LIMIT = 8;
/** 缓存过期阈值：只有缓存超过 24 小时，才允许「自动」补一次网络请求 */
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * 「已订阅」（/Installed）的缓存过期阈值：订阅状态随本机安装 / 官网退订随时变化，
 * 沿用 24 小时会把「只缓存到 6 条」的半截结果当成事实卡一整天，所以单独收紧到 10 分钟。
 */
const INSTALLED_STALE_MS = 10 * 60 * 1000;
/** 已订阅一次最多读回几页缓存：20 × 24 = 480 条，覆盖绝大多数账号的订阅量 */
const INSTALLED_CACHE_PAGE_LIMIT = 20;
/** 滚动加载最小间隔：连续滚轮 / 惯性滚动不会触发连环请求 */
const MIN_LOAD_MORE_GAP_MS = 900;
/** 用户手动刷新时同一筛选的最小间隔（防连点，但不会被 30 秒闸门挡住） */
const USER_MIN_GAP_MS = 2_000;

/** 底栏中间提示用的 HH:mm */
function clockText(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** 只有字段真的变了才写回：避免无意义的响应式更新让卡片重绘（“不闪”的关键） */
function patchIfChanged(current: OnlineMod, fresh: OnlineMod): void {
  let changed = false;
  for (const key of Object.keys(fresh) as (keyof OnlineMod)[]) {
    if (key === "raw") continue;
    const a = current[key];
    const b = fresh[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
        changed = true;
        break;
      }
      continue;
    }
    if (a !== b) {
      changed = true;
      break;
    }
  }
  if (changed) Object.assign(current, fresh);
}

export function useOnlineList(deps: {
  selection: OnlineSelection;
  /** 官方搜索已提交的词（空 = 显示最新列表） */
  query: Ref<string>;
  sort: Ref<string>;
  order: Ref<"DESC" | "ASC">;
  /** 网格的真实滚动容器（换筛选时归零） */
  scrollEl: Ref<HTMLElement | null>;
  /** 列表一变就把已缓存的译文接回来（只读缓存，零网络） */
  hydrateList: (list: OnlineMod[]) => void;
  /** 列表一变就同步封面（本地优先） */
  syncImages: (list: OnlineMod[]) => void;
  /** 接口明确返回 401：交给登录层处理（清会话 + 尝试静默重登） */
  onUnauthorized: (message: string) => void;
  /** 退出本地搜索态（返回调用前是否处于本地搜索视图）—— 与官方列表互斥 */
  clearLocalSearch: () => boolean;
}) {
  const { t } = useI18n();
  const { selection, scrollEl } = deps;

  /** 列表（无限滚动累加） */
  const items = ref<OnlineMod[]>([]);
  /** 滚动哨兵的 DOM（由页面在模板 ref 上写入；收藏 / 本地搜索视图不挂哨兵） */
  const sentinel = ref<HTMLElement | null>(null);
  const totalCount = ref<number | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref<string | null>(null);
  const moreError = ref<string | null>(null);
  const hasMore = ref(true);
  /** 下一次请求的 start（官方接口 1 起；按已取回条数偏移，抗数据变动） */
  const cursor = ref(1);

  const onlySubscribed = ref(false);
  /** v0.7：只看收藏（纯本地：user_data.json 的收藏 ID × 缓存池，绝不发网络请求） */
  const favoritesOnly = ref(false);
  /** 收藏视图的本地候选池（online_cache.json 里的全部条目，只读一次） */
  const favoritePool = ref<OnlineMod[] | null>(null);
  /** true = 断网且该分类无缓存：显示“暂无本地缓存”的空态，不发任何请求 */
  const noCacheOffline = ref(false);
  /** 当前列表的筛选签名：变了说明是「另一个列表」，数据整体替换而不是合并 */
  let listSignature = "";

  /** 左侧分类（官方 /api/v4/mods/Tags） */
  const activeTag = ref<number | null>(null);

  /**
   * 实际生效的分类：收藏视图下一律为 null。
   * 单一出口 —— 请求参数、缓存 key、前端过滤全部只读它，
   * 避免「收藏 + 官方分类」叠加导致侧栏计数与列表条数对不上（如 3 收藏却只剩 48/1037）。
   */
  const effectiveTag = computed<number | null>(() => (favoritesOnly.value ? null : activeTag.value));

  /** 网格实际渲染的官方列表（本地搜索态由页面另行决定，不在这里掺和） */
  const visibleOfficialItems = computed<OnlineMod[]>(() =>
    favoritesOnly.value ? items.value.filter((m) => isFavorite(m.modId)) : items.value,
  );

  /** 请求序号：筛选条件变化时自增，丢弃过期响应 */
  let seq = 0;
  /** signature → 上次真正发网络请求的时间 */
  const lastFetchMsBySignature = new Map<string, number>();
  /** 当前正在飞的请求属于哪个筛选（单飞，防叠加） */
  let fetchSignature: string | null = null;
  /** 上次 loadMore 的时间 */
  let lastLoadMoreMs = 0;

  function exceedsTagFilter(mod: OnlineMod): boolean {
    if (effectiveTag.value === null) return true;
    // 已订阅接口不支持 tags 过滤，这里按官方 modTagIds 前端过滤
    return mod.tagIds.includes(effectiveTag.value);
  }

  function requestChunk(start: number) {
    if (onlySubscribed.value) return installedMods(start, PAGE_SIZE);
    return findMods({
      query: deps.query.value.trim(),
      start,
      count: PAGE_SIZE,
      sort: deps.sort.value,
      order: deps.order.value,
      tags: effectiveTag.value === null ? [] : [effectiveTag.value],
    });
  }

  /** 当前筛选条件的签名：变了 = 另一个列表（整体替换），没变 = 同一列表（逐条比对） */
  function signatureOf(): string {
    return [
      favoritesOnly.value ? "fav" : onlySubscribed.value ? "sub" : "all",
      deps.query.value.trim().toLowerCase(),
      deps.sort.value,
      deps.order.value,
      effectiveTag.value === null ? "" : String(effectiveTag.value),
    ].join("|");
  }

  /**
   * 读缓存并拼成列表。**一次 invoke**（Rust 侧是纯内存查找，微秒级），绝不逐页往返。
   * 返回空 items = 完全没有缓存，调用方这时才允许去发网络请求 / 显示骨架。
   */
  async function loadCachePages(from = 1): Promise<{
    hit: boolean;
    items: OnlineMod[];
    nextStart: number;
    complete: boolean;
    savedAtMs: number;
  }> {
    const installed = onlySubscribed.value;
    try {
      // 已订阅：走 /Installed 专用 key（installed|start|count），绝不掺搜索 / 排序 / 分类，
      // 否则 key 与 online_installed 写入时不一致，永远读不到自己写的缓存。
      const pages = installed
        ? await readInstalledPages({
            start: from,
            count: PAGE_SIZE,
            maxPages: INSTALLED_CACHE_PAGE_LIMIT,
          })
        : await readCachedPages({
            query: deps.query.value.trim(),
            start: from,
            count: PAGE_SIZE,
            sort: deps.sort.value,
            order: deps.order.value,
            tags: effectiveTag.value === null ? [] : [effectiveTag.value],
            maxPages: CACHE_PAGE_LIMIT,
          });
      const merged: OnlineMod[] = [];
      let total: number | null = null;
      let nextStart = from;
      let shortPage = false;
      let savedAtMs = 0;
      for (const page of pages) {
        if (!savedAtMs && page.savedAtMs) savedAtMs = page.savedAtMs;
        if (total === null && page.totalCount !== null) total = page.totalCount;
        for (const raw of page.items) {
          const mod = raw as unknown as OnlineMod;
          if (typeof mod?.modId !== "number") continue;
          if (installed && !exceedsTagFilter(mod)) continue;
          if (!merged.some((seen) => seen.modId === mod.modId)) merged.push(mod);
        }
        nextStart = page.start + page.items.length;
        if (page.items.length < PAGE_SIZE) {
          shortPage = true;
          break;
        }
      }
      if (total !== null) totalCount.value = total;
      // 结束判定：服务端报过总数就以「已取回条数 ≥ 总数」为准，否则才退回「本页不满一页」。
      // 旧实现只看「本页不满一页」，一页半截缓存就会把列表永久判成「已到最后一页」（6 条卡死）。
      const complete = total !== null ? nextStart - 1 >= total : shortPage;
      // hit = 这个 key 在缓存里真实存在（哪怕结果是 0 条）
      return { hit: pages.length > 0, items: merged, nextStart, complete, savedAtMs };
    } catch {
      return { hit: false, items: [], nextStart: from, complete: false, savedAtMs: 0 };
    }
  }

  /**
   * 把数据写进列表，两种模式：
   * - merge：同一筛选的静默刷新 / 翻页 → 逐条比对，只有真变的卡片被 patch，新条目追加；
   * - replace：换了筛选（分类 / 搜索 / 排序 / 来源 / 收藏）→ 整体替换，但**复用已存在的对象**，
   *   一次赋值完成，中间不出现空白帧，selected 引用也不失效（详情面板不闪）。
   */
  function applyList(next: OnlineMod[], mode: "merge" | "replace"): void {
    if (mode === "replace") {
      const existing = new Map(items.value.map((mod) => [mod.modId, mod]));
      const reused = next.map((fresh) => {
        const current = existing.get(fresh.modId);
        if (!current) return fresh;
        patchIfChanged(current, fresh);
        return current;
      });
      items.value = reused;
      // 选中项必须属于新列表：换了分类还对着一张不存在的卡片，详情面板就会挂错模组
      const kept = selection.selected.value
        ? reused.find((m) => m.modId === selection.selected.value?.modId) ?? null
        : null;
      selection.select(kept);
      deps.hydrateList(items.value);
      return;
    }
    const existing = new Map(items.value.map((mod) => [mod.modId, mod]));
    const appended: OnlineMod[] = [];
    for (const fresh of next) {
      const current = existing.get(fresh.modId);
      if (!current) {
        appended.push(fresh);
        continue;
      }
      patchIfChanged(current, fresh);
    }
    if (appended.length) items.value = [...items.value, ...appended];
    deps.hydrateList(items.value);
  }

  /**
   * 换筛选时把滚动容器归零（在替换数据之前调用）。
   * 新分类的卡片数量/高度都不同，等 applyList 之后再让浏览器纠正会导致「先弹顶再乱窜」。
   */
  function resetScrollToTop(): void {
    savedScrollTop = 0;
    const el = scrollEl.value;
    if (el) el.scrollTop = 0;
  }

  /**
   * 「⭐ 我的收藏」：纯本地视图。
   * 数据源 = user_data.json 的收藏 ID ×（缓存池 + 当前列表），
   * **绝不调用 Find / Installed**，断网也完全可用。
   */
  async function loadFavorites(mode: "merge" | "replace"): Promise<void> {
    if (!favoritePool.value) {
      try {
        const cached = await allCachedItems();
        favoritePool.value = cached.filter((mod) => typeof mod?.modId === "number");
      } catch {
        favoritePool.value = [];
      }
    }
    const byId = new Map<number, OnlineMod>();
    for (const mod of favoritePool.value ?? []) byId.set(mod.modId, mod);
    // 当前列表可能比缓存更新（刚装过 / 刚翻到），以它为准
    for (const mod of items.value) byId.set(mod.modId, mod);

    await ensureUserData().catch(() => undefined);
    const favorites = favoriteIdSet.value;
    const matched = [...byId.values()]
      .filter((mod) => favorites.has(mod.modId))
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));

    totalCount.value = matched.length;
    hasMore.value = false;
    cursor.value = 1;
    error.value = null;
    loading.value = false;
    loadingMore.value = false;
    applyList(matched, mode);
    setStatusMessage(t("favorites.localHint", { n: matched.length }));
    deps.syncImages(matched);
  }

  /**
   * 列表加载唯一入口（官方搜索专用）。
   *
   * 规则（严格按需求）：
   * 1. 先查缓存。**命中就立刻渲染并彻底断网** —— 即使是空列表（0 条）也算命中；
   * 2. 只有两种情况允许发 Find：
   *    a) 该「分类 + 搜索词 + 排序 + 页码」从未缓存过；
   *    b) 用户手动点了刷新（或顶栏重试），且距上次请求 ≥ 2 秒（防连点）；
   *    c) 缓存已超过 24 小时（软件放了一整天没开，才允许自动补一次）；
   * 3. 静默刷新（SWR）已删除：缓存命中后不再有任何后台请求；
   * 4. 换筛选时强制 scrollTop = 0，避免列表高度变化让滚动条乱窜；
   * 5. 收藏视图完全不发网络请求。
   */
  async function reload(forceNetwork = false): Promise<void> {
    seq += 1;
    const mySeq = seq;
    const signature = signatureOf();
    const mode: "merge" | "replace" = signature === listSignature ? "merge" : "replace";

    // 换筛选：先归零（在替换数据之前，避免高度变化导致跳动）
    if (mode === "replace") resetScrollToTop();

    // 收藏：纯本地，直接返回（不发任何网络请求）
    if (favoritesOnly.value) {
      listSignature = signature;
      await loadFavorites(mode);
      return;
    }

    // 本地搜索不再掺入官方列表——两条搜索链路彻底分开，这里只管官方（缓存 → /Find）
    const cached = await loadCachePages(1);
    if (mySeq !== seq) return;

    // 已订阅用更短的过期阈值（10 分钟），其余列表仍是 24 小时
    const ttl = onlySubscribed.value ? INSTALLED_STALE_MS : CACHE_STALE_MS;
    const cacheAge = cached.savedAtMs ? Date.now() - cached.savedAtMs : Number.MAX_SAFE_INTEGER;
    const lastFetch = lastFetchMsBySignature.get(signature) ?? 0;
    const sinceFetch = Date.now() - lastFetch;
    const expired = cacheAge >= ttl;
    /**
     * 已订阅：只要决定联网（缓存过期 / 手动刷新），就从第 1 页**整体重建**。
     * 绝不把「陈旧的半截缓存」和服务器真实现状拼在一起（6 条配 24 条会错位）。
     */
    const rebuildInstalled = onlySubscribed.value && (forceNetwork || expired);

    if (cached.hit) {
      // ① 命中缓存：立刻渲染（哪怕 0 条）
      noCacheOffline.value = false;
      listSignature = signature;
      applyList(cached.items, mode);
      cursor.value = cached.nextStart;
      hasMore.value = !cached.complete;
      error.value = null;
      loading.value = false;
      loadingMore.value = false;
      setStatusMessage(t("statusbar.cacheLoaded"));
      deps.syncImages(visibleOfficialItems.value);
    } else {
      // ② 从未缓存过
      listSignature = signature;
      cursor.value = 1;
      hasMore.value = true;
      // 已知断网：一个请求都不发，直接给友好提示（避免终端满屏 Dns Failed）
      if (isNetworkError.value && !forceNetwork) {
        items.value = [];
        loading.value = false;
        noCacheOffline.value = true;
        setStatusMessage(t("statusbar.networkDownHint"));
        return;
      }
      noCacheOffline.value = false;
      loading.value = items.value.length === 0;
      // 同一个筛选连点（且上一次请求还没落盘）时，2 秒内不重复请求
      if (!forceNetwork && sinceFetch < USER_MIN_GAP_MS) return;
    }

    if (rebuildInstalled) {
      cursor.value = 1;
      hasMore.value = true;
    } else if (cached.hit && !expired && !forceNetwork) {
      // 缓存新鲜：静默刷新关闭 —— 一个请求都不发
      return;
    }

    // 手动刷新 / 过期补拉：同一筛选 2 秒防连点
    if (sinceFetch < USER_MIN_GAP_MS) return;

    if (sessionPhase.value !== "online") {
      loading.value = false;
      if (!cached.hit) setStatusMessage(t("statusbar.offlineHint"));
      return;
    }

    // 已知断网：不再撞墙，继续展示缓存
    if (isNetworkError.value && !forceNetwork) {
      loading.value = false;
      hasMore.value = false;
      if (!cached.hit) noCacheOffline.value = true;
      setStatusMessage(t("statusbar.networkDownHint"));
      return;
    }

    // 同一筛选已经有一个请求在飞：绝不叠加
    if (fetchSignature === signature) return;

    /** 从第 1 页开始取 = 这次响应代表整个列表，必须 replace（清掉旧的半截数据） */
    const replaceOnFirst = cursor.value === 1;
    fetchSignature = signature;
    lastFetchMsBySignature.set(signature, Date.now());
    setStatusMessage(cached.hit ? t("statusbar.refreshing") : t("statusbar.fetching"));
    try {
      let guard = 0;
      while (mySeq === seq && guard < 4) {
        guard += 1;
        const result = await requestChunk(cursor.value);
        if (mySeq !== seq) return;
        if (result.totalCount !== null) totalCount.value = result.totalCount;
        if (result.serverMessage && result.items.length === 0 && !items.value.length) {
          error.value = result.serverMessage;
        }
        cursor.value += result.items.length;
        // 结束判定：有总数就以总数为准，否则才按「不满一页」判定
        const fetchedAll =
          result.totalCount !== null
            ? cursor.value - 1 >= result.totalCount
            : result.items.length < PAGE_SIZE;
        hasMore.value = result.items.length > 0 && !fetchedAll;
        const usableItems = onlySubscribed.value
          ? result.items.filter(exceedsTagFilter)
          : result.items;
        if (replaceOnFirst && !usableItems.length && items.value.length) {
          // 服务端这一页空（未登录 / 临时异常）：保留已渲染的缓存，绝不用空列表覆盖
          break;
        }
        applyList(usableItems, guard === 1 && replaceOnFirst ? "replace" : "merge");
        break;
      }
      if (mySeq !== seq) return;
      error.value = null;
      noCacheOffline.value = false;
      setStatusMessage(t("statusbar.freshAt", { time: clockText(Date.now()) }));
      deps.syncImages(visibleOfficialItems.value);
    } catch (e) {
      if (mySeq === seq) {
        if (isNetworkFailure(e)) {
          // 断网 / DNS / 超时：不把技术性报错抛到脸上，只给“请检查网络”
          noCacheOffline.value = !items.value.length;
          error.value = null;
          setStatusMessage(t("statusbar.networkDownHint"));
        } else {
          if (!items.value.length) error.value = messageOf(e);
          setStatusMessage(t("statusbar.offlineHint"));
        }
        if (isApiFailure(e) && e.kind === "unauthenticated") {
          deps.onUnauthorized(messageOf(e));
        }
      }
    } finally {
      if (mySeq === seq) loading.value = false;
      if (fetchSignature === signature) fetchSignature = null;
    }
  }

  /** 滚动到底部：追加下一批（同样缓存优先，只显示底部小 spinner，绝不整屏转圈） */
  async function loadMore(): Promise<void> {
    if (loading.value || loadingMore.value || !hasMore.value) return;
    // 收藏视图纯本地：不翻页、不发请求
    if (favoritesOnly.value || error.value || !items.value.length) return;
    // 连续滚轮 / 惯性滚动：两次加载之间至少间隔 900ms
    const now = Date.now();
    if (now - lastLoadMoreMs < MIN_LOAD_MORE_GAP_MS) return;
    lastLoadMoreMs = now;
    const mySeq = seq;

    // 缓存里还有下一页就直接用，不碰网络
    const cached = await loadCachePages(cursor.value);
    if (mySeq !== seq) return;
    if (cached.hit && cached.items.length) {
      const before = items.value.length;
      applyList(cached.items, "merge");
      cursor.value = cached.nextStart;
      hasMore.value = !cached.complete;
      if (items.value.length > before) {
        deps.syncImages(visibleOfficialItems.value);
        return;
      }
    } else if (cached.hit && !cached.items.length) {
      // 这一页在缓存里确实是空的：真到底了，不要再打网络
      hasMore.value = false;
      return;
    }

    if (sessionPhase.value !== "online") {
      hasMore.value = false;
      return;
    }
    // 已知断网：不再尝试翻页（否则滑动一次就多一条 DNS 报错）
    if (isNetworkError.value) {
      hasMore.value = false;
      return;
    }

    loadingMore.value = true;
    moreError.value = null;
    try {
      let guard = 0;
      while (mySeq === seq && hasMore.value && guard < 3) {
        guard += 1;
        const result = await requestChunk(cursor.value);
        if (mySeq !== seq) return;
        if (result.totalCount !== null) totalCount.value = result.totalCount;
        cursor.value += result.items.length;
        if (result.items.length === 0) {
          hasMore.value = false;
          break;
        }
        // 结束判定：服务端给了总数就以总数为准（不再被「不满一页」误判成已到最后一页）
        const fetchedAll =
          result.totalCount !== null
            ? cursor.value - 1 >= result.totalCount
            : result.items.length < PAGE_SIZE;
        const usableItems = onlySubscribed.value
          ? result.items.filter(exceedsTagFilter)
          : result.items;
        const before = items.value.length;
        applyList(usableItems, "merge");
        if (items.value.length > before) {
          // 已追加新卡片：下一批交给滚动事件 / keepFilling，不在这里连发
          hasMore.value = !fetchedAll;
          break;
        }
        // 服务端忽略了 start / 全部重复：没有新条目就停止翻页，避免无限请求
        hasMore.value = false;
        break;
      }
      deps.syncImages(visibleOfficialItems.value);
    } catch (e) {
      if (mySeq === seq) moreError.value = messageOf(e);
    } finally {
      if (mySeq === seq) {
        loadingMore.value = false;
        keepFilling();
      }
    }
  }

  /** 一批加载完仍没填满视口时继续拉（IntersectionObserver 不会重复触发已相交的哨兵） */
  function keepFilling(): void {
    const el = scrollEl.value;
    const marker = sentinel.value;
    // 收藏视图不补页：保持视口不变量只会变成无意义的循环请求
    if (favoritesOnly.value) return;
    if (!el || !marker || !hasMore.value || moreError.value) return;
    const box = el.getBoundingClientRect();
    const markerBox = marker.getBoundingClientRect();
    if (markerBox.top - box.bottom < 400) {
      // 视口没被填满：等节流窗口过去再补一页，避免与 loadMore 的冷却互相卡死
      const wait = Math.max(0, MIN_LOAD_MORE_GAP_MS - (Date.now() - lastLoadMoreMs));
      window.setTimeout(() => void loadMore(), wait + 30);
    }
  }

  /** 就地改列表里的对象：selected 引用同一个对象，详情面板会自动同步 */
  function patchMod(modId: number, patch: Partial<OnlineMod>): void {
    const item = items.value.find((m) => m.modId === modId);
    if (item) Object.assign(item, patch);
    // 列表曾重建过时，详情可能持有另一份引用，这里兜底同步
    if (selection.selected.value && selection.selected.value.modId === modId && selection.selected.value !== item) {
      Object.assign(selection.selected.value, patch);
    }
  }

  function pickTag(id: number | null): void {
    // 分类与收藏视图互斥：选了分类就必然要退出收藏视图
    const wasFavorites = favoritesOnly.value;
    if (wasFavorites) favoritesOnly.value = false;
    // 点官方分类 = 回到官方列表，本地搜索框自动清空
    const wasLocal = deps.clearLocalSearch();
    if (activeTag.value === id && !wasFavorites && !wasLocal) return;
    activeTag.value = id;
    void reload();
  }

  function pickSubscribed(value: boolean): void {
    // 来源与收藏视图互斥：在收藏视图里点来源，先退出收藏再按来源重查
    const wasFavorites = favoritesOnly.value;
    if (wasFavorites) favoritesOnly.value = false;
    // 切来源也是回官方列表，本地搜索框一并清空
    const wasLocal = deps.clearLocalSearch();
    if (onlySubscribed.value === value && !wasLocal) return;
    onlySubscribed.value = value;
    // /Installed 不支持 tags 过滤：进入「已订阅」必须清空官方分类，
    // 否则前端过滤会把「全部订阅」砍成只剩几条（看起来像只同步了少量模组）
    if (value) activeTag.value = null;
    noCacheOffline.value = false;
    void reload();
  }

  /**
   * 「⭐ 我的收藏」开关（纯本地）。
   * 切换后 reload() 内部会直接走 loadFavorites()：
   * 只用 user_data.json 的收藏 ID 匹配「缓存池 + 当前列表」，
   * **不会调用 Find / Installed**，断网也可用；哨兵被 v-if 移除后自动翻页也会停掉。
   */
  function toggleFavorites(): void {
    // 收藏是纯本地视图，与本地搜索互斥
    deps.clearLocalSearch();
    favoritesOnly.value = !favoritesOnly.value;
    void reload();
  }

  /** 退出登录后丢弃收藏候选池（下次收藏视图重新读缓存） */
  function resetFavoritePool(): void {
    favoritePool.value = null;
  }

  /**
   * 滚动位置记忆（仅组件内部状态，不触发渲染）。
   * KeepAlive 把子树移出文档后 clientHeight/scrollHeight 都变 0，
   * 所以必须在滚动事件里持续记录，且只在容器确实有滚动高度时才覆写。
   */
  let savedScrollTop = 0;

  function rememberScroll(): void {
    const el = scrollEl.value;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight) savedScrollTop = el.scrollTop;
  }

  /** 被 KeepAlive 再次显示：把 scrollTop 还原（数据不动、不发请求） */
  function restoreScrollTop(): void {
    const el = scrollEl.value;
    if (!el) return;
    const target = savedScrollTop;
    if (target <= 0) return;
    el.scrollTop = target;
    // 缩略图 / 字体回流会让高度暂时不足导致 scrollTop 被截断，下一帧补一次
    if (el.scrollTop < target) {
      requestAnimationFrame(() => {
        const again = scrollEl.value;
        if (again && again.scrollTop < target) again.scrollTop = target;
      });
    }
  }

  /** 退出登录 / 会话失效时由页面重新走一次 reload（列表保留缓存，不在这里清空） */
  return {
    items,
    totalCount,
    loading,
    loadingMore,
    error,
    moreError,
    hasMore,
    onlySubscribed,
    favoritesOnly,
    noCacheOffline,
    activeTag,
    effectiveTag,
    visibleOfficialItems,
    sentinel,
    reload,
    loadMore,
    resetScrollToTop,
    patchMod,
    pickTag,
    pickSubscribed,
    toggleFavorites,
    resetFavoritePool,
    rememberScroll,
    restoreScrollTop,
  };
}

export type OnlineList = ReturnType<typeof useOnlineList>;
