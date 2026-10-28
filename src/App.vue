<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import ModCard from "./components/ModCard.vue";
import ModDetail from "./components/ModDetail.vue";
import FirstRunWizard from "./components/FirstRunWizard.vue";
import OnlineBrowser from "./components/OnlineBrowser.vue";
import PresetManager from "./components/PresetManager.vue";
import { useI18n } from "vue-i18n";
import {
  detectRootCandidates,
  getSettings,
  modStats,
  pickFolder,
  scanMods,
  setLocale as persistLocale,
  setModRoot,
} from "./api";
import { formatDateTime, translateBackendMessage } from "./format";
import { applyLocale, detectSystemLocale, LOCALE_OPTIONS, normalizeLocale, type Locale } from "./i18n";
import { TAG_ZH, SORT_OPTIONS, localizedTagName } from "./online/types";
import type { ModEntry, ModStats, ScanReport, SortKey, SourceFilter, StatusFilter } from "./types";

/** 顶部模式：本地扫描 / 在线官方服务 */
const mode = ref<"local" | "online">("local");

/** 在线页的筛选状态提升到顶栏，保证两种模式的搜索/排序控件位置完全一致 */
const onlineQuery = ref("");
const onlineSort = ref(SORT_OPTIONS[0].value);
const onlineOrder = ref<"DESC" | "ASC">("DESC");
const onlineRef = ref<InstanceType<typeof OnlineBrowser> | null>(null);

const { t, locale } = useI18n();
const localeOptions = LOCALE_OPTIONS;
const currentLocale = computed<Locale>(() => String(locale.value));
/** 排序/比较用的区域：中文按拼音，其他语言直接用自己的语言代码 */
const collationLocale = computed(() =>
  currentLocale.value === "zh" ? "zh-Hans-CN" : currentLocale.value,
);

/** 切换界面语言：立即生效，再写回 settings.json（写失败只报错，不回滚 UI） */
async function changeLocale(event: Event) {
  const next = (event.target as HTMLSelectElement).value as Locale;
  applyLocale(next);
  try {
    await persistLocale(next);
  } catch (e) {
    error.value = normalizeError(e);
  }
}

const report = ref<ScanReport | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref("");
const source = ref<SourceFilter>("all");
const status = ref<StatusFilter>("all");
const sortKey = ref<SortKey>("name");
const selectedId = ref<string | null>(null);
const candidates = ref<string[]>([]);

const stats = ref<ModStats | null>(null);
const statsLoading = ref(false);
const statsError = ref<string | null>(null);

const showWarnings = ref(false);
/** v0.3：预设管理器模态框 */
const showPresets = ref(false);
const choosingRoot = ref(false);
/** 首次启动引导：没有可用根目录时自动弹出 */
const showWizard = ref(false);

const mods = computed<ModEntry[]>(() => report.value?.mods ?? []);
const warnings = computed<string[]>(() => report.value?.warnings ?? []);

const sourceCounts = computed(() => ({
  all: mods.value.length,
  local: mods.value.filter((m) => m.kind === "local").length,
  subscribed: mods.value.filter((m) => m.kind === "subscribed").length,
}));

const statusCounts = computed(() => {
  const counts = { enabled: 0, disabled: 0, unknown: 0 };
  for (const m of mods.value) {
    if (m.enabled === true) counts.enabled += 1;
    else if (m.enabled === false) counts.disabled += 1;
    else counts.unknown += 1;
  }
  return counts;
});

const filtered = computed<ModEntry[]>(() => {
  const q = search.value.trim().toLowerCase();
  return mods.value.filter((m) => {
    if (source.value !== "all" && m.kind !== source.value) return false;
    if (status.value === "enabled" && m.enabled !== true) return false;
    if (status.value === "disabled" && m.enabled !== false) return false;
    if (status.value === "unknown" && m.enabled !== null) return false;
    if (activeTag.value && !m.contentTags.includes(activeTag.value)) return false;
    if (!q) return true;
    const haystack = [
      m.displayName,
      m.nameFromFolder,
      m.folderName,
      m.author ?? "",
      m.description ?? "",
      m.workshopId === null ? "" : String(m.workshopId),
    ];
    return haystack.some((v) => v.toLowerCase().includes(q));
  });
});

