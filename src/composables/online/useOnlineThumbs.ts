/**
 * 在线页的封面图缓存。
 *
 * 本地优先，零网络：
 * 1. 一次 invoke 批量问 Rust 本地有没有对应 jpg；
 * 2. 有就转成 asset: URL 直接渲染；
 * 3. 缺的交给 Rust 后台线程下载，下完通过 `online://images-ready` 事件推回来再补 UI。
 *
 * 组件内部临时状态（不需要跨页面共享）：`localThumbs` / `requested`。
 */
import { reactive } from "vue";
import { assetUrl, fetchImages, localImages, type LocalImage } from "../../online/images";
import { isNetworkError } from "../../online/networkError";
import type { OnlineMod } from "../../online/types";

/** 一次最多排队补多少张封面（剩下的等下一次滚动 / 列表变化） */
const IMAGE_BATCH = 60;

export function useOnlineThumbs() {
  /** 本地封面映射（modId → asset URL），命中就直接读本机 jpg，零网络 */
  const localThumbs = reactive<Record<number, string>>({});
  /** 本次会话已排队下载过的 modId：避免每次重渲染都重复排队 */
  const requested = new Set<number>();

  /** 列表变化后同步封面：本地命中直接填，缺失的排队后台下载 */
  async function syncImages(list: OnlineMod[]): Promise<void> {
    if (!list.length) return;
    try {
      const locals = await localImages(list.map((mod) => mod.modId));
      for (const [id, url] of Object.entries(locals)) localThumbs[Number(id)] = url;
    } catch {
      /* 图片缓存不可用时退回官网 URL */
    }
    const missing = list
      .filter((mod) => !!mod.thumbnail && !localThumbs[mod.modId] && !requested.has(mod.modId))
      .slice(0, IMAGE_BATCH)
      .map((mod) => ({ modId: mod.modId, url: mod.thumbnail as string }));
    if (!missing.length) return;
    // 断网时不要把一批封面下载请求全部撞上去（终端会满屏 DNS 失败）
    if (isNetworkError.value) return;
    for (const task of missing) requested.add(task.modId);
    void fetchImages(missing).catch(() => undefined);
  }

  /** `online://images-ready` 事件：后台下完一批就把本地 asset URL 补进映射 */
  function applyImages(images: LocalImage[]): void {
    for (const item of images) localThumbs[item.modId] = assetUrl(item.path);
  }

  /** 卡片 / 详情封面：本地 jpg 优先，其次官网 CDN */
  function thumbOf(mod: OnlineMod | null): string | null {
    if (!mod) return null;
    return localThumbs[mod.modId] ?? mod.thumbnail;
  }

  return { localThumbs, syncImages, applyImages, thumbOf };
}

export type OnlineThumbs = ReturnType<typeof useOnlineThumbs>;
