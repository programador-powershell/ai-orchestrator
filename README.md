<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell estilo Unsloth Studio**: navegação de modos na sidebar (pílulas, colapsável), topbar slim, Settings em modal (Ctrl+,).
- **9 abas** — Chat, Code, Design, Data, Work, Security, Agent, Game e **Tuning** — com comandos de barra (`/review`, `/explain`, `/testgen`) no composer.
- **Fine-Tuning 100% em nuvem**: harness no gateway (jobs persistidos, eventos SSE, catálogo, reconciliador) + aba Train (Configurar/Execução/Histórico, SFT/DPO, hiperparâmetros, custo estimado); nada instalado, nenhum código de terceiros embutido.
- **Memória persistente** independente de fornecedor (SQLite/IndexedDB), com import de histórico Claude/OpenAI.
- **Modelos fusion**: orquestrador+executor, merge e race entre modelos.
- **BYOK** (traga sua própria chave) armazenado no keyring do sistema operacional.
- **Editor ERD** na aba Data com export SQL (PostgreSQL, MySQL, ANSI, SQLite e MSSQL), migração up/down e export SVG.
- **Editor de vídeo** estilo OpenCut na aba Design.
- **Sandbox** estilo ai-jail na aba Security.
- **Import de plugins/skills** nas Configurações.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- Instalador `AI-Orchestrator-Setup.exe` com download HTTPS retomável e validação Ed25519, SHA-256 e Authenticode.
- **Clean-room**: referências externas (Unsloth Studio, drawdb, opencode, soup) documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :new: Releases Notes

### :up: V.4.2
### :warning: Latest Changes

- **Comandos de barra** no composer (`/review`, `/explain`, `/testgen`): prompts reutilizáveis expandidos antes do envio, com `$ARGS` e variáveis nomeadas.
- **Aba Data com paridade drawDB ampliada**: dialetos **SQLite** e **MSSQL** no export, relação **n-n** agora gera tabela de junção real (2 FKs + PK composta), FKs com **ON UPDATE/ON DELETE**, **migração down** (rollback `down.sql`) e **export do diagrama como SVG**.

### :pushpin: Fixes

- Correctness: relação n-n exportava só FK simples; agora materializa a tabela de junção. `downloadText` usa MIME correto para `.svg`.

### :construction_worker: Refactors

- Conversores/validação de dataset em `lib/tunelab`, comandos em `lib/commands` e render de ERD em `lib/erdSvg` — todos puros e testados (309 testes no desktop).

## :wrench: Instalação

Instala as dependências do monorepo.
```
corepack pnpm install
```

Inicia o app desktop em modo desenvolvimento.
```
corepack pnpm dev:desktop
```

Gera o build de produção.
```
corepack pnpm build
```

## :file_folder: Diretórios

```
├── Raiz
│   ├── apps
│   │   ├── desktop        # cliente Tauri 2 + Next.js 16.3/React 19 distribuído ao usuário
│   │   └── bootstrapper   # instalador gráfico que baixa e valida o NSIS do cliente
│   ├── packages
│   │   └── contracts      # contratos públicos compartilhados pelo cliente e gateway
│   ├── services
│   │   └── gateway        # API Rust/Axum, PostgreSQL e Redis (inclui harness de fine-tuning)
│   ├── scripts            # build local, assinatura e manifestos de release
│   └── docs               # documentação de release, specs de design e créditos (clean-room)
└── main
```

## :rocket: Executáveis

| Nome                          | Descrição                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| AI-Orchestrator-Setup.exe     | Instalador para o usuário final; baixa, valida e instala por usuário (sem UAC)      |
| build-local-installer.ps1     | Gera `artifacts/local/AI-Orchestrator-Setup-Local.exe` com o NSIS incorporado       |
| build-bootstrapper.ps1        | Compila o bootstrapper (instalador gráfico pequeno)                                 |
| sign-windows.ps1              | Assinatura Authenticode dos binários Windows                                        |
| configure-release.ps1         | Configura repositório e chaves para o primeiro release                              |
| generate-release-manifests.mjs| Gera e assina os manifestos de release (Ed25519/SHA-256)                            |
| gateway (cargo)               | `cargo run --manifest-path services/gateway/Cargo.toml` inicia a API Rust/Axum      |

## :computer: Acesso

Para o gateway local acesse http://127.0.0.1:8787

O app desktop não usa credencial padrão — a autenticação é via OIDC.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :book: Documentação

### :link: [Wiki](docs/superpowers/specs/2026-08-10-liquid-glass-v2-design.md)