const sorted = computed<ModEntry[]>(() => {
  const list = [...filtered.value];
  const collator = new Intl.Collator(collationLocale.value, { numeric: true, sensitivity: "base" });
  list.sort((a, b) => {
    switch (sortKey.value) {
      case "updated": {
        const av = a.lastUpdateMs ?? -1;
        const bv = b.lastUpdateMs ?? -1;
        return bv - av;
      }
      case "priority": {
        const av = a.priority ?? Number.MAX_SAFE_INTEGER;
        const bv = b.priority ?? Number.MAX_SAFE_INTEGER;
        return av - bv;
      }
      case "folder":
        return collator.compare(a.folderName, b.folderName);
      case "name":
      default:
        return collator.compare(a.displayName, b.displayName);
    }
  });
  return list;
});

const selected = computed<ModEntry | null>(
  () => mods.value.find((m) => m.id === selectedId.value) ?? null,
);

const lastScanText = computed(() =>
  report.value ? formatDateTime(report.value.scannedAtMs) : t("rootbar.neverScanned"),
);

const heading = computed(() => {
  if (source.value === "local") return t("content.localMods");
  if (source.value === "subscribed") return t("content.subscribedMods");
  return t("content.allMods");
});

/** 内容区副标题右侧的状态文案 */
const statusText = computed(() => {
  if (status.value === "enabled") return t("content.statusEnabled");
  if (status.value === "disabled") return t("content.statusDisabled");
  if (status.value === "unknown") return t("content.statusUnknown");
  return t("content.statusAll");
});

function normalizeError(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return t("labels.unknown");
  }
}

async function refresh(root?: string | null) {
  loading.value = true;
  error.value = null;
  try {
    const next = await scanMods(root);
    report.value = next;
    if (!next.mods.some((m) => m.id === selectedId.value)) {
      selectedId.value = next.mods[0]?.id ?? null;
    }
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    loading.value = false;
  }
}

async function chooseRoot() {
  if (choosingRoot.value) return;
  choosingRoot.value = true;
  try {
    const picked = await pickFolder(report.value?.root ?? candidates.value[0] ?? null);
    if (!picked) return;
    loading.value = true;
    error.value = null;
    const next = await setModRoot(picked);
    report.value = next;
    selectedId.value = next.mods[0]?.id ?? null;
    if (!candidates.value.includes(picked)) candidates.value.unshift(picked);
  } catch (e) {
    error.value = normalizeError(e);
  } finally {
    choosingRoot.value = false;
    loading.value = false;
  }
}

function selectMod(mod: ModEntry) {
  selectedId.value = mod.id;
}

/**
 * 启用/禁用后的局部刷新：只 patch 这一条记录的字段，不重扫、不重置筛选、不重算体积。
 * 后端已把真实写入结果回传，这里不做任何推测。
 */
function handleToggle(payload: { enabled: boolean }) {
  const id = selectedId.value;
  const list = report.value?.mods;
  if (!id || !list) return;
  const mod = list.find((m) => m.id === id);
  if (!mod) return;
  mod.enabled = payload.enabled;
  mod.issues = mod.issues.filter((issue) => !issue.startsWith("mod-status.json 中没有该模组的记录"));
}

/**
 * 删除后的局部移除：只把这一条从数组里摘掉，不重扫、不重置筛选。
 * 删的可能刚好是当前选中项，所以顺手把选中项回退到同位置上的一条。
 */
function handleRemoved(payload: { id: string }) {
  const list = report.value?.mods;
  if (!list) return;
  const index = list.findIndex((m) => m.id === payload.id);
  if (index < 0) return;
  const wasSelected = selectedId.value === payload.id;
  list.splice(index, 1);
  if (!wasSelected) return;
  const next = list[index] ?? list[index - 1] ?? null;
  selectedId.value = next?.id ?? null;
}

watch(selectedId, async (id) => {
  stats.value = null;
  statsError.value = null;
  if (!id) return;
  const mod = mods.value.find((m) => m.id === id);
  if (!mod) return;
  statsLoading.value = true;
  try {
    stats.value = await modStats(mod.path);
  } catch (e) {
    statsError.value = normalizeError(e);
  } finally {
    statsLoading.value = false;
  }
});

