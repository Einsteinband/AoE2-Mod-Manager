import type { OnlineMod } from "../../online/types";

/** 前端本地排序键：官方接口未提供对应服务端排序参数，只对当前已加载条目排序。 */
export const ONLINE_SIZE_SORT = "fileSize";

export function validSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function normalizedSize(mod: OnlineMod): number | null {
  return validSize(mod.fileSize);
}

function compareFallback(a: OnlineMod, b: OnlineMod): number {
  const title = a.title.localeCompare(b.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return title !== 0 ? title : a.modId - b.modId;
}

/**
 * 按官方列表/详情透传的字节数排序。
 * null / 非有限数值统一视为未知；升序、降序都排在有效体积之后。0 字节是有效数值，不视为未知。
 */
export function sortOnlineModsBySize(
  mods: OnlineMod[],
  order: "DESC" | "ASC",
): OnlineMod[] {
  return [...mods].sort((a, b) => {
    const av = normalizedSize(a);
    const bv = normalizedSize(b);

    if (av === null && bv === null) return compareFallback(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return order === "DESC" ? bv - av : av - bv;
    return compareFallback(a, b);
  });
}
