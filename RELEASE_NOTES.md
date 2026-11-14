# v0.5.3 — 2026-11-14

## v0.5.3 - What's New

- **📜Release History Built In:** Settings → About → *Release history* is now shipped inside the app instead of being fetched from GitHub. The full history back to v0.1.0 appears the moment you expand it, works offline, and no longer disappears when GitHub is unreachable or the anonymous API hits its rate limit. The separate *Check for updates* feature still uses the network exactly as before.

## v0.5.3 - 更新内容

- **📜更新历史内置：** 设置 → 关于的「更新历史」改为随软件构建、安装的内置记录，不再实时请求 GitHub。展开即可看到从 v0.1.0 起的全部版本，断网、GitHub 不可达或接口限流都不会再让历史空掉或加载失败；独立的「检查更新」仍照原样联网工作，两条路径互不影响。

---

# v0.5.2 — 2026-11-14

## v0.5.2 - What's New

- **🌍Languages:** Added German (Deutsch) and Russian (Русский) — the UI now ships in five languages.
- **📏Online Size Sorting:** Online mods can be sorted by file size. Sizes come from cached mod info, so a mod shows no size until its info has been cached. The feature is off by default — enable it in *Settings → General*.
- **🎨Interface:** Detail-panel layout, settings interactions and status-bar colors polished; the load priority is shown in the mod detail again.

## v0.5.2 - 更新内容

- **🌍多语言：** 新增德语（Deutsch）与俄语（Русский），界面共支持五种语言。
- **📏在线按大小排序：** 在线模组可按文件大小排序。体积取自已缓存的模组信息，未缓存的模组在该信息缓存前没有体积、暂不参与排序。功能默认关闭，需在「设置 → 通用」中手动开启。
- **🎨界面优化：** 优化详情面板布局、设置页交互与状态栏配色，模组详情恢复显示「加载优先级」。

---

# v0.5.1 — 2026-11-12

## v0.5.1 - What's New

- **✨Mod Details:** Improved the Mod detail page with clearer information and more convenient actions. Users can switch between icon and text button styles. Right-clicking the card allows for convenient module management.
- **🎨Appearance:** Added 8 accent colors with light and dark themes. Improved color selection and added customizable card decorations, including installed-Mod background colors, accent borders, and corner stripes.
- **🖼️Cover Images:** Improved cover image detection and fallback handling. Added a button to retry retrieving Mod covers.
- **📦External Mods (Experimental):** External Mod importing and management with limited ZIP support. This feature is experimental; RAR, 7z, folders, and batch importing are not supported.
- **🌐Browsing Experience:** Improved Mod card presentation, search, offline information access, and multilingual support.

## v0.5.1 - 更新内容

- **✨模组详情：** 优化详情页信息布局与操作体验，支持切换图标或文字按钮样式，右键卡片可以便捷地进行模组管理。
- **🎨外观设置：** 新增 8 种强调色及浅色/深色主题；优化颜色选择，并支持自定义卡片装饰，包括已安装 Mod 的背景色、主题色边框和右下角斜线。
- **🖼️封面图片：** 改进封面识别与加载失败回退机制，新增封面重新获取功能。
- **📦外部 Mod（实验性）：** 外部 Mod 导入与管理，现阶段仅有限支持 ZIP 文件。该功能仍处于实验阶段，不支持 RAR、7z、文件夹及批量导入。
- **🌐浏览体验：** 优化 Mod 卡片展示、搜索、离线信息查看及多语言支持。

---

# v0.5.0 — 2026-11-10

## v0.5.0 - Update Notes
### ✨ New Features
- Automatically remembers the last position, size, and maximized state of the main window when closed, and restores it on the next launch, eliminating the need to manually adjust every time.
- The sidebar categories for local and online mods now support independent collapse and expand, with group states persisted locally to reduce information density pressure in long lists.
- Mod update detection optimization: up to 5 concurrent requests to reduce waiting time for individual checks; added detection result caching to reduce duplicate requests; the left list dynamically displays the "Updates Pending" count and entry, and automatically hides when there are no mods to update.
- Optimized the UI performance when the window is resized, now the buttons are no longer squeezed.
- 
### 🧪 Experimental
- Third-party ZIP mod import: added an experimental import entry, for verification only, not recommended for use as a formal feature yet.
- 
## v0.5.0 - 更新内容

