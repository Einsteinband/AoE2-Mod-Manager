/**
 * 本地页的「手动拖拽排序模式」：进入 / 退出、内存顺序、保存、放弃、热键、Sortable 生命周期。
 *
 * 三条约定的行为（不要“优化”掉）：
 * 1. 排序只对**全量列表**有意义：进入时清空搜索/筛选并把左侧栏锁定，列表固定按 Priority 升序；
 * 2. 只对**已启用**模组排序（未启用模组的 Priority 没有实际意义）；
 * 3. 拖拽只改内存顺序，**只有点保存 / Ctrl+S 才写盘**；写盘失败按上次成功保存的顺序回滚。
 *
 * 依赖方向：本文件依赖筛选状态（进入前快照、退出时还原），筛选状态不反依赖本文件，
 * 因此不会出现循环引用。扫描结果的「重扫前先退出排序」由页面负责（见 App.vue 的 rescan）。
 */
import { computed, nextTick, onBeforeUnmount, ref, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { updateModPriority } from "../../api";
import { attachDragSort, type DragEndPayload } from "../../dragSort";
import { normalizeBackendError } from "../../format";
import { displayTitle } from "../../userData";
import type { ModEntry } from "../../types";
import type { LocalFilters } from "./useLocalFilters";

export function useSortMode(deps: {
  mods: ComputedRef<ModEntry[]>;
  loading: Ref<boolean>;
  collationLocale: ComputedRef<string>;
  filters: LocalFilters;
  hasReport: () => boolean;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { mods, loading, collationLocale, filters, showToast } = deps;

  /** 排序模式：只有开启时卡片才可拖拽，关闭时保持正常的点击选中 */
  const sortMode = ref(false);
  const sortSaving = ref(false);
  /**
   * 可拖拽的列表：只含 enabled === true 的模组，与 report.mods 是同一批对象引用，改 Priority 无需重扫。
   * v1.2：未启用模组不参与加载优先级，整块不进入可拖拽列表（也不再单独列在下方）。
   */
  const dragList = ref<ModEntry[]>([]);
  /** 排序模式下被隐藏的模组数（enabled !== true），只在顶部提示条里报个数 */
  const excludedSortCount = computed(() => mods.value.filter((m) => m.enabled !== true).length);
  /** 最近一次成功写入磁盘的顺序（判断“有没有未保存改动”，失败时也按它回滚） */
  const savedOrder = ref<string[]>([]);
  /** 有未保存改动时退出排序模式的二次确认 */
  const showDiscardConfirm = ref(false);
  /** 进入排序模式前的筛选快照，退出时还原 */
  let sortSnapshot: ReturnType<LocalFilters["snapshot"]> | null = null;
  /** 本次排序是否真的改过顺序（决定退出后是否停在“按加载优先级”） */
  let orderChanged = false;
  /** 拖拽结束后短时间内屏蔽 click，避免松手时把卡片误选中 */
  let suppressClickUntil = 0;

  /** 排序网格的真实 DOM（由 ModGrid 就绪回调写入） */
  const gridEl = ref<HTMLElement | null>(null);
  let disposeDrag: (() => void) | null = null;

  function compareByPriority(a: ModEntry, b: ModEntry): number {
    const collator = new Intl.Collator(collationLocale.value, {
      numeric: true,
      sensitivity: "base",
    });
    const av = a.priority ?? Number.MAX_SAFE_INTEGER;
    const bv = b.priority ?? Number.MAX_SAFE_INTEGER;
    return av === bv
      ? collator.compare(
          displayTitle(a.workshopId, a.displayName),
          displayTitle(b.workshopId, b.displayName),
        )
      : av - bv;
  }

  /**
   * 挂载 Sortable。
   * 必须等 DOM 真正渲染出 .sort-grid 之后再挂（否则 gridEl 还是 null），
   * 旧实现靠 watch([gridEl, sortMode]) 兑，一旦 el 与 sortMode 在同一次 patch 里变化，
   * 回调可能在 gridEl 还是 null 时就跑完（之后不会再补一次），
   * 结果就是“能进排序模式、但卡片完全拖不动且无任何报错”。
   */
  async function mountDragSortable(): Promise<void> {
    await nextTick();
    const el = gridEl.value;
    if (!el) {
      console.warn("[sort] 排序网格未渲染出来，拖拽未挂载");
      return;
    }
    disposeDrag?.();
    disposeDrag = attachDragSort(el, handleDragEnd);
  }

  function unmountDragSortable(): void {
    disposeDrag?.();
    disposeDrag = null;
  }

  /**
   * 进入排序模式。
   * 关键决策：手动排序只对**全量列表**有意义——过滤后的子集一旦拖拽，
   * 拖出来的相对顺序会和全局顺序冲突（且无法推断插到哪个槽位），
   * 所以进入时清空搜索/筛选并把左侧栏置灰锁定，列表固定按 Priority 升序。
   */
  async function enterSortMode(): Promise<void> {
    if (loading.value || sortSaving.value || !deps.hasReport() || !mods.value.length) return;
    // 一个已启用模组都没有时，排序没有任何意义，直接拦下并提示
    if (!mods.value.some((m) => m.enabled === true)) {
      showToast(t("sort.nothingEnabled"), "error");
      return;
    }
    sortSnapshot = filters.snapshot();
    filters.search.value = "";
    filters.source.value = "all";
    filters.status.value = "all";
    filters.activeTag.value = null;
    filters.favoritesOnly.value = false;
    filters.sortKey.value = "priority";

    // v1.2：排序只针对已启用模组。未启用模组的 Priority 没有实际意义，
    // 混进可拖拽列表既干扰生效顺序、又需要用户多拖几十张无用的卡片。
    const byPriority = [...mods.value].sort(compareByPriority);
    dragList.value = byPriority.filter((m) => m.enabled === true);
    savedOrder.value = dragList.value.map((m) => m.id);
    orderChanged = false;
    sortMode.value = true;
    // 必须等 DOM 真正渲染出 .sort-grid 再挂载（否则 gridEl 还是 null）
    await mountDragSortable();
  }

  function exitSortMode(): void {
    if (!sortMode.value) return;
    sortMode.value = false;
    showDiscardConfirm.value = false;
    unmountDragSortable();
    const snapshot = sortSnapshot;
    sortSnapshot = null;
    if (!snapshot) return;
    filters.restore(snapshot);
    // 本次真的排过序就停在“按加载优先级”，否则拖完看不到结果
    filters.sortKey.value = orderChanged ? "priority" : snapshot.sortKey;
  }

  function handleDragEnd({ oldIndex, newIndex }: DragEndPayload): void {
    const list = dragList.value;
    if (oldIndex < 0 || oldIndex >= list.length) return;
    const [moved] = list.splice(oldIndex, 1);
    if (!moved) return;
    list.splice(Math.min(newIndex, list.length), 0, moved);
    suppressClickUntil = Date.now() + 150;
    // 只改内存顺序，不写盘：等用户点“保存排序”才调 update_mod_priority
  }

  /** 有未保存的改动？只比顺序，不比内容 */
  const sortDirty = computed(() => {
    const ids = dragList.value.map((m) => m.id);
    return (
      ids.length !== savedOrder.value.length || ids.some((id, i) => id !== savedOrder.value[i])
    );
  });

  /** 排序模式 + 有未保存改动：重扫 / 切页都必须先拦住（否则等于静默丢弃） */
  const blocksRescan = computed(() => sortMode.value && sortDirty.value);

  /** 拖拽刚松手：页面据此忽略浏览器补的 click，避免误切换选中项 */
  function isClickSuppressed(): boolean {
    return Date.now() < suppressClickUntil;
  }

  /**
   * 手动保存：只有点“保存排序”（或排序模式下按 Ctrl+S）才写盘。
   * 成功后**只**改内存里的 Priority（同一批对象引用），绝不重扫：不闪、滚动条不复位。
   */
  async function saveSortOrder(): Promise<void> {
    if (sortSaving.value || !sortMode.value || !sortDirty.value) return;
    const list = [...dragList.value];
    const ids = list.map((m) => m.id);

    sortSaving.value = true;
    try {
      const outcome = await updateModPriority(ids);
      list.forEach((mod, index) => {
        mod.priority = index + 1;
      });
      // v1.2：后端把未启用模组接在 N+1.. 顺延，这里同步内存值，
      // 否则退出排序后仍按旧 Priority 排序，已启用模组会被未启用的挤下去
      [...mods.value.filter((m) => m.enabled !== true)]
        .sort(compareByPriority)
        .forEach((mod, index) => {
          mod.priority = list.length + index + 1;
        });
      savedOrder.value = ids;
      orderChanged = true;
      showToast(t("sort.savedToast", { n: outcome.updated }));
    } catch (e) {
      // 磁盘没写成功 → 界面顺序回到上一次成功保存的样子
      const byId = new Map(dragList.value.map((m) => [m.id, m]));
      dragList.value = savedOrder.value
        .map((id) => byId.get(id))
        .filter((m): m is ModEntry => Boolean(m));
      showToast(normalizeBackendError(e), "error");
    } finally {
      sortSaving.value = false;
    }
  }

  /** 退出排序模式：有未保存改动时先二次确认 */
  function requestExitSortMode(): void {
    if (!sortMode.value || sortSaving.value) return;
    if (sortDirty.value) {
      showDiscardConfirm.value = true;
      return;
    }
    exitSortMode();
  }

  /** 放弃更改：内存里的 Priority 本来就没动，直接退出，列表自然回到磁盘顺序 */
  function discardSortChanges(): void {
    showDiscardConfirm.value = false;
    exitSortMode();
  }

  /** 排序模式下 Ctrl+S 手动保存 */
  function onSortHotkey(event: KeyboardEvent): void {
    if (!sortMode.value) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    void saveSortOrder();
  }

  onBeforeUnmount(unmountDragSortable);

  return {
    sortMode,
    sortSaving,
    dragList,
    showDiscardConfirm,
    sortDirty,
    blocksRescan,
    excludedSortCount,
    gridEl,
    enterSortMode,
    exitSortMode,
    requestExitSortMode,
    discardSortChanges,
    saveSortOrder,
    isClickSuppressed,
    onSortHotkey,
  };
}

export type SortMode = ReturnType<typeof useSortMode>;
