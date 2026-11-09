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
