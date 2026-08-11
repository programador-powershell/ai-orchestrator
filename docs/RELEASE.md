# Publicação do AI Orchestrator

O workflow `.github/workflows/release.yml` não contém `owner/repo` fixo. Ele usa
`GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER` e, opcionalmente, as variáveis abaixo.

O bootstrapper não possui URL reserva ou repositório fictício. Builds `release` locais
falham imediatamente se `RELEASE_MANIFEST_URL` e `INSTALLER_MANIFEST_PUBLIC_KEY` não
forem fornecidos. Para uma compilação manual, use:

```powershell
.\scripts\build-bootstrapper.ps1 `
  -ManifestUrl 'https://github.com/owner/repo/releases/download/v1.2.3/installer-manifest.json' `
  -ManifestPublicKey '<ED25519_PUBLIC_KEY_BASE64>' `
  -NoBundle
```

## Variáveis do repositório

- `RELEASE_BASE_URL`: raiz alternativa de distribuição. Se ausente, usa GitHub Releases.
- `RUNTIME_REPOSITORY`: fork fixado do llama.cpp. Se ausente, o job do runtime é ignorado.
- `RUNTIME_REF`: commit ou tag imutável do fork do runtime.

## Secrets

- `INSTALLER_MANIFEST_PRIVATE_KEY`: chave privada Ed25519 em PEM ou PEM codificado em Base64.
- `INSTALLER_MANIFEST_PUBLIC_KEY`: 32 bytes públicos Ed25519 codificados em Base64.
- `WINDOWS_PUBLISHER`: nome esperado do publicador.
- `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PUBLIC_KEY` para o updater.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, se a chave possuir senha.
- `WINDOWS_CERTIFICATE_BASE64`: certificado Authenticode PFX codificado em Base64.
- `WINDOWS_CERTIFICATE_PASSWORD`.
- `RUNTIME_REPOSITORY_TOKEN`, somente se o fork do runtime for privado.

Releases estáveis (`v1.2.3`) falham sem Authenticode e assinatura do updater.
Pré-releases (`v1.2.3-beta.1`) podem omitir o PFX e as chaves do updater, mas o
manifesto do bootstrapper continua obrigatoriamente assinado com Ed25519. Quando as
chaves Tauri não estão configuradas, a beta não publica `latest.json`.

O runtime e modelos locais não são baixados pela instalação inicial. O job do runtime
só é executado quando `RUNTIME_REPOSITORY` estiver configurado.

## Publicar

Crie e envie uma tag `vX.Y.Z` ou `vX.Y.Z-beta.N`. O CI valida TypeScript e Rust,
produz o NSIS por usuário, compila o bootstrapper remoto com no máximo 15 MiB, cria
`installer-manifest.json` e publica os assets no GitHub Release. O único arquivo
apresentado ao usuário como instalação inicial deve ser `AI-Orchestrator-Setup.exe`.

O gateway é implantado separadamente. No OpenShip, importe `services/gateway` como a
raiz do projeto, configure os secrets do ambiente e associe PostgreSQL, Redis e um
domínio TLS antes de promover staging para produção.