### ✨ 新增
- 自动记忆主窗口上次关闭时的位置、尺寸和最大化状态，下次启动直接恢复，不再每次手动调整。
- 本地模组和在线模组侧边栏的分类分组支持独立折叠与展开，分组状态本地持久化，减少长列表的信息密度压力。
- 模组更新检测优化：最多 5 路并发请求，减少逐个检测等待时间；增加检测结果缓存，减少重复请求；左侧列表动态显示「待更新」数量及入口，没有待更新模组时自动隐藏。
- 优化了ui在窗口缩放时的表现，现在按钮不会被挤压了

### 🧪 实验性
- 第三方 ZIP 模组导入：新增实验性导入入口，仅供验证，暂不建议作为正式功能使用。

---

# v0.4.9 — 2026-11-09

## v0.4.9 - Under the hood

### 🛠 Fixes
- **Backend error protocol**: hundreds of hardcoded Rust messages are now wrapped in a standard `aoe2mm:err:<code>` envelope. The UI resolves every error through a single translation path, laying the groundwork for more languages down the road.
- **"Fake login" fixed**: the account session probe is rebuilt so a network hiccup no longer shows "logged in" while downloads actually fail. The bottom-left status now reflects reality.
- **Dead-link hint**: when the official API returns an invalid download URL, the detail panel now shows a clear *"this mod's download link has expired — the author may have removed it"* instead of a raw English parser string like `relative URL without a base`.
- **Sidebar tag leak**: scan-time error codes (e.g. `aoe2mm:err:scan.tagOther`) no longer leak into the left sidebar; they are resolved through the same translation pipeline as every other error.

---

## v0.4.9 - 底层升级

### 🛠 修复
- **底层错误码全面升级**：数百处硬编码的 Rust 文本统一替换为 `aoe2mm:err:<code>` 错误码协议，前端经单一翻译出口解析，为未来支持更多语言打下基础。
- **修复「假登录」问题**：重构账号会话探测逻辑，网络波动时不再误报「已登录、实则无法下载」；左下角状态与真实可用性一致。
- **修复死链提示**：官方 API 返回无效下载链接时，详情面板现在明确提示「该模组的下载链接已失效，可能是作者已将其删除」，不再直接抛出 `relative URL without a base` 这类底层英文串。
- **修复侧栏分类协议串泄露**：扫描阶段的错误码（如 `aoe2mm:err:scan.tagOther`）不再原样显示在左侧侧边栏，统一走翻译管道。

---

# v0.4.8 — 2026-11-07

## v0.4.8 - Fixes & Improvements

### ✨ New
- Full Spanish (Español) UI: every screen, dialog and toast is translated. The language picker now offers English / Español / 中文 and the choice is remembered in `settings.json`.
- Backend error messages are translated: raw Rust errors are matched as whole sentences and rendered in the current UI language, with the original path / cause kept in place. Non-Chinese UIs no longer show mixed Chinese-English text.
- Settings - Appearance: weight and line spacing moved from dropdowns to left/right toggle buttons; new card weight and a serif / sans-serif font switch. English UI gets its own font stack and slightly tighter tracking.
- Settings window is now a floating, draggable panel: move it aside and keep working in the main window.
- The bottom-left "Account & network" area is rebuilt into a single entry point: a fixed label with the live status shown beside it, plus a popup menu holding the account line (cookie source and count), "Check connection" (login state and a real request in one go) and "Sign out / clear cache". The duplicate account block in the online sidebar is gone.

### 🛠 Fixes
- Settings - General & Storage: folder paths and buttons no longer squeeze each other; action buttons moved to the left and wrap when space is tight.
- Settings - Mod translation: the online data cache figure is hidden and the "clear translation cache" button is removed; the explanation now sits under the batch translation section.
- Errors raised on the online mod browser now go through the same translation path as the rest of the app.
- Signing out reports the real reason when it fails (for example a file still in use) instead of claiming success. "Check connection" now always answers, in all four login/network combinations.

---

## v0.4.8 - 修复与优化

