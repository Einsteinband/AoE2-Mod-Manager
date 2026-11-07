# v0.4.7

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
