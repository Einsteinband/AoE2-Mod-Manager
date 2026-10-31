/**
 * 本地页的「筛选 / 搜索 / 排序键 / 分类」状态与派生结果。
 *
 * 边界：只处理**内存里的 ModEntry 列表**，不认识扫描、排序模式、弹窗。
 * 页面、排序模式、批量操作都从这里读 `sorted` / `filtered`，保证三处口径一致。
 *
 * 两条互斥规则原样保留（都是踩过坑的）：
 * 1. 收藏视图与「来源 / 状态 / 官方分类」互斥 —— 叠加会让侧栏计数与列表条数对不上；
 * 2. 标签索引把官方与推断的同名标签合并计数 —— 保证“侧栏显示的数量”与“点开后的条数”一致。
 */
import { computed, ref, watch, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { customNameOf, displayTitle, isFavorite } from "../../userData";
import { TAG_ZH } from "../../online/types";
import type { ModEntry, SortKey, SourceFilter, StatusFilter } from "../../types";

interface TagOption {
  name: string;
  count: number;
}

/** 排序模式进入前的筛选快照，退出时还原 */
export interface FilterSnapshot {
  search: string;
  source: SourceFilter;
  status: StatusFilter;
  activeTag: string | null;
  sortKey: SortKey;
  favoritesOnly: boolean;
}

/** 官方 17 项分类的固定顺序（直接复用在线页的 TAG_ZH，保证两侧排列一致） */
const TAG_ORDER: Record<string, number> = Object.fromEntries(
  Object.values(TAG_ZH).map((name, index) => [name, index]),
);

export function useLocalFilters(deps: {
  mods: ComputedRef<ModEntry[]>;
  collationLocale: ComputedRef<string>;
}) {
  const { t } = useI18n();
  const { mods, collationLocale } = deps;

  const search = ref("");
  const source = ref<SourceFilter>("all");
  const status = ref<StatusFilter>("all");
  /** v0.5：只看收藏（只过滤 isFavorite === true，按 WorkshopID 匹配） */
  const favoritesOnly = ref(false);
  const sortKey = ref<SortKey>("name");
  /** 左侧选中的官方/推断标签；null = 全部内容 */
  const activeTag = ref<string | null>(null);

  const sourceCounts = computed(() => ({
    all: mods.value.length,
    local: mods.value.filter((m) => m.kind === "local").length,
    subscribed: mods.value.filter((m) => m.kind === "subscribed").length,
  }));

  const statusCounts = computed(() => {
    const counts = { enabled: 0, disabled: 0, unknown: 0 };
    for (const m of mods.value) {
      if (m.enabled === true) counts.enabled += 1;
      else if (m.enabled === false) counts.disabled += 1;
      else counts.unknown += 1;
    }
    return counts;
  });

  const filtered = computed<ModEntry[]>(() => {
    const q = search.value.trim().toLowerCase();
    /**
     * 收藏视图与「来源 / 状态 / 官方分类」互斥：
     * 两套条件叠加时侧栏计数（3 个收藏）与列表条数（48/1037）必然对不上，
     * 所以收藏视图下只按 isFavorite 过滤（外加搜索关键字）。
     */
    const fav = favoritesOnly.value;
    return mods.value.filter((m) => {
      if (fav && !isFavorite(m.workshopId)) return false;
      if (!fav) {
        if (source.value !== "all" && m.kind !== source.value) return false;
        if (status.value === "enabled" && m.enabled !== true) return false;
        if (status.value === "disabled" && m.enabled !== false) return false;
        if (status.value === "unknown" && m.enabled !== null) return false;
        if (activeTag.value && !m.contentTags.includes(activeTag.value)) return false;
      }
      if (!q) return true;
      const haystack = [
        displayTitle(m.workshopId, m.displayName),
        customNameOf(m.workshopId) ?? "",
        m.displayName,
        m.nameFromFolder,
        m.folderName,
        m.author ?? "",
        m.description ?? "",
        m.workshopId === null ? "" : String(m.workshopId),
      ];
      return haystack.some((v) => v.toLowerCase().includes(q));
    });
  });

  const sorted = computed<ModEntry[]>(() => {
    const list = [...filtered.value];
    const collator = new Intl.Collator(collationLocale.value, {
      numeric: true,
      sensitivity: "base",
    });
    list.sort((a, b) => {
      switch (sortKey.value) {
        case "updated": {
          const av = a.lastUpdateMs ?? -1;
          const bv = b.lastUpdateMs ?? -1;
          return bv - av;
        }
        case "priority": {
          const av = a.priority ?? Number.MAX_SAFE_INTEGER;
          const bv = b.priority ?? Number.MAX_SAFE_INTEGER;
          return av - bv;
        }
        case "folder":
          return collator.compare(a.folderName, b.folderName);
        case "name":
        default:
          return collator.compare(
            displayTitle(a.workshopId, a.displayName),
            displayTitle(b.workshopId, b.displayName),
          );
      }
    });
    return list;
  });

  /**
   * 标签索引：官方与推断同名标签合并计数，
   * 保证“侧栏显示的数量”与“点击后的结果数量”一致。
   */
  const tagIndex = computed(() => {
    const map = new Map<string, { count: number; official: boolean }>();
    for (const mod of mods.value) {
      const isOfficial = mod.categorySource === "official";
      for (const tag of mod.contentTags) {
        const current = map.get(tag) ?? { count: 0, official: false };
        current.count += 1;
        if (isOfficial) current.official = true;
        map.set(tag, current);
      }
    }
    return map;
  });

  /** 官方分类：只来自 mod_metadata.json 记录过的模组，按官方字典顺序排 */
  const officialTagList = computed<TagOption[]>(() =>
    [...tagIndex.value.entries()]
      .filter(([, value]) => value.official)
      .map(([name, value]) => ({ name, count: value.count }))
      .sort((a, b) => {
        const ai = TAG_ORDER[a.name] ?? Number.MAX_SAFE_INTEGER;
        const bi = TAG_ORDER[b.name] ?? Number.MAX_SAFE_INTEGER;
        return ai === bi ? a.name.localeCompare(b.name, collationLocale.value) : ai - bi;
      }),
  );

  /** 特征推断：本地扫描兜底得出的标签，按命中数降序 */
  const inferredTagList = computed<TagOption[]>(() =>
    [...tagIndex.value.entries()]
      .filter(([, value]) => !value.official)
      .map(([name, value]) => ({ name, count: value.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, collationLocale.value)),
  );

  const activeTagLabel = computed(() => activeTag.value ?? t("sidebar.allContent"));

  const heading = computed(() => {
    if (favoritesOnly.value) return t("favorites.heading");
    if (source.value === "local") return t("content.localMods");
    if (source.value === "subscribed") return t("content.subscribedMods");
    return t("content.allMods");
  });

  /** v0.5：本地列表里的收藏数（侧栏计数） */
  const favoriteLocalCount = computed(
    () => mods.value.filter((m) => isFavorite(m.workshopId)).length,
  );

  /** 内容区副标题右侧的状态文案 */
  const statusText = computed(() => {
    if (status.value === "enabled") return t("content.statusEnabled");
    if (status.value === "disabled") return t("content.statusDisabled");
    if (status.value === "unknown") return t("content.statusUnknown");
    return t("content.statusAll");
  });

  /** 内容区副标题：收藏视图下明确说明「分类已让位」，避免用户以为分类还在生效 */
  const contentHint = computed(() =>
    favoritesOnly.value ? t("favorites.scopeHint") : `${activeTagLabel.value} · ${statusText.value}`,
  );

  /**
   * 侧栏「⭐ 我的收藏」开关。
   * 进入收藏视图时把来源 / 状态 / 分类全部复位：只按收藏过滤，计数与列表条数才一致。
   */
  function toggleFavorites(): void {
    favoritesOnly.value = !favoritesOnly.value;
    if (!favoritesOnly.value) return;
    source.value = "all";
    status.value = "all";
    activeTag.value = null;
  }

  /** 点来源 / 状态 / 分类：先退出收藏视图，否则条件叠加又会出现计数错位 */
  function pickSource(next: SourceFilter): void {
    favoritesOnly.value = false;
    source.value = next;
  }

  function pickStatus(next: StatusFilter): void {
    favoritesOnly.value = false;
    status.value = next;
  }

  function pickTag(next: string | null): void {
    favoritesOnly.value = false;
    activeTag.value = next;
  }

  /** 空态里的「清除筛选」：一次性复位全部条件 */
  function clearFilters(): void {
    search.value = "";
    source.value = "all";
    status.value = "all";
    activeTag.value = null;
    favoritesOnly.value = false;
  }

  /** 排序模式：进入前快照，退出时还原（排序只对全量列表有意义） */
  function snapshot(): FilterSnapshot {
    return {
      search: search.value,
      source: source.value,
      status: status.value,
      activeTag: activeTag.value,
      sortKey: sortKey.value,
      favoritesOnly: favoritesOnly.value,
    };
  }

  function restore(snap: FilterSnapshot): void {
    search.value = snap.search;
    source.value = snap.source;
    status.value = snap.status;
    activeTag.value = snap.activeTag;
    sortKey.value = snap.sortKey;
    favoritesOnly.value = snap.favoritesOnly;
  }

  // 重新扫描/卸装后选中的标签可能消失：自动退回“全部内容”，避免莫名空列表
  watch([officialTagList, inferredTagList], () => {
    if (!activeTag.value) return;
    const stillExists =
      officialTagList.value.some((item) => item.name === activeTag.value) ||
      inferredTagList.value.some((item) => item.name === activeTag.value);
    if (!stillExists) activeTag.value = null;
  });

  return {
    search,
    source,
    status,
    favoritesOnly,
    sortKey,
    activeTag,
    sourceCounts,
    statusCounts,
    sorted,
    officialTagList,
    inferredTagList,
    heading,
    contentHint,
    favoriteLocalCount,
    toggleFavorites,
    pickSource,
    pickStatus,
    pickTag,
    clearFilters,
    snapshot,
    restore,
  };
}

export type LocalFilters = ReturnType<typeof useLocalFilters>;
