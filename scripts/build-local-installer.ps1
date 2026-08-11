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

# Resolve o pnpm sem depender do PATH da máquina: binário direto quando
# existir, senão via corepack (vem com o Node.js — cenário padrão aqui).
$pnpmExe = $null
$pnpmPrefix = @()
if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { $pnpmExe = 'pnpm.cmd' }
elseif (Get-Command pnpm -ErrorAction SilentlyContinue) { $pnpmExe = 'pnpm' }
elseif (Get-Command corepack -ErrorAction SilentlyContinue) { $pnpmExe = 'corepack'; $pnpmPrefix = @('pnpm') }
else { throw 'pnpm não encontrado. Instale o Node.js (que traz o corepack) ou o pnpm.' }

function Invoke-Pnpm {
  & $pnpmExe @($pnpmPrefix + $args)
}

Push-Location $workspace
try {
  if (-not $FinalizeOnly) {
    Write-Host '[1/4] Validando contratos e interfaces...'
    Invoke-Pnpm check
    if ($LASTEXITCODE -ne 0) { throw 'A validação TypeScript falhou.' }

    Write-Host '[2/4] Gerando o NSIS local do cliente...'
    Invoke-Pnpm --filter '@ai-orchestrator/desktop' tauri build --config src-tauri/tauri.local.conf.json --bundles nsis
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
    Invoke-Pnpm --filter '@ai-orchestrator/bootstrapper' tauri build --no-bundle
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
      # Destino em uso (uma janela do Setup antigo aberta trava a cópia).
      # O NTFS permite RENOMEAR um exe em execução: tira o travado do
      # caminho e libera o nome para a versão nova.
      try {
        Move-Item -LiteralPath $setup -Destination ("$setup.{0:HHmmss}.old" -f (Get-Date)) -ErrorAction Stop
      } catch {
        if ($attempt -eq 20) { throw }
        Start-Sleep -Milliseconds 500
      }
    }
  }
  if (-not $copied) { throw 'Não foi possível atualizar o Setup local.' }
  # Limpeza best-effort dos renomeados (sai quando o Setup antigo fechar).
  Get-ChildItem -LiteralPath $output -Filter '*.old' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
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
