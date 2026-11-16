/**
 * 「收藏」工作区数据源（独立于本地页 / 在线页）。
 *
 * 收藏项 = 官方在线信息 + 本机安装状态：
 *   - 收藏 ID 真源：`user_data.json`（favoriteIdSet）
 *   - 在线信息：online_cache.json（列表） → 官方详情缓存 → favoriteMeta 离线快照
 *   - 本地状态：一次真实扫描（scanMods），按 WorkshopID 对上收藏项
 * 安装 / 卸载 / 启停只改本地状态，不触碰在线信息。
 */
import { computed, reactive, ref } from "vue";
import { getSettings, scanMods } from "../api";
import {
  allCachedItems,
  readDetailCache,
} from "../online/cache";
import { assetUrl, fetchImages, localImages, onImagesReady } from "../online/images";
import { isNetworkError } from "../online/networkError";
import { isRemoteThumbnail } from "../online/modSource";
import { enqueueDownload } from "../online/downloadQueue";
import { sessionPhase } from "../sessionState";
import { favoriteIdSet, userDataLoaded } from "../userData";
import { favoriteMetaMap, rememberOnlineMeta } from "../favoriteMeta";
import { translateBackendMessage, normalizeError } from "../format";
import type { ModEntry } from "../types";
import type { OnlineMod } from "../online/types";
import {
  buildFavoriteEntry,
  mergeSnapshots,
  snapshotFromDetail,
  snapshotFromList,
  snapshotFromMeta,
  type FavoriteOnlineSnapshot,
} from "./model";

/** 一次最多补多少张封面（与本地页占位卡同一批次口径） */
const IMAGE_BATCH = 60;

export type FavoriteStatusFilter = "all" | "installed" | "uninstalled";

