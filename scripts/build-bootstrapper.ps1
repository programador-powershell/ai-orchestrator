param(
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ManifestUrl,
  [Parameter(Mandatory = $true)][string]$ManifestPublicKey,
  [switch]$NoBundle
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$env:RELEASE_MANIFEST_URL = $ManifestUrl
$env:INSTALLER_MANIFEST_PUBLIC_KEY = $ManifestPublicKey

if ($ManifestUrl.Contains('__')) {
  throw 'ManifestUrl ainda contém um placeholder.'
}
if ($ManifestPublicKey.Contains('__') -or $ManifestPublicKey.Trim().Length -lt 43) {
  throw 'ManifestPublicKey não parece ser uma chave Ed25519 em Base64.'
}

$arguments = @('--filter', '@ai-orchestrator/bootstrapper', 'tauri', 'build')
if ($NoBundle) { $arguments += '--no-bundle' }

Push-Location $workspace
try {
  & pnpm.cmd @arguments
  if ($LASTEXITCODE -ne 0) { throw "A compilação do bootstrapper falhou ($LASTEXITCODE)." }
} finally {
  Pop-Location
}
