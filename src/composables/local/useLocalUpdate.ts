/**
 * 本地页的「版本更新」相关职责：
 * 1. 启动时只跑一次的版本检查（右下角常驻提示）；
 * 2. 把某个本地模组覆盖安装到服务端最新版（复用在线下载管线）。
 *
 * 两者都刻意做成“一次性 / 用户触发”，绝不轮询：
 * 启动检查用 check_update（无防抖）+ 前端 10 分钟节流，失败静默，
 * 没网 / GitHub 限流不应该在界面上刷错误。
 */
import { ref, computed, type ComputedRef, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { checkUpdate, openExternalUrl } from "../../api";
import {
  enqueueLocalUpdate,
  onTaskSettled,
  downloadTasks,
} from "../../online/downloadQueue";
import { markUpdated } from "../../modUpdates";
import { sessionPhase } from "../../sessionState";
import type { ModEntry } from "../../types";

/** 启动检查的前端节流：10 分钟内真正联网查过就跳过（只挡频繁重启，不挡新版本） */
const STARTUP_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 上次「真正联网并拿到结论」的时间戳；成功后写，失败不写（断网不留锁） */
const STARTUP_CHECK_KEY = "aoe2mm.updateCheckAt";

function readLastCheckAt(): number {
  try {
    return Number(window.localStorage.getItem(STARTUP_CHECK_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeLastCheckAt(): void {
  try {
    window.localStorage.setItem(STARTUP_CHECK_KEY, String(Date.now()));
  } catch {
    /* 隐私模式写不进：退化为每次启动都查（等同 v0.3.4 行为） */
  }
}

export function useLocalUpdate(deps: {
  /** 有未保存排序改动时为 true：此时不允许静默丢弃顺序 */
  blocksRescan: ComputedRef<boolean>;
  rescan: () => Promise<void>;
  normalizeError: (e: unknown) => string;
  showToast: (text: string, kind?: "ok" | "error") => void;
}) {
  const { t } = useI18n();

  /** 启动时检查到的版本更新提示（右下角常驻，可点击跳转、可手动关闭） */
  const updateNotice = ref<{ version: string; url: string } | null>(null);

  /**
   * 正在本地更新的 entryId（从统一队列派生）。
   * 找 kind=local_update 且状态为 downloading/installing 的任务，取其 entryId。
   */
  const updatingEntryId = computed<string | null>(() => {
    for (const task of downloadTasks.value) {
      if (
        task.kind === "local_update" &&
        (task.status === "downloading" || task.status === "installing") &&
        task.entryId
      ) {
        return task.entryId;
      }
    }
    return null;
  });

  /** rescan 防抖：批量连续完成时合并成一次 */
  let rescanTimer: number | null = null;
  function scheduleRescan() {
    if (rescanTimer !== null) window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      void deps.rescan();
    }, 400);
  }

  // 监听队列任务完成：local_update 类型的任务成功后清除角标 + rescan
  const offSettled = onTaskSettled((task) => {
    if (task.kind !== "local_update") return;
    if (task.status === "done") {
      if (task.entryId) markUpdated(task.entryId);
      deps.showToast(t("update.modDoneToast"));
      scheduleRescan();
    } else if (task.status === "failed" && task.error) {
      deps.showToast(task.error, "error");
    }
  });

  onUnmounted(() => {
    offSettled();
    if (rescanTimer !== null) window.clearTimeout(rescanTimer);
  });

  /**
   * 把本地模组覆盖安装到服务端最新版。
   * 走统一下载队列（enqueueLocalUpdate），与在线下载共享串行泵。
   * force=true 自动设置（覆盖已有本地目录，旧目录先备份）。
   */
  async function handleUpdateMod(mod: ModEntry): Promise<void> {
    const modId = mod.workshopId ?? 0;
    if (modId <= 0 || updatingEntryId.value) return;
    // v0.6：离线状态下必须拦截下载（本地收藏/备注仍然可用）
    if (sessionPhase.value !== "online") {
      deps.showToast(t("online.offlineBlocked"), "error");
      return;
    }
    if (deps.blocksRescan.value) {
      deps.showToast(t("sort.unsavedBlock"), "error");
      return;
    }
    const result = enqueueLocalUpdate(modId, mod.displayName, mod.id);
    if (!result.accepted && result.reason === "duplicate") {
      deps.showToast(t("downloader.alreadyQueued"), "error");
    }
  }

  /**
   * 启动时只跑一次版本检查（不轮询、不重试）。
   *
   * 【v0.4.7 修复：右下角更新提示长期不弹】
   * 旧实现调 check_update_auto，Rust 侧有 2 小时防抖，命中防抖时回放的是「上次的结论」；
   * 而那次结论通常就是 has_update=false ⇒ 新版本发布后，只要还在窗口期内，重启多少次都不弹。
   * 现在改调 check_update（与设置页「检查更新」同一条链路，无防抖），
   * 节流挪到前端：只有「10 分钟内真正联网查过」才跳过，失败不写时间戳，断网直接不发请求。
   */
  async function runStartupUpdateCheck(): Promise<void> {
    // 断网时不发请求：Rust 侧三个镜像会各等一次超时，白拖住后台线程十几秒
    if (window.navigator.onLine === false) return;
    const last = readLastCheckAt();
    if (last > 0 && Date.now() - last < STARTUP_CHECK_MIN_INTERVAL_MS) return;
    try {
      const info = await checkUpdate();
      writeLastCheckAt();
      if (!info?.hasUpdate) return;
      updateNotice.value = { version: info.latestVersion, url: info.releaseUrl };
    } catch {
      /* 静默失败：没网 / 限流不该在界面上刷错误 */
    }
  }

  /** 点击右下角提示：拉系统浏览器到 Release 页面（不在 WebView 里跳转） */
  async function openUpdatePage(): Promise<void> {
    const url = updateNotice.value?.url;
    if (!url) return;
    try {
      await openExternalUrl(url);
      updateNotice.value = null;
    } catch (e) {
      deps.showToast(deps.normalizeError(e), "error");
    }
  }

  /** 手动关闭提示（用户不想现在更新） */
  function dismissUpdateNotice(): void {
    updateNotice.value = null;
  }

  return { updateNotice, updatingEntryId, handleUpdateMod, runStartupUpdateCheck, openUpdatePage, dismissUpdateNotice };
}

export type LocalUpdate = ReturnType<typeof useLocalUpdate>;
