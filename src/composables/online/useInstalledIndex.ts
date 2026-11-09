/**
 * 本机安装索引：WorkshopID → 目录 / 来源。
 *
 * 这是**磁盘事实**（只读目录名 + 元数据，不触发特征扫描），与服务器的订阅标记无关：
 * 详情页用它决定主按钮是「下载安装」还是「卸载本地模组」，
 * 本地页删过模组、装过模组后都要重新读一次（在线页被 KeepAlive 唤醒时也会）。
 */
import { computed, ref } from "vue";
import { installedLocalIndex } from "../../api";
import { rawMessageOf } from "../../online/errors";
import { translateBackendMessage } from "../../format";
import type { InstalledIndexEntry } from "../../types";

export function useInstalledIndex() {
  const localIndex = ref<Record<number, InstalledIndexEntry>>({});
  const localIndexErrorRaw = ref<string | null>(null);
  const localIndexError = computed(() =>
    localIndexErrorRaw.value ? translateBackendMessage(localIndexErrorRaw.value) : null,
  );

  async function refreshLocalIndex(): Promise<void> {
    try {
      const list = await installedLocalIndex();
      const map: Record<number, InstalledIndexEntry> = {};
      for (const entry of list) {
        // local 优先：同一 modId 在 local 与 subscribed 各有一份时，
        // scan::installed_index 先扫 local 再扫 subscribed，后写的 subscribed 会覆盖前者。
        // 覆盖会让「卸载本地模组 / 打开所在文件夹」指向订阅那份，与按钮文案矛盾。
        const prev = map[entry.workshopId];
        if (prev && prev.kind === "local" && entry.kind !== "local") continue;
        map[entry.workshopId] = entry;
      }
      localIndex.value = map;
      localIndexErrorRaw.value = null;
    } catch (e) {
      localIndexErrorRaw.value = rawMessageOf(e);
    }
  }

  return { localIndex, localIndexError, refreshLocalIndex };
}

export type InstalledIndex = ReturnType<typeof useInstalledIndex>;
