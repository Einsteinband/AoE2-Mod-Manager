# publish.ps1
# 自动读取 package.json 的版本号，打 Tag，推送，并上传本地包到 GitHub Release

$ErrorActionPreference = "Stop"
$version = (Get-Content package.json | ConvertFrom-Json).version
$tag = "v$version"

Write-Host "准备发布版本: $tag" -ForegroundColor Cyan

# 1. 自动修改版本号？这里假设你已经手动改了版本号并打包好了。
# 如果你想把改版本号和打包也自动化，可以在这里加。

# 2. Git 提交与打标签
Write-Host "正在提交代码并打标签..." -ForegroundColor Yellow
git add .
git commit -m "chore: release $tag"
git tag $tag
git push origin main
git push origin $tag

# 3. 调用 gh cli 上传本地包
$nsisPath = "src-tauri\target\release\bundle\nsis\AoE2 Mod Manager_${version}_x64-setup.exe"
$portablePath = "dist-portable\AoE2ModManager-${version}-win-x64-portable.zip"

Write-Host "正在创建 GitHub Release 并上传本地文件..." -ForegroundColor Yellow
gh release create $tag `
  $nsisPath `
  $portablePath `
  --title "$tag" `
  --notes "Release $tag. Please download the assets below."

Write-Host "发布完成！" -ForegroundColor Green