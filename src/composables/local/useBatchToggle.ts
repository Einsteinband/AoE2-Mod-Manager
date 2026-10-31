/**
 * 本地页工具栏的「批量启用 / 批量禁用」。
 *
 * 后端整批只写一次盘（一次进程检测 → 一份备份 → 原子替换 → 回读校验），
 * 所以不会出现“前面改了、后面没改”。成功后只就地 patch 已登记（enabled !== null）的条目，
 * 不重扫、不重置筛选；未登记的条目由后端计入 notInStatus 并在 Toast 里告知。
 *
 * 目标列表 = **当前筛选结果**（不是全量）：WorkshopID 优先，local 模组靠 kind + 文件夹名定位。
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { batchToggleMods } from "../../api";
import type { BatchTarget, ModEntry, ScanReport } from "../../types";

export function useBatchToggle(deps: {
  sorted: ComputedRef<ModEntry[]>;
  report: Ref<ScanReport | null>;
  patchModEnabled: (id: string, enabled: boolean) => void;
  normalizeError: (e: unknown) => string;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { sorted, report, patchModEnabled, showToast } = deps;

  /** null = 未弹窗；true = 全部启用；false = 全部禁用 */
  const batchAsk = ref<boolean | null>(null);
  const batchBusy = ref(false);
  const batchError = ref<string | null>(null);

  /** 只传当前筛选出的列表：WorkshopID 优先，local 模组靠 kind + 文件夹名定位 */
  const batchTargets = computed<BatchTarget[]>(() =>
    sorted.value.map((mod) => ({
      workshopId: mod.workshopId && mod.workshopId > 0 ? mod.workshopId : null,
      kind: mod.kind,
      folderName: mod.folderName,
    })),
  );

  function askBatch(enable: boolean): void {
    if (batchBusy.value) return;
    if (!batchTargets.value.length) {
      showToast(t("batch.empty"), "error");
      return;
    }
    batchError.value = null;
    batchAsk.value = enable;
  }

  async function runBatchToggle(): Promise<void> {
    if (batchAsk.value === null || batchBusy.value) return;
    const enable = batchAsk.value;
    const targets = batchTargets.value;
    if (!targets.length) {
      batchAsk.value = null;
      showToast(t("batch.empty"), "error");
      return;
    }
    const keys = new Set(targets.map((target) => `${target.kind}//${target.folderName}`));
    batchBusy.value = true;
    batchError.value = null;
    try {
      const result = await batchToggleMods(enable, targets);
      for (const mod of report.value?.mods ?? []) {
        if (mod.enabled === null) continue;
        if (!keys.has(`${mod.kind}//${mod.folderName}`)) continue;
        patchModEnabled(mod.id, result.enabled);
      }
      batchAsk.value = null;
      if (result.notInStatus >= result.requested) {
        showToast(t("batch.allUnregistered"), "error");
      } else if (!result.wrote) {
        showToast(t("batch.noChange"));
      } else {
        const text =
          t(enable ? "batch.doneEnable" : "batch.doneDisable", {
            updated: result.updated,
            already: result.already,
          }) + (result.notInStatus > 0 ? t("batch.skipped", { n: result.notInStatus }) : "");
        showToast(text);
      }
    } catch (e) {
      batchError.value = deps.normalizeError(e);
    } finally {
      batchBusy.value = false;
    }
  }

  /** 关闭二次确认弹窗（取消） */
  function cancelBatch(): void {
    batchAsk.value = null;
  }

  return { batchAsk, batchBusy, batchError, batchTargets, askBatch, runBatchToggle, cancelBatch };
}

export type BatchToggle = ReturnType<typeof useBatchToggle>;
