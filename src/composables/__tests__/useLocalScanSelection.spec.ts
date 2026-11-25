import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModEntry, ScanReport } from "../../types";
import { setHiddenMod } from "../../hiddenMods";

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) };
});

vi.mock("../../api", () => ({
  detectRootCandidates: vi.fn(),
  pickFolder: vi.fn(),
  scanMods: vi.fn(),
  setModRoot: vi.fn(),
}));

import { scanMods } from "../../api";
import { useLocalScan } from "../local/useLocalScan";

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

function report(mods: ModEntry[]): ScanReport {
  return {
    root: "F:/Games/AoE2DE/mods",
    rootExists: true,
    scannedAtMs: 1700000000000,
    localDir: "F:/Games/AoE2DE/mods/local",
    subscribedDir: "F:/Games/AoE2DE/mods/subscribed",
    localExists: true,
    subscribedExists: true,
    mods,
    warnings: [],
  };
}

const hidden = makeMod("local/hidden", "hidden");
const visible = makeMod("local/visible", "visible");

beforeEach(() => {
  window.localStorage.clear();
  // localStorage 清空不会重置模块内 ref，显式复位两条夹具的隐藏状态
  setHiddenMod(hidden.id, false);
  setHiddenMod(visible.id, false);
  vi.clearAllMocks();
});

describe("useLocalScan 重扫 / 换根后的选中回退", () => {
  it("历史选中项不存在时，默认选中第一条未隐藏 Mod，而不是隐藏条目", async () => {
    setHiddenMod(hidden.id, true);
    vi.mocked(scanMods).mockResolvedValue(report([hidden, visible]));
    const scan = useLocalScan();

    await scan.refresh();

    expect(scan.selectedId.value).toBe(visible.id);
  });

  it("全部条目都被隐藏时，回退为空选中（详情进入空态）", async () => {
    setHiddenMod(hidden.id, true);
    setHiddenMod(visible.id, true);
    vi.mocked(scanMods).mockResolvedValue(report([hidden, visible]));
    const scan = useLocalScan();

    await scan.refresh();

    expect(scan.selectedId.value).toBeNull();
  });

  it("当前选中项仍在新扫描结果中且未被隐藏时，保留原选中不被刷新覆盖", async () => {
    vi.mocked(scanMods).mockResolvedValue(report([visible, hidden]));
    const scan = useLocalScan();
    scan.selectedId.value = visible.id;

    await scan.refresh();

    expect(scan.selectedId.value).toBe(visible.id);
  });

  it("引导完成接管报告时，同样跳过隐藏条目选取默认选中", () => {
    setHiddenMod(hidden.id, true);
    const scan = useLocalScan();

    scan.handleWizardDone(report([hidden, visible]));

    expect(scan.selectedId.value).toBe(visible.id);
  });
});
