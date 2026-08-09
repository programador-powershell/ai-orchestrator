param(
  [string]$Version = '0.1.0',
  [string]$OutputDirectory = 'artifacts\local',
  [switch]$FinalizeOnly
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$output = Join-Path $workspace $OutputDirectory
$desktopTarget = Join-Path $workspace 'apps\desktop\src-tauri\target\release\bundle\nsis'
$bootstrapper = Join-Path $workspace 'apps\bootstrapper\src-tauri\target\release\ai-orchestrator-bootstrapper.exe'

Push-Location $workspace
try {
  if (-not $FinalizeOnly) {
    Write-Host '[1/4] Validando contratos e interfaces...'
    & pnpm.cmd check
    if ($LASTEXITCODE -ne 0) { throw 'A validação TypeScript falhou.' }

    Write-Host '[2/4] Gerando o NSIS local do cliente...'
    & pnpm.cmd --filter '@ai-orchestrator/desktop' tauri build --config src-tauri/tauri.local.conf.json --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'A geração do NSIS desktop falhou.' }
  }

  $desktopInstaller = Get-ChildItem -LiteralPath $desktopTarget -Filter '*setup.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $desktopInstaller) { throw "Nenhum NSIS foi encontrado em $desktopTarget" }

  if (-not $FinalizeOnly) {
    Write-Host '[3/4] Incorporando o cliente no Setup Liquid Glass...'
    $env:LOCAL_DESKTOP_INSTALLER = $desktopInstaller.FullName
    $env:LOCAL_DESKTOP_VERSION = $Version
    $env:RELEASE_MANIFEST_URL = $null
    $env:INSTALLER_MANIFEST_PUBLIC_KEY = $null
    & pnpm.cmd --filter '@ai-orchestrator/bootstrapper' tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'A geração do Setup local falhou.' }
  }
  if (-not (Test-Path -LiteralPath $bootstrapper)) { throw 'O executável do Setup local não foi produzido.' }

  Write-Host '[4/4] Validando e publicando o artefato local...'
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $setup = Join-Path $output 'AI-Orchestrator-Setup-Local.exe'
  $copied = $false
  foreach ($attempt in 1..20) {
    try {
      Copy-Item -LiteralPath $bootstrapper -Destination $setup -Force
      $copied = $true
      break
    } catch [System.IO.IOException] {
      if ($attempt -eq 20) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $copied) { throw 'Não foi possível atualizar o Setup local.' }
  $desktopHash = (Get-FileHash -LiteralPath $desktopInstaller.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $setupHash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata = [ordered]@{
    schemaVersion = 1
    channel = 'local'
    version = $Version
    createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    setup = [ordered]@{ file = (Split-Path $setup -Leaf); size = (Get-Item $setup).Length; sha256 = $setupHash }
    embeddedDesktop = [ordered]@{ file = $desktopInstaller.Name; size = $desktopInstaller.Length; sha256 = $desktopHash }
  }
  $metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'local-build.json') -Encoding UTF8

  Write-Host "Setup local pronto: $setup"
  Write-Host "SHA-256: $setupHash"
} finally {
  Pop-Location
}
