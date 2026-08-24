param(
  [ValidateSet("auto", "list", "raise")][string]$Mode = "auto",
  [string]$TitleContains = "",
  [string]$Hwnd = "",
  [string]$ProcessName = "Code",
  # Testing aid: skip the earlier rungs so the fallbacks can be exercised
  # directly. Production always starts at 1.
  [int]$StartAt = 1
)

# Raise a specific VS Code window to the foreground.
#
# VS Code has no API for a window to raise itself, and when a toast is clicked
# Windows hands foreground rights to the Code.exe the shell spawned to forward the
# vscode:// URI - which exits immediately. So the window handles the URI but stays
# behind, and we raise it explicitly.
#
# The catch is Windows foreground lock: a background process may not call
# SetForegroundWindow. There is no single workaround that always works, so we walk
# a ladder from politest to most forceful and report which rung succeeded.
# Deliberately excluded: temporarily zeroing SPI_SETFOREGROUNDLOCKTIMEOUT. It
# mutates a system-wide setting, and its pvParam is the value itself rather than
# a pointer - easy to corrupt, and not worth it for a notification.
# (strategy=...) so the extension log shows what this machine actually honors.
#
# One Code.exe process owns every window, so windows are identified by title, not
# PID. When several match, the extension disambiguates by raising each and asking
# VS Code which one took focus.

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
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
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

$SW_RESTORE  = 9
$SW_MINIMIZE = 6
$SW_SHOW     = 5
$HWND_TOPMOST   = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_SHOWWINDOW = 0x0040
$VK_MENU = 0x12
$KEYEVENTF_KEYUP = 0x0002

function Test-Foreground([IntPtr]$h) { return ([CtWin]::GetForegroundWindow() -eq $h) }

function Raise-Window([IntPtr]$h) {
  if ([CtWin]::IsIconic($h)) { [void][CtWin]::ShowWindow($h, $SW_RESTORE) }
  else { [void][CtWin]::ShowWindow($h, $SW_SHOW) }

  # 1. The polite call. Works when we happen to hold foreground rights.
  if ($StartAt -le 1) {
    [void][CtWin]::SetForegroundWindow($h)
    if (Test-Foreground $h) { return "setforeground" }
  }

  # 2. Shell's own switcher; often bypasses the lock.
  if ($StartAt -le 2) {
    [void][CtWin]::SwitchToThisWindow($h, $true)
    if (Test-Foreground $h) { return "switchtothiswindow" }
  }

  # 3. Borrow the foreground thread's input queue, then activate.
  if ($StartAt -le 3) {
  $fg = [CtWin]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    $fgPid = [uint32]0
    $fgThread = [CtWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $me = [CtWin]::GetCurrentThreadId()
    if ($fgThread -ne 0 -and $fgThread -ne $me -and [CtWin]::AttachThreadInput($me, $fgThread, $true)) {
      [void][CtWin]::AllowSetForegroundWindow(-1)
      [void][CtWin]::BringWindowToTop($h)
      [void][CtWin]::SetForegroundWindow($h)
      [void][CtWin]::SetActiveWindow($h)
      [void][CtWin]::SetFocus($h)
      [void][CtWin]::AttachThreadInput($me, $fgThread, $false)
      if (Test-Foreground $h) { return "attachthreadinput" }
    }
  }
  }

  # 4. Synthetic ALT tap. Any input event resets the foreground lock, which is the
  #    long-standing workaround for exactly this restriction.
  if ($StartAt -le 4) {
    [CtWin]::keybd_event([byte]$VK_MENU, 0, 0, [UIntPtr]::Zero)
    [CtWin]::keybd_event([byte]$VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    [void][CtWin]::SetForegroundWindow($h)
    if (Test-Foreground $h) { return "altkey" }
  }

  # 5. Topmost flicker: at least lift it above everything visually.
  if ($StartAt -le 5) {
  [void][CtWin]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][CtWin]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  if (Test-Foreground $h) { return "topmost" }
  }

  # 6. Last resort: a restore from minimized always activates.
  [void][CtWin]::ShowWindow($h, $SW_MINIMIZE)
  [void][CtWin]::ShowWindow($h, $SW_RESTORE)
  if (Test-Foreground $h) { return "minimizerestore" }

  return ""
}

if ($Mode -eq "raise") {
  if (-not $Hwnd) { Write-Output "error=no-hwnd"; exit 2 }
  $h = [IntPtr][int64]$Hwnd
  $strategy = Raise-Window $h
  Write-Output ("raised=" + $Hwnd)
  Write-Output ("strategy=" + $strategy)
  Write-Output ("foreground=" + [bool]$strategy)
  if ($strategy) { exit 0 } else { exit 1 }
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
  $strategy = Raise-Window ($script:matches[0].H)
  Write-Output ("raised=" + [int64]$script:matches[0].H)
  Write-Output ("strategy=" + $strategy)
  Write-Output ("foreground=" + [bool]$strategy)
  if ($strategy) { exit 0 } else { exit 1 }
}

exit 0