### ✨ 新增
- 完整西班牙语界面：所有页面、对话框与提示均已翻译；语言下拉现有 English / Español / 中文，选择记在 `settings.json`。
- 后端错误消息翻译：Rust 原文按整句匹配后转成当前界面语言，并保留原始路径 / 原因；非中文界面不再出现中外混排。
- 设置 - 外观：字重与行距由下拉改为左右切换按钮，新增卡片字重、衬线 / 非衬线字体切换；英文界面使用专用字体栈并略微收紧字距。
- 设置窗口改为可拖动的浮动面板，可挪到一边继续操作主界面。
- 左下角「账号与网络」重做为一处入口：按钮文案固定、状态文字显示在右侧，弹出菜单内含账号信息（凭据来源与数量）、「校验连接」（登录状态与真实请求一次完成）与「退出登录 / 清缓存」；在线页侧栏重复的账号块已移除。

### 🛠 修复
- 设置 - 通用 / 存储：路径与按钮不再互相挤压，操作按钮统一左移、空间不足时换行排列。
- 设置 - 模组翻译：隐藏在线数据缓存统计、「清理翻译缓存」按钮已移除，说明文本移到「批量翻译」下方。
- 在线模组页的报错统一走翻译出口。
- 退出登录失败时如实提示原因（如文件仍被占用），不再假报成功；「校验连接」在登录与网络的四种组合下都会给出结果。

---

# v0.4.7 — 2026-11-07

## v0.4.7 - Fixes & Improvements

### 🛠 Fixes
- Downloads no longer hang after a connection drop: 60s socket idle timeout and 900s overall timeout on the Rust side, plus a 20-minute watchdog in the UI. One stuck task can no longer block the whole queue.
- "Download not responding" now appears after 5 seconds without progress, and cancelling at that point releases the queue immediately.
- Failed downloads can be retried directly from the download panel.
- Network errors are shown in plain language; raw TLS / OS error strings are no longer exposed.
- The install report (final path, backup info) is no longer shown after a successful install.

### ✨ New
- Local mods: new "Download order" sort option - newest downloaded or reinstalled first, mods without install records last.
- Settings - About: the author profile link is replaced by a "Feedback & suggestions" row with a GitHub Issue button that opens the issue tracker.

---

## v0.4.7 - 修复与优化

### 🛠 修复
- 断网后下载不再卡死：Rust 侧增加 60 秒 socket 空闲超时与 900 秒整体超时，界面侧增加 20 分钟看门狗；单个任务挂起不会再堵死整个队列。
- 无进度 5 秒即提示「下载无响应」，此时点取消可立即释放队列。
- 下载失败的任务可直接在下载面板重试，无需先移除再重新添加。
- 网络错误改为通俗文案，不再向用户暴露 TLS / 系统错误原文。
- 安装成功后不再显示路径与备份报告。

### ✨ 新增
- 本地模组页新增「按下载顺序」排序：最近下载或重装排最前，无安装记录的排最后。
- 设置 - 关于：「作者主页」改为「反馈或建议」，并提供打开 GitHub Issue 的按钮。

---

# v0.4.6 — 2026-11-06

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

---

# v0.4.5 — 2026-11-06

## v0.4.5 - Fixes & Improvements

### 🛠 Fixes
- Sign-in fixed: the account window is no longer torn down right before opening it (the v0.4.0 regression that made "Sign in" look unresponsive), and the Steam / PlayStation sign-in entries were removed - the app now goes straight to Microsoft / Xbox.
- **Please make sure your Steam account is already linked on the Age of Empires II website** (ageofempires.com) before signing in. An unlinked account can sign in, but the official site will not return your subscribed mods; the sign-in panel now links to the account page and explains this.

### ✨ New
- Settings - About: new "Diagnostics (run log)" section. Describe the problem, then copy a ready-to-paste report (version / OS / problem / last 100 log lines) for AI analysis, or open the log folder in one click. Logs now rotate at 5 MB and keep the latest 5 files, with local time stamps.

### 🔧 Changes
- Settings - Storage: all caches now live in a single "Data & cache folder". A one-click migration moves the old image / mod-info / translation caches safely (copy, verify, atomic rename, delete old; automatic rollback on failure), and settings.json always stays in place as an anchor.

---

## v0.4.5 - 修复与优化

