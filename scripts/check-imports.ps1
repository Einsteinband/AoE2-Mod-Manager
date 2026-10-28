$od = "F:\mingw\mingw64\bin\objdump.exe"
$exe = $args[0]
$text = & $od -p $exe | Out-String

Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
[DllImport("kernel32", SetLastError=true, CharSet=CharSet.Ansi)]
public static extern IntPtr GetProcAddress(IntPtr module, string name);
'@

$current = $null
$missing = @()
$checked = 0
$script:modules = @{}
foreach ($line in ($text -split "`r?`n")) {
    if ($line -match 'DLL Name:\s*(\S+)') {
        $current = $matches[1]
        $h = [W.K]::LoadLibraryExW($current, [IntPtr]::Zero, 0x00001000)
        if ($h -eq [IntPtr]::Zero) {
            $missing += "DLL 无法加载: $current (err=$([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"
            $current = $null
        } else {
            $script:modules[$current] = $h
        }
        continue
    }
    if ($null -ne $current -and $line -match '^\s+[0-9a-f]+\s+<none>\s+[0-9a-f]+\s+(\S+)\s*$') {
        $fn = $matches[1]
        $checked++
        $addr = [W.K]::GetProcAddress($script:modules[$current], $fn)
        if ($addr -eq [IntPtr]::Zero) {
            $missing += "缺失导出: $current!$fn"
        }
    }
}
"检查导入函数数: $checked"
if ($missing.Count -eq 0) { "全部导入函数均可解析" } else { $missing | Select-Object -Unique }
