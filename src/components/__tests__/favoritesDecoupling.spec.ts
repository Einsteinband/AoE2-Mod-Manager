import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 概念隔离回归：
 *   顶部板块 = local | online（mode，仅页面导航；favorites 时用 mainSection 保留高亮）
 *   收藏状态 = all | installed | uninstalled（favoritesWorkspace.scope，仅数据能力，不再有侧栏 UI 切换）
 * 两套状态不得互相写入。
 */

const topbar = readFileSync(join("src", "components", "layout", "TopBar.vue"), "utf8");
const app = readFileSync(join("src", "App.vue"), "utf8");
const favoritesBrowser = readFileSync(
  join("src", "components", "favorites", "FavoritesBrowser.vue"),
  "utf8",
);
const favoritesNav = readFileSync(
  join("src", "components", "favorites", "FavoritesNav.vue"),
  "utf8",
);

describe("顶部板块与收藏状态互不控制", () => {
  it("顶栏只管主板块：本地模组 / 在线模组两个页签，且不读写收藏状态", () => {
    expect(topbar).toContain('t("nav.local")');
    expect(topbar).toContain('t("nav.online")');
    expect(topbar).not.toContain("useFavorites");
    expect(topbar).not.toContain("scope");
    // 收藏态顶部高亮走独立的 mainSection，不靠 mode=favorites 硬凑
    expect(topbar).toContain("mainSection");
    expect(app).toContain("lastMainSection");
  });

  it("收藏分类状态只在 openFavorites 写入，切换顶部 mode 不会写 scope", () => {
    const writes = app.match(/favoritesWorkspace\.scope\.value\s*=/g) ?? [];
    expect(writes).toHaveLength(1);
    const openFavorites = app.match(/function openFavorites[\s\S]*?\n}/)?.[0] ?? "";
    expect(openFavorites).toContain("favoritesWorkspace.scope.value = scope");
    // watch(mode) 只负责退出本地排序模式，不触碰收藏分类
    const modeWatch = app.match(/watch\(mode,[\s\S]*?\n\}\);/)?.[0] ?? "";
    expect(modeWatch).not.toContain("favoritesWorkspace.scope");
    expect(modeWatch).not.toContain("openFavorites");
  });

  it("收藏页不接收顶部 mode；收藏内部已无本地 / 在线二级分类入口", () => {
    expect(favoritesBrowser).not.toContain("mode:");
    expect(favoritesBrowser).not.toContain("props.mode");
    expect(favoritesNav).toContain('emit("open-favorites", "all")');
    expect(favoritesNav).not.toContain("openScope");
    expect(favoritesNav).not.toContain("fav-nav-child");
    expect(favoritesNav).not.toContain("stateLocal");
  });
});