### 🛠 修复
- 登录问题修复：账号窗口不再在打开前被销毁（这是 v0.4.0 之后「点登录没反应」的根因），同时移除了 Steam / PlayStation 登录入口，现在直接使用微软 / Xbox 账号登录。
- **请确保你的 Steam 账号已在帝国时代2官网（ageofempires.com）完成绑定**，否则即使登录成功，官网也不会返回你订阅的模组。登录面板已加入绑定说明与账号中心入口。

### ✨ 新增
- 设置 - 关于：新增「问题诊断（运行日志）」区域。填写问题描述后一键复制完整诊断信息（版本 / 系统 / 问题 / 最近 100 行日志），直接发给 AI 分析；也可一键打开日志所在文件夹。日志按 5MB 滚动，保留最近 5 份，时间戳为本地时间。

### 🔧 调整
- 设置 - 存储：所有缓存合并为单一「数据与缓存总目录」。支持一键安全迁移（复制、校验、原子改名、删除旧目录，失败自动回滚），settings.json 始终留在原处作为定位锚点。

---

# v0.4.4 — 2026-11-06

## v0.4.4 - Improvements

### 🛠 Improvements
- Subscription conflict guard: fixed the case where a localized mod was still force-downloaded by the game. The local list now shows a red "Suggest unsubscribe" badge plus a dedicated dialog that guides you to cancel the subscription on the official website, so the same mod is no longer stored twice.
- Removed the remaining hardcoded Chinese strings from the interface; the English UI is now fully localized.

---

## v0.4.4 - 优化与修复

### 🛠 优化与修复
- 订阅冲突防呆：解决“本地化后游戏依然强制下载”的问题。本地列表新增“建议退订”红标与专属弹窗，引导用户前往官网取消订阅，防止文件重复。
- 清洗了界面残留的硬编码中文，英文界面完美无瑕。

---

# v0.4.3 — 2026-11-05

## v0.4.3 - New Features

### 🚀 New Features
- Added a Launch Game button with automatic game path detection, one-click launch through Steam.
- Improved legacy or non-standard mod structures by auto-filling the missing resources level, removing the in-game mod warning icon.
- The download list now stays docked and always visible.

---

## v0.4.3 - 新增功能

### 🚀 新增功能
- 新增「启动游戏」按钮，自动检测游戏路径，一键唤起 Steam 启动。
- 优化老旧或不规范模组结构，自动补全 resources 层级，告别游戏内模组感叹号。
- 下载列表改为常驻。

---

# v0.4.2 — 2026-11-05

## v0.4.2 - Bug Fixes

### 🐛 Bug Fixes
- Fixed the mod detail page text.

---

## v0.4.2 - 问题修复

### 🐛 问题修复
- 修复详情页文本。

---

# v0.4.1 — 2026-11-04

## v0.4.1 - Download Queue Manager & Bug Fixes

### ✨ New Features
- **Download Queue Manager**: Added a global floating download manager (bottom-right). You can now queue multiple mods; they will download and install sequentially in the background without blocking your browsing.
- **Card Size Settings**: Restored the ability to customize the grid column count (4, 5, or 6 columns) in Settings -> Appearance.

### 🐛 Bug Fixes
- Fixed a critical issue where switching to another mod while downloading would freeze the UI and prevent new downloads.
- Improved download cancellation logic: queued tasks can be removed, and active downloads can be cancelled cleanly.

---

## v0.4.1 - 下载队列管理器与问题修复

### ✨ 新增功能
- **下载队列管理器**：新增右下角全局悬浮下载管理器。支持将多个模组加入队列，后台按顺序串行下载并安装，完全不阻塞你的浏览。
- **卡片列数设置**：在“设置 -> 外观”中恢复了自定义网格列数（4列、5列、6列）的功能。

### 🐛 问题修复
- 修复了下载时切换到其他模组会导致 UI 卡死且无法下载新模组的严重 Bug。
- 优化了下载取消逻辑：排队中的任务可以直接移除，正在下载的任务可以安全中断。

---

# v0.4.0 — 2026-11-01

## v0.4.0 - UI Revolution, Performance & Game Protection

This is a milestone update! We have completely refactored the UI layout to eliminate stuttering, significantly boosted translation speed, added strict protection for Data Mods, and introduced flexible custom cache paths.

### 🛡️ Game Protection
- **Data Mod Exclusion**: Automatically identifies Data Mods (displaying a ⚙️ gear badge). Since the game only allows one Data Mod at a time, the app now strictly intercepts conflicts when enabling multiple Data Mods (via single toggle, batch enable, or presets) to prevent in-game crashes.

