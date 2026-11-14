import { computed, ref } from "vue";
import { SORT_OPTIONS, type OnlineMod } from "../../online/types";
import { ONLINE_SIZE_SORT, validSize } from "./sortOnlineMods";

const STORAGE_KEY = "aoe2mm.onlineSizeSortEnabled";

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 在线文件大小排序开关；默认关闭，旧设置缺字段也按关闭处理。 */
export const onlineSizeSortEnabled = ref(readStoredEnabled());

/** 开关只持久化到浏览器本地偏好，不触发在线接口，也不影响本地 Mod 排序。 */
export function setOnlineSizeSortEnabled(next: boolean): void {
  onlineSizeSortEnabled.value = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* 存储不可用时保留本次会话状态。 */
  }
}

export const DEFAULT_ONLINE_SORT = SORT_OPTIONS[0].value;

/** 关闭开关后，当前选择仍停留在大小排序时回退到默认服务端排序。 */
export function normalizeOnlineSortForSetting(sort: string): string {
  return onlineSizeSortEnabled.value ? sort : sort === ONLINE_SIZE_SORT ? DEFAULT_ONLINE_SORT : sort;
}

/** 在线排序下拉选项：只有开关开启时才暴露文件大小。 */
export const visibleOnlineSortOptions = computed(() =>
  SORT_OPTIONS.filter((opt) => opt.value !== ONLINE_SIZE_SORT || onlineSizeSortEnabled.value).map(
    (opt) => opt,
  ),
);

export type OnlineSizeHydrateStats = {
  total: number;
  existing: number;
  supplemented: number;
  missing: number;
};


/**
 * 只补齐当前列表中缺失的大小：优先保留当前列表已有值，按 modId 读取同条件缓存页。
 * 不新增条目、不修改原列表；无法匹配或缓存值非法时保持 null。
 */
export function hydrateOnlineModSizes(
  mods: OnlineMod[],
  cachedSizeByModId: Map<number, number>,
): { items: OnlineMod[]; stats: OnlineSizeHydrateStats } {
  const stats: OnlineSizeHydrateStats = { total: mods.length, existing: 0, supplemented: 0, missing: 0 };
  const items = mods.map((mod) => {
    const currentSize = validSize(mod.fileSize);
    if (currentSize !== null) {
      stats.existing += 1;
      return mod;
    }
    const cachedSize = cachedSizeByModId.get(mod.modId);
    if (cachedSize !== undefined && cachedSize >= 0) {
      stats.supplemented += 1;
      return { ...mod, fileSize: cachedSize };
    }
    stats.missing += 1;
    return mod;
  });
  return { items, stats };
}
