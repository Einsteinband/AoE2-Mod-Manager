/**
 * 本地页的「预设管理」：弹窗开关、应用后的指纹记录、脏检查。
 *
 * 脏检查的设计（原样保留）：
 * - 应用预设后重扫一次，记住「启用集合指纹」（只取 id，排序后拼串）；
 * - 指纹一变就解除所有预设按钮的置灰，覆盖三条来源：
 *   软件内开关（局部 patch，不重扫）、游戏里改完再点「重新扫描」、安装 / 删除模组；
 * - 应用流程进行中的那次扫描不能被当成“用户手动改动”，所以用 `presetApplying` 挡住。
 */
import { computed, ref, watch, type ComputedRef } from "vue";
import type { ModEntry } from "../../types";

/** 启用集合指纹：只取 id，排序后拼串。任何开关 / 增删都会改变它 */
function enabledFingerprint(list: ModEntry[]): string {
  return list
    .filter((m) => m.enabled === true)
    .map((m) => m.id)
    .sort()
    .join("|");
}

export function usePresets(deps: {
  mods: ComputedRef<ModEntry[]>;
  /** 应用预设后的重扫（= 页面的 rescan 包装：会先退出排序模式并检查未保存改动） */
  rescan: () => Promise<void>;
}) {
  const { mods } = deps;

  const showPresets = ref(false);
  /** 最近一次成功应用的预设（脏检查靠它判断是否还能显示“当前已应用”） */
  const lastAppliedPresetId = ref<string | null>(null);
  /** 应用后重扫得到的「启用集合指纹」 */
  const appliedFingerprint = ref("");
  /** 应用流程正在进行：此期间的扫描结果不应被当成“用户手动改动” */
  let presetApplying = false;

  const fingerprint = computed(() => enabledFingerprint(mods.value));

  /** 应用预设后：重扫 → 用重扫结果记下指纹 → 标记“当前已应用” */
  async function handlePresetApplied(presetId: string): Promise<void> {
    presetApplying = true;
    try {
      await deps.rescan();
      appliedFingerprint.value = enabledFingerprint(mods.value);
      lastAppliedPresetId.value = presetId;
    } finally {
      presetApplying = false;
    }
  }

  /**
   * 脏检查：指纹一变就解除所有预设按钮的置灰。
   * 覆盖三条来源：软件内开关（handleToggle 局部 patch，无需重扫）、
   * 游戏里改完再点“重新扫描”、以及安装/删除模组。
   */
  watch(fingerprint, (next) => {
    if (presetApplying || !lastAppliedPresetId.value) return;
    if (next === appliedFingerprint.value) return;
    lastAppliedPresetId.value = null;
    appliedFingerprint.value = "";
  });

  return { showPresets, lastAppliedPresetId, handlePresetApplied };
}

export type Presets = ReturnType<typeof usePresets>;
