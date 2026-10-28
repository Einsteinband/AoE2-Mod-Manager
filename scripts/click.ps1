param(
  [string]$ProcessName = "aoe2-mod-manager",
  [int]$OffsetX = 0,
  [int]$OffsetY = 0,
  [string]$OutFile = "F:\tmp\shot-click.png"
)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name Click -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@

$proc = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $proc.MainWindowHandle
[Win32.Click]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$rect = New-Object Win32.Click+RECT
[Win32.Click]::GetWindowRect($h, [ref]$rect) | Out-Null

$x = $rect.Left + $OffsetX
$y = $rect.Top + $OffsetY
[Win32.Click]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[Win32.Click]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 60
[Win32.Click]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 1200
"clicked at ($x,$y) window=($($rect.Left),$($rect.Top))"
