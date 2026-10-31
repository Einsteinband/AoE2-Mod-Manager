/**
 * 在线页的「下载 / 安装 / 卸载本地文件」。
 *
 * 主按钮状态机**以磁盘事实为准**（不看服务器的 userInstalled）：
 *   本地没有目录 → “下载并安装为本地模组”；已有目录（无论官方订阅还是本工具安装）→ “卸载本地模组”。
 * 下架 / 退订不在本工具做：取消订阅请点「在网站浏览」到官网操作。
 *
 * Rust 侧在同一条管线里完成 下载 → 解压 → 装入 subscribed → 补 info.json/缩略图 → 移到 local
 * → 一次写 mod-status.json；前端只负责进度显示与结果呈现。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { deleteModFiles } from "../../api";
import { messageOf } from "../../online/errors";
import { cancelInstall, installMod, openModWebpage } from "../../online/service";
import {
  isApiFailure,
  type DownloadProgress,
  type InstallOutcome,
  type OnlineMod,
} from "../../online/types";
import { translateBackendMessage } from "../../format";
import { sessionPhase } from "../../sessionState";
import type { InstalledIndexEntry } from "../../types";
import type { OnlineDetail } from "./useOnlineDetail";
import type { InstalledIndex } from "./useInstalledIndex";
import type { OnlineSelection } from "./useOnlineSelection";

function kindOf(e: unknown): string | null {
  return isApiFailure(e) ? e.kind : null;
}

export function useOnlineInstall(deps: {
  selection: OnlineSelection;
  detail: OnlineDetail;
  installed: InstalledIndex;
  /** 就地改列表里的对象（不触发 reload） */
  patchMod: (modId: number, patch: Partial<OnlineMod>) => void;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();
  const { selection, detail, installed } = deps;

  const progress = ref<DownloadProgress | null>(null);
  const installing = ref(false);
  const installError = ref<string | null>(null);
  const installNote = ref<string | null>(null);
  const needForce = ref(false);
  const forceOverwrite = ref(false);
  const actionBusy = ref(false);
  const actionMessage = ref<string | null>(null);
  const openingWeb = ref(false);

  /** 删除本地文件前的二次确认 */
  const confirmDeleteOpen = ref(false);
  const deleteBusy = ref(false);
  const deleteError = ref<string | null>(null);

  const selected = selection.selected;

  /** 本机安装记录（磁盘事实）：有目录 = 已安装为本地模组 */
  const localEntry = computed<InstalledIndexEntry | null>(() => {
    const mod = selected.value;
    if (!mod) return null;
    return installed.localIndex.value[mod.modId] ?? null;
  });

  const primaryAction = computed<"install" | "uninstall-local">(() =>
    localEntry.value ? "uninstall-local" : "install",
  );

  /** 主按钮文案：与 primaryAction 严格一一对应 */
  const subscribeLabel = computed(() => {
    if (installing.value) return t("online.downloading");
    return primaryAction.value === "uninstall-local"
      ? t("online.uninstallLocal")
      : t("online.installLocal");
  });

  const subscribeBusy = computed(() => actionBusy.value || installing.value);

  /** 下载进度事件：顺手记下真实总字节数（详情缺 modFileSize 时兜底显示） */
  function handleProgress(payload: DownloadProgress): void {
    progress.value = payload;
    if (payload.total > 0) detail.measuredBytes.value = payload.total;
  }

  function installNoteText(outcome: InstallOutcome): string {
    return [
      outcome.install.updated ? t("online.installUpdated") : t("online.installed"),
      t("online.finalDir", { dir: outcome.finalDir, path: outcome.finalPath }),
      t("online.fileStats", {
        n: outcome.install.fileCount,
        mb: (outcome.install.bytes / 1024 / 1024).toFixed(1),
      }),
      outcome.install.backupDir ? t("online.backupDir", { dir: outcome.install.backupDir }) : "",
      outcome.assets
        ? t("online.assets", { msg: translateBackendMessage(outcome.assets.message) })
        : "",
      outcome.statusNote
        ? t("online.statusNote", { msg: translateBackendMessage(outcome.statusNote) })
        : "",
      outcome.statusBackupPath ? t("online.statusBackup", { path: outcome.statusBackupPath }) : "",
      translateBackendMessage(outcome.note),
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * 主按钮：直接下载并安装为本地模组。
   * forceOverwrite 决定目标目录已存在时是否覆盖（旧目录先备份，不直接删）。
   */
  async function downloadAndInstall(): Promise<void> {
    const mod = selected.value;
    if (!mod || subscribeBusy.value) return;
    // v0.6：离线拦截（本地收藏 / 备注不受影响，只有下载被挡）
    if (sessionPhase.value !== "online") {
      deps.showToast(t("online.offlineBlocked"), "error");
      return;
    }
    actionBusy.value = true;
    actionMessage.value = null;
    installError.value = null;
    installNote.value = null;

    installing.value = true;
    progress.value = null;
    try {
      const outcome = await installMod(
        mod.modId,
        mod.title,
        forceOverwrite.value,
        mod.tagIds,
        mod.tagNames,
        mod.creator,
        detail.rawDescription.value,
        mod.thumbnail,
      );
      installNote.value = installNoteText(outcome);
      needForce.value = false;
      // 本地模组：服务器订阅状态不参与判断
      deps.patchMod(mod.modId, { userInstalled: false, updateAvailable: false });
      if (outcome.localized) {
        actionMessage.value = t("online.installDone");
        deps.showToast(t("online.installDoneToast"));
      } else {
        actionMessage.value = t("online.installKeepSubscribed");
        deps.showToast(t("online.installKeepSubscribedToast"), "error");
      }
    } catch (e) {
      installError.value = messageOf(e);
      if (kindOf(e) === "install" && installError.value.includes("允许覆盖")) {
        needForce.value = true;
      }
      actionMessage.value = t("online.installFailed");
      deps.showToast(t("online.installFailedToast", { msg: messageOf(e) }), "error");
    } finally {
      installing.value = false;
      progress.value = null;
      actionBusy.value = false;
      void installed.refreshLocalIndex();
    }
  }

  /** 重新安装 / 覆盖安装（已有本地目录时的次要按钮） */
  async function doInstall(): Promise<void> {
    const mod = selected.value;
    if (!mod || installing.value) return;
    // v0.6：离线拦截（重新安装 / 覆盖安装同样需要登录态去取签名下载地址）
    if (sessionPhase.value !== "online") {
      deps.showToast(t("online.offlineBlocked"), "error");
      return;
    }
    installing.value = true;
    installError.value = null;
    installNote.value = null;
    progress.value = null;
    try {
      const outcome = await installMod(
        mod.modId,
        mod.title,
        forceOverwrite.value,
        mod.tagIds,
        mod.tagNames,
        mod.creator,
        detail.rawDescription.value,
        mod.thumbnail,
      );
      installNote.value = installNoteText(outcome);
      needForce.value = false;
      deps.showToast(t("online.installDoneShort"));
    } catch (e) {
      installError.value = messageOf(e);
      if (kindOf(e) === "install" && installError.value.includes("允许覆盖")) {
        needForce.value = true;
      }
    } finally {
      installing.value = false;
      progress.value = null;
      void installed.refreshLocalIndex();
    }
  }

  async function stopInstall(): Promise<void> {
    try {
      await cancelInstall();
    } catch {
      /* 忽略 */
    }
  }

  function askDeleteLocal(): void {
    if (!localEntry.value || subscribeBusy.value) return;
    deleteError.value = null;
    confirmDeleteOpen.value = true;
  }

  /** 只删本机文件（不向官方发任何请求，也不动服务器订阅状态） */
  async function confirmDeleteLocal(): Promise<void> {
    const mod = selected.value;
    const entry = localEntry.value;
    if (!mod || !entry || deleteBusy.value) return;
    deleteBusy.value = true;
    deleteError.value = null;
    try {
      const report = await deleteModFiles(entry.kind, entry.folderName, mod.modId);
      confirmDeleteOpen.value = false;
      installNote.value = translateBackendMessage(report.message);
      actionMessage.value = t("online.deletedLocal");
      deps.showToast(t("online.deletedLocalToast"));
      await installed.refreshLocalIndex();
    } catch (e) {
      deleteError.value = messageOf(e);
    } finally {
      deleteBusy.value = false;
    }
  }

  function cancelDeleteLocal(): void {
    confirmDeleteOpen.value = false;
  }

  /** 用系统默认浏览器打开官方模组页面（URL 由后端拼装），在那里取消订阅 */
  async function openWebpage(): Promise<void> {
    const mod = selected.value;
    if (!mod || openingWeb.value) return;
    openingWeb.value = true;
    try {
      const url = await openModWebpage(mod.modId);
      deps.showToast(t("online.openedBrowser", { url }));
    } catch (e) {
      deps.showToast(t("online.openFailed", { msg: messageOf(e) }), "error");
    } finally {
      openingWeb.value = false;
    }
  }

  /** 选中另一个模组：清掉上一条的安装状态（避免"上一条的报错"挂在新模组上） */
  function resetForSwitch(): void {
    installError.value = null;
    installNote.value = null;
    needForce.value = false;
    actionMessage.value = null;
  }

  return {
    progress,
    installing,
    installError,
    installNote,
    needForce,
    forceOverwrite,
    actionMessage,
    openingWeb,
    confirmDeleteOpen,
    deleteBusy,
    deleteError,
    localEntry,
    primaryAction,
    subscribeLabel,
    subscribeBusy,
    handleProgress,
    downloadAndInstall,
    doInstall,
    stopInstall,
    askDeleteLocal,
    confirmDeleteLocal,
    cancelDeleteLocal,
    openWebpage,
    resetForSwitch,
  };
}

export type OnlineInstall = ReturnType<typeof useOnlineInstall>;
