/**
 * 本地页的「数据源」：扫描结果、根目录、当前选中项。
 *
 * 这块是本地页所有其他视图状态的底座（筛选 / 排序 / 批量 / 详情都读它），
 * 所以单独成层：**只负责“磁盘上有什么”**，不掺筛选、排序、弹窗等视图逻辑。
 *
 * 与原 App.vue 的差别仅在于「重扫前退出排序模式」被上移到页面的 `rescan` 包装函数里
 * （排序模式不能既依赖扫描结果、又被扫描结果反向依赖），其余行为逐行保持：
 * 局部 patch 不重扫、不重置筛选、不重算体积。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { detectRootCandidates, pickFolder, scanMods, setModRoot } from "../../api";
import { formatDateTime, translateBackendMessage, normalizeError } from "../../format";
import type { ModEntry, ScanReport } from "../../types";

/** 提取原始错误串（不翻译），存进 ref，渲染时再翻译。 */
export function useLocalScan() {
  const { t } = useI18n();

  const report = ref<ScanReport | null>(null);
  const loading = ref(false);
  const errorRaw = ref<string | null>(null);
  /** 存 raw 错误串，渲染时再翻译，切语言即时跟随。 */
  const error = computed(() => errorRaw.value ? translateBackendMessage(errorRaw.value) : null);
  const candidates = ref<string[]>([]);
  const choosingRoot = ref(false);
  /** 首次启动引导：没有可用根目录时自动弹出 */
  const showWizard = ref(false);
  const selectedId = ref<string | null>(null);

  const mods = computed<ModEntry[]>(() => report.value?.mods ?? []);
  const warnings = computed<string[]>(() => (report.value?.warnings ?? []).map(translateBackendMessage));
  const selected = computed<ModEntry | null>(
    () => mods.value.find((m) => m.id === selectedId.value) ?? null,
  );
  const lastScanText = computed(() =>
    report.value ? formatDateTime(report.value.scannedAtMs) : t("rootbar.neverScanned"),
  );

  /** 后端异常 → raw 错误串（本地页所有错误提示的唯一出口） */
  // normalizeError 已抽离到 format.ts，全局通用

  /** 探测候选根目录（只读注册表 / 常见路径，不走网络） */
  async function loadCandidates(): Promise<void> {
    candidates.value = (await detectRootCandidates()).map((c) => c.path);
  }

  /**
   * 重新扫描。**故意不处理排序模式**：是否需要先退出由页面决定（见 App.vue 的 rescan），
   * 否则本文件与排序 composable 会互相依赖。
   */
  async function refresh(root?: string | null): Promise<void> {
    loading.value = true;
    errorRaw.value = null;
    try {
      const next = await scanMods(root);
      report.value = next;
      if (!next.mods.some((m) => m.id === selectedId.value)) {
        selectedId.value = next.mods[0]?.id ?? null;
      }
    } catch (e) {
      errorRaw.value = normalizeError(e);
    } finally {
      loading.value = false;
    }
  }

  /** 换根目录：后端写入 settings.json 并直接返回完整扫描结果 */
  async function chooseRoot(): Promise<void> {
    if (choosingRoot.value) return;
    choosingRoot.value = true;
    try {
      const picked = await pickFolder(report.value?.root ?? candidates.value[0] ?? null);
      if (!picked) return;
      loading.value = true;
      errorRaw.value = null;
      const next = await setModRoot(picked);
      report.value = next;
      selectedId.value = next.mods[0]?.id ?? null;
      if (!candidates.value.includes(picked)) candidates.value.unshift(picked);
    } catch (e) {
      errorRaw.value = normalizeError(e);
    } finally {
      choosingRoot.value = false;
      loading.value = false;
    }
  }

  /**
   * 启用/禁用后的局部刷新：只 patch 这一条记录的字段，不重扫、不重置筛选、不重算体积。
   * 后端已把真实写入结果回传，这里不做任何推测。
   */
  function patchModEnabled(id: string, enabled: boolean): void {
    const list = report.value?.mods;
    if (!list) return;
    const mod = list.find((m) => m.id === id);
    if (!mod) return;
    mod.enabled = enabled;
    mod.issues = mod.issues.filter(
      (issue) => !issue.startsWith("aoe2mm:err:scan.notInStatus"),
    );
  }

  /** 封面写入成功后的局部刷新：只更新这一条记录的磁盘封面路径，不重扫目录。 */
  function patchModCover(id: string, path: string): void {
    const list = report.value?.mods;
    if (!list) return;
    const mod = list.find((m) => m.id === id);
    if (!mod) return;
    mod.thumbnail = path;
    mod.coverUrl = null;
  }

  /** 引导完成：后端已写入 settings.json 并吐回完整扫描结果 */
  function handleWizardDone(next: ScanReport): void {
    report.value = next;
    selectedId.value = next.mods[0]?.id ?? null;
    errorRaw.value = null;
    showWizard.value = false;
    if (next.root && !candidates.value.includes(next.root)) candidates.value.unshift(next.root);
  }

  return {
    report,
    mods,
    warnings,
    loading,
    error,
    errorRaw: errorRaw,
    candidates,
    choosingRoot,
    showWizard,
    selectedId,
    selected,
    lastScanText,
    normalizeError,
    loadCandidates,
    refresh,
    chooseRoot,
    patchModEnabled,
    patchModCover,
    handleWizardDone,
  };
}

/** 本地页扫描/选中状态的整体句柄（供页面按需取用） */
export type LocalScan = ReturnType<typeof useLocalScan>;
