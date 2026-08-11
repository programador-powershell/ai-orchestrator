param(
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][string]$ReleaseBaseUrl,
  [string]$UpdaterPublicKey,
  [Parameter(Mandatory = $true)][string]$ManifestPublicKey
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktopConfig = Join-Path $workspace 'apps\desktop\src-tauri\tauri.conf.json'
$desktop = Get-Content -LiteralPath $desktopConfig -Raw
$desktop = $desktop.Replace('__GITHUB_REPOSITORY__', $Repository)
if (-not [string]::IsNullOrWhiteSpace($UpdaterPublicKey)) {
  $desktop = $desktop.Replace('__TAURI_UPDATER_PUBLIC_KEY__', $UpdaterPublicKey)
}
Set-Content -LiteralPath $desktopConfig -Value $desktop -Encoding utf8NoBOM

$env:RELEASE_MANIFEST_URL = "$($ReleaseBaseUrl.TrimEnd('/'))/installer-manifest.json"
$env:INSTALLER_MANIFEST_PUBLIC_KEY = $ManifestPublicKey
if ($env:GITHUB_ENV) {
  "RELEASE_MANIFEST_URL=$env:RELEASE_MANIFEST_URL" | Add-Content -LiteralPath $env:GITHUB_ENV
  "INSTALLER_MANIFEST_PUBLIC_KEY=$ManifestPublicKey" | Add-Content -LiteralPath $env:GITHUB_ENV
}

Write-Host "Release configurado para $Repository"
Write-Host "RELEASE_MANIFEST_URL=$env:RELEASE_MANIFEST_URL"
