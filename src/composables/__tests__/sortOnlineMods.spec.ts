import { describe, expect, it } from "vitest";
import type { OnlineMod } from "../../online/types";
import { sortOnlineModsBySize } from "../online/sortOnlineMods";

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;

function makeMod(modId: number, title: string, fileSize: OnlineMod["fileSize"]): OnlineMod {
  return {
    modId,
    title,
    creator: null,
    thumbnail: null,
    installs: null,
    installsTruncated: false,
    rating: null,
    modStatus: null,
    userInstalled: false,
    userDownloaded: false,
    updateAvailable: false,
    gameTitleId: 2,
    tagIds: [],
    tagNames: [],
    fileSize,
    raw: {},
  };
}

describe("sortOnlineModsBySize", () => {
  it("handles empty and single-item lists", () => {
    expect(sortOnlineModsBySize([], "ASC")).toEqual([]);
    const one = [makeMod(1, "Only", 123)];
    expect(sortOnlineModsBySize(one, "DESC")).toEqual(one);
  });

  it("compares raw bytes across KB, MB and GB units", () => {
    const mods = [
      makeMod(3, "GB mod", GB),
      makeMod(1, "KB mod", KB),
      makeMod(2, "MB mod", MB),
    ];

    expect(sortOnlineModsBySize(mods, "ASC").map((m) => m.modId)).toEqual([1, 2, 3]);
    expect(sortOnlineModsBySize(mods, "DESC").map((m) => m.modId)).toEqual([3, 2, 1]);
  });

  it("places unknown sizes after valid sizes in both directions", () => {
    const mods = [
      makeMod(1, "Null", null),
      makeMod(2, "One KB", KB),
      makeMod(3, "NaN", NaN),
      makeMod(4, "Two KB", 2 * KB),
      makeMod(5, "Zero bytes", 0),
    ];

    expect(sortOnlineModsBySize(mods, "ASC").map((m) => m.modId)).toEqual([5, 2, 4, 3, 1]);
    expect(sortOnlineModsBySize(mods, "DESC").map((m) => m.modId)).toEqual([4, 2, 5, 3, 1]);
  });

  it("uses title and modId as a stable fallback for equal sizes", () => {
    const mods = [
      makeMod(2, "B", KB),
      makeMod(1, "A", KB),
      makeMod(3, "A", KB),
    ];

    expect(sortOnlineModsBySize(mods, "ASC").map((m) => m.modId)).toEqual([1, 3, 2]);
    expect(sortOnlineModsBySize(mods, "DESC").map((m) => m.modId)).toEqual([1, 3, 2]);
  });

  it("does not mutate the source list", () => {
    const mods = [makeMod(2, "B", MB), makeMod(1, "A", KB)];
    sortOnlineModsBySize(mods, "ASC");
    expect(mods.map((m) => m.modId)).toEqual([2, 1]);
  });
});
