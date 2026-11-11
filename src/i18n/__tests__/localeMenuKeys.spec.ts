import { describe, it, expect } from "vitest";
import zh from "../locales/zh";
import en from "../locales/en";
import es from "../locales/es";

const locales = { zh, en, es };

/** 菜单直接复用 / 依赖的既有 key（三语必须齐全） */
const REQUIRED_PATHS = [
  "menu.enable",
  "menu.disable",
  "menu.ariaLabel",
  "favorites.favorite",
  "favorites.favorited",
  "favorites.rename",
  "favorites.addedToast",
  "favorites.removedToast",
  "favorites.savedToast",
  "detail.openFolder",
  "detail.browseSite",
  "detail.deleteMod",
  "detail.confirmTitle",
  "detail.confirmTool",
  "detail.confirmOfficial",
  "detail.confirmUnknown",
  "detail.confirmLocalOnly",
  "detail.deleteConfirmLabel",
  "detail.downloadInstall",
  "detail.errReveal",
  "detail.errOpenWebsite",
  "detail.errDelete",
  "translate.busy",
  "translate.queued",
  "translate.trigger",
  "translate.showTranslated",
  "translate.showOriginal",
  "translate.notReady",
  "translate.okToast",
  "translate.fromCacheToast",
  "translate.truncated",
  "translate.failNetwork",
  "translate.failBusy",
  "translate.failQuota",
  "translate.failGeneric",
  "online.installLocal",
  "online.reinstallLocal",
  "online.installing",
  "online.downloading",
  "online.offlineBlocked",
  "online.openedBrowser",
  "online.openFailed",
  "downloader.enqueued",
  "downloader.alreadyQueued",
  "downloader.addedToast",
  "card.notRegisteredHint",
];

/** 带动态参数的 key：三语占位符必须一致（避免参数静默丢失） */
const PARAM_KEYS = [
  "translate.trigger",
  "translate.showTranslated",
  "translate.truncated",
  "translate.failGeneric",
  "favorites.addedToast",
  "favorites.removedToast",
  "downloader.addedToast",
  "online.openedBrowser",
  "online.openFailed",
];

function get(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur && typeof cur === "object") return (cur as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function paramsOf(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const matches = text.match(/\{(\w+)\}/g) ?? [];
  return matches.map((m) => m.slice(1, -1)).sort();
}

describe("locale menu keys", () => {
  for (const [name, dict] of Object.entries(locales)) {
    it(`${name}: all required paths exist`, () => {
      for (const path of REQUIRED_PATHS) {
        expect(get(dict as Record<string, unknown>, path), path).toBeDefined();
      }
    });

    it(`${name}: parameter placeholders match reference locale`, () => {
      for (const path of PARAM_KEYS) {
        const refParams = paramsOf(get(en as Record<string, unknown>, path));
        const curParams = paramsOf(get(dict as Record<string, unknown>, path));
        expect(curParams, path).toEqual(refParams);
      }
    });
  }
});
