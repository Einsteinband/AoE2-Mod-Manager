/**
 * 「我的收藏」里的**已卸载 / 未安装**占位条目。
 *
 * 数据流：
 *   user_data.json 的收藏 ID（唯一真源）
 *     − 本次扫描到的已安装 WorkshopID
 *     = 需要占位展示的 ID
 *   标题 / 作者 / 分类 ← favoriteMeta.ts 的 localStorage 轻量缓存（或在线缓存）
 *   封面             ← images.rs 的本地图片缓存（零网络，缺图才后台补）
 *
 * 这样收藏与安装状态彻底解耦：卸载后卡片不会消失，而是变成「未安装」，
 * 点一下就重新入队下载。不新增任何 Rust 命令，也不起后台任务。
 */
import { computed, reactive, watch, type ComputedRef } from "vue";
import { favoriteMetaOf, rememberInstalledMods } from "../../favoriteMeta";
import { isNetworkError } from "../../online/networkError";
import { assetUrl, fetchImages, localImages, onImagesReady } from "../../online/images";
import { favoriteIdSet, userDataLoaded } from "../../userData";
import type { ModEntry } from "../../types";

/** 占位条目 id 前缀：与真实条目（local:xxx / subscribed:xxx）天然不冲突 */
const GHOST_PREFIX = "fav:";
/** 一次最多补多少张封面 */
const IMAGE_BATCH = 60;

export function ghostEntryId(modId: number): string {
  return GHOST_PREFIX + modId;
}

export function isGhostEntryId(id: string): boolean {
  return id.startsWith(GHOST_PREFIX);
}

/** 用元数据 + 封面缓存拼一条「未安装」条目 */
function buildGhost(modId: number, cover: string | null): ModEntry {
  const meta = favoriteMetaOf(modId);
  const title = meta?.title?.trim() || `#${modId}`;
  return {
    id: ghostEntryId(modId),
    folderName: "",
    path: "",
    // 官方订阅位的模组：将来重新下载时装到 subscribed/，只影响展示文案
    kind: "subscribed",
    workshopId: modId,
    nameFromFolder: `#${modId}`,
    displayName: title,
    displayNameSource: "folder",
    author: meta?.creator ?? null,
    description: meta?.description ?? null,
    thumbnail: null,
    coverUrl: cover,
    enabled: null,
    priority: null,
    lastUpdateMs: null,
    checksum: null,
    contentTags: meta?.tagNames ?? [],
    // 占位条目不参与分类索引（侧栏只索引真实扫描结果），这里给空数组
    categories: [],
    categorySource: "heuristic",
    officialTags: meta?.tagNames ?? [],
    source: "unknown",
    metadataRecorded: false,
    issues: [],
    infoJsonPresent: false,
    isDataMod: false,
    uninstalled: true,
  };
}

export function useUninstalledFavorites(deps: { mods: ComputedRef<ModEntry[]> }) {
  const { mods } = deps;

  /** modId → 图片缓存里的 asset URL */
  const covers = reactive<Record<number, string>>({});
  /** 本次会话已排队的封面下载，避免重渲染时重复排队 */
  const requested = new Set<number>();

  let listening = false;
  /** 后台补图完成 → 占位卡立刻有封面（零轮询） */
  function ensureImageListener(): void {
    if (listening) return;
    listening = true;
    void onImagesReady((images) => {
      for (const item of images) covers[item.modId] = assetUrl(item.path);
    }).catch(() => undefined);
  }

  /** 当前磁盘上真实存在的 WorkshopID */
  const installedIds = computed<Set<number>>(() => {
    const set = new Set<number>();
    for (const mod of mods.value) {
      const id = Number(mod.workshopId ?? 0);
      if (Number.isFinite(id) && id > 0) set.add(id);
    }
    return set;
  });

  /** 收藏了、但这次扫描没扫到的模组 = 需要「未安装」占位卡片 */
  const ghosts = computed<ModEntry[]>(() => {
    const out: ModEntry[] = [];
    for (const id of favoriteIdSet.value) {
      if (installedIds.value.has(id)) continue;
      out.push(buildGhost(id, covers[id] ?? null));
    }
    return out;
  });

  /** 扫描结果 / 收藏变化 → 记忆元数据（卸载前就已落盘，不依赖卸载时机） */
  watch(
    [mods, userDataLoaded],
    ([list, ready]) => {
      rememberInstalledMods(list, { userDataReady: ready });
    },
    { immediate: true },
  );

  /** 占位条目变化 → 缺图的先查本地图片缓存，再按官网地址后台补图 */
  watch(
    ghosts,
    async (list) => {
      if (!list.length) return;
      ensureImageListener();
      const missing = list
        .map((mod) => Number(mod.workshopId ?? 0))
        .filter((id) => id > 0 && !covers[id]);
      if (!missing.length) return;
      try {
        const locals = await localImages(missing);
        for (const key of Object.keys(locals)) {
          const url = locals[Number(key)];
          if (url) covers[Number(key)] = url;
        }
      } catch {
        /* 图片缓存不可用：卡片退化为首字母占位 */
      }
      if (isNetworkError.value) return;
      const tasks = list
        .map((mod) => Number(mod.workshopId ?? 0))
        .filter((id) => id > 0 && !covers[id] && !requested.has(id))
        .map((id) => {
          const meta = favoriteMetaOf(id);
          return meta?.thumbnailUrl ? { modId: id, url: meta.thumbnailUrl } : null;
        })
        .filter((task): task is { modId: number; url: string } => !!task)
        .slice(0, IMAGE_BATCH);
      if (!tasks.length) return;
      for (const task of tasks) requested.add(task.modId);
      void fetchImages(tasks).catch(() => undefined);
    },
    { immediate: true },
  );

  return { ghosts, covers, ghostEntryId, isGhostEntryId };
}

export type UninstalledFavorites = ReturnType<typeof useUninstalledFavorites>;
