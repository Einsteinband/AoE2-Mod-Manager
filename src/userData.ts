/**
 * 收藏 / 自定义备注名的全局单例。
 *
 * 关键约束：
 * 1. 只和 WorkshopID 绑定 —— 模组卸载后收藏与备注仍在 user_data.json 里。
 * 2. 修改后立刻调 save_user_data；界面只做**局部 Patch**（改这一个 key），
 *    绝不触发 scan_mods 全量重扫，滚动条与筛选状态都不会复位。
 * 3. 写入串行化：连点收藏时后一次必须等前一次落盘，避免旧快照覆盖新状态。
 */
import { computed, reactive } from "vue";
import { loadUserData, saveUserData } from "./api";
import type { ModUserData, UserDataStore } from "./types";

const state = reactive<UserDataStore>({ version: 1, mods: {} });

/** 最近一次读写错误（界面可选用；不抛到全局） */
export const userDataError = reactive<{ message: string | null }>({ message: null });

let loaded = false;
let loading: Promise<void> | null = null;
/** 写盘队列：所有 save 排成一条链，避免并发覆盖 */
let writeChain: Promise<void> = Promise.resolve();

/** WorkshopID → key；null / 0 / 负数都视为“没有 ID，无法收藏” */
export function modKey(workshopId: number | null | undefined): string | null {
  if (!workshopId || workshopId <= 0) return null;
  return String(workshopId);
}

/** 只读视图：给需要遍历的地方用（不要直接改） */
export const userDataMods = computed<Record<string, ModUserData>>(() => state.mods);

export function entryOf(workshopId: number | null | undefined): ModUserData | null {
  const key = modKey(workshopId);
  return key ? state.mods[key] ?? null : null;
}

export function isFavorite(workshopId: number | null | undefined): boolean {
  return entryOf(workshopId)?.isFavorite === true;
}

export function customNameOf(workshopId: number | null | undefined): string | null {
  const name = entryOf(workshopId)?.customName;
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/** 主标题：有备注名用备注名，否则用原名 */
export function displayTitle(workshopId: number | null | undefined, original: string): string {
  return customNameOf(workshopId) ?? original;
}

/** 全部收藏（在线页侧栏计数用） */
export const favoriteCount = computed(
  () => Object.values(state.mods).filter((m) => m.isFavorite).length,
);

/** 幂等加载：多个组件同时调用只会读一次磁盘 */
export function ensureUserData(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = loadUserData()
    .then((store) => {
      state.version = store.version ?? 1;
      state.mods = store.mods ?? {};
      loaded = true;
      userDataError.message = null;
    })
    .catch((e: unknown) => {
      // 读失败不开写：保持 loaded=false，后续写入会先重试读，避免用空表覆盖用户数据
      userDataError.message = typeof e === "string" ? e : String(e);
      throw e;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 整体快照：丢掉空条目，保证落盘文件干净 */
function snapshot(): UserDataStore {
  const mods: Record<string, ModUserData> = {};
  for (const [key, value] of Object.entries(state.mods)) {
    const customName = value.customName?.trim() ? value.customName.trim() : null;
    if (!value.isFavorite && !customName) continue;
    mods[key] = { customName, isFavorite: value.isFavorite };
  }
  return { version: 1, mods };
}

function persist(): Promise<void> {
  const run = writeChain.catch(() => undefined).then(async () => {
    try {
      await saveUserData(snapshot());
      userDataError.message = null;
    } catch (e: unknown) {
      userDataError.message = typeof e === "string" ? e : String(e);
      throw e;
    }
  });
  writeChain = run;
  return run;
}

/** 收藏开关：先局部 Patch（界面立刻变），再落盘；失败则回滚到原值 */
export async function setFavorite(
  workshopId: number | null | undefined,
  favorite: boolean,
): Promise<boolean> {
  const key = modKey(workshopId);
  if (!key) throw new Error("该模组没有 WorkshopID，无法收藏");
  await ensureUserData();

  const before = state.mods[key] ? { ...state.mods[key] } : null;
  state.mods[key] = { customName: state.mods[key]?.customName ?? null, isFavorite: favorite };
  try {
    await persist();
    return favorite;
  } catch (e) {
    if (before) state.mods[key] = before;
    else delete state.mods[key];
    throw e;
  }
}

/** 自定义备注名：空字符串 = 清除备注，恢复显示原名 */
export async function setCustomName(
  workshopId: number | null | undefined,
  name: string,
): Promise<string | null> {
  const key = modKey(workshopId);
  if (!key) throw new Error("该模组没有 WorkshopID，无法设置备注名");
  await ensureUserData();

  const trimmed = name.trim();
  const next = trimmed ? trimmed.slice(0, 60) : null;

  const before = state.mods[key] ? { ...state.mods[key] } : null;
  state.mods[key] = { customName: next, isFavorite: state.mods[key]?.isFavorite === true };
  try {
    await persist();
    return next;
  } catch (e) {
    if (before) state.mods[key] = before;
    else delete state.mods[key];
    throw e;
  }
}
