param([Parameter(Mandatory = $true)][int]$StartPid, [int]$MaxDepth = 10)

# Walk the process ancestry from a Claude CLI PID up to the terminal host, and
# report each ancestor with its visible top-level window (0 when it has none).
# The extension uses this to bind a session to an exact VS Code terminal (an
# ancestor PID matching a terminal's shell PID) or, for sessions in standalone
# terminals, to the terminal window to raise on toast click.
#
# Output, one ancestor per line, child first:
#   anc=<pid>|<processName>|<hwnd>

$ErrorActionPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SwWin {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
}
"@

# pid -> (ppid, name), one CIM sweep
$table = @{}
Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object {
  $table["$($_.ProcessId)"] = @{ PPid = "$($_.ParentProcessId)"; Name = $_.Name }
}

# pid -> first visible top-level window
$windows = @{}
$cb = [SwWin+EnumWindowsProc]{
  param($h, $l)
  if (-not [SwWin]::IsWindowVisible($h)) { return $true }
  if ([SwWin]::GetWindow($h, 4) -ne [IntPtr]::Zero) { return $true }  # GW_OWNER: skip owned popups
  $wpid = [uint32]0
  [void][SwWin]::GetWindowThreadProcessId($h, [ref]$wpid)
  $key = "$wpid"
  if (-not $windows.ContainsKey($key)) { $windows[$key] = $h }
  return $true
}
[void][SwWin]::EnumWindows($cb, [IntPtr]::Zero)

$cur = "$StartPid"
$seen = @{}
for ($i = 0; $i -lt $MaxDepth; $i++) {
  if (-not $table.ContainsKey($cur) -or $seen.ContainsKey($cur)) { break }
  $seen[$cur] = $true
  $entry = $table[$cur]
  $hwnd = 0
  if ($windows.ContainsKey($cur)) { $hwnd = [int64]$windows[$cur] }
  Write-Output ("anc=" + $cur + "|" + $entry.Name + "|" + $hwnd)
  $next = $entry.PPid
  if ($next -eq "0" -or $next -eq $cur) { break }
  $cur = $next
}
