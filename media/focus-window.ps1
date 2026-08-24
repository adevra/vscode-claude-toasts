param(
  [ValidateSet("auto", "list", "raise")][string]$Mode = "auto",
  [string]$TitleContains = "",
  [string]$Hwnd = "",
  [string]$ProcessName = "Code"
)

# Raise a specific VS Code window to the foreground.
#
# VS Code has no API for a window to raise itself, and when a toast is clicked
# Windows hands foreground rights to the newly spawned Code.exe (which merely
# forwards the vscode:// URI and exits), not to the already-running instance.
# So the window handles the URI but stays behind; we do the raise explicitly.
#
# One Code.exe process owns every window, so the window cannot be identified by
# PID - only by title. When several windows match (two folders with the same
# name), this script reports the candidates and the extension disambiguates by
# raising them one at a time and checking which one made itself focused.
#
# Modes:
#   auto  - match on title; raise only if exactly one candidate, else list them
#   list  - report candidates, raise nothing
#   raise - raise the given -Hwnd

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CtWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);

  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
"@

function Raise-Window([IntPtr]$h) {
  if ([CtWin]::IsIconic($h)) { [void][CtWin]::ShowWindow($h, 9) }  # SW_RESTORE
  [void][CtWin]::SwitchToThisWindow($h, $true)
  if ([CtWin]::GetForegroundWindow() -ne $h) {
    [void][CtWin]::BringWindowToTop($h)
    [void][CtWin]::SetForegroundWindow($h)
  }
  if ([CtWin]::GetForegroundWindow() -ne $h) {
    $fg = [CtWin]::GetForegroundWindow()
    $fgPid = [uint32]0
    $fgThread = [CtWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $me = [CtWin]::GetCurrentThreadId()
    if ([CtWin]::AttachThreadInput($me, $fgThread, $true)) {
      [void][CtWin]::BringWindowToTop($h)
      [void][CtWin]::SetForegroundWindow($h)
      [void][CtWin]::AttachThreadInput($me, $fgThread, $false)
    }
  }
  return ([CtWin]::GetForegroundWindow() -eq $h)
}

if ($Mode -eq "raise") {
  if (-not $Hwnd) { Write-Output "error=no-hwnd"; exit 2 }
  $h = [IntPtr][int64]$Hwnd
  $ok = Raise-Window $h
  Write-Output ("raised=" + $Hwnd)
  Write-Output ("foreground=" + $ok)
  if ($ok) { exit 0 } else { exit 1 }
}

$pids = @{}
Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $pids[[uint32]$_.Id] = $true }
if ($pids.Count -eq 0) { Write-Output "error=no-process"; exit 2 }

$script:matches = New-Object System.Collections.ArrayList
$callback = [CtWin+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [CtWin]::IsWindowVisible($hWnd)) { return $true }
  $wpid = [uint32]0
  [void][CtWin]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
  if (-not $pids.ContainsKey($wpid)) { return $true }
  $t = [CtWin]::Title($hWnd)
  if ([string]::IsNullOrEmpty($t)) { return $true }
  if ($TitleContains -eq "" -or $t -like "*$TitleContains*") {
    [void]$script:matches.Add([pscustomobject]@{ H = $hWnd; T = $t })
  }
  return $true
}
[void][CtWin]::EnumWindows($callback, [IntPtr]::Zero)

Write-Output ("count=" + $script:matches.Count)
foreach ($m in $script:matches) {
  Write-Output ("hwnd=" + [int64]$m.H + "|title=" + $m.T)
}
if ($script:matches.Count -eq 0) { exit 3 }

if ($Mode -eq "auto" -and $script:matches.Count -eq 1) {
  $ok = Raise-Window ($script:matches[0].H)
  Write-Output ("raised=" + [int64]$script:matches[0].H)
  Write-Output ("foreground=" + $ok)
  if ($ok) { exit 0 } else { exit 1 }
}

# Ambiguous (or list mode): caller decides.
exit 0
