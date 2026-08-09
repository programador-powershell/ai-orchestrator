# AI Orchestrator

Plataforma multiagente com cliente desktop, gateway próprio e runtime local opcional.

## Para usuários

Baixe **`AI-Orchestrator-Setup.exe`** na página Releases, abra e aguarde. O instalador
baixa, valida, instala somente para o seu usuário e abre o aplicativo. Não execute os
arquivos `.bat`/`.ps1`: eles são ferramentas internas e não são necessários para usar
o produto. Node, pnpm, Rust, MSVC, Ollama e modelos locais não são pré-requisitos.

## Estrutura

- `apps/desktop`: cliente Tauri/React distribuído ao usuário.
- `apps/bootstrapper`: instalador gráfico pequeno que baixa e valida o NSIS do cliente.
- `packages/contracts`: contratos públicos compartilhados pelo cliente e gateway.
- `services/gateway`: API Rust/Axum, PostgreSQL e Redis.
- `scripts`: geração e assinatura de manifestos de release.

## Desenvolvimento

```powershell
pnpm.cmd install
pnpm.cmd check
pnpm.cmd dev:desktop
```

Para o gateway, copie `services/gateway/.env.example` para `.env`, inicie PostgreSQL e
Redis e execute `cargo run --manifest-path services/gateway/Cargo.toml`.

## Distribuição

Para validar tudo localmente antes da primeira publicação:

```powershell
pnpm.cmd build:installer:local
```

O comando gera `artifacts/local/AI-Orchestrator-Setup-Local.exe`. Esse Setup contém o
NSIS do desktop incorporado e não acessa GitHub. O canal publicado continua usando o
bootstrapper pequeno com download HTTPS retomável.

O endereço do manifesto remoto é compilado pelo workflow a partir de
`github.repository` e `RELEASE_BASE_URL`; não existe `owner/repo` fixo no código. O
Setup publicado consulta `installer-manifest.json` e valida Ed25519, SHA-256 e
Authenticode antes de executar o NSIS do cliente.

No modo `currentUser`, o NSIS instala sem UAC em `%LOCALAPPDATA%\AI Orchestrator`,
seguindo o destino padrão do Tauri para instalações por usuário.

Uma tag `vX.Y.Z` aciona `.github/workflows/release.yml`. Releases estáveis exigem
assinatura Authenticode e chaves de assinatura Tauri/Ed25519. Builds beta podem ser
gerados sem Authenticode, mas são marcados como pré-release.

Veja `docs/RELEASE.md` para configurar o primeiro release.

O executável dentro de `target` é apenas um artefato de desenvolvimento. O Setup que
deve ser entregue ao usuário é produzido pelo workflow depois que o repositório e as
chaves de assinatura forem configurados. A compilação release recusa URLs placeholder.