### ⚡ Core Performance
- **Translation Boost**: Increased batch translation concurrency from 1 to 3. Added intelligent rate-limiting and 429 backoff for anti-ban protection. Translation speed is now 4x faster.

### 📁 Storage & Security
- **Custom Cache Paths**: Added a new "Cache & Storage" tab. You can now freely customize the storage directories for images, mod info, and translations, saying goodbye to C-drive overflow.
- **Smart Fallback**: If a custom directory becomes unavailable (e.g., external drive unplugged), the app automatically falls back to the default path to prevent missing covers.
- **Force Exit**: Fixed the zombie process bug. Closing the window now instantly terminates all background processes, saving system resources.

### ✨ UI & UX Revolution
- **Dual Themes**: Added global Light and Dark theme switching for eye protection.
- **Advanced Typography**: Support for switching between "SimHei / YouYuan / Microsoft YaHei" fonts. Font size, line spacing, and weight can be independently adjusted.
- **Layout & Toolbar Redesign**: Refactored the global UI skeleton. Search, sorting, and scanning buttons are now compactly aligned, and batch operations are independently partitioned. Completely resolved window scaling and layout jumping issues.
- **Redesigned Details Panel**: Mod descriptions are moved to the top. Action buttons are reorganized by priority, and technical info is collapsed for a better reading experience.

### 🔔 Updates & Notifications
- **Lanzou Cloud Download**: Added a "Lanzou Cloud Download" entry in the update toast (Password: h7dt) for faster downloads in China.
- **Popup Logic Hardened**: Fixed a bug where clicking the backdrop would mistakenly mark release notes as read. You must now click "Got it" to dismiss.

---

## v0.4.0 - 视觉大革命、性能飞跃与模组防呆

这是一次里程碑式的重大更新！我们重构了底层 UI 架构，彻底解决了界面卡顿与布局挤压；大幅提升了翻译速度；新增了数据模组冲突保护；并让软件存储更加灵活。

### 🛡️ 游戏防呆与机制
- **数据模组互斥防呆**：自动识别包含 `.dat` 核心数据的模组（显示 ⚙️ 齿轮角标）。由于游戏机制限制同一时间只能启用一个数据模组，软件现在会在单开、批量开启和应用预设时自动拦截冲突，防止游戏内失效或闪退。

### ⚡ 核心性能提升
- **翻译引擎大提速**：批量翻译并发从 1 路提升至 3 路，加入智能限流与 429 自动退避防封。翻译速度提升 4 倍以上。

### 📁 存储与安全
- **自定义缓存路径**：新增「缓存与存储」设置。支持自由更改“图片”、“模组信息”、“翻译”的存放目录，彻底告别 C 盘爆满。
- **智能防呆回退**：若自定义目录不可用（如移动硬盘拔出），自动回退到默认路径，防止封面加载失败。
- **强制退出机制**：修复了关闭软件后后台进程残留的问题，现在关闭窗口将瞬间彻底结束所有进程，不占用系统资源。

### ✨ 视觉与交互革命
- **双主题支持**：新增全局明暗主题切换，一键无缝切换，白天黑夜都护眼。
- **超强排版引擎**：支持“黑体 / 幼圆 / 微软雅黑”字体切换，字号、行距、粗细皆可独立调节，告别视觉疲劳。
- **布局与工具栏重组**：重构了全局 UI 骨架。搜索框与排序、扫描按钮紧凑贴合，批量操作独立分区。完美解决窗口缩放时的挤压与跳动问题。
- **全新详情面板**：模组描述全面前置，操作按钮按主次重排，“技术信息”折叠收纳，阅读与操作更直观。

### 🔔 更新与提示
- **蓝奏云备用下载**：右下角的“发现新版本”弹窗内新增“蓝奏云高速下载”入口（密码：h7dt），国内下载更顺畅。
- **更新弹窗逻辑加固**：修复了误触关闭遮罩被记录为已读的 Bug，必须点击“我知道了”才会关闭，确保不漏看新特性。

---

# v0.3.5 — 2026-10-31

## v0.3.5 — Performance Boost, Custom Storage & Data Mod Protection

### Game Protection
- **Data Mod Conflict Detection**: mods containing core `.dat` files are detected automatically and marked with a dedicated ⚙️ gear badge.
- **Mutual Exclusion Guard**: the game allows only one Data Mod at a time. Enabling a second one through single toggle, batch enable, or preset apply is now intercepted and skipped automatically, preventing in-game failures and crashes.

### Performance
- **Faster Translation Engine**: batch translation concurrency raised from 1 to 3, with intelligent rate limiting and 429 backoff for anti-ban safety. Translation is now over 4x faster.

### Storage & Configuration
- **Custom Cache Paths**: a new "Cache & Storage" settings tab lets you choose where images, mod info, and translation data are stored, so your C drive no longer fills up.
- **Smart Fallback**: if a custom directory becomes unavailable (for example an unplugged external drive), the app falls back to the default path automatically so cover images keep loading.

### Update Notifications
- **Lanzou Cloud Download**: the update dialog now offers a "Lanzou Cloud fast download" entry (password: h7dt) for smoother downloads in China.
- **Popup Logic Hardened**: fixed a bug where clicking the backdrop dismissed the release notes popup. Only "Got it" now marks the notes as read.

---

## v0.3.5 — 性能飞跃、存储自定义与数据模组防呆

### 游戏防呆
- **数据模组冲突检测**：自动识别包含 `.dat` 核心数据的模组，并在卡片上显示专属 ⚙️ 齿轮角标。
- **互斥保护拦截**：游戏机制限制同一时间只能启用一个数据模组，因此无论是单条启用、批量启用还是应用预设，软件都会自动拦截并跳过多余的数据模组，避免游戏内失效或闪退。

### 性能优化
- **翻译引擎提速**：批量翻译并发从 1 路提升至 3 路，并加入智能限流与 429 退避防封，翻译速度提升 4 倍以上。

### 存储与配置
- **自定义缓存路径**：新增「缓存与存储」设置，可自定义图片、模组信息、翻译数据的存放目录，告别 C 盘爆满。
- **智能防呆回退**：若自定义目录不可用（例如移动硬盘被拔出），自动回退到默认路径，确保封面正常加载。

### 更新提示
- **蓝奏云下载**：更新弹窗内新增「蓝奏云高速下载」入口（密码：h7dt），国内下载更顺畅。
- **弹窗逻辑加固**：修复了点击遮罩会误将更新说明标记为已读的 Bug，现在必须点击「我知道了」才会记录已读。

---

# v0.3.4 — 2026-10-31

## v0.3.4 — UI & UX Revolution

### New Visual System
- **Light Mode Added**: a global theme switcher for seamless toggling between dark and light modes. Easy on the eyes, day or night.
- **Advanced Typography Engine**: switch between SimHei / YouYuan / Microsoft YaHei, with font size, line spacing and weight adjustable independently to eliminate visual fatigue.
- **Responsive Modular Layout**: the global UI skeleton was refactored to fully solve window scaling, squeezing and jumping issues. The search box and toolbar are now more compact and professional.

### Login & Security Optimization
- **User-Controlled Persistent Login**: new "Remember me for 7 days" toggle.
  - Benefit: when enabled, credentials are stored locally with DPAPI encryption, so restarting the app is instant.
  - Risk: credentials stay on disk for 7 days. Do NOT enable this on public or shared computers.
  - Default strategy: disabled by default for maximum security out of the box. When disabled, restarting triggers a silent Microsoft SSO verification that takes a few seconds.

### Experience & Extensions
- **Redesigned Details Panel**: mod descriptions moved to the top, action buttons reorganized by priority, and "Technical Info" collapsed for a more intuitive experience.
- **Startup Update Popup**: after a major update the app shows the release notes on launch, so no new feature is missed.
- **Built-in Update History**: browse the changelog of all historical versions anytime in Settings - About.
- **Lanzou Cloud Backup Download**: a Lanzou Cloud entry in the About section for faster downloads in China.

### Fixes & Improvements
- **Indexing Mechanism Optimization**: when local indexing is disabled in settings, the "Go to Settings" banner is hidden automatically instead of nagging repeatedly.
- Optimized card rendering on both local and online pages, completely resolving physical jitter when switching categories.
- Refactored the underlying business logic for faster performance and lower memory usage.

---

## v0.3.4 — 视觉与体验大革命

