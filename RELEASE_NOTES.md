# v0.3.5

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
