/**
 * 在线页详情里的「收藏 / 备注名」。
 *
 * 只和 modId 绑定（模组卸载后收藏与备注仍在 user_data.json 里），
 * 写入后界面只做局部 Patch —— 绝不触发列表重载，滚动位置与筛选都不动。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { messageOf } from "../../online/errors";
import { customNameOf, isFavorite, setCustomName, setFavorite } from "../../userData";
import type { OnlineSelection } from "./useOnlineSelection";

export function useOnlineFavorite(deps: {
  selection: OnlineSelection;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { selection } = deps;

  const favBusy = ref(false);
  const favError = ref<string | null>(null);
  const renameOpen = ref(false);
  const renameBusy = ref(false);
  const renameError = ref<string | null>(null);

  const canFavorite = computed(() => (selection.selected.value?.modId ?? 0) > 0);
  const favorited = computed(() => isFavorite(selection.selected.value?.modId));
  const customName = computed(() => customNameOf(selection.selected.value?.modId));

  async function toggleFavorite(): Promise<void> {
    const mod = selection.selected.value;
    if (!mod || favBusy.value) return;
    favBusy.value = true;
    favError.value = null;
    try {
      const next = await setFavorite(mod.modId, !favorited.value);
      deps.showToast(next ? t("favorites.addedToast") : t("favorites.removedToast"));
    } catch (e) {
      favError.value = messageOf(e);
    } finally {
      favBusy.value = false;
    }
  }

  function openRename(): void {
    if (!selection.selected.value) return;
    renameError.value = null;
    renameOpen.value = true;
  }

  function closeRename(): void {
    renameOpen.value = false;
  }

  async function applyRename(name: string): Promise<void> {
    const mod = selection.selected.value;
    if (!mod || renameBusy.value) return;
    renameBusy.value = true;
    renameError.value = null;
    try {
      await setCustomName(mod.modId, name);
      renameOpen.value = false;
      deps.showToast(t("favorites.savedToast"));
    } catch (e) {
      renameError.value = messageOf(e);
    } finally {
      renameBusy.value = false;
    }
  }

  /** 切换到另一个模组时收起备注名弹窗（与旧实现一致：只在切换时重置） */
  function resetForSwitch(): void {
    favError.value = null;
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