### 全新视觉系统
- **明亮模式上线**：新增全局明暗主题切换，支持一键无缝切换，白天黑夜都护眼。
- **超强排版引擎**：支持「黑体 / 幼圆 / 微软雅黑」字体切换，字号、行距、粗细皆可独立调节，彻底告别视觉疲劳。
- **响应式模块化布局**：重构了全局 UI 骨架，完美解决窗口缩放时的挤压与跳动问题，搜索框与工具栏布局更加紧凑专业。

### 登录与安全机制优化
- **持久登录自主可控**：新增「记住登录 7 天」开关。
  - 好处：开启后，登录凭证以 DPAPI 加密形式保存在本机，重启软件无需再次验证，秒开即用。
  - 风险：凭证会落盘 7 天，请勿在公共电脑上开启。
  - 默认策略：该功能默认关闭，保障默认状态下的最高安全性；关闭时，重启软件会自动通过微软 SSO 进行静默验证（耗时数秒）。

### 体验与扩展
- **全新详情面板**：模组描述全面前置，操作按钮按主次重排，「技术信息」折叠收纳，阅读与操作更直观。
- **首启更新弹窗**：每次大版本更新后，软件启动会自动展示新特性说明，不再错过任何更新。
- **内置更新历史**：在「设置 - 关于」中可随时查看所有历史版本的更新日志。
- **蓝奏云备用下载**：在「关于」页提供蓝奏云网盘入口，方便国内用户高速获取资源。

### 修复与优化
- **索引机制优化**：当在设置中关闭本地索引时，页面顶部的「前往开启」残留横幅会自动隐藏，不再反复打扰。
- 优化了本地与在线页面的卡片渲染逻辑，彻底解决切换分类时的物理抖动。
- 重构了底层业务逻辑代码，软件运行速度更快，内存占用更低。

---

# v0.3.3 — 2026-10-30

Optimized module sorting

优化了模组排序

---

# v0.3.2 — 2026-10-30

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

---

# v0.3.1 — 2026-10-30

## v0.3.1 - Update Check Fix

- **Fixed Excessive Update Requests**: The app no longer contacts GitHub on every launch. Automatic update checks are now limited to once every 24 hours.

- **Manual Check Unchanged**: Clicking "Check for Updates" still queries GitHub immediately.

---

## v0.3.1 - 更新检查修复

- **修复频繁请求更新**：不再每次启动都访问 GitHub，自动检查限制为 24 小时最多一次。

- **手动检查保持即时**：在设置中点「检查更新」仍然立即请求。

---

> 完整说明 / Full documentation: [README.zh.md](README.zh.md) · [README.md](README.md)

---

# v0.3.0 — 2026-10-30

## v0.3.0 - Translation and Fast Cache Version

🌐 **One-Click Module Translation**: Supports Chinese / multiple languages, powered by the free Google / MyMemory APIs, with translation results cached permanently on your machine.

⚡ **Instant, Cache-Backed Startup**: Online and local mods now share a dual image + text cache, so you can switch categories and browse covers instantly — even offline.

🔒 **Non-Commercial Use Only**: The project is now released under the PolyForm Noncommercial license to protect the author's rights.

---

## v0.3.0 - 多语言翻译并缓存

🌐 **模组一键翻译**：支持多语言，基于 Google / MyMemory 免费接口，翻译结果永久缓存在本地。

⚡ **无痕秒开**：在线与本地模组全面接入图文双缓存，断网也能秒切分类、浏览封面。

🔒 **禁止商业使用**：采用 PolyForm Noncommercial 协议，保护作者权益。

---

> 完整说明 / Full documentation: [README.zh.md](README.zh.md) · [README.md](README.md)

---

# v0.2.3 — 2026-10-30 — v0.2.3 Update

bug fix

---

# v0.2.2 — 2026-10-30

模组收藏功能，不用担心找不到心仪的模组
在线模组缓存到本地，丝滑体验

Module collection feature, no need to worry about not finding your favorite modules. 
Online modules are cached locally for a smooth experience.

---

# v0.2.1 — 2026-10-29

Reduced the update check cooldown from 60s to 15s for a smoother experience.

Removed verbose developer notes from the mod detail panel to keep the UI clean.

将更新检查从60s降为15s以获得更平稳的体验.