function createFavoritesWorkspace() {
  const loading = ref(false);
  const errorRaw = ref<string | null>(null);
  const error = computed(() => (errorRaw.value ? translateBackendMessage(errorRaw.value) : null));

  /** 收藏内部二级分类：全部 / 本地模组（已安装）/ 在线模组（无本地副本） */
  const scope = ref<FavoriteStatusFilter>("all");
  /** online_cache.json 里的列表条目（最实时的一层） */
  const listPool = ref<Record<number, OnlineMod>>({});
  /** 官方详情缓存（描述 / 版本 / 发布时间） */
  const detailPool = ref<Record<number, Record<string, unknown>>>({});
  /** 本机扫描结果（只取安装状态与操作能力） */
  const localMods = ref<ModEntry[]>([]);
  /** 应用图片缓存里的封面（未安装条目） */
  const covers = reactive<Record<number, string>>({});
  const requested = new Set<number>();
  let listening = false;

  function ensureImageListener(): void {
    if (listening) return;
    listening = true;
    void onImagesReady((images) => {
      for (const item of images) covers[item.modId] = assetUrl(item.path);
    }).catch(() => undefined);
  }

  /** 在线快照：列表 → 详情 → 离线快照，逐级只补缺 */
  function snapshotOf(modId: number): FavoriteOnlineSnapshot {
    const list = listPool.value[modId] ? snapshotFromList(listPool.value[modId]) : null;
    const detail = detailPool.value[modId]
      ? snapshotFromDetail(modId, detailPool.value[modId])
      : null;
    const meta = snapshotFromMeta(favoriteMetaMap.value[String(modId)] ?? null);
    return mergeSnapshots(modId, [list, detail, meta]);
  }

  const localById = computed<Record<number, ModEntry>>(() => {
    const map: Record<number, ModEntry> = {};
    for (const mod of localMods.value) {
      const id = Number(mod.workshopId ?? 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      const prev = map[id];
      // 同一 WorkshopID 在 local 与 subscribed 各有一份时，local 优先（与安装索引同口径）
      if (prev && prev.kind === "local" && mod.kind !== "local") continue;
      map[id] = mod;
    }
    return map;
  });

  const entries = computed<ModEntry[]>(() => {
    if (!userDataLoaded.value) return [];
    const out: ModEntry[] = [];
    for (const modId of favoriteIdSet.value) {
      const online = snapshotOf(modId);
      const local = localById.value[modId] ?? null;
      out.push(
        buildFavoriteEntry({
          modId,
          online,
          local,
          coverUrl: local ? null : covers[modId] ?? null,
        }),
      );
    }
    return out;
  });

  const installedCount = computed(
    () => entries.value.filter((entry) => entry.uninstalled !== true).length,
  );
  const uninstalledCount = computed(
    () => entries.value.filter((entry) => entry.uninstalled === true).length,
  );

  async function loadLocal(): Promise<void> {
    try {
      const settings = await getSettings();
      const report = await scanMods(settings.modRoot ?? null);
      localMods.value = report.mods;
    } catch (e) {
      localMods.value = [];
      errorRaw.value = normalizeError(e);
    }
  }

  async function loadOnline(): Promise<void> {
    try {
      const items = await allCachedItems();
      const map: Record<number, OnlineMod> = {};
      for (const item of items) {
        if (typeof item?.modId === "number" && item.modId > 0) map[item.modId] = item;
      }
      listPool.value = map;
    } catch {
      // 没有在线缓存不影响收藏展示：还有详情缓存与离线快照
      listPool.value = {};
    }

    // 详情缓存：只对收藏 ID 读取，零网络
    const details: Record<number, Record<string, unknown>> = {};
    for (const modId of favoriteIdSet.value) {
      try {
        const hit = await readDetailCache(modId);
        const value = hit?.value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          details[modId] = value as Record<string, unknown>;
        }
      } catch {
        /* 单条缓存读不到不影响其他条目 */
      }
    }
    detailPool.value = details;

    // 把拿到的官方字段写回离线快照，供以后断网时仍显示同一份信息
    for (const modId of favoriteIdSet.value) {
      const snapshot = snapshotOf(modId);
      if (!snapshot.title && !snapshot.creator) continue;
      rememberOnlineMeta({
        modId,
        title: snapshot.title,
        creator: snapshot.creator,
        description: snapshot.description,
        tagIds: snapshot.tagIds,
        tagNames: snapshot.tagNames,
        thumbnail: snapshot.thumbnailUrl,
        publishedMs: snapshot.publishedMs,
        updatedMs: snapshot.updatedMs,
        version: snapshot.version,
        installs: snapshot.installs,
      });
    }
  }

  /** 未安装条目的封面：先查应用图片缓存，缺图再按官方地址后台补 */
  async function loadCovers(): Promise<void> {
    const ids = [...favoriteIdSet.value].filter((id) => !localById.value[id] && !covers[id]);
    if (!ids.length) return;
    ensureImageListener();
    try {
      const locals = await localImages(ids);
      for (const key of Object.keys(locals)) {
        const url = locals[Number(key)];
        if (url) covers[Number(key)] = url;
      }
    } catch {
      /* 图片缓存不可用：卡片退化为首字母占位 */
    }
    if (isNetworkError.value) return;
    const tasks = ids
      .filter((id) => !covers[id] && !requested.has(id))
      .map((id) => {
        const url = (snapshotOf(id).thumbnailUrl ?? "").trim();
        return isRemoteThumbnail(url) ? { modId: id, url } : null;
      })
      .filter((task): task is { modId: number; url: string } => !!task)
      .slice(0, IMAGE_BATCH);
    if (!tasks.length) return;
    for (const task of tasks) requested.add(task.modId);
    void fetchImages(tasks).catch(() => undefined);
  }

  /** 重新对齐在线信息与本地状态（进入工作区、安装完成、卸载、手动刷新时调用） */
  let inFlight: Promise<void> | null = null;
  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      loading.value = true;
      errorRaw.value = null;
      try {
        await loadLocal();
        await loadOnline();
        await loadCovers();
      } finally {
        loading.value = false;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** 未安装收藏的下载入口：沿用现有队列，不新开安装通道 */
  function install(entry: ModEntry): { accepted: boolean; reason: "noId" | "offline" | "busy" | "ok" } {
    const modId = Number(entry.workshopId ?? 0);
    if (!Number.isFinite(modId) || modId <= 0) return { accepted: false, reason: "noId" };
    if (sessionPhase.value !== "online") return { accepted: false, reason: "offline" };
    const online = entry.onlineInfo ?? null;
    const snapshot = snapshotOf(modId);
    const result = enqueueDownload({
      modId,
      title: entry.displayName || snapshot.title,
      kind: "install",
      tagIds: snapshot.tagIds,
      tagNames: snapshot.tagNames,
      creator: snapshot.creator,
      description: snapshot.description,
      thumbnail: online?.thumbnailUrl ?? snapshot.thumbnailUrl,
    });
    return result.accepted ? { accepted: true, reason: "ok" } : { accepted: false, reason: "busy" };
  }

  return {
    loading,
    error,
    entries,
    scope,
    installedCount,
    uninstalledCount,
    refresh,
    install,
  };
}

/**
 * 全应用共享同一个收藏工作区状态：
 * 侧栏（本地页 / 在线页 / 收藏页）要读同一份计数与分类，
 * 收藏页切换「本地模组 / 在线模组」也写同一个 scope。
 * 只创建一次，避免每个入口各自扫描一遍。
 */
let sharedWorkspace: ReturnType<typeof createFavoritesWorkspace> | null = null;

export function useFavorites(): ReturnType<typeof createFavoritesWorkspace> {
  sharedWorkspace ??= createFavoritesWorkspace();
  return sharedWorkspace;
}

export type FavoritesWorkspace = ReturnType<typeof useFavorites>;
