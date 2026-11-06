# v0.4.5

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