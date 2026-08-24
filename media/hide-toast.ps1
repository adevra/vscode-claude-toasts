param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Group = ""
)

# Pull a toast out of the Action Center once it has been answered, so a stale
# Allow/Deny pair cannot sit there offering buttons that no longer do anything.

$ErrorActionPreference = "Stop"
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $history = [Windows.UI.Notifications.ToastNotificationManager]::History
  if ($Group) { $history.Remove($Tag, $Group, $AppId) } else { $history.Remove($Tag, "", $AppId) }
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
