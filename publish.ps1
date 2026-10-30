# publish.ps1
# 自动读取 package.json 的版本号，打 Tag、推送，并上传本地安装包到 GitHub Release。

# 注意：用 Continue + 显式 $LASTEXITCODE 校验，避免 git 的 "LF will be replaced by CRLF"
# 之类 stderr 警告在 PS 5.1 下被当成终止性异常，导致脚本实际成功却返回 exit 1。
$ErrorActionPreference = "Continue"

$version = (Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tag = "v$version"

Write-Host "准备发布版本: $tag" -ForegroundColor Cyan

# ---- 0. 定位 gh cli（PATH 里没有时用默认安装路径兜底）----
$gh = $null
$cmd = Get-Command gh -ErrorAction SilentlyContinue
if ($cmd) {
  $gh = $cmd.Source
} elseif (Test-Path "C:\Program Files\GitHub CLI\gh.exe") {
  $gh = "C:\Program Files\GitHub CLI\gh.exe"
}
if (-not $gh) { throw "找不到 gh cli，请安装 GitHub CLI 或把 gh.exe 加入 PATH。" }
Write-Host "使用 gh: $gh" -ForegroundColor DarkGray

# ---- 1. Git 提交与打标签 ----
Write-Host "正在提交代码并打标签..." -ForegroundColor Yellow
git add .
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m "chore: release $tag"
  if ($LASTEXITCODE -ne 0) { throw "git commit 失败 (exit $LASTEXITCODE)" }
} else {
  Write-Host "没有需要提交的改动，跳过 commit。" -ForegroundColor DarkGray
}

$existingTag = git tag --list $tag
if ([string]::IsNullOrWhiteSpace($existingTag)) {
  git tag $tag
  if ($LASTEXITCODE -ne 0) { throw "git tag 失败 (exit $LASTEXITCODE)" }
} else {
  Write-Host "标签 $tag 已存在，跳过 tag。" -ForegroundColor DarkGray
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push main 失败 (exit $LASTEXITCODE)" }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "git push tag 失败 (exit $LASTEXITCODE)" }

# ---- 2. 用 gh cli 上传安装包 ----
$nsisPath = "src-tauri\target\release\bundle\nsis\AoE2 Mod Manager_${version}_x64-setup.exe"
$portablePath = "dist-portable\AoE2ModManager-${version}-win-x64-portable.zip"

foreach ($f in @($nsisPath, $portablePath)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "发布资产不存在: $f" }
}

$notesFile = "RELEASE_NOTES.md"
if (Test-Path -LiteralPath $notesFile) {
  $notesArgs = @("--notes-file", $notesFile)
} else {
  $notesArgs = @("--notes", "Release $tag. Please download the assets below.")
}

Write-Host "正在创建 GitHub Release 并上传安装文件..." -ForegroundColor Yellow
& $gh release create $tag `
  $nsisPath `
  $portablePath `
  --title "$tag" `
  @notesArgs
if ($LASTEXITCODE -ne 0) { throw "gh release create 失败 (exit $LASTEXITCODE)" }

Write-Host "发布完成！" -ForegroundColor Green
