import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "aoe2mm.hiddenLocalMods.v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("hiddenMods", () => {
  it("marks and persists by stable entry id", async () => {
    const mod = await import("../../hiddenMods");

    expect(mod.isHiddenMod("local/a")).toBe(false);
    mod.setHiddenMod("local/a", true);
    expect(mod.isHiddenMod("local/a")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual(["local/a"]);

    mod.setHiddenMod("local/a", false);
    expect(mod.isHiddenMod("local/a")).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("restores stored ids when the module loads after a restart", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["subscribed/zzz", "  "]));
    vi.resetModules();
    const mod = await import("../../hiddenMods");

    expect(mod.isHiddenMod("subscribed/zzz")).toBe(true);
    expect(mod.isHiddenMod("subscribed/other")).toBe(false);
  });

  it("counts hidden entries only among the supplied mods", async () => {
    const mod = await import("../../hiddenMods");
    mod.setHiddenMod("local/a", true);
    mod.setHiddenMod("local/missing", true);

    expect(mod.countHiddenMods([{ id: "local/a" }, { id: "local/b" }])).toBe(1);
  });
});
