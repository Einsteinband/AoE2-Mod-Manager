/**
 * 本机安装索引：WorkshopID → 目录 / 来源。
 *
 * 这是**磁盘事实**（只读目录名 + 元数据，不触发特征扫描），与服务器的订阅标记无关：
 * 详情页用它决定主按钮是「下载安装」还是「卸载本地模组」，
 * 本地页删过模组、装过模组后都要重新读一次（在线页被 KeepAlive 唤醒时也会）。
 */
import { ref } from "vue";
import { installedLocalIndex } from "../../api";
import { messageOf } from "../../online/errors";
import type { InstalledIndexEntry } from "../../types";

export function useInstalledIndex() {
  const localIndex = ref<Record<number, InstalledIndexEntry>>({});
  const localIndexError = ref<string | null>(null);

  async function refreshLocalIndex(): Promise<void> {
    try {
      const list = await installedLocalIndex();
      const map: Record<number, InstalledIndexEntry> = {};
      for (const entry of list) map[entry.workshopId] = entry;
      localIndex.value = map;
      localIndexError.value = null;
    } catch (e) {
      localIndexError.value = messageOf(e);
    }
  }

  return { localIndex, localIndexError, refreshLocalIndex };
}

export type InstalledIndex = ReturnType<typeof useInstalledIndex>;
