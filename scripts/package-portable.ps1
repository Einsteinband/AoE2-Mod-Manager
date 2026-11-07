#requires -Version 5.1
<#
  生成“免安装版”zip：
    src-tauri\target\release\aoe2-mod-manager.exe
    src-tauri\target\release\WebView2Loader.dll
    README.txt
  打成一个可直接解压运行的压缩包（dist-portable\AoE2ModManager-<version>-win-x64-portable.zip）。

  用法：
    npm run portable                                 # 先构建再打包
    npm run portable -- -NoBuild                     # 只用现有 release 产物打包
    npm run portable -- -OutDir D:\release           # 自定义输出目录
#>
param(
  [switch]$NoBuild,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

# ---- 1. 版本号唯一来源：tauri.conf.json ----
$confPath = Join-Path $root "src-tauri\tauri.conf.json"
$conf = Get-Content -LiteralPath $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $conf.version
$product = $conf.productName

# ---- 2. 构建（默认执行，与发布命令完全一致；-NoBuild 复用已有产物）----
if (-not $NoBuild) {
  Write-Host "==> npm run tauri build" -ForegroundColor Cyan
  & npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（exit $LASTEXITCODE）" }
}

# ---- 3. 收集文件（exe 与 WebView2Loader.dll 必须同目录）----
$release = Join-Path $root "src-tauri\target\release"
$exe = Join-Path $release "aoe2-mod-manager.exe"
if (-not (Test-Path -LiteralPath $exe)) {
  throw "找不到 $exe，请先运行 npm run tauri build"
}
$loader = Join-Path $release "WebView2Loader.dll"
if (-not (Test-Path -LiteralPath $loader)) {
  throw "找不到 WebView2Loader.dll（build.rs 应已复制到 release 目录）"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $root "dist-portable" }
$stageName = "$product $version"
$stage = Join-Path $OutDir $stageName
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item -LiteralPath $exe -Destination $stage
Copy-Item -LiteralPath $loader -Destination $stage

$readme = @"
$product $version - Portable / 免安装版

EN
  1. Extract this folder anywhere (D:\Games\..., USB drive, ...).
  2. Run aoe2-mod-manager.exe.
  3. On first launch the app scans the registry and your Steam libraries for
     Age of Empires II: Definitive Edition, then asks you to confirm the mod folder.

  - Keep WebView2Loader.dll next to the exe.
  - Settings, presets and login cache live in %APPDATA%\com.aoe2.modmanager.
  - Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11;
    otherwise install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703).

中文
  1. 解压到任意目录（例如 D:\Games\... 或 U 盘）。
  2. 运行 aoe2-mod-manager.exe。
  3. 首次启动会自动探测游戏安装目录，确认一次即可。

  - WebView2Loader.dll 必须与 exe 放在同一目录，不要单独移动。
  - 配置、预设与登录缓存保存在 %APPDATA%\com.aoe2.modmanager。
  - 需要 Microsoft Edge WebView2 运行时（Win10/11 一般已自带）。
"@
Set-Content -LiteralPath (Join-Path $stage "README.txt") -Value $readme -Encoding UTF8

# ---- 4. 压缩 ----
$zip = Join-Path $OutDir ("AoE2ModManager-{0}-win-x64-portable.zip" -f $version)
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Host ""
Write-Host "==> 免安装包已生成" -ForegroundColor Green
Write-Host "    $zip  ($sizeMb MB)"
Write-Host "    解压后运行：$stageName\aoe2-mod-manager.exe"
