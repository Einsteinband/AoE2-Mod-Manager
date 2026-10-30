# 本地开发与发布避坑指南

## 环境依赖
- **GitHub CLI**: 安装在 `C:\Program Files\GitHub CLI\gh.exe`，未加入系统 PATH 环境变量。
- **发版命令**: 必须使用绝对路径 `& "C:\Program Files\GitHub CLI\gh.exe" release create ...`
- **网络代理**: 执行 git push 和 gh 之前，确保代理正常运行（如 `127.0.0.1:7897`），否则会失败。

## 自动发版脚本（publish.ps1）
1. **不要重复执行**：如果脚本中途失败，先检查 `git log` 和 `git tag`。
   - 如果 `git push` 成功但 tag 没推，单独执行 `git push origin vX.X.X`。
   - 如果 tag 存在但 Release 没建，直接单独执行 `gh release create ...`。
2. **文件上传**：gh 上传时会自动将文件名中的空格替换为点（如 `AoE2 Mod Manager` -> `AoE2.Mod.Manager`），这是正常现象。
