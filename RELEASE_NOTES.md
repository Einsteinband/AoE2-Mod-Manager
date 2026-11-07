# v0.4.8

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
