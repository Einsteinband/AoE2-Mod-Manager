/**
 * 订阅冲突识别（纯前端：只读扫描结果，不碰磁盘、不碰 Steam / ACF）。
 *
 * 背景：官方订阅状态只能由用户在官网或游戏内手动取消，本地没有任何可靠的退订手段
 * （改 ACF / 注册表既徒劳又有风险）。用户把已订阅的模组「本地化」到 local/ 之后，
 * 游戏仍会因为账号处于订阅状态而把同一模组重新下载到 subscribed/，于是两侧各有一份。
 *
 * 本模块只做**识别与提示**：不给 subscribed 那份打禁用、不删任何目录、不发任何请求。
 *
 * 判定顺序（双保险）：
 *   1. WorkshopID 相同 —— 最可靠。local 目录名不带 `{id}_`，ID 由 mod_metadata.json 补回
 *      （见 scan.rs::collect_entry），所以两侧通常都拿得到真实 ID；
 *   2. 归一化名字相同 —— 兜底。手动放进 local/、没有元数据记录的模组只能靠名字认：
 *      scan.rs::split_folder_name 对两侧都已去掉 `{id}_` 前缀，直接比对即可。
 */
import type { ModEntry } from "./types";

export type ConflictReason = "workshopId" | "name";

export interface ConflictPair {
  /** 订阅那一份在扫描结果里的 id，形如 "subscribed:1385_xxx" */
  subscribedId: string;
  /** 本地那一份在扫描结果里的 id，形如 "local:xxx" */
  localId: string;
  /** 命中依据 */
  reason: ConflictReason;
  subscribedName: string;
  localName: string;
}

export interface ConflictIndex {
  /** subscribed 条目 id → 冲突对（列表红标据此显示） */
  bySubscribedId: Map<string, ConflictPair>;
  /** local 条目 id → 冲突对（详情页提示「订阅未取消」据此显示） */
  byLocalId: Map<string, ConflictPair>;
  /** 冲突对数（侧栏计数 / 调试用） */
  count: number;
}

/**
 * 名字归一化：小写 + 去掉空白、下划线、连字符、句点。
 * 只用于兜底比对：宁可漏判，也不要把明显不同的两个模组强行拉平。
 */
export function normalizeModName(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[\s_\-.]+/g, "");
}

/** 比对用名字：优先文件夹名（两侧都已去 `{id}_` 前缀），为空时退回 displayName */
function nameKeyOf(mod: ModEntry): string {
  const primary = normalizeModName(mod.nameFromFolder);
  if (primary) return primary;
  return normalizeModName(mod.displayName);
}

/**
 * 从一次扫描结果里算出所有「local 与 subscribed 各有一份」的冲突对。
 *
 * 纯函数、无副作用，直接放进 Vue 的 computed 里使用。
 */
export function buildConflictIndex(mods: ModEntry[]): ConflictIndex {
  const bySubscribedId = new Map<string, ConflictPair>();
  const byLocalId = new Map<string, ConflictPair>();

  const locals: ModEntry[] = [];
  const subs: ModEntry[] = [];
  for (const mod of mods) {
    // 占位条目（已卸载的收藏，useUninstalledFavorites 里 kind 固定为 "subscribed"）
    // 在磁盘上并不存在，绝不能参与比对，否则会一片误报。
    if (mod.uninstalled === true) continue;
    if (mod.kind === "local") locals.push(mod);
    else if (mod.kind === "subscribed") subs.push(mod);
  }
  if (!locals.length || !subs.length) {
    return { bySubscribedId, byLocalId, count: 0 };
  }

  const usedLocal = new Set<string>();

  const link = (sub: ModEntry, local: ModEntry, reason: ConflictReason): void => {
    const pair: ConflictPair = {
      subscribedId: sub.id,
      localId: local.id,
      reason,
      subscribedName: sub.displayName,
      localName: local.displayName,
    };
    bySubscribedId.set(sub.id, pair);
    byLocalId.set(local.id, pair);
    usedLocal.add(local.id);
  };

  // ① WorkshopID 精确配对（两侧都 > 0 才有意义）
  const localById = new Map<number, ModEntry>();
  for (const local of locals) {
    const id = local.workshopId ?? 0;
    if (id > 0 && !localById.has(id)) localById.set(id, local);
  }
  for (const sub of subs) {
    const id = sub.workshopId ?? 0;
    if (id <= 0) continue;
    const local = localById.get(id);
    if (!local || usedLocal.has(local.id)) continue;
    link(sub, local, "workshopId");
  }

  // ② 归一化名字兜底（只处理①没配上的，一个 local 只配一个 sub）
  const localByName = new Map<string, ModEntry>();
  for (const local of locals) {
    if (usedLocal.has(local.id)) continue;
    const key = nameKeyOf(local);
    if (key && !localByName.has(key)) localByName.set(key, local);
  }
  for (const sub of subs) {
    if (bySubscribedId.has(sub.id)) continue;
    const key = nameKeyOf(sub);
    if (!key) continue;
    const local = localByName.get(key);
    if (!local || usedLocal.has(local.id)) continue;
    link(sub, local, "name");
  }

  return { bySubscribedId, byLocalId, count: bySubscribedId.size };
}
