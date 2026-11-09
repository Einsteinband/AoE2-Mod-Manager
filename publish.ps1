# publish.ps1
# 自动读取 package.json 的版本号，创建 GitHub Release 并上传本地安装包。
#
# 默认策略：本地 commit + 打 tag，并 git push origin main 与 tag，
# 然后用 gh release create 上传安装包资产。
# 如只发布安装包、不推送源码，显式加 -NoPushSource（此时本地仍 commit/tag 留档，
# 远端 tag 由 gh release create 用 --target main 在默认分支上兜底创建）。
#
# 文件范围规则（2026-11）：
#   暂存时用 pathspec 显式排除 AI 协作文档、个人开发环境配置、临时文件和本地交接目录。
#   推送前做两道校验：
#     1. 暂存区必须在开始时为空（避免混入用户手动暂存的无关修改）；
#     2. 暂存完成后再次扫描，出现任何被排除的文件立即中止，不 commit 不 push。

# 注意：用 Continue + 显式 $LASTEXITCODE 校验，避免 git 的 "LF will be replaced by CRLF"
# 之类 stderr 警告在 PS 5.1 下被当成终止性异常，导致脚本实际成功却返回 exit 1。
param(
  [switch]$NoPushSource
)

$ErrorActionPreference = "Continue"

$version = (Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tag = "v$version"
$targetBranch = "main"

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

# ---- 1. Git 提交并打标签 ----
# 排除策略：
#   第 1 层：.gitignore 挡住 AGENTS.md / DEVELOPMENT.md / PROJECT_STRUCTURE.md /
#            errors.txt / docs/v0.3-summary.md / docs/ddd/* / docs/handoff/*。
#   第 2 层：git add pathspec 额外排除 docs/ddd/ 与 docs/handoff/ 两个目录，
#            即使 .gitignore 被误改也不会把交接文档推送出去。
#            （不在 pathspec 里列具体文件名，否则 git 会因 "文件已被 .gitignore 忽略"
#             而输出 hint 并返回非 0，导致误判为失败。）
#   第 3 层：add 完成后扫描暂存区文件名，命中任何排除项立即中止。
$excludePathspecs = @(
  ':(exclude)AGENTS.md',
  ':(exclude)docs/v0.3-summary.md',
  ':(exclude)docs/ddd/',
  ':(exclude)docs/handoff/'
)
# 校验用的正则：覆盖所有不允许推送的文件/目录。
$excludePatterns = @(
  '^AGENTS\.md$',
  '^DEVELOPMENT\.md$',
  '^PROJECT_STRUCTURE\.md$',
  '^errors\.txt$',
  '^docs/v0\.3-summary\.md$',
  '^docs/ddd/',
  '^docs/handoff/'
)

# 1a. 发布前校验：开始时暂存区必须为空。
$stagedBefore = git diff --cached --name-only
if ($stagedBefore) {
  Write-Host "发布中止：暂存区已有未提交内容，疑似混入手动暂存的无关修改：" -ForegroundColor Red
  $stagedBefore | ForEach-Object { Write-Host "  $_" }
  Write-Host "请先 commit 或 git reset 清空暂存区后再执行发布。" -ForegroundColor Red
  exit 1
}

Write-Host "正在本地提交代码并打标签..." -ForegroundColor Yellow
git add . @excludePathspecs
if ($LASTEXITCODE -ne 0) { throw "git add 失败 (exit $LASTEXITCODE)" }

# 1b. 二次校验：扫描暂存区，出现被排除的文件立即中止。
$stagedAfter = git diff --cached --name-only
$badFiles = @()
foreach ($f in $stagedAfter) {
  foreach ($pat in $excludePatterns) {
    if ($f -match $pat) { $badFiles += $f; break }
  }
}
if ($badFiles) {
  Write-Host "发布中止：暂存区检测到不应推送的文件：" -ForegroundColor Red
  $badFiles | ForEach-Object { Write-Host "  $_" }
  Write-Host "未执行 commit/push。请用 git reset HEAD <file> 取消暂存后重试。" -ForegroundColor Red
  exit 1
}

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

if ($NoPushSource) {
  Write-Host "已指定 -NoPushSource：跳过源码推送。" -ForegroundColor DarkGray
} else {
  Write-Host "正在推送源码（默认行为）..." -ForegroundColor Yellow
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push main 失败 (exit $LASTEXITCODE)" }
  git push origin $tag
  if ($LASTEXITCODE -ne 0) { throw "git push tag 失败 (exit $LASTEXITCODE)" }
}

# ---- 2. 用 gh cli 上传安装包 ----
# tag 已在上一步推送；--target 作为兜底：远端已存在同名 tag 时会被忽略，不会报错。
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
  --target $targetBranch `
  --title "$tag" `
  @notesArgs
if ($LASTEXITCODE -ne 0) { throw "gh release create 失败 (exit $LASTEXITCODE)" }

Write-Host "发布完成！" -ForegroundColor Green
