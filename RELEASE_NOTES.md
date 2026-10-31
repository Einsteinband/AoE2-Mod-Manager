# v0.4.0

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