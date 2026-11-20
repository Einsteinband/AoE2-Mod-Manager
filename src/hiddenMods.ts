/**
 * 本地模组的「隐藏」显示偏好。
 *
 * 隐藏只是列表显示属性：不写 mod-status.json、不改启用状态、不改收藏、不删文件。
 * 键使用扫描条目的稳定 `id`（`kind:folderName`），这样没有 WorkshopID 的手动本地模组也能隐藏。
 * 纯前端 localStorage 偏好；不新增 Tauri 命令、数据库或第三方依赖。
 */
import { ref } from "vue";

const STORAGE_KEY = "aoe2mm.hiddenLocalMods.v1";

function normalizeEntryId(id: string | null | undefined): string | null {
  const trimmed = id?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readStoredIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = new Set<string>();
    for (const item of parsed) {
      const id = normalizeEntryId(typeof item === "string" ? item : null);
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

const hiddenIds = ref<Set<string>>(readStoredIds());

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenIds.value]));
  } catch {
    /* 存储不可用时保留本次会话状态；与现有 UI 偏好缓存口径一致。 */
  }
}

export function isHiddenMod(id: string | null | undefined): boolean {
  const entryId = normalizeEntryId(id);
  return entryId !== null && hiddenIds.value.has(entryId);
}

export function setHiddenMod(id: string | null | undefined, hidden: boolean): void {
  const entryId = normalizeEntryId(id);
  if (!entryId) return;

  const next = new Set(hiddenIds.value);
  if (hidden) next.add(entryId);
  else next.delete(entryId);
  hiddenIds.value = next;
  persist();
}

/** 侧栏隐藏分类计数；只统计当前扫描列表中仍存在的隐藏条目。 */
export function countHiddenMods(mods: readonly { id: string }[]): number {
  let count = 0;
  for (const mod of mods) {
    if (hiddenIds.value.has(mod.id)) count += 1;
  }
  return count;
}
