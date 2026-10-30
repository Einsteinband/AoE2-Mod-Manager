# v0.3.2

## v0.3.2 - Local Chinese Search & Batch Tools

### Local Chinese search (new)
- **Two separate search boxes**: the top bar only does official search and fires only on Enter / "Search". A new local box above the mod grid searches Chinese titles and authors with a 300 ms debounce and **zero network requests**; results render in the same card grid.
- **Search while indexing**: local search queries both the index being built and everything already cached, so hits appear immediately instead of waiting for the full crawl.
- **Live index status**: 🟡 syncing (N / M collected) · 🟢 ready · 🔴 failed, please sign in · ⚪ disabled — pushed from the backend in real time.
- **Safer background sync**: the index is capped at 100,000 mods; on an expired cookie (401) the crawler stops immediately instead of retrying, and resumes automatically after you sign in again.

### One-click mod toggles
- An enable/disable switch on every card, plus "Enable all / Disable all" in the toolbar for the current filtered list. The whole batch is written to `mod-status.json` once, behind a confirmation dialog.

### Batch title translation
- Settings → Translation: translate the English titles of indexed mods, one request per second, resumable and stoppable at any time. Results are cached locally.

### Settings
- Settings → General now has two switches, both **off by default**: "Local Chinese search & auto indexing" and "Local search box on the online page".
- Existing caches, favorites and presets need no migration; missing `settings.json` fields fall back to defaults.

---

## v0.3.2 - 本地中文搜索与批量工具

### 本地中文搜索（全新）
- **双搜索框**：顶栏只负责官方搜索，回车或点「搜索」才会发请求；列表上方新增本地搜索框，用中文标题 / 作者检索，300ms 防抖、**完全不发网络请求**，结果直接渲染进原卡片网格。
- **边爬边搜**：本地搜索同时查询正在建立的索引和已缓存的所有条目，不用等全部爬完就能出结果。
- **索引状态实时可见**：🟡 同步中（已收集 N / M）· 🟢 已就绪 · 🔴 同步失败请先登录 · ⚪ 未开启。
- **后台同步更安全**：索引上限 10 万条；Cookie 过期（401）时立即停止而非反复重试，重新登录后自动续爬。

### 模组一键开关
- 每张卡片右下角可直接启用 / 禁用；工具栏可对当前筛选结果「全部启用 / 全部禁用」，整批只写一次 `mod-status.json`，并带二次确认。

### 批量翻译标题
- 设置 → 翻译：单线程每秒 1 条翻译索引里的英文标题，可随时停止、断点续跑，译文存本地。

### 设置
- 设置 → 通用新增两个开关，**默认都关闭**：「本地中文搜索与自动索引」和「在线页的本地搜索框」。
- 已有缓存、收藏与预设数据无需迁移；`settings.json` 缺字段自动按默认值处理。

---

> 完整说明 / Full documentation: [README.zh.md](README.zh.md) · [README.md](README.md)
