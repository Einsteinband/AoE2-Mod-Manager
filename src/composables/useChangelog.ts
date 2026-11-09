/**
 * 新版本首启弹窗（每个版本只弹一次）
 *
 * localStorage 记录「上次启动时已经展示过更新说明的版本」（settings.json 不新增字段）。
 * 首次启动向导优先：向导没关就先攒着，关掉再弹，避免两个浮层叠在一起。
 */
import { ref, watch, type Ref } from "vue";
import {
  appVersion,
  fetchGithubReleases,
  normalizeVersion,
  renderReleaseMarkdown,
} from "../api";

export interface VersionNotes {
  /** 当前运行的版本号 */
  version: string;
  /** Release 标题（无标题时回落 v{version}） */
  title: string;
  /** 已渲染好的安全 HTML（空串 = 拉不到 / 正文为空，走兜底文案） */
  html: string;
}

const LAST_SEEN_VERSION_KEY = "aoe2.lastSeenVersion";

/** 拉取更新说明的最长等待：卡住也要走兜底文案，绝不出现「更新了却没弹」 */
const VERSION_NOTES_FETCH_TIMEOUT_MS = 10000;

function readLastSeenVersion(): string {
  try {
    return window.localStorage.getItem(LAST_SEEN_VERSION_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastSeenVersion(version: string) {
  try {
    window.localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch (e) {
    // 隐私模式 / 存储被禁用：下次启动会再弹一次，不影响主流程
    console.warn("[version-notes] failed to write lastSeenVersion", e);
  }
}

/** 版本号归一化后比较：v 前缀 / 大小写 / 空白都不算差异 */
function sameVersion(a: string, b: string): boolean {
  return normalizeVersion(a) === normalizeVersion(b);
}

/** 给网络调用加超时上限：Promise 一直挂着也不能让弹窗无限缺席 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("version-notes timeout")), ms);
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function useChangelog(showWizard: Ref<boolean>) {
  const versionNotes = ref<VersionNotes | null>(null);
  /** 首次启动向导优先：向导没关就先攒着，关掉再弹，避免两个浮层叠在一起 */
  let versionNotesPending = false;
  /** 本次启动是否已经判定过（多重入口重复调用也只弹一次，杜绝同版本弹两遍） */
  let versionNotesChecked = false;

  async function showVersionNotesIfNeeded() {
    // 本次启动只判定一次：向导监听等入口重复触发也不会弹第二次
    if (versionNotesChecked) return;
    versionNotesChecked = true;

    let current = "";
    try {
      current = await appVersion();
    } catch (e) {
      // 读不到版本就不写 lastSeenVersion，下次启动重试，不会漏掉更新说明
      console.warn("[version-notes] failed to read the current version", e);
      return;
    }
    if (!current) {
      versionNotesChecked = false;
      return;
    }
    // 这个版本已经确认过（lastSeenVersion 相同）就安静启动
    if (sameVersion(readLastSeenVersion(), current)) return;

    let title = `v${current}`;
    let html = "";
    try {
      const releases = await withTimeout(fetchGithubReleases(), VERSION_NOTES_FETCH_TIMEOUT_MS);
      // 只取与「当前运行版本」对应的那一条：跨版本升级不会把中间版本的说明再弹一遍
      const hit = releases.find((release) => sameVersion(release.version || release.tagName, current));
      if (hit?.name?.trim()) title = hit.name.trim();
      html = hit ? renderReleaseMarkdown(hit.body ?? "") : "";
    } catch (e) {
      // 网络不通 / 未发版 / 超时：不拦启动，只显示一句兜底文案，确认后照样记版本号
      console.warn("[version-notes] failed to fetch release notes; using fallback text", e);
    }
    versionNotes.value = { version: current, title, html };
  }

  function scheduleVersionNotes() {
    if (showWizard.value) {
      versionNotesPending = true;
      return;
    }
    void showVersionNotesIfNeeded();
  }

  /**
   * 「我知道了」：唯一写入 lastSeenVersion 的入口。
   * 只在按钮点击时调用；点遮罩、Esc、直接关进程都不算已读，下次启动继续弹。
   * 先写再关：即使写入抛异常也已捕获，弹窗不会卡在界面上。
   */
  function dismissVersionNotes() {
    const version = versionNotes.value?.version;
    if (version) writeLastSeenVersion(version);
    versionNotes.value = null;
  }

  watch(
    showWizard,
    (open) => {
      if (open || !versionNotesPending) return;
      versionNotesPending = false;
      void showVersionNotesIfNeeded();
    },
  );

  return {
    versionNotes,
    scheduleVersionNotes,
    dismissVersionNotes,
  };
}
