/**
 * 在线页详情里的「收藏 / 备注名」。
 *
 * 只和 modId 绑定（模组卸载后收藏与备注仍在 user_data.json 里），
 * 写入后界面只做局部 Patch —— 绝不触发列表重载，滚动位置与筛选都不动。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { rawMessageOf } from "../../online/errors";
import { translateBackendMessage } from "../../format";
import { customNameOf, isFavorite, setCustomName, setFavorite } from "../../userData";
import { rememberOnlineMeta } from "../../favoriteMeta";
import type { OnlineSelection } from "./useOnlineSelection";

export function useOnlineFavorite(deps: {
  selection: OnlineSelection;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { selection } = deps;

  const favBusy = ref(false);
  const favErrorRaw = ref<string | null>(null);
  const favError = computed(() =>
    favErrorRaw.value ? translateBackendMessage(favErrorRaw.value) : null,
  );
  const renameOpen = ref(false);
  const renameBusy = ref(false);
  const renameErrorRaw = ref<string | null>(null);
  const renameError = computed(() =>
    renameErrorRaw.value ? translateBackendMessage(renameErrorRaw.value) : null,
  );

  const canFavorite = computed(() => (selection.selected.value?.modId ?? 0) > 0);
  const favorited = computed(() => isFavorite(selection.selected.value?.modId));
  const customName = computed(() => customNameOf(selection.selected.value?.modId));

  async function toggleFavorite(): Promise<void> {
    const mod = selection.selected.value;
    if (!mod || favBusy.value) return;
    favBusy.value = true;
    favErrorRaw.value = null;
    try {
      const next = await setFavorite(mod.modId, !favorited.value);
      // v0.6：收藏那一刻就把标题 / 作者 / 分类 / 封面记进本地元数据缓存，
      // 以后即使从未安装、或缓存被清空，「我的收藏」仍然能显示它
      if (next) rememberOnlineMeta(mod);
      deps.showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
    } catch (e) {
      favErrorRaw.value = rawMessageOf(e);
    } finally {
      favBusy.value = false;
    }
  }

  function openRename(): void {
    if (!selection.selected.value) return;
    renameErrorRaw.value = null;
    renameOpen.value = true;
  }

  function closeRename(): void {
    renameOpen.value = false;
  }

  async function applyRename(name: string): Promise<void> {
    const mod = selection.selected.value;
    if (!mod || renameBusy.value) return;
    renameBusy.value = true;
    renameErrorRaw.value = null;
    try {
      await setCustomName(mod.modId, name);
      renameOpen.value = false;
      deps.showToast(t("favorites.savedToast"));
    } catch (e) {
      renameErrorRaw.value = rawMessageOf(e);
    } finally {
      renameBusy.value = false;
    }
  }

  /** 切换到另一个模组时收起备注名弹窗（与旧实现一致：只在切换时重置） */
  function resetForSwitch(): void {
    favErrorRaw.value = null;
    renameOpen.value = false;
  }

  return {
    favBusy,
    favError,
    renameOpen,
    renameBusy,
    renameError,
    canFavorite,
    favorited,
    customName,
    toggleFavorite,
    openRename,
    closeRename,
    applyRename,
    resetForSwitch,
  };
}

export type OnlineFavorite = ReturnType<typeof useOnlineFavorite>;
