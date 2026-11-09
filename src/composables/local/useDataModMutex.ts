/**
 * 数据模组互斥（游戏同一时间只能加载一个 .dat）
 *
 * 包含单个启用的冲突确认 + 批量启用时的数据模组裁剪。
 */
import { computed, ref, type Ref } from "vue";
import type { ModEntry } from "../../types";
import { toggleModEnabled } from "../../api";
import { translateBackendMessage } from "../../format";
import { useBatchToggle } from "../local/useBatchToggle";

export function useDataModMutex(options: {
  scan: {
    report: Ref<any>;
    patchModEnabled: (id: string, enabled: boolean) => void;
    normalizeError: (e: unknown) => string;
  };
  sorted: Ref<ModEntry[]>;
  t: (key: string, params?: Record<string, unknown>) => string;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { scan, sorted, t, showToast } = options;

  /** 待用户确认的冲突：旧数据模组（已启用）→ 新数据模组（将要启用） */
  const dataModConflict = ref<{ oldMod: ModEntry; newMod: ModEntry } | null>(null);
  const dataModBusy = ref(false);
  const dataModErrorRaw = ref<string | null>(null);
  const dataModError = computed(() =>
    dataModErrorRaw.value ? translateBackendMessage(dataModErrorRaw.value) : null,
  );

  /** 当前已启用的其他数据模组（排除 excludeId 自己） */
  function enabledDataMods(excludeId?: string): ModEntry[] {
    return (scan.report.value?.mods ?? []).filter(
      (m: ModEntry) => m.isDataMod && m.enabled === true && m.id !== excludeId,
    );
  }

  /** 写一条启用状态（只 patch 这一条，不重扫） */
  async function writeModEnabled(mod: ModEntry, enabled: boolean): Promise<void> {
    const result = await toggleModEnabled(mod.workshopId, mod.kind, mod.folderName, enabled);
    scan.patchModEnabled(mod.id, result.enabled);
  }

  /** 没有冲突时直接启用数据模组 */
  async function enableDataMod(mod: ModEntry): Promise<void> {
    dataModBusy.value = true;
    dataModErrorRaw.value = null;
    try {
      await writeModEnabled(mod, true);
      showToast(t("dataMod.enabledToast", { name: mod.displayName }));
    } catch (e) {
      showToast(scan.normalizeError(e), "error");
    } finally {
      dataModBusy.value = false;
    }
  }

  /**
   * 卡片 / 详情页的「启用数据模组」请求：先查已有的数据模组，
   * 已启用另一个则弹冲突确认，否则直接启用。
   */
  function requestEnableDataMod(payload: { id: string }): void {
    if (dataModBusy.value || dataModConflict.value) return;
    const mod = scan.report.value?.mods.find((m: ModEntry) => m.id === payload.id);
    if (!mod) return;
    const conflict = enabledDataMods(mod.id)[0] ?? null;
    if (!conflict) {
      void enableDataMod(mod);
      return;
    }
    dataModErrorRaw.value = null;
    dataModConflict.value = { oldMod: conflict, newMod: mod };
  }

  /** 用户确认：先禁用旧的数据模组，再启用新的 */
  async function confirmDataModSwitch(): Promise<void> {
    const conflict = dataModConflict.value;
    if (!conflict || dataModBusy.value) return;
    dataModBusy.value = true;
    dataModErrorRaw.value = null;
    try {
      await writeModEnabled(conflict.oldMod, false);
      await writeModEnabled(conflict.newMod, true);
      dataModConflict.value = null;
      showToast(
        t("dataMod.switchedToast", {
          old: conflict.oldMod.displayName,
          new: conflict.newMod.displayName,
        }),
      );
    } catch (e) {
      dataModErrorRaw.value = scan.normalizeError(e);
    } finally {
      dataModBusy.value = false;
    }
  }

  /** 用户取消：中止启用，不动磁盘 */
  function cancelDataModSwitch(): void {
    if (dataModBusy.value) return;
    dataModConflict.value = null;
    dataModErrorRaw.value = null;
  }

  // ---------------- 批量启用时的数据模组互斥 ----------------

  /** 本次批量启用被跳过的数据模组数量（0 = 无跳过） */
  const dataModSkipCount = ref(0);
  /** 本次批量启用需要顺带禁用的旧数据模组 */
  const dataModBatchDisable = ref<ModEntry[]>([]);
  /** 批量目标覆盖：null = 直接用当前筛选结果（不改变 collation / 筛选） */
  const batchOverride = ref<ModEntry[] | null>(null);
  const batchSource = computed(() => batchOverride.value ?? sorted.value);

  /** batch 自己的 Toast：把「跳过 X 个数据模组」并入结果提示，避免两条提示互相覆盖 */
  function showBatchToast(text: string, kind: "ok" | "error" = "ok"): void {
    if (dataModSkipCount.value > 0) {
      showToast(`${text}${t("batch.dataModSkipped", { n: dataModSkipCount.value })}`, kind);
      return;
    }
    showToast(text, kind);
  }

  const batch = useBatchToggle({
    sorted: batchSource,
    report: scan.report,
    patchModEnabled: scan.patchModEnabled,
    normalizeError: scan.normalizeError,
    showToast: showBatchToast,
  });
  const { batchAsk, batchBusy, batchError, batchTargets, askBatch, runBatchToggle, cancelBatch } = batch;

  function resetBatchDataMod(): void {
    batchOverride.value = null;
    dataModBatchDisable.value = [];
    dataModSkipCount.value = 0;
  }

  /**
   * 全部启用：数据模组只能留一个。
   * 取当前列表里排在最前面（优先级最高）的那个，其余从本次目标里摘掉（静默跳过）；
   * 已启用但不是它的数据模组会在确认后被禁用，否则游戏里会互相覆盖。
   */
  function askBatchEnable(): void {
    if (batchBusy.value) return;
    const list = sorted.value;
    const dataMods = list.filter((m) => m.isDataMod);
    const winner = dataMods[0] ?? null;
    const skipped = winner ? dataMods.length - 1 : 0;
    dataModSkipCount.value = skipped;
    // 列表里没有数据模组时，不做任何额外禁用（别误伤用户已有的数据模组）
    dataModBatchDisable.value = winner ? enabledDataMods(winner.id) : [];
    batchOverride.value =
      skipped > 0 ? list.filter((m) => !m.isDataMod || m.id === winner?.id) : null;
    askBatch(true);
  }

  /** 全部禁用：与数据模组无关，清掉残留状态后照常走 */
  function askBatchDisable(): void {
    resetBatchDataMod();
    askBatch(false);
  }

  /** 确认执行：批量启用时先禁用冲突的旧数据模组，再整批启用（批次仍只写一次盘） */
  async function runBatchToggleGuarded(): Promise<void> {
    if (batchAsk.value === null || batchBusy.value) return;
    if (batchAsk.value === false) {
      await runBatchToggle();
      resetBatchDataMod();
      return;
    }
    for (const stale of dataModBatchDisable.value) {
      try {
        await writeModEnabled(stale, false);
      } catch (e) {
        // 弹窗不关：用户可以重试或取消，绝不带着两个数据模组继续下去
        showToast(scan.normalizeError(e), "error");
        return;
      }
    }
    await runBatchToggle();
    resetBatchDataMod();
  }

  function cancelBatchGuarded(): void {
    cancelBatch();
    resetBatchDataMod();
  }

  /** 批量确认文案：把「跳过几个数据模组 / 会先禁用哪个」如实写进弹窗 */
  const batchConfirmMessage = computed(() => {
    if (batchAsk.value !== true) {
      return t("batch.confirmDisableMessage", { n: batchTargets.value.length });
    }
    let text = t("batch.confirmEnableMessage", { n: batchTargets.value.length });
    if (dataModSkipCount.value > 0) {
      text += t("batch.dataModSkipNote", { n: dataModSkipCount.value });
    }
    const stale = dataModBatchDisable.value;
    if (stale.length) {
      text += t("batch.dataModDisableNote", {
      names: stale.map((m) => m.displayName).join(" / "),
    });
    }
    return text;
  });

  return {
    // 单个互斥
    dataModConflict,
    dataModBusy,
    dataModError,
    requestEnableDataMod,
    confirmDataModSwitch,
    cancelDataModSwitch,
    // 批量互斥
    batchAsk,
    batchBusy,
    batchError,
    batchTargets,
    askBatchEnable,
    askBatchDisable,
    runBatchToggleGuarded,
    cancelBatchGuarded,
    batchConfirmMessage,
  };
}
