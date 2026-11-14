# v0.5.2

## v0.5.2 - What's New

- **🌍Languages:** Added German (Deutsch) and Russian (Русский) — the UI now ships in five languages.
- **📏Online Size Sorting:** Online mods can be sorted by file size. Sizes come from cached mod info, so a mod shows no size until its info has been cached. The feature is off by default — enable it in *Settings → General*.
- **🎨Interface:** Detail-panel layout, settings interactions and status-bar colors polished; the load priority is shown in the mod detail again.

## v0.5.2 - 更新内容

- **🌍多语言：** 新增德语（Deutsch）与俄语（Русский），界面共支持五种语言。
- **📏在线按大小排序：** 在线模组可按文件大小排序。体积取自已缓存的模组信息，未缓存的模组在该信息缓存前没有体积、暂不参与排序。功能默认关闭，需在「设置 → 通用」中手动开启。
- **🎨界面优化：** 优化详情面板布局、设置页交互与状态栏配色，模组详情恢复显示「加载优先级」。

---

# v0.5.1

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

# v0.5.0

## v0.5.0 - 更新内容

### ✨ 新增
- 自动记忆主窗口上次关闭时的位置、尺寸和最大化状态，下次启动直接恢复，不再每次手动调整。
- 本地模组和在线模组侧边栏的分类分组支持独立折叠与展开，分组状态本地持久化，减少长列表的信息密度压力。
- 模组更新检测优化：最多 5 路并发请求，减少逐个检测等待时间；增加检测结果缓存，减少重复请求；左侧列表动态显示「待更新」数量及入口，没有待更新模组时自动隐藏。

### 🧪 实验性
- 第三方 ZIP 模组导入：新增实验性导入入口，仅供验证，暂不建议作为正式功能使用。

---

# v0.4.9

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

# v0.4.8
