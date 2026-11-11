import { describe, it, expect } from "vitest";
import type { InstalledIndexEntry, ModKind } from "../../types";
import { buildOnlineMenuItems } from "../online/useOnlineModMenu";

const labels = {
  installLocal: "Download",
  reinstallLocal: "Reinstall",
  installing: "Installing…",
  downloading: "Downloading…",
  enqueued: "Queued",
  favorite: "Favorite",
  favorited: "Favorited",
  rename: "Rename",
  translateBusy: "Translating…",
  translateQueued: "Queued",
  translateTrigger: "Translate",
  translateShowTranslated: "Show translated",
  translateShowOriginal: "Show original",
  waitingHint: "Waiting for the description…",
  openFolder: "Open folder",
  browseSite: "Open webpage",
  offlineHint: "Offline",
};

function entry(kind: ModKind = "subscribed"): InstalledIndexEntry {
  return { workshopId: 555, kind, folderName: "mod_555", source: "official" };
}

const baseState = {
  entry: null,
  taskStatus: null,
  favorited: false,
  offline: false,
  cachedTranslation: false,
  showingOriginal: false,
  translating: false,
  queued: false,
  canText: true,
};

describe("buildOnlineMenuItems", () => {
  it("order: favorite → translate → rename; translate always present", () => {
    const items = buildOnlineMenuItems(555, baseState, labels);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(["install", "favorite", "translate", "rename", "folder", "website"]);
    expect(items.find((i) => i.id === "install")!.label).toBe("Download");
    expect(items.find((i) => i.id === "folder")!.disabled).toBe(true);
    // 在线菜单永远不出现本地启停 / 本地删除
    expect(ids).not.toContain("toggle");
    expect(ids).not.toContain("delete");
  });

  it("local entry present: reinstall label and folder enabled", () => {
    const items = buildOnlineMenuItems(555, { ...baseState, entry: entry() }, labels);
    expect(items.find((i) => i.id === "install")!.label).toBe("Reinstall");
    expect(items.find((i) => i.id === "folder")!.disabled).toBe(false);
  });

  it("busy / queued install label and disabled state follow task status", () => {
    const running = buildOnlineMenuItems(555, { ...baseState, taskStatus: "installing" }, labels);
    expect(running.find((i) => i.id === "install")!.label).toBe("Installing…");
    expect(running.find((i) => i.id === "install")!.disabled).toBe(true);

    const queued = buildOnlineMenuItems(555, { ...baseState, taskStatus: "queued" }, labels);
    expect(queued.find((i) => i.id === "install")!.label).toBe("Queued");
    expect(queued.find((i) => i.id === "install")!.disabled).toBe(false);
  });

  it("offline disables install with hint", () => {
    const items = buildOnlineMenuItems(555, { ...baseState, offline: true }, labels);
    const install = items.find((i) => i.id === "install")!;
    expect(install.disabled).toBe(true);
    expect(install.hint).toBe("Offline");
  });

  it("cached translation: toggle label and enabled; no cache but text translatable: trigger", () => {
    const withCache = buildOnlineMenuItems(
      555,
      { ...baseState, cachedTranslation: true, showingOriginal: true },
      labels,
    );
    const cached = withCache.find((i) => i.id === "translate")!;
    expect(cached.label).toBe("Show translated");
    expect(cached.disabled).toBe(false);

    const fresh = buildOnlineMenuItems(555, baseState, labels);
    const trigger = fresh.find((i) => i.id === "translate")!;
    expect(trigger.label).toBe("Translate");
    expect(trigger.disabled).toBe(false);
  });

  it("no cache and description missing: translate disabled with waiting hint", () => {
    const items = buildOnlineMenuItems(555, { ...baseState, canText: false }, labels);
    const translate = items.find((i) => i.id === "translate")!;
    expect(translate.disabled).toBe(true);
    expect(translate.hint).toBe("Waiting for the description…");
  });

  it("translating / queued: busy label and disabled", () => {
    const busy = buildOnlineMenuItems(555, { ...baseState, translating: true }, labels);
    const busyItem = busy.find((i) => i.id === "translate")!;
    expect(busyItem.label).toBe("Translating…");
    expect(busyItem.disabled).toBe(true);

    const queued = buildOnlineMenuItems(555, { ...baseState, queued: true }, labels);
    const queuedItem = queued.find((i) => i.id === "translate")!;
    expect(queuedItem.label).toBe("Queued");
    expect(queuedItem.disabled).toBe(true);
  });

  it("modId <= 0 disables favorite/translate/rename/website", () => {
    const items = buildOnlineMenuItems(0, baseState, labels);
    for (const id of ["favorite", "translate", "rename", "website"]) {
      expect(items.find((i) => i.id === id)!.disabled).toBe(true);
    }
  });
});
