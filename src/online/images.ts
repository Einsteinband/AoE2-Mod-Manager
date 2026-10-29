/**
 * 本地封面图缓存的前端入口（Rust 侧 images.rs）。
 *
 * 流程：
 * 1. `localImages(ids)` 批量问本地有没有 `<modId>.jpg`；
 * 2. 命中的用 `convertFileSrc` 转成 `http://asset.localhost/...` 直接给 <img>（零网络）；
 * 3. 缺的后台 `fetchImages()`（Rust 后台线程下载，不 await），
 *    下完由 Rust 发 `online://images-ready` 事件推回来，界面再补上。
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LocalImage {
  modId: number;
  /** 绝对路径（已存在 image_cache 下） */
  path: string;
}

export interface ImageTask {
  modId: number;
  url: string;
}

/** 批量查询本地已有封面，返回 modId → asset URL */
export async function localImages(modIds: number[]): Promise<Record<number, string>> {
  if (!modIds.length) return {};
  const list = await invoke<LocalImage[]>("online_images_local", { modIds });
  const map: Record<number, string> = {};
  for (const item of list) map[item.modId] = convertFileSrc(item.path);
  return map;
}

/** 后台补齐缺失封面（立即返回排队数量，不阻塞 UI） */
export function fetchImages(tasks: ImageTask[]): Promise<number> {
  if (!tasks.length) return Promise.resolve(0);
  return invoke<number>("online_images_fetch", { tasks });
}

/** 订阅“封面已落地”事件 */
export function onImagesReady(
  handler: (images: LocalImage[]) => void,
): Promise<UnlistenFn> {
  return listen<LocalImage[]>("online://images-ready", (event) => handler(event.payload ?? []));
}

/** 绝对路径 → asset URL（详情页等直接拿路径的地方用） */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
