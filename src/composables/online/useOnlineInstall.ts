/**
 * 在线页的「下载 / 安装 / 卸载本地文件」——**队列适配层**。
 *
 * 真正的下载状态机在 `src/online/downloadQueue.ts`（模块级单例，右下角悬浮窗共用）。
 * 本文件只做三件事：
 *   ① 把「当前选中模组」在队列里的任务投影成详情面板需要的字段；
 *   ② 提供入队入口（点击按钮 = 立即入队，不阻塞 UI）；
 *   ③ 保留与队列无关的本地文件删除 / 打开本地文件夹 / 打开官网 / 本地安装记录。
 *
 * 主按钮状态机仍以磁盘事实为准（不看服务器 userInstalled）：
 *   本地没有目录 → “下载并安装为本地模组”；已有目录（官方订阅或本工具安装）→ “卸载本地模组”。
 * 下架 / 退订不在本工具做：取消订阅请点「在网站浏览」到官网操作。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { deleteModFiles, getSettings, revealModFolder } from "../../api";
import { messageOf } from "../../online/errors";
import { openModWebpage } from "../../online/service";
import type { DownloadProgress, InstallOutcome, OnlineMod } from "../../online/types";
import {
  activeTaskOfMod,
  enqueueDownload,
  latestTaskOfMod,
  queuePositionOf,
  requestCancelTask,
  taskOfMod,
} from "../../online/downloadQueue";
import { translateBackendMessage } from "../../format";
import { sessionPhase } from "../../sessionState";
import type { InstalledIndexEntry } from "../../types";
import type { OnlineDetail } from "./useOnlineDetail";
import type { InstalledIndex } from "./useInstalledIndex";
import type { OnlineSelection } from "./useOnlineSelection";

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

  const openingWeb = ref(false);
  /** 「打开所在文件夹」进行中（避免连点拉起多个资源管理器） */
  const revealingFolder = ref(false);

  /** 删除本地文件前的二次确认 */
  const confirmDeleteOpen = ref(false);
  const deleteBusy = ref(false);
  const deleteError = ref<string | null>(null);

  const selected = selection.selected;

  // ---------------- 队列投影（只看当前选中的模组） ----------------

  /** 该模组最近一条任务：优先未结束的，否则最近一次结果（用于显示失败 / 完成信息） */
  const modTask = computed(() => {
    const mod = selected.value;
    if (!mod) return null;
    return taskOfMod(mod.modId);
  });

  /** 正在跑（下载中 / 安装中）：只代表当前模组自己 */
  const installing = computed(() => {
    const status = modTask.value?.status;
    return status === "downloading" || status === "installing";
  });

  /** 排队中：按钮显示「已加入队列（第 N 位）」，点击可移出队列 */
  const queued = computed(() => modTask.value?.status === "queued");

  /** 队列位次（1 起） */
  const queuePos = computed<number | null>(() => {
    const task = modTask.value;
    if (!task || task.status !== "queued") return null;
    return queuePositionOf(task.id);
  });

  /** 用户已请求取消，但后端还在收尾（安装阶段没有取消点） */
  const cancelRequested = computed(
    () => modTask.value?.cancelRequested === true && installing.value,
  );

  const progress = computed<DownloadProgress | null>(() => modTask.value?.progress ?? null);
  const installError = computed<string | null>(() => modTask.value?.error ?? null);
  const actionMessage = computed<string | null>(() => {
    const message = modTask.value?.message;
    // 队列里已结束的任务才显示结果提示，避免排队中就冒出「安装失败」
    if (!message || (modTask.value && installing.value)) return null;
    return t(message.key, message.params ?? {});
  });
  const installNote = computed<string | null>(() => {
    const outcome = modTask.value?.outcome ?? null;
    return outcome ? installNoteText(outcome) : null;
  });

  /** 覆盖勾选：落到该模组的任务上（新任务入队时沿用） */
  const needForce = computed<boolean>({
    get: () => modTask.value?.needForce === true,
    set: (value) => {
      const task = modTask.value;
      if (task) task.needForce = value;
    },
  });
  const forceOverwrite = computed<boolean>({
    get: () => modTask.value?.payload.force === true,
    set: (value) => {
      const task = modTask.value;
      if (task) task.payload.force = value;
    },
  });

  /** 本机安装记录（磁盘事实）：有目录 = 已安装为本地模组 */
  const localEntry = computed<InstalledIndexEntry | null>(() => {
    const mod = selected.value;
    if (!mod) return null;
    return installed.localIndex.value[mod.modId] ?? null;
  });

  const primaryAction = computed<"install" | "uninstall-local">(() =>
    localEntry.value ? "uninstall-local" : "install",
  );

  /** 主按钮文案：与 primaryAction 严格一一对应（排队 / 下载中只影响当前模组） */
  const subscribeLabel = computed(() => {
    if (cancelRequested.value) return t("downloader.stopping");
    if (queued.value) {
      return queuePos.value
        ? t("downloader.enqueuedPos", { n: queuePos.value })
        : t("downloader.enqueued");
    }
    if (modTask.value?.status === "installing") return t("online.installing");
    if (modTask.value?.status === "downloading") return t("online.downloading");
    return primaryAction.value === "uninstall-local"
      ? t("online.uninstallLocal")
      : t("online.installLocal");
  });

  /** 只有「正在跑」才禁用主按钮；排队中是可点的（点它 = 移出队列） */
  const subscribeBusy = computed(() => installing.value);

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

  // ---------------- 入队 / 取消 ----------------

  /** 推入下载队列（同步返回，立刻可以去做别的事） */
  function pushToQueue(kind: "install" | "reinstall"): void {
    const mod = selected.value;
    if (!mod) return;
    // v0.6：离线拦截（本地收藏 / 备注不受影响，只有下载被挡）
    if (sessionPhase.value !== "online") {
      deps.showToast(t("online.offlineBlocked"), "error");
      return;
    }
    const result = enqueueDownload({
      modId: mod.modId,
      title: mod.title,
      kind,
      tagIds: mod.tagIds,
      tagNames: mod.tagNames,
      creator: mod.creator,
      // 描述只有「它正是当前详情」时才拿得到，其余情况传 null（后端会兜底）
      description: detail.rawDescription.value,
      thumbnail: mod.thumbnail,
      force: modTask.value?.payload.force === true,
      // 快照必须在入队瞬间取：安装完成后列表里的 userInstalled 会被抹成 false
      wasSubscribed: mod.userInstalled === true,
    });
    if (!result.accepted) {
      deps.showToast(t("downloader.alreadyQueued"), "error");
      return;
    }
    deps.showToast(t("downloader.addedToast", { title: mod.title }));
  }

  /** 主按钮：加入队列（下载并安装为本地模组） */
  function downloadAndInstall(): void {
    pushToQueue("install");
  }

  /** 重新安装 / 覆盖安装（已有本地目录时的次要按钮） */
  function doInstall(): void {
    pushToQueue("reinstall");
  }

  /** 取消当前模组的任务：排队中 = 移出队列；下载中 = 中断；安装中 = 标记并等真实结果 */
  function stopInstall(): void {
    const mod = selected.value;
    if (!mod) return;
    const task = activeTaskOfMod(mod.modId);
    if (task) requestCancelTask(task.id);
  }

  function askDeleteLocal(): void {
    if (!localEntry.value || installing.value) return;
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
      await deleteModFiles(entry.kind, entry.folderName, mod.modId);
      confirmDeleteOpen.value = false;
      const task = latestTaskOfMod(mod.modId);
      if (task) task.message = { key: "online.deletedLocal" };
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

  /**
   * 在资源管理器中定位「已安装到本地」的模组文件夹。
   * 磁盘路径 = 模组根目录 + 索引条目的 kind + folderName，
   * 合法性（必须位于模组根目录之下、必须是真实目录）仍由 Rust 侧 reveal_mod_folder 校验。
   */
  async function openLocalFolder(): Promise<void> {
    const entry = localEntry.value;
    if (!entry || revealingFolder.value) return;
    revealingFolder.value = true;
    try {
      const settings = await getSettings();
      const root = (settings.modRoot ?? "").trim();
      if (!root) {
        deps.showToast(t("detail.errReveal"), "error");
        return;
      }
      const sep = root.includes("\\") ? "\\" : "/";
      const base = root.endsWith(sep) ? root : root + sep;
      await revealModFolder(`${base}${entry.kind}${sep}${entry.folderName}`);
    } catch (e) {
      deps.showToast(`${t("detail.errReveal")}: ${messageOf(e)}`, "error");
    } finally {
      revealingFolder.value = false;
    }
  }

  /** 切换模组：队列状态按 modId 存放，无需清理（保留接口以兼容调用点） */
  function resetForSwitch(): void {
    /* no-op */
  }

  /** 登录开始时清掉当前模组的结果提示（不动队列 / 进度） */
  function clearMessages(): void {
    const mod = selected.value;
    if (!mod) return;
    const task = latestTaskOfMod(mod.modId);
    if (task && !installing.value) task.message = null;
  }

  return {
    progress,
    installing,
    queued,
    queuePos,
    cancelRequested,
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
    downloadAndInstall,
    doInstall,
    stopInstall,
    askDeleteLocal,
    confirmDeleteLocal,
    cancelDeleteLocal,
    openWebpage,
    revealingFolder,
    openLocalFolder,
    resetForSwitch,
    clearMessages,
  };
}

export type OnlineInstall = ReturnType<typeof useOnlineInstall>;
