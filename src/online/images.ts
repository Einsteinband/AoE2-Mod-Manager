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

/** 单张封面下载失败回执（与 Rust images::FailedImage 对齐） */
export interface FailedImage {
  modId: number;
  kind: string;
  message: string;
  status: number | null;
}

export interface ImageTask {
  modId: number;
  url: string;
  /** 手动强制刷新：先删旧缓存再下载；普通批量下载不传（默认 false） */
  force?: boolean;
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

/** 封面同步结果：复用缓存复制到模组目录，或缓存缺失/损坏时重新下载并写两处 */
export interface CoverSyncOutcome {
  status: "copied-from-cache" | "downloaded";
  bytes: number;
  cachePath: string | null;
  installPath: string | null;
}

/**
 * 把有效封面同步到已安装模组目录的 thumbnail.jpg。
 * 缓存有效 → 复制；缓存缺失/损坏 → 走现有官方下载并同时补应用缓存。
 * 仅对已安装（本地索引有 kind/folderName）的在线模组调用。
 */
export async function syncCoverToInstall(
  modId: number,
  kind: string,
  folderName: string,
  url: string | null,
): Promise<CoverSyncOutcome> {
  return invoke<CoverSyncOutcome>("online_cover_sync", { modId, kind, folderName, url });
}

/** 订阅“封面已落地”事件 */
export function onImagesReady(
  handler: (images: LocalImage[]) => void,
): Promise<UnlistenFn> {
  return listen<LocalImage[]>("online://images-ready", (event) => handler(event.payload ?? []));
}

/** 订阅“封面下载失败”事件（与成功事件分开，供重试流程区分下载失败与加载失败） */
export function onImagesFailed(
  handler: (images: FailedImage[]) => void,
): Promise<UnlistenFn> {
  return listen<FailedImage[]>("online://images-failed", (event) => handler(event.payload ?? []));
}

/** 绝对路径 → asset URL（详情页等直接拿路径的地方用） */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
