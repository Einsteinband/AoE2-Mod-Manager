<script setup lang="ts">
/**
 * 设置 → 存储：数据与缓存总目录管理（路径显示 / 打开目录 / 迁移）。
 *
 * 从 SettingsModal 迁移，自包含状态和业务逻辑。
 * 心智模型：图片/在线数据/索引/译文/收藏/预设/队列/登录凭证共用一个根目录。
 * 前端只负责展示与触发；路径裁决、目标体检、迁移与回滚全在 Rust（data_dir.rs）。
 */
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import ConfirmDialog from "../ConfirmDialog.vue";
import { formatDateTime, msgText, normalizeBackendError, type Msg } from "../../format";
import type { DataDirView } from "../../types";
import { indexBar, refreshIndexStatus, retryIndexSync } from "../../online/indexStatusStore";

const { t } = useI18n();


function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// ---------------- 数据目录状态 ----------------

const dataDirView = ref<DataDirView | null>(null);
const dataDirBusy = ref(false);
const dataDirMessage = ref<Msg | null>(null);
const dataDirError = ref<Msg | null>(null);
/** 已选好、等待二次确认的目标目录（null = 没有待确认的迁移） */
const migrateTarget = ref<string | null>(null);
const migrateError = ref<string | null>(null);

// ---------------- 在线模组索引（复用全局索引状态，不另建状态） ----------------

interface IndexSyncView {
  atMs: number;
  added: number;
  complete: boolean;
  ok: boolean;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function isToday(ms: number): boolean {
  return localDayKey(ms) === localDayKey(Date.now());
}

function clockText(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** IndexStatus 的 lastSync* 与全局 lastSync 取较新的一份，避免手动完成后设置页短暂落后 */
const indexSyncInfo = computed<IndexSyncView | null>(() => {
  const st = indexBar.status;
  const last = indexBar.lastSync;
  const fromStatus: IndexSyncView | null = st?.lastSyncAtMs
    ? {
        atMs: st.lastSyncAtMs,
        added: st.lastSyncAdded,
        complete: st.lastSyncComplete,
        ok: st.lastSyncOk,
      }
    : null;
  const fromLast: IndexSyncView | null = last
    ? { atMs: last.atMs, added: last.added, complete: last.complete, ok: last.ok }
    : null;
  if (fromStatus && fromLast) return fromLast.atMs >= fromStatus.atMs ? fromLast : fromStatus;
  return fromLast ?? fromStatus;
});

const indexCountText = computed(() =>
  indexBar.status
    ? t("settings.onlineIndexCount", { n: indexBar.status.indexed })
    : t("settings.onlineIndexLoading"),
);

/** 冷启动时 Rust 的 lastSync* 只在内存里；退回索引文件的持久更新时间，避免把已有索误导成“尚未同步” */
const indexLastSyncAtMs = computed(
  () => indexSyncInfo.value?.atMs ?? indexBar.status?.updatedAtMs ?? 0,
);

const indexLastSyncText = computed(() => {
  const atMs = indexLastSyncAtMs.value;
  if (!atMs) return t("settings.onlineIndexNever");
  if (isToday(atMs)) {
    return t("settings.onlineIndexLastToday", { time: clockText(atMs) });
  }
  return t("settings.onlineIndexLastAt", { time: formatDateTime(atMs) });
});

const indexResultText = computed(() => {
  const info = indexSyncInfo.value;
  if (!info) return "";
  if (!info.complete) return t("settings.onlineIndexLastPartial");
  if (!info.ok) return t("settings.onlineIndexLastFailed");
  if (!isToday(info.atMs)) return "";
  return t("settings.onlineIndexAddedToday", { n: info.added });
});

const indexBusy = computed(
  () => indexBar.retrying || indexBar.status?.syncing === true,
);

/** 唯一入口：复用底栏同一个 retryIndexSync()（内部 reason="manual"），不是第二条同步链路 */
async function updateOnlineIndex(): Promise<void> {
  if (indexBusy.value) return;
  await retryIndexSync();
}

const dataDirSizeText = computed(() => {
  const view = dataDirView.value;
  if (!view) return t("cache.reading");
  const total = t("settings.dataDirSize", { size: formatBytes(view.totalBytes) });
  return view.imagesBytes > 0
    ? total + " · " + t("settings.dataDirImageSize", { size: formatBytes(view.imagesBytes) })
    : total;
});

async function loadDataDir() {
  try {
    dataDirView.value = await invoke<DataDirView>("data_dir_view");
  } catch {
    dataDirView.value = null;
  }
}

/** 打开目录：Rust 用 explorer.exe 拉起，目录不存在会先建出来 */
async function openDataDir() {
  if (dataDirBusy.value) return;
  dataDirError.value = null;
  dataDirMessage.value = null;
  try {
    await invoke<string>("open_data_dir");
  } catch (e) {
    dataDirError.value = { key: "settings.dataDirFailed", params: { msg: normalizeBackendError(e) } };
  }
}

/**
 * 迁移第一步：只选目录，**不立刻搬**。
 * 迁移含 session.bin（登录凭证）等敏感文件，必须先经过二次确认弹窗。
 */
async function migrateDataDir() {
  if (dataDirBusy.value || migrateTarget.value) return;
  dataDirError.value = null;
  dataDirMessage.value = null;
  migrateError.value = null;
  try {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: t("settings.dataDirPickTitle"),
      defaultPath: dataDirView.value?.path || undefined,
    });
    if (typeof picked !== "string" || !picked) return; // 用户取消
    migrateTarget.value = picked;
  } catch (e) {
    dataDirError.value = { key: "settings.dataDirFailed", params: { msg: normalizeBackendError(e) } };
  }
}