/** 本地列表的滚动位置：mode 切换时 .grid-scroll 被 v-if 销毁重建，故靠 ref 变化钩子静默还原 */
const localScrollEl = ref<HTMLElement | null>(null);
let localScrollTop = 0;
let localScrollBound: HTMLElement | null = null;

function rememberLocalScroll() {
  const el = localScrollEl.value;
  if (!el) return;
  // 只有真有滚动高度时才记录，避免元素脱离文档后被归零的值覆盖掉
  if (el.scrollHeight > el.clientHeight) localScrollTop = el.scrollTop;
}

watch(
  localScrollEl,
  (el) => {
    if (localScrollBound) {
      localScrollBound.removeEventListener("scroll", rememberLocalScroll);
      localScrollBound = null;
    }
    if (!el) return;
    el.addEventListener("scroll", rememberLocalScroll, { passive: true });
    localScrollBound = el;

    const target = localScrollTop;
    if (target <= 0) return;
    void nextTick(() => {
      el.scrollTop = target;
      // 缩略图 / 字体回流会让高度暂时不足导致 scrollTop 被截断，下一帧再补一次
      if (el.scrollTop < target) {
        requestAnimationFrame(() => {
          if (el.scrollTop < target) el.scrollTop = target;
        });
      }
    });
  },
  { flush: "post" },
);

onMounted(async () => {
  try {
    candidates.value = (await detectRootCandidates()).map((c) => c.path);
    const settings = await getSettings();
    // 语言：已保存的优先，否则按系统语言决定（并把结果回写，以后不再依赖 navigator）
    const savedLocale = normalizeLocale(settings.locale);
    applyLocale(savedLocale ?? detectSystemLocale());
    if (!savedLocale) {
      void persistLocale(locale.value).catch(() => undefined);
    }
    if (settings.modRoot) {
      await refresh(settings.modRoot);
      // 记录的路径被移动 / 磁盘未连接时，直接回到引导而不是只留一个错误面板
      if (!report.value || !report.value.rootExists) showWizard.value = true;
    } else {
      showWizard.value = true;
    }
  } catch (e) {
    error.value = normalizeError(e);
    showWizard.value = true;
  }
});

/** 引导完成：后端已写入 settings.json 并吐回完整扫描结果 */
function handleWizardDone(next: ScanReport) {
  report.value = next;
  selectedId.value = next.mods[0]?.id ?? null;
  error.value = null;
  showWizard.value = false;
  if (next.root && !candidates.value.includes(next.root)) candidates.value.unshift(next.root);
}
/** 官方 17 项分类的固定顺序（直接复用在线页的 TAG_ZH，保证两侧排列一致） */
const TAG_ORDER: Record<string, number> = Object.fromEntries(
  Object.values(TAG_ZH).map((name, index) => [name, index]),
);

interface TagOption {
  name: string;
  count: number;
}

/** 左侧选中的官方/推断标签；null = 全部内容 */
const activeTag = ref<string | null>(null);

/**
 * 标签索引：官方与推断同名标签合并计数，
 * 保证“侧栏显示的数量”与“点击后的结果数量”一致。
 */
const tagIndex = computed(() => {
  const map = new Map<string, { count: number; official: boolean }>();
  for (const mod of mods.value) {
    const isOfficial = mod.categorySource === "official";
    for (const tag of mod.contentTags) {
      const current = map.get(tag) ?? { count: 0, official: false };
      current.count += 1;
      if (isOfficial) current.official = true;
      map.set(tag, current);
    }
  }
  return map;
});

/** 官方分类：只来自 mod_metadata.json 记录过的模组，按官方字典顺序排 */
const officialTagList = computed<TagOption[]>(() =>
  [...tagIndex.value.entries()]
    .filter(([, value]) => value.official)
    .map(([name, value]) => ({ name, count: value.count }))
    .sort((a, b) => {
      const ai = TAG_ORDER[a.name] ?? Number.MAX_SAFE_INTEGER;
      const bi = TAG_ORDER[b.name] ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.name.localeCompare(b.name, collationLocale.value) : ai - bi;
    }),
);

