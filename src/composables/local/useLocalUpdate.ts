/**
 * 本地页的「版本更新」相关职责：
 * 1. 启动时只跑一次的版本检查（右下角常驻提示）；
 * 2. 把某个本地模组覆盖安装到服务端最新版（复用在线下载管线）。
 *
 * 两者都刻意做成“一次性 / 用户触发”，绝不轮询：
 * 启动检查用 check_update（无防抖）+ 前端 10 分钟节流，失败静默，
 * 没网 / GitHub 限流不应该在界面上刷错误。
 */
import { ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { checkUpdate, openExternalUrl } from "../../api";
import { installMod } from "../../online/service";
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