从mod细节面板上移除了开发者笔记,以保持UI清洁.

---

# v0.2.0 — 2026-10-29 — v0.2.0 - Drag & Drop Sorting & Update Checker

## What's Changed in v0.2.0

### ✨ New Features
- **Drag & Drop Sorting**: You can now reorder your mods in the "Sort Mode" to adjust load priority (`Priority`).
- **Update Checker (Software & Mods)**: Added a new Settings panel (⚙️). You can now check for software updates and batch-check for mod updates.
- **Preset Overwrite**: Applying a preset now completely overwrites your current config instead of merging, preventing mod conflicts.
- **Full i18n Support**: Added an auto-loading language system (English/Chinese built-in).

### 🐛 Bug Fixes
- Fixed a critical issue where downloaded mods in `local/` were being incorrectly auto-subscribed by the game. Local mods now have `WorkshopID=0` and no ID prefix, completely isolated from the game's server sync.
- Fixed mod file deletion leaving empty folders or missing `mod-status.json` records.

---

## v0.2.0 更新日志

### ✨ 新增功能
- **拖拽排序**：新增“排序模式”，支持直接拖拽卡片调整模组加载优先级（Priority）。
- **双端更新检测**：全新设置面板（⚙️）上线，支持一键检查软件更新，以及批量检测本地模组是否有新版本。
- **预设覆盖逻辑修复**：应用预设时改为“覆盖式”，不再追加，彻底解决模组冲突。
- **全量多语言架构**：支持丢入语言文件即自动识别，内置中英双语。

### 🐛 重要修复
- **彻底解决反向同步 Bug**：此前下载到 `local` 目录的模组会被游戏误认为官方订阅。现在本地模组的 `WorkshopID` 强制为 `0`，且去除文件夹 ID 前缀，游戏彻底不再干预。
- 修复了卸载模组时残留空文件夹或未清理 `mod-status.json` 记录的问题。

---

# v0.1.1 — 2026-10-29

模组排序功能
Module Sorting Function

---

# v0.1.0 — 2026-10-28 — v0.1.0 - Initial Release

# AoE2 Mod Manager v0.1.0 (Initial Release)

A modern, open-source third-party mod manager for **Age of Empires II: Definitive Edition**. 

### ✨ Key Features
- **Seamless Download & Localization**: Browse 40,000+ official mods online and download them directly into your `local` folder. No need to launch the game!
- **Smart Game Recognition**: Automatically generates `info.json` and updates `mod-status.json` so the game recognizes your mods immediately.
- **Preset System**: Save your mod configurations and restore them with one click after game updates.
- **Fully Internationalized**: English and Chinese support out-of-the-box.
- **Safe & Read-only**: Never destroys your game files. Automatic backups before modifying status.

### 📥 Installation
- **Installer**: Download `AoE2 Mod Manager_0.1.0_x64-setup.exe` and run it.
- **Portable**: Download `AoE2ModManager-0.1.0-win-x64-portable.zip`, extract it anywhere, and run the `.exe`.

*(Note: The app is currently unsigned. Windows SmartScreen may show a warning. Click "More info" -> "Run anyway".)*

---

# 帝国时代 II · 模组管理器 v0.1.0 (首发版)

一个现代、开源、第三方的《帝国时代 II：决定版》模组管理器。

### ✨ 核心功能
- **免进游戏，一键安装**：在线浏览 4 万+ 官方模组并直接下载至本地。游戏秒识别，无需在游戏内等待下载。
- **智能游戏识别**：自动生成 `info.json` 并更新 `mod-status.json`，进游戏直接启用。
- **预设批量恢复**：游戏更新导致模组全禁用？一键恢复你之前保存的模组配置。
- **原生多语言**：自带中英双语，支持极速扩展新语言。
- **安全防呆**：只读保护，修改前自动备份，绝不损坏你的原版游戏文件。

### 📥 安装方式
- **安装版**：下载 `AoE2 Mod Manager_0.1.0_x64-setup.exe` 并运行。
- **免安装版**：下载 `AoE2ModManager-0.1.0-win-x64-portable.zip`，解压后直接运行 `aoe2-mod-manager.exe`。

*(注意：软件暂无数字签名，Windows 可能会弹出 SmartScreen 拦截，请点击“更多信息” -> “仍要运行”。)*

---
