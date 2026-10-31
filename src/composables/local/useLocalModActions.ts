/**
 * 本地页的「单条目操作」：选中、启用/禁用写回、删除后局部移除、详情统计。
 *
 * 共同点：全部是**就地局部更新**（只 patch 一条 / 只摘一条），
 * 绝不触发重扫 —— 筛选状态、滚动位置、体积统计都不受影响。
 * 统计信息与选中项绑在一起（detail 面板的数据源），所以一起放在这里。
 */
import { ref, watch, type Ref } from "vue";
import { modStats } from "../../api";
import type { ModEntry, ModStats, ScanReport } from "../../types";
import type { SortMode } from "./useSortMode";

export function useLocalModActions(deps: {
  report: Ref<ScanReport | null>;
  selectedId: Ref<string | null>;
  patchModEnabled: (id: string, enabled: boolean) => void;
  sort: SortMode;
  normalizeError: (e: unknown) => string;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { report, selectedId, patchModEnabled, sort, showToast } = deps;

  const stats = ref<ModStats | null>(null);
  const statsLoading = ref(false);
  const statsError = ref<string | null>(null);

  function selectMod(mod: ModEntry): void {
    // 拖拽松手时浏览器仍会补一个 click：这段时间内忽略，避免排序时误切换选中项
    if (sort.isClickSuppressed()) return;
    selectedId.value = mod.id;
  }

  function handleToggle(payload: { enabled: boolean }): void {
    const id = selectedId.value;
    if (!id) return;
    patchModEnabled(id, payload.enabled);
  }

  /** v0.9：卡片右下角快捷开关写入成功 → 只改这一条 */
  function handleCardToggled(payload: { id: string; enabled: boolean }): void {
    patchModEnabled(payload.id, payload.enabled);
    // v1.2：排序模式下只排启用项。卡片刚被关掉 → 立即退出可拖拽列表（列表长度变化会标记为未保存）
    if (!sort.sortMode.value || payload.enabled) return;
    const index = sort.dragList.value.findIndex((m) => m.id === payload.id);
    if (index >= 0) sort.dragList.value.splice(index, 1);
  }

  /** v0.9：卡片快捷开关失败 / 未登记 → 统一走右下角 Toast */
  function handleCardToggleError(message: string): void {
    showToast(message, "error");
  }

  /**
   * 删除后的局部移除：只把这一条从数组里摘掉，不重扫、不重置筛选。
   * 删的可能刚好是当前选中项，所以顺手把选中项回退到同位置上的一条。
   */
  function handleRemoved(payload: { id: string }): void {
    const list = report.value?.mods;
    if (!list) return;
    const index = list.findIndex((m) => m.id === payload.id);
    if (index < 0) return;
    const wasSelected = selectedId.value === payload.id;
    list.splice(index, 1);
    if (!wasSelected) return;
    const next = list[index] ?? list[index - 1] ?? null;
    selectedId.value = next?.id ?? null;
  }

  // 详情统计：跟着选中项走，切换时先清空避免上一份数据残留
  watch(selectedId, async (id) => {
    stats.value = null;
    statsError.value = null;
    if (!id) return;
    const mod = report.value?.mods.find((m) => m.id === id);
    if (!mod) return;
    statsLoading.value = true;
    try {
      stats.value = await modStats(mod.path);
    } catch (e) {
      statsError.value = deps.normalizeError(e);
    } finally {
      statsLoading.value = false;
    }
  });

  return {
    stats,
    statsLoading,
    statsError,
    selectMod,
    handleToggle,
    handleCardToggled,
    handleCardToggleError,
    handleRemoved,
  };
}

export type LocalModActions = ReturnType<typeof useLocalModActions>;
