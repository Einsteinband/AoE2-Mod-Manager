import { describe, expect, it, vi } from "vitest";
import type { ModEntry, ScanReport } from "../../types";
import { useLocalScan } from "../local/useLocalScan";

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

vi.mock("../../api", () => ({
  detectRootCandidates: vi.fn(),
  pickFolder: vi.fn(),
  scanMods: vi.fn(),
  setModRoot: vi.fn(),
}));

function makeMod(): ModEntry {
  return {
    id: "local/test_mod",
    folderName: "test_mod",
    path: "F:/Games/AoE2DE/mods/local/test_mod",
    kind: "local",
    workshopId: 12345,
    nameFromFolder: "test_mod",
    displayName: "Test Mod",
    displayNameSource: "info.json",
    author: "Tester",
    description: "A test mod description.",
    thumbnail: null,
    enabled: true,
    priority: 100,
    lastUpdateMs: 1700000000000,
    installedAtMs: 1700000000000,
    checksum: null,
    contentTags: ["ui"],
    categories: ["ui"],
    categorySource: "official",
    officialTags: ["ui"],
    source: "tool",
    metadataRecorded: true,
    issues: [],
    infoJsonPresent: true,
    isDataMod: false,
    sizeBytes: null,
    sizeComplete: false,
    uninstalled: false,
  };
}

function report(mods: ModEntry[]): ScanReport {
  return {
    root: "F:/Games/AoE2DE",
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

describe("useLocalScan cover patch", () => {
  it("updates only the selected mod thumbnail after the Rust write succeeds", () => {
    const mod = makeMod();
    const other: ModEntry = { ...makeMod(), id: "local/other", folderName: "other" };
    const scan = useLocalScan();
    scan.handleWizardDone(report([mod, other]));

    scan.patchModCover(mod.id, "F:/Games/AoE2DE/mods/local/test_mod/thumbnail.jpg");

    const [updated, untouched] = scan.mods.value;
    expect(updated.thumbnail).toBe("F:/Games/AoE2DE/mods/local/test_mod/thumbnail.jpg");
    expect(updated.coverUrl).toBeNull();
    expect(untouched.thumbnail).toBeNull();
  });
});
