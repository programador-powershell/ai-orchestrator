<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell estilo Unsloth Studio**: navegação de modos na sidebar (pílulas, colapsável), topbar slim, Settings em modal (Ctrl+,).
- **9 abas** — Chat, Code, Design, Data, Work, Security, Agent, Game e **Tuning** — com comandos de barra (`/review`, `/explain`, `/testgen`) no composer.
- **Resposta em streaming** (token a token) em todos os caminhos: gateway, modelo direto (BYOK) e runtime local.
- **Modo agente**: o modelo executa ferramentas (ler/buscar/editar/rodar) com aprovação, diagnostics pós-edição e auto-compact de contexto; **MCP** externo e interno.
- **Modelos fusion** com preset por estratégia **e modelos específicos por tipo de atividade** (Chat, Code, Data…).
- **Fine-Tuning 100% em nuvem**: harness no gateway (jobs persistidos, eventos SSE, catálogo, reconciliador) + aba Train (Configurar/Execução/Histórico, SFT/DPO, hiperparâmetros, custo estimado); nada instalado, nenhum código de terceiros embutido.
- **Memória persistente** independente de fornecedor (SQLite/IndexedDB), com import de histórico Claude/OpenAI.
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

### :up: V.5
### :warning: Latest Changes

- **Streaming real da resposta**: os tokens aparecem conforme o modelo gera, também no caminho de modelo direto — novo comando Rust `provider_chat_stream` (SSE + Tauri Channel, chave só no keyring) e leitura de SSE no navegador. Antes, a resposta só surgia depois de pronta.
- **Modo agente (toggle Ferramentas)**: o modelo **executa** ferramentas — lê arquivos, busca, roda comandos e edita — em loop ler→propor→executar→realimentar, com **cartões na conversa** e **aprovação humana** para tudo que grava ou executa.
- **Diagnostics pós-edição**: depois de gravar código, o app roda o check da linguagem (tsc/cargo/py_compile/node) e devolve os erros na conversa, fechando editar→verificar→corrigir.
- **Auto-compact de contexto**: conversas longas são resumidas automaticamente para caber na janela do modelo — o app apenas **avisa** na conversa, sem pedir confirmação.
- **MCP**: cliente para servidores externos (JSON-RPC `tools/list`/`tools/call`, ferramentas namespaced `mcp:<servidor>:<tool>` sob aprovação) e **MCP interno** expondo as ferramentas do próprio app.
- **Fusion por tipo de atividade**: cada preset pode definir **orquestrador, executores e estratégia específicos por aba** (Chat, Code, Data…), escolhidos direto do catálogo; sem override, a aba usa o preset base.

### :pushpin: Fixes

- Resposta que só aparecia ao final no caminho de modelo direto (`stream: false`) agora transmite token a token.
- Corte cego de histórico (`slice(-12)`) substituído por compactação com resumo real.

### :construction_worker: Refactors

- Novos módulos puros e testados: `lib/agent` (loop e ferramentas), `lib/compact`, `lib/diagnostics`, `lib/mcp`, `lib/fusionResolve` — 351 testes no desktop, 18 no gateway e 10 no Rust do desktop.

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
