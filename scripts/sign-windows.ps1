param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [Parameter(Mandatory = $true)][string]$CertificateBase64,
  [Parameter(Mandatory = $true)][string]$CertificatePassword
)

$ErrorActionPreference = 'Stop'
$certificatePath = Join-Path $env:RUNNER_TEMP 'ai-bot-signing.pfx'
[IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($CertificateBase64))
try {
  $signTool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $signTool) { throw 'signtool.exe não encontrado no runner' }
  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Arquivo para assinatura não encontrado: $file" }
    & $signTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $certificatePath /p $CertificatePassword $file
    if ($LASTEXITCODE -ne 0) { throw "Falha ao assinar $file" }
    & $signTool verify /pa /v $file
    if ($LASTEXITCODE -ne 0) { throw "Falha ao verificar $file" }
  }
} finally {
  Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
}
