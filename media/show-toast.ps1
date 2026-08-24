param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$XmlBase64,
  [string]$Tag = "",
  [string]$Group = ""
)

$ErrorActionPreference = "Stop"

try {
  $xml = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($XmlBase64))

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml($xml)

  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  if ($Tag) { $toast.Tag = $Tag }
  if ($Group) { $toast.Group = $Group }

  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