function cancelMigrate() {
  if (dataDirBusy.value) return;
  migrateTarget.value = null;
  migrateError.value = null;
}

/** 迁移第二步：用户确认后才真正执行；Rust 侧任何失败都会自动回滚并回传原因 */
async function runMigrate() {
  const target = migrateTarget.value;
  if (!target || dataDirBusy.value) return;
  dataDirBusy.value = true;
  dataDirError.value = null;
  dataDirMessage.value = null;
  migrateError.value = null;
  try {
    const view = await invoke<DataDirView>("migrate_data_dir", { newPath: target });
    dataDirView.value = view;
    dataDirMessage.value = { key: "settings.dataDirMigrated", params: { path: view.path } };
    migrateTarget.value = null;
    // 卡片上的封面 URL 是按旧目录拼的，重载一次让它们全部指向新目录
    // （确认弹窗本来就承诺「迁移后会重新加载」）
    window.setTimeout(() => window.location.reload(), 600);
  } catch (e) {
    // Rust 已给出中文原因（含「已回滚」与回滚失败清单），留在弹窗里展示
    migrateError.value = normalizeBackendError(e);
    void loadDataDir();
  } finally {
    dataDirBusy.value = false;
  }
}

onMounted(() => {
  void loadDataDir();
  // 设置页打开时读一次真实索引状态；观察器仍由 App 顶层统一持有
  void refreshIndexStatus();
});
</script>

