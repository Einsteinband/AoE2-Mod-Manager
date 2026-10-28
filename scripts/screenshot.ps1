param(
  [string]$ProcessName = "aoe2-mod-manager",
  [string]$OutFile = "F:\tmp\shot.png"
)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$proc = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "未找到带窗口的进程: $ProcessName" }
$h = $proc.MainWindowHandle

$HWND_TOPMOST = [IntPtr]::new(-1)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_SHOWWINDOW = 0x0040

[Win32.Native]::ShowWindow($h, 9) | Out-Null
[Win32.Native]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW) | Out-Null
[Win32.Native]::BringWindowToTop($h) | Out-Null

# 前台线程亲和，确保 SetForegroundWindow 生效
$fg = [Win32.Native]::GetForegroundWindow()
$fgPid = 0
$fgThread = [Win32.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$curThread = [Win32.Native]::GetCurrentThreadId()
[Win32.Native]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
[Win32.Native]::SetForegroundWindow($h) | Out-Null
[Win32.Native]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null

Start-Sleep -Milliseconds 1400

$rect = New-Object Win32.Native+RECT
[Win32.Native]::GetWindowRect($h, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
if ($w -le 0 -or $hh -le 0) { throw "窗口尺寸无效: ${w}x${hh}" }

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $OutFile (${w}x${hh})"