/** 特征推断：本地扫描兜底得出的标签，按命中数降序 */
const inferredTagList = computed<TagOption[]>(() =>
  [...tagIndex.value.entries()]
    .filter(([, value]) => !value.official)
    .map(([name, value]) => ({ name, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, collationLocale.value)),
);

const activeTagLabel = computed(() => activeTag.value ?? t("sidebar.allContent"));

// 重新扫描/卸装后选中的标签可能消失：自动退回“全部内容”，避免莫名空列表
watch([officialTagList, inferredTagList], () => {
  if (!activeTag.value) return;
  const stillExists =
    officialTagList.value.some((t) => t.name === activeTag.value) ||
    inferredTagList.value.some((t) => t.name === activeTag.value);
  if (!stillExists) activeTag.value = null;
});

/** 有多少模组的分类来自软件记录的官方 Tag */
const officialTagged = computed(
  () => mods.value.filter((m) => m.categorySource === "official").length,
);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="crest">⚔</span>
        <div>
          <h1>{{ t("app.name") }}</h1>
          <p>{{ t("app.tagline") }}</p>
        </div>
      </div>

      <nav class="mode-tabs">
        <button type="button" :class="{ active: mode === 'local' }" @click="mode = 'local'">
          {{ t("nav.local") }}
        </button>
        <button type="button" :class="{ active: mode === 'online' }" @click="mode = 'online'">
          {{ t("nav.online") }}
        </button>
      </nav>

      <div v-if="mode === 'local'" class="search-box">
        <span class="glyph">⌕</span>
        <input
          v-model="search"
          type="search"
          :placeholder="t('search.placeholder')"
          spellcheck="false"
        />
        <button
          v-if="search"
          class="clear"
          type="button"
          :title="t('search.clear')"
          :aria-label="t('search.clear')"
          @click="search = ''"
        >
          ✕
        </button>
      </div>

      <!-- 在线模式：同一个搜索框位置，绑定在线 query（输入 300ms 防抖自动查） -->
      <div v-else class="search-box">
        <span class="glyph">⌕</span>
        <input
          v-model="onlineQuery"
          type="search"
          :placeholder="t('online.searchPlaceholder')"
          spellcheck="false"
        />
        <button
          v-if="onlineQuery"
          class="clear"
          type="button"
          :title="t('search.clear')"
          :aria-label="t('search.clear')"
          @click="onlineQuery = ''"
        >
          ✕
        </button>
      </div>

      <div v-if="mode === 'local'" class="toolbar">
        <select v-model="sortKey" :title="t('toolbar.sortLabel')">
          <option value="name">{{ t("toolbar.sortName") }}</option>
          <option value="updated">{{ t("toolbar.sortUpdated") }}</option>
          <option value="priority">{{ t("toolbar.sortPriority") }}</option>
          <option value="folder">{{ t("toolbar.sortFolder") }}</option>
        </select>
        <button type="button" :disabled="loading || !report" @click="refresh()">
          {{ t("toolbar.rescan") }}
        </button>
        <button type="button" :disabled="loading || choosingRoot" @click="chooseRoot">
          {{ t("toolbar.changeRoot") }}
        </button>
        <button type="button" class="preset-entry" @click="showPresets = true">
          {{ t("toolbar.presets") }}
        </button>
      </div>

      <!-- 在线模式：同一行右侧换成排序 / 升降序 / 刷新 -->
      <div v-else class="toolbar">
        <select v-model="onlineSort" :title="t('toolbar.sortLabel')">
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ t(opt.labelKey) }}
          </option>
        </select>
        <select v-model="onlineOrder" :title="t('online.orderLabel')">
          <option value="DESC">{{ t("online.sortDesc") }}</option>
          <option value="ASC">{{ t("online.sortAsc") }}</option>
        </select>
        <button type="button" :title="t('online.refreshTitle')" @click="onlineRef?.refresh()">
          {{ t("online.refresh") }}
        </button>
      </div>

      <div class="lang-switch">
        <span class="glyph">🌐</span>
        <select
          :value="currentLocale"
          :title="t('lang.label')"
          :aria-label="t('lang.label')"
          @change="changeLocale"
        >
          <option v-for="option in localeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
    </header>

    <div class="rootbar">
      <span>{{ t("rootbar.root") }}</span>
      <span class="path" :title="report?.root ?? ''">{{ report?.root ?? t("rootbar.notSet") }}</span>
      <span class="sep">|</span>
      <span class="pill">{{ t("rootbar.local", { n: sourceCounts.local }) }}</span>
      <span class="pill">{{ t("rootbar.subscribed", { n: sourceCounts.subscribed }) }}</span>
      <span class="pill">
        {{ t("rootbar.showing", { shown: sorted.length, total: mods.length }) }}
      </span>
      <span class="sep">|</span>
      <span>{{ t("rootbar.scannedAt", { time: lastScanText }) }}</span>
      <span class="spacer"></span>
      <button
        v-if="warnings.length"
        type="button"
        class="warn-pill"
        @click="showWarnings = !showWarnings"
      >
        ⚠ {{ t("rootbar.warnings", { n: warnings.length }) }}
      </button>
    </div>

    <div class="body-grid" :class="{ 'online-mode': mode === 'online' }">
      <aside v-if="mode === 'local'" class="sidebar">
        <div class="side-group">
          <div class="side-title">{{ t("sidebar.source") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'all' }"
            @click="source = 'all'"
          >
            <span class="label">{{ t("sidebar.allMods") }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'local' }"
            @click="source = 'local'"
          >
            <span class="label">{{ t("sidebar.local") }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: source === 'subscribed' }"
            @click="source = 'subscribed'"
          >
            <span class="label">{{ t("sidebar.subscribed") }}</span>
          </button>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.officialTags") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: activeTag === null }"
            @click="activeTag = null"
          >
            <span class="label">{{ t("sidebar.allContent") }}</span>
          </button>
          <button
            v-for="item in officialTagList"
            :key="item.name"
            type="button"
            class="side-item"
            :class="{ active: activeTag === item.name }"
            :title="t('sidebar.tagCount', { name: localizedTagName(item.name), n: item.count })"
            @click="activeTag = item.name"
          >
            <span class="label">{{ localizedTagName(item.name) }}</span>
          </button>
          <div v-if="!officialTagList.length" class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.officialEmpty") }}
          </div>
        </div>

        <div v-if="inferredTagList.length" class="side-group">
          <div class="side-title">{{ t("sidebar.inferredTags") }}</div>
          <button
            v-for="item in inferredTagList"
            :key="item.name"
            type="button"
            class="side-item"
            :class="{ active: activeTag === item.name }"
            :title="t('sidebar.inferredCount', { name: localizedTagName(item.name), n: item.count })"
            @click="activeTag = item.name"
          >
            <span class="label">{{ localizedTagName(item.name) }}</span>
          </button>
          <div class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.officialVsInferred", { official: officialTagged, inferred: mods.length - officialTagged }) }}
          </div>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.status") }}</div>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'all' }"
            @click="status = 'all'"
          >
            <span class="label">{{ t("sidebar.all") }}</span><span class="count">{{ sourceCounts.all }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'enabled' }"
            @click="status = 'enabled'"
          >
            <span class="label">{{ t("sidebar.enabled") }}</span><span class="count">{{ statusCounts.enabled }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'disabled' }"
            @click="status = 'disabled'"
          >
            <span class="label">{{ t("sidebar.disabled") }}</span><span class="count">{{ statusCounts.disabled }}</span>
          </button>
          <button
            type="button"
            class="side-item"
            :class="{ active: status === 'unknown' }"
            @click="status = 'unknown'"
          >
            <span class="label">{{ t("sidebar.unknown") }}</span><span class="count">{{ statusCounts.unknown }}</span>
          </button>
        </div>

        <div class="side-group">
          <div class="side-title">{{ t("sidebar.basis") }}</div>
          <div class="side-note note" style="padding: 4px 10px">
            {{ t("sidebar.basisNote", { official: officialTagged, inferred: mods.length - officialTagged }) }}
          </div>
        </div>
      </aside>

      <section v-if="mode === 'local'" class="content">
        <div v-if="showWarnings" class="warn-panel">
          <strong>{{ t("state.warningsTitle") }}</strong>
          <ul class="warn-list">
            <li v-for="w in warnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <div class="content-head">
          <h2>{{ heading }}</h2>
          <span class="hint">{{ activeTagLabel }} · {{ statusText }}</span>
        </div>

        <div ref="localScrollEl" class="grid-scroll">
          <div v-if="loading" class="state-panel">
            <h2><span class="spinner"></span>{{ t("state.scanningTitle") }}</h2>
            <p>{{ t("state.scanningBody") }}</p>
          </div>

          <div v-else-if="error" class="state-panel">
            <h2>{{ t("state.scanFailedTitle") }}</h2>
            <p>{{ error }}</p>
            <div class="actions">
              <button type="button" @click="chooseRoot">{{ t("state.chooseOther") }}</button>
              <button type="button" :disabled="!report" @click="refresh()">{{ t("state.retry") }}</button>
            </div>
          </div>

          <div v-else-if="!report" class="state-panel">
            <h2>{{ t("state.pickRootTitle") }}</h2>
            <p>{{ t("state.pickRootBody") }}</p>
            <button
              v-for="candidate in candidates"
              :key="candidate"
              type="button"
              class="candidate"
              @click="refresh(candidate)"
            >
              {{ t("state.useDetected", { path: candidate }) }}
            </button>
            <p v-if="!candidates.length" class="note">{{ t("state.noneDetected") }}</p>
            <div class="actions">
              <button type="button" :disabled="choosingRoot" @click="chooseRoot">
                {{ t("state.chooseManually") }}
              </button>
            </div>
          </div>

          <div v-else-if="!report.rootExists" class="state-panel">
            <h2>{{ t("state.rootMissingTitle") }}</h2>
            <p>{{ t("state.rootMissingBody", { path: report.root }) }}</p>
            <div class="actions">
              <button type="button" @click="chooseRoot">{{ t("state.chooseAgain") }}</button>
            </div>
          </div>

          <div v-else-if="!mods.length" class="state-panel">
            <h2>{{ t("state.noModsTitle") }}</h2>
            <p>{{ t("state.noModsBody", { local: report.localDir, subscribed: report.subscribedDir }) }}</p>
            <ul class="warn-list">
              <li v-for="w in warnings" :key="w">{{ w }}</li>
            </ul>
            <div class="actions">
              <button type="button" @click="refresh()">{{ t("state.rescan") }}</button>
              <button type="button" @click="chooseRoot">{{ t("state.switchRoot") }}</button>
            </div>
          </div>

          <div v-else-if="!sorted.length" class="state-panel">
            <h2>{{ t("state.filteredTitle") }}</h2>
            <p>{{ t("state.filteredBody", { total: mods.length }) }}</p>
            <div class="actions">
              <button
                type="button"
                @click="
                  search = '';
                  source = 'all';
                  status = 'all';
                  activeTag = null;
                "
              >
                {{ t("state.clearFilters") }}
              </button>
            </div>
          </div>

          <div v-else class="card-grid">
            <ModCard
              v-for="mod in sorted"
              :key="mod.id"
              :mod="mod"
              :active="mod.id === selectedId"
              @select="selectMod"
            />
          </div>
        </div>
      </section>

      <aside v-if="mode === 'local'" class="detail">
        <ModDetail
          v-if="selected"
          :mod="selected"
          :stats="stats"
          :stats-loading="statsLoading"
          :stats-error="statsError"
          @toggled="handleToggle"
          @removed="handleRemoved"
        />
        <div v-else class="detail-empty">
          {{ t("state.detailEmpty") }}<br />
          <span class="note">{{ t("state.detailEmptyNote") }}</span>
        </div>
      </aside>

      <!-- KeepAlive 缓存 OnlineBrowser 实例：切到本地再切回在线不会重新挂载、
           不会重新检查登录状态、也不会重新请求第一页。
           筛选状态由顶栏通过 v-model 传入，组件内部无需自带工具栏。 -->
      <KeepAlive>
        <OnlineBrowser
          v-if="mode === 'online'"
          ref="onlineRef"
          v-model:query="onlineQuery"
          v-model:sort="onlineSort"
          v-model:order="onlineOrder"
        />
      </KeepAlive>

      <!-- 首次启动：探测失败/未设置时引导用户手动选择根目录 -->
      <FirstRunWizard
        v-if="showWizard"
        @done="handleWizardDone"
        @close="showWizard = false"
      />

      <!-- v0.3：预设管理器（position: fixed 浮层，不影响三栏布局） -->
      <PresetManager
        v-if="showPresets"
        :mods="mods"
        @close="showPresets = false"
        @applied="refresh()"
      />
    </div>
  </div>
</template>
