<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **7 abas** — Chat, Code, Design, Data, Work, Security e Agent — todas com chat e modo planejamento.
- **Fine-Tuning 100% em nuvem**: dataset builder + validação + job na API do provedor (chave BYOK); nada é instalado e nenhum código de terceiros é embutido — saída na conversa como cartões.
- **Memória persistente** independente de fornecedor (SQLite/IndexedDB), com import de histórico Claude/OpenAI.
- **Modelos fusion**: orquestrador+executor, merge e race entre modelos.
- **BYOK** (traga sua própria chave) armazenado no keyring do sistema operacional.
- **Editor ERD** na aba Data com export SQL (PostgreSQL, MySQL e ANSI).
- **Editor de vídeo** estilo OpenCut na aba Design.
- **Sandbox** estilo ai-jail na aba Security.
- **Import de plugins/skills** nas Configurações.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- Instalador `AI-Orchestrator-Setup.exe` com download HTTPS retomável e validação Ed25519, SHA-256 e Authenticode.
- **Clean-room**: referências externas (Unsloth Studio, drawdb, opencode, soup) documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :new: Releases Notes

### :up: V.3
### :warning: Latest Changes

- **Frontend migrado de Vite 7 para Next.js 16.3** (App Router, export estático em `out/`): o app segue SPA dentro do Tauri (`dynamic` com `ssr:false`), com boot guardado contra o duplo-efeito do StrictMode e checagem de porta 1420 no dev (o Next não tem strictPort).
- **Fine-Tuning só nuvem**: removida a execução local do soup (escada binário→embutido, editor `soup.yaml`, botão GPU); o fluxo interno — dataset builder, validação, upload, job BYOK, eventos na conversa e catálogo — permanece completo.
- **`third_party/` removido por inteiro** (soup, opencode e drawdb): as funções seguem nativas no app e as referências externas estão registradas em `docs/creditos-inspiracao.md` (regime clean-room; AGPL nunca entra no repo).

### :pushpin: Fixes

- `.gitignore` cobre os artefatos do Next (`out/`, `.next/`, `next-env.d.ts`) e a config local do Claude; regras dos `vite.config` gerados mantidas para o bootstrapper (que segue no Vite).

### :construction_worker: Refactors

- tsconfig do desktop unificado (exclusão de testes preservada para o type-check do `next build`); dependências do Vite removidas do desktop; React atualizado para 19.2.

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
│   │   └── gateway        # API Rust/Axum, PostgreSQL e Redis
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
