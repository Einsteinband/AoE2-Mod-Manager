# v0.4.1

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
