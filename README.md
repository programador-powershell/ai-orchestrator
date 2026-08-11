<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + React 19.
- **7 abas** — Chat, Code, Design, Data, Work, Security e Agent — todas com chat e modo planejamento.
- **Memória persistente** independente de fornecedor (SQLite/IndexedDB), com import de histórico Claude/OpenAI.
- **Modelos fusion**: orquestrador+executor, merge e race entre modelos.
- **BYOK** (traga sua própria chave) armazenado no keyring do sistema operacional.
- **Editor ERD** na aba Data com export SQL (PostgreSQL, MySQL e ANSI).
- **Editor de vídeo** estilo OpenCut na aba Design.
- **Sandbox** estilo ai-jail na aba Security.
- **Import de plugins/skills** nas Configurações.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- Instalador `AI-Orchestrator-Setup.exe` com download HTTPS retomável e validação Ed25519, SHA-256 e Authenticode.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :new: Releases Notes

### :up: V.2.3
### :warning: Latest Changes

- Fine-Tuning 100% interno: o soup viaja EMBUTIDO no app (`third_party/soup`, Apache-2.0, fonte + templates como recursos do desktop) e roda da cópia local via Python — nada é instalado. Escada real de detecção: binário no PATH → cópia embutida → fonte sem runtime (rotulado honestamente); treino na nuvem interno via API de fine-tuning (chave BYOK) segue como caminho principal, com job persistido, acompanhamento automático e modelo resultante no catálogo.
- Saída de execução na CONVERSA: comandos do soup, validação de dataset, eventos do job e avisos aparecem como cartões na janela de conversa da aba (código com rótulo de linguagem e copiar), junto das respostas do agente — como o Claude mostra diffs na conversa.
- Repositórios de referência embutidos em `third_party/` (clones vendorizados sem `.git`): soup (Apache-2.0, executável), opencode (MIT, referência do CLI nativo) e drawdb (AGPL-3.0 — **somente referência**, nunca compilado no app; uso além disso requer análise TI/SI). Papéis e regras em `third_party/THIRD_PARTY.md`.

### :pushpin: Fixes

- Barra superior não quebra mais no redimensionamento: tiers por container query medindo a largura REAL da topbar (rail aberta/recolhida entra na conta) — abas encolhem para ícones, segmented mostra só o ativo, status vira ponto compacto e a área de ações recorta (`overflow: clip`) em vez de invadir os controles da janela.

### :construction_worker: Refactors

- TuneView sem log bruto: painel de execução substituído pelo feed do thread da aba (mensagens persistem no histórico de conversas do rail).

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
│   │   ├── desktop        # cliente Tauri 2/React 19 distribuído ao usuário
│   │   └── bootstrapper   # instalador gráfico que baixa e valida o NSIS do cliente
│   ├── packages
│   │   └── contracts      # contratos públicos compartilhados pelo cliente e gateway
│   ├── services
│   │   └── gateway        # API Rust/Axum, PostgreSQL e Redis
│   ├── scripts            # build local, assinatura e manifestos de release
│   ├── docs               # documentação de release e specs de design
│   └── third_party        # repositórios embutidos: soup (Apache-2.0, executável), opencode (MIT) e drawdb (AGPL-3.0, só referência)
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
