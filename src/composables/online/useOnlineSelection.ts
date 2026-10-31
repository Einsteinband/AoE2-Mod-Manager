/**
 * 在线页的「当前打开的模组」。
 *
 * 单独一层是为了打断依赖环：列表（换筛选时要清空选中项）、详情、收藏、安装
 * 都要读写这一个 ref，谁也不该反向依赖谁。这里**不包含任何业务逻辑**。
 */
import { computed, ref } from "vue";
import type { OnlineMod } from "../../online/types";

export function useOnlineSelection() {
  const selected = ref<OnlineMod | null>(null);

  /** 选中项的稳定身份：详情 / 安装流程用它判断异步回调回来时是不是还停在同一个模组 */
  const selectedId = computed(() => selected.value?.modId ?? null);

  function select(mod: OnlineMod | null): void {
    selected.value = mod;
  }

  return { selected, selectedId, select };
}

export type OnlineSelection = ReturnType<typeof useOnlineSelection>;