<template>
  <section class="settings-card">
    <div class="cache-dir-row">
      <div class="row-label">
        <span class="row-title">
          {{ t("settings.dataDirTitle") }}
          <span class="cache-dir-badge">
            {{
              dataDirView?.isCustom
                ? t("settings.dataDirCustomBadge")
                : t("settings.dataDirDefaultBadge")
            }}
          </span>
        </span>
        <span class="row-note mono cache-dir-path" :title="dataDirView?.path || ''">
          {{ dataDirView?.path || "—" }}
        </span>
        <span class="row-note data-dir-size">{{ dataDirSizeText }}</span>
        <span v-if="dataDirView && !dataDirView.exists" class="cache-dir-warn">
          {{ t("settings.dataDirMissing") }}
        </span>
      </div>
      <div class="cache-dir-actions">
        <button
          type="button"
          class="settings-check"
          :disabled="dataDirBusy"
          @click="openDataDir"
        >
          {{ t("settings.dataDirOpen") }}
        </button>
        <button
          type="button"
          class="settings-check"
          :disabled="dataDirBusy"
          @click="migrateDataDir"
        >
          <span v-if="dataDirBusy" class="spinner"></span>
          {{ dataDirBusy ? t("settings.dataDirMigrating") : t("settings.dataDirMigrate") }}
        </button>
      </div>
    </div>

    <p class="settings-hint">{{ t("settings.dataDirNote") }}</p>

    <div v-if="dataDirView?.legacy" class="settings-msg">
      {{ t("settings.dataDirLegacy") }}
    </div>
    <div v-if="dataDirError" class="settings-msg error">{{ msgText(dataDirError) }}</div>
    <div v-else-if="dataDirMessage" class="settings-msg">{{ msgText(dataDirMessage) }}</div>

    <div class="settings-sep"></div>

    <!-- 在线模组索引：手动触发复用底栏同一个同步入口，不另起统计 -->
    <div class="settings-row index-sync-row">
      <div class="row-label">
        <span class="row-title">{{ t("settings.onlineIndexTitle") }}</span>
        <span class="row-note">{{ t("settings.onlineIndexNote") }}</span>
        <div class="index-sync-meta">
          <span>{{ indexCountText }}</span>
          <span>{{ indexLastSyncText }}</span>
          <span v-if="indexResultText">{{ indexResultText }}</span>
        </div>
      </div>
      <div class="index-sync-actions">
        <button
          type="button"
          class="settings-check"
          :disabled="indexBusy"
          @click="updateOnlineIndex"
        >
          <span v-if="indexBusy" class="spinner"></span>
          {{
            indexBusy
              ? t("settings.onlineIndexUpdating")
              : t("settings.onlineIndexUpdate")
          }}
        </button>
      </div>
    </div>

    <!-- 数据目录迁移的二次确认（含登录凭证，绝不能直接执行） -->
    <ConfirmDialog
      v-if="migrateTarget"
      :title="t('settings.dataDirConfirmTitle')"
      :message="t('settings.dataDirConfirmBody')"
      :detail="migrateTarget"
      :confirm-label="t('settings.dataDirConfirmOk')"
      :cancel-label="t('settings.dataDirConfirmCancel')"
      :busy="dataDirBusy"
      :error="migrateError"
      @confirm="runMigrate"
      @cancel="cancelMigrate"
    />
  </section>
</template>

<style scoped>
/* 数据目录行：单列布局（标签在上、按钮在下），与 settings-common.css 的 .settings-row 两列布局区分 */
.cache-dir-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 10px 0;
}
.cache-dir-row + .cache-dir-row {
  border-top: 1px solid var(--line);
}
/* 长路径单行省略：覆盖 settings-common.css 里 .row-note.mono 的 break-all，避免长路径顶出按钮 */
.row-note.mono.cache-dir-path {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: normal;
  color: var(--parch-dim);
}
.cache-dir-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}
.index-sync-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.index-sync-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  font-size: calc(11px * var(--global-scale));
  line-height: 1.6;
  color: var(--parch-dim);
}
.index-sync-meta span + span::before {
  content: "·";
  margin: 0 6px;
  color: var(--muted);
}
.cache-dir-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  border-radius: 3px;
  font-size: calc(10px * var(--global-scale));
  letter-spacing: calc(0.5px * var(--ui-tracking));
  color: var(--gold-text);
}
.cache-dir-warn {
  font-size: calc(10.5px * var(--global-scale));
  color: var(--danger-text);
}
.data-dir-size {
  color: var(--parch-dim);
}
/* 成功消息绿色 + 行距：保持原 SettingsModal scoped 视觉（全局 .settings-msg 默认无颜色） */
.settings-msg {
  line-height: 1.7;
  color: var(--ok-text);
}
/* 提示行：与原 SettingsModal scoped 一致（var(--muted) 而非全局的 opacity 0.7） */
.settings-hint {
  line-height: 1.7;
  color: var(--muted);
}
</style>
