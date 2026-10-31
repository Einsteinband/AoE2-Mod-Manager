# v0.3.4

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
