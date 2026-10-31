/**
 * 本地页的「版本更新」相关职责：
 * 1. 启动时只跑一次的版本检查（右下角常驻提示）；
 * 2. 把某个本地模组覆盖安装到服务端最新版（复用在线下载管线）。
 *
 * 两者都刻意做成“一次性 / 用户触发”，绝不轮询：
 * 24 小时内自动查过就跳过（时间锁在 Rust 侧判定），失败静默，
 * 没网 / GitHub 限流不应该在界面上刷错误。
 */
import { ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { checkUpdateAuto, openExternalUrl } from "../../api";
import { installMod } from "../../online/service";
import { markUpdated } from "../../modUpdates";
import { sessionPhase } from "../../sessionState";
import type { ModEntry } from "../../types";

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
  /** v0.4：正在覆盖安装的模组（ModEntry.id），用于禁用详情页按钮 */
  const updatingEntryId = ref<string | null>(null);

  /**
   * v0.4：把本地模组覆盖安装到服务端最新版。
   * 直接复用现有的 online_install 管线（下载 → 解压 → 原子更换 → 写 mod-status.json）；
   * force=true 表示目标目录已存在时也允许覆盖（旧目录会先备份，不直接删）。
   * 分类 Tag 不回传，由 Rust 从 mod_metadata.json 里沿用上次安装记录。
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
    updatingEntryId.value = mod.id;
    try {
      await installMod(modId, mod.displayName, true);
      markUpdated(mod.id);
      deps.showToast(t("update.modDoneToast"));
      await deps.rescan();
    } catch (e) {
      deps.showToast(deps.normalizeError(e), "error");
    } finally {
      updatingEntryId.value = null;
    }
  }

  /**
   * 启动时只跑一次版本检查（不轮询、不重试）。
   * 24 小时内自动查过就直接跳过——时间锁在 Rust 侧判定，连一条 [update] 日志都不会打。
   */
  async function runStartupUpdateCheck(): Promise<void> {
    try {
      const info = await checkUpdateAuto();
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
