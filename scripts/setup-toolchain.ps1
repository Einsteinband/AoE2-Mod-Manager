# 一次性修复 Windows GNU 工具链与 Tauri manifest 冲突
# 作用：把 MinGW-W64 自带的 default-manifest.o（极简 manifest）替换成不含 .rsrc 的空对象，
#       使 tauri-build 的 manifest（含 Microsoft.Windows.Common-Controls v6 依赖）成为唯一一份。
# 不修复的症状：exe 启动即 STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)，comctl32.dll!TaskDialogIndirect 缺失。
$ErrorActionPreference = "Stop"

$mingwLib = "F:\mingw\mingw64\x86_64-w64-mingw32\lib"
$target = Join-Path $mingwLib "default-manifest.o"
$backup = Join-Path $mingwLib "default-manifest.o.backup"
$replacement = Join-Path $PSScriptRoot "..\src-tauri\link\default-manifest.o"

if (-not (Test-Path $target)) { throw "找不到 $target，请先安装 MinGW-w64（WinLibs）" }
if (-not (Test-Path $replacement)) { throw "找不到 $replacement" }

$current = (Get-Item $target).Length
if ($current -eq (Get-Item $replacement).Length) {
    "已是最新，无需修复（$target）"
    return
}

if (-not (Test-Path $backup)) {
    Copy-Item $target $backup -Force
    "已备份原始 manifest 对象 -> $backup"
}
Copy-Item $replacement $target -Force
"已替换 $target （$current -> $((Get-Item $target).Length) 字节）"
"如需还原：Copy-Item '$backup' '$target' -Force"
