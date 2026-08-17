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

$arguments = @('--filter', '@orchestrator/bootstrapper', 'tauri', 'build')
if ($NoBundle) { $arguments += '--no-bundle' }

# Resolve o pnpm sem depender do PATH: binário direto ou via corepack (Node).
if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { $pnpmExe = 'pnpm.cmd' }
elseif (Get-Command pnpm -ErrorAction SilentlyContinue) { $pnpmExe = 'pnpm' }
elseif (Get-Command corepack -ErrorAction SilentlyContinue) { $pnpmExe = 'corepack'; $arguments = @('pnpm') + $arguments }
else { throw 'pnpm não encontrado. Instale o Node.js (que traz o corepack) ou o pnpm.' }

Push-Location $workspace
try {
  & $pnpmExe @arguments
  if ($LASTEXITCODE -ne 0) { throw "A compilação do bootstrapper falhou ($LASTEXITCODE)." }
} finally {
  Pop-Location
}
