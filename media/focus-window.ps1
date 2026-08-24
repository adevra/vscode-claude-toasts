param(
  [Parameter(Mandatory = $true)][string]$TitleContains,
  [string]$ProcessName = "Code"
)

# Raise a specific VS Code window to the foreground.
#
# VS Code has no API for a window to raise itself, and when a toast is clicked
# Windows hands foreground rights to the newly spawned Code.exe (which merely
# forwards the vscode:// URI and exits), not to the already-running instance.
# So the window handles the URI but stays behind. We do the raise explicitly.

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

# Collect PIDs belonging to the target process so we only consider its windows.
$pids = @{}
Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $pids[[uint32]$_.Id] = $true }
if ($pids.Count -eq 0) { Write-Output "no-process"; exit 2 }

$found = [IntPtr]::Zero
$foundTitle = ""

$callback = [CtWin+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [CtWin]::IsWindowVisible($hWnd)) { return $true }
  $wpid = [uint32]0
  [void][CtWin]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
  if (-not $pids.ContainsKey($wpid)) { return $true }
  $t = [CtWin]::Title($hWnd)
  if ([string]::IsNullOrEmpty($t)) { return $true }
  if ($t -like "*$TitleContains*") {
    $script:found = $hWnd
    $script:foundTitle = $t
    return $false   # stop enumerating
  }
  return $true
}
[void][CtWin]::EnumWindows($callback, [IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) { Write-Output "no-window"; exit 3 }

# Restore if minimized, then try progressively more forceful raises. Foreground
# lock means SetForegroundWindow alone often silently fails from a background
# process; SwitchToThisWindow and the AttachThreadInput dance work around it.
if ([CtWin]::IsIconic($found)) { [void][CtWin]::ShowWindow($found, 9) }  # SW_RESTORE

[void][CtWin]::SwitchToThisWindow($found, $true)
if ([CtWin]::GetForegroundWindow() -ne $found) {
  [void][CtWin]::BringWindowToTop($found)
  [void][CtWin]::SetForegroundWindow($found)
}
if ([CtWin]::GetForegroundWindow() -ne $found) {
  $fg = [CtWin]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [CtWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $me = [CtWin]::GetCurrentThreadId()
  if ([CtWin]::AttachThreadInput($me, $fgThread, $true)) {
    [void][CtWin]::BringWindowToTop($found)
    [void][CtWin]::SetForegroundWindow($found)
    [void][CtWin]::AttachThreadInput($me, $fgThread, $false)
  }
}

$ok = [CtWin]::GetForegroundWindow() -eq $found
Write-Output ("target=" + $foundTitle)
Write-Output ("foreground=" + $ok)
if ($ok) { exit 0 } else { exit 1 }
