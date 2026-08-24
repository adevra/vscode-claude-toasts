param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  # "name=#RRGGBB;name=#RRGGBB;..." - the palette lives in src/sessionMeta.ts and
  # is passed in so there is exactly one source of truth.
  [Parameter(Mandatory = $true)][string]$Spec
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($pair in $Spec.Split(";")) {
  if (-not $pair) { continue }
  $name, $hex = $pair.Split("=")
  if (-not $name -or -not $hex) { continue }
  $col = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $bmp = New-Object System.Drawing.Bitmap 728, 16
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.Clear($col)
  $bmp.Save((Join-Path $OutDir ("strip-" + $name + ".png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $gfx.Dispose(); $bmp.Dispose()
}
Write-Output "ok"
