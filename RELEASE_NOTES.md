# v0.4.6

## v0.4.6 - Fixes & Improvements

### 🔧 Changes
- Subscription conflict notice reworked: the popup that appeared after a mod was localized is gone. Instead, the local list header now always shows a one-line note reminding you that mods living in the `local` folder can be downloaded a second time by the game while the account is still subscribed - check the "Unsubscribed?" badge on the card, then unsubscribe in game or on the website if you see duplicates. Nothing is blocked, nothing pops up.
- The reminder is a single line of muted text in the list header: it never covers the list, never steals focus, and collapses to an ellipsis on narrow windows.
- Translation request pacing lowered from 250 ms to 800 ms per outgoing HTTP request, to reduce HTTP 429 rate limiting from the free endpoints. The pace still widens automatically when throttled and narrows again after a run of successes.

### 🛠 Fixes
- English UI no longer shows hard-coded Chinese: the view switcher (grid / list), the mod detail panel section titles and the Settings - Appearance / Typography section are now fully localized.
- The status bar now always speaks the language you selected, including messages that were raised before the language switch took effect.

### ✨ New
- Settings - Translation: the unfinished "Custom endpoint (in development)" option is removed. Only Auto / Google / MyMemory remain; an old config that still points at the custom endpoint falls back to Auto automatically.

---

## v0.4.6 - 修复与优化

### 🔧 调整
- 订阅冲突提示改版：本地化完成后弹出的提示框已移除。改为在本地列表抬头常驻一行说明——`local` 目录里的模组，在账号仍处于订阅状态时游戏会再下载一份；如果游戏内出现两个相同的模组，卡片上的「建议退订」标记仍在，请到游戏内或官网取消订阅。不弹窗、不阻塞操作。
- 说明只占抬头的一行浅色文字：不遮挡列表、不抢焦点，窗口变窄时自动收成省略号。
- 翻译请求的发送间隔由 250ms 放宽到 800ms，降低免费接口被判定为脚本（HTTP 429）的概率；被限流时仍会自动继续降速，连续成功后逐步恢复。

### 🛠 修复
- 英文界面不再出现硬编码中文：视图切换（网格 / 列表）、模组详情页的分区标题、设置里的「外观 / 排版」整块文案全部改为语言包驱动。
- 底栏状态提示始终使用当前界面语言，包括在语言切换生效之前发出的那几条提示。

### ✨ 新增
- 设置 - 翻译：移除尚未实现的「自定义接口（开发中）」选项，只保留 自动 / Google / MyMemory；历史配置里指向自定义接口的会按「自动」执行，不再报错。
