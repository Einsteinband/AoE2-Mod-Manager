/**
 * 本地页详情选中态回归：被隐藏 / 已不存在的 Mod 不得继续占用详情面板。
 *
 * 覆盖场景：
 * 1. 选中未隐藏 Mod → 详情正常渲染；
 * 2. 隐藏当前选中 Mod（其他可见 Mod 仍在）→ 详情进入空态，选中态清空；
 * 3. 隐藏全部 Mod → 详情空态，不残留旧 Mod；
 * 4. 取消隐藏后，重新选中该 Mod 可正常显示；
 * 5. 「已隐藏」筛选视图内仍可点开隐藏条目进行管理；
 * 6. 重扫后选中条目已不存在 → 过期选中态被清空。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computed, ref } from "vue";
import { mount } from "@vue/test-utils";
import type { ModEntry, StatusFilter } from "../../../types";
import { setHiddenMod } from "../../../hiddenMods";

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  };
});

const mods = ref<ModEntry[]>([]);
const selectedId = ref<string | null>(null);
const status = ref<StatusFilter>("all");

vi.mock("../../../composables/local/useLocalScan", () => ({
  useLocalScan: () => ({
    report: ref(null),
    mods,
    warnings: ref([]),
    loading: ref(false),
    error: ref(null),
    candidates: ref([]),
    choosingRoot: ref(false),
    showWizard: ref(false),
    selectedId,
    selected: computed(() => mods.value.find((m) => m.id === selectedId.value) ?? null),
    lastScanText: ref(""),
    chooseRoot: vi.fn(),
    refresh: vi.fn(),
    patchModEnabled: vi.fn(),
    patchModCover: vi.fn(),
    normalizeError: vi.fn((e: unknown) => String(e)),
    loadCandidates: vi.fn(),
    handleWizardDone: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/useLocalFilters", () => ({
  useLocalFilters: () => ({
    search: ref(""),
    source: ref("all"),
    status,
    updatesOnly: ref(false),
    updatesAvailableCount: ref(0),
    activeTag: ref(null),
    sourceCounts: computed(() => ({ all: 0, local: 0, subscribed: 0, imported: 0 })),
    statusCounts: computed(() => ({ enabled: 0, disabled: 0, unknown: 0, hidden: 0 })),
    sorted: computed(() => mods.value),
    officialTagList: computed(() => []),
    inferredTagList: computed(() => []),
    heading: computed(() => "heading"),
    pickSource: vi.fn(),
    pickStatus: vi.fn(),
    pickTag: vi.fn(),
    pickUpdatesOnly: vi.fn(),
    clearFilters: vi.fn(),
    sortKey: ref("name"),
    order: ref("DESC"),
    snapshot: vi.fn(),
    restore: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/useSortMode", () => ({
  useSortMode: () => ({
    sortMode: ref(false),
    sortSaving: ref(false),
    dragList: ref([]),
    showDiscardConfirm: ref(false),
    sortDirty: ref(false),
    excludedSortCount: ref(0),
    blocksRescan: ref(false),
    enterSortMode: vi.fn(),
    exitSortMode: vi.fn(),
    discardSortChanges: vi.fn(),
    saveSortOrder: vi.fn(),
    onSortHotkey: vi.fn(),
    gridEl: ref(null),
    isClickSuppressed: vi.fn(() => false),
  }),
}));

vi.mock("../../../composables/local/useLocalModActions", () => ({
  useLocalModActions: () => ({
    stats: ref(null),
    statsLoading: ref(false),
    statsError: ref(null),
    selectMod: vi.fn(),
    handleToggle: vi.fn(),
    handleCardToggled: vi.fn(),
    handleCardToggleError: vi.fn(),
    handleRemoved: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/useDataModMutex", () => ({
  useDataModMutex: () => ({
    dataModConflict: ref(null),
    dataModBusy: ref(false),
    dataModError: ref(null),
    requestEnableDataMod: vi.fn(),
    confirmDataModSwitch: vi.fn(),
    cancelDataModSwitch: vi.fn(),
    batchAsk: ref(null),
    batchBusy: ref(false),
    batchError: ref(null),
    askBatchEnable: vi.fn(),
    askBatchDisable: vi.fn(),
    runBatchToggleGuarded: vi.fn(),
    cancelBatchGuarded: vi.fn(),
    batchConfirmMessage: computed(() => ""),
  }),
}));

vi.mock("../../../composables/local/usePresets", () => ({
  usePresets: () => ({
    showPresets: ref(false),
    lastAppliedPresetId: ref(null),
    handlePresetApplied: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/useLocalUpdate", () => ({
  useLocalUpdate: () => ({
    updateNotice: ref(null),
    updatingEntryId: ref(null),
    handleUpdateMod: vi.fn(),
    runStartupUpdateCheck: vi.fn(),
    openUpdatePage: vi.fn(),
    dismissUpdateNotice: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/useLocalBatchUpdate", () => ({
  useLocalBatchUpdate: () => ({
    isBatching: ref(false),
    total: ref(0),
    completed: ref(0),
    currentTitle: ref(null),
    progressPercent: ref(0),
    startBatchUpdate: vi.fn(),
  }),
}));

vi.mock("../../../composables/useToast", () => ({
  useToast: () => ({ toast: ref(null), showToast: vi.fn() }),
}));

vi.mock("../../../composables/useScrollRestore", () => ({
  useScrollRestore: () => ({ el: ref(null) }),
}));

vi.mock("../../../composables/useContextMenu", () => ({
  useContextMenu: () => ({
    open: ref(false),
    x: ref(0),
    y: ref(0),
    target: ref(null),
    openAt: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("../../../composables/local/localNav", () => ({
  consumeLocalNavIntent: vi.fn(() => null),
  publishLocalNav: vi.fn(),
}));

vi.mock("../../../api", () => ({
  deleteModFiles: vi.fn(),
  openExternalUrl: vi.fn(),
  pickModZip: vi.fn(),
  revealModFolder: vi.fn(),
  toggleModEnabled: vi.fn(),
}));

vi.mock("../../../modUpdates", () => ({
  itemsById: new Map(),
  updateIds: new Set<string>(),
  report: ref(null),
  checkProgress: false,
}));

vi.mock("../../../modConflict", () => ({
  buildConflictIndex: () => ({ bySubscribedId: new Map(), byLocalId: new Map() }),
}));

vi.mock("../../../online/translation", () => ({
  hasTranslatableText: vi.fn(() => false),
  isDescriptionLoaded: vi.fn(() => true),
  currentTargetLanguageName: vi.fn(() => "Chinese"),
  ensureTranslation: vi.fn(),
  hydrateTranslations: vi.fn(),
  isQueued: vi.fn(() => false),
  isShowingOriginal: vi.fn(() => false),
  isTranslating: vi.fn(() => false),
  toggleOriginal: vi.fn(),
  translationErrorKind: vi.fn(() => "generic"),
  translationOf: vi.fn(() => null),
  translatedTitleOf: vi.fn(() => null),
  translationLangEpoch: ref(0),
}));

vi.mock("../../../online/service", () => ({ openModWebpage: vi.fn() }));

vi.mock("../../../userData", () => ({
  customNameOf: vi.fn(() => null),
  ensureUserData: vi.fn(),
  isFavorite: vi.fn(() => false),
  setCustomName: vi.fn(),
  setFavorite: vi.fn(),
}));

vi.mock("../../../format", () => ({
  normalizeBackendError: vi.fn((e: unknown) => String(e)),
  normalizeError: vi.fn((e: unknown) => String(e)),
  translateBackendMessage: vi.fn((m: string) => m),
}));

import LocalBrowser from "../LocalBrowser.vue";

function makeMod(id: string, name: string): ModEntry {
  return {
    id,
    folderName: name,
    path: `/mods/${name}`,
    kind: "local",
    workshopId: null,
    nameFromFolder: name,
    displayName: name,
    displayNameSource: "folder",
    author: null,
    description: null,
    thumbnail: null,
    enabled: true,
    priority: null,
    lastUpdateMs: null,
    installedAtMs: null,
    checksum: null,
    contentTags: [],
    categories: [],
    categorySource: "heuristic",
    officialTags: [],
    source: "official",
    metadataRecorded: false,
    issues: [],
    infoJsonPresent: false,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
  };
}

const modA = makeMod("local/a", "Mod A");
const modB = makeMod("local/b", "Mod B");

const stubs = {
  PageShell: {
    template: '<div><slot name="sidebar" /><slot name="content" /><slot name="detail" /></div>',
  },
  ModGrid: { template: '<div><slot /><slot name="cards" /></div>' },
  ModCard: { template: "<i />" },
  ModDetail: {
    props: ["mod"],
    template: '<div class="detail">{{ mod?.displayName }}</div>',
  },
  LocalSidebar: { template: "<aside />" },
  ImportDialog: { template: "<div />" },
  PresetManager: { template: "<div />" },
  FirstRunWizard: { template: "<div />" },
  ConfirmDialog: { template: "<div />" },
  RenameDialog: { template: "<div />" },
  ContextMenu: { template: "<div />" },
};

function mountBrowser() {
  return mount(LocalBrowser, {
    props: { cardSize: 200 },
    global: { stubs },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setHiddenMod(modA.id, false);
  setHiddenMod(modB.id, false);
  mods.value = [modA, modB];
  selectedId.value = null;
  status.value = "all";
});

describe("本地页详情选中态：隐藏 / 失效条目不残留详情", () => {
  it("选中未隐藏 Mod 时详情正常渲染", async () => {
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".detail").text()).toBe("Mod A");
    expect(wrapper.find(".detail-empty").exists()).toBe(false);
  });

  it("隐藏当前选中 Mod（仍有其他可见 Mod）→ 详情空态且选中态清空", async () => {
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").text()).toBe("Mod A");

    setHiddenMod(modA.id, true);
    await wrapper.vm.$nextTick();

    expect(selectedId.value).toBeNull();
    expect(wrapper.find(".detail").exists()).toBe(false);
    expect(wrapper.find(".detail-empty").exists()).toBe(true);
  });

  it("隐藏全部 Mod → 详情不残留旧 Mod 信息", async () => {
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    setHiddenMod(modA.id, true);
    setHiddenMod(modB.id, true);
    await wrapper.vm.$nextTick();

    expect(selectedId.value).toBeNull();
    expect(wrapper.find(".detail").exists()).toBe(false);
    expect(wrapper.find(".detail-empty").exists()).toBe(true);
  });

  it("取消隐藏后重新选中，详情恢复正常显示", async () => {
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    setHiddenMod(modA.id, true);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".detail").exists()).toBe(false);

    setHiddenMod(modA.id, false);
    selectedId.value = modA.id;
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".detail").text()).toBe("Mod A");
  });

  it("「已隐藏」筛选视图内仍可点开隐藏条目进行管理", async () => {
    setHiddenMod(modA.id, true);
    status.value = "hidden";
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".detail").text()).toBe("Mod A");
  });

  it("重扫后选中条目已不存在 → 过期选中态被清空，详情进入空态", async () => {
    selectedId.value = modA.id;
    const wrapper = mountBrowser();
    await wrapper.vm.$nextTick();

    mods.value = [modB];
    await wrapper.vm.$nextTick();

    expect(selectedId.value).toBeNull();
    expect(wrapper.find(".detail").exists()).toBe(false);
    expect(wrapper.find(".detail-empty").exists()).toBe(true);
  });
});
