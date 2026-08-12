<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell estilo Unsloth Studio**: navegação de modos na sidebar (pílulas, colapsável), topbar slim, Settings em modal (Ctrl+,).
- **10 abas** — Chat, Code, **Office**, Design, Data, Work, Security, Agent, Game e Tuning — com comandos de barra (`/review`, `/explain`, `/testgen`), `@`-menção de arquivo e busca global do histórico no composer.
- **Aba Office**: o documento é objeto vivo do workspace — você pede a alteração no chat, o **Office Command Engine** valida a operação estruturada e o arquivo muda na tela (a IA nunca grava direto).
- **Build & deploy** nas abas Code e Agent: carrega repositório GitHub, pasta local ou artefato pré-compilado, **identifica a stack** (Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker) pelo arquivo-âncora e executa o pipeline com controle de versão.
- **Resposta em streaming** (token a token) em todos os caminhos: gateway, modelo direto (BYOK) e runtime local.
- **Modo agente**: o modelo executa ferramentas (ler/buscar/editar/rodar) com aprovação, diagnostics pós-edição e auto-compact de contexto; **MCP** externo e interno.
- **Modelos fusion** com preset por estratégia **e modelos específicos por tipo de atividade** (Chat, Code, Data…).
- **Fine-Tuning 100% em nuvem**: harness no gateway (jobs persistidos, eventos SSE, catálogo, reconciliador) + aba Train (Configurar/Execução/Histórico, SFT/DPO, hiperparâmetros, custo estimado); nada instalado, nenhum código de terceiros embutido.
- **Memória persistente** independente de fornecedor (SQLite/IndexedDB), com import de histórico Claude/OpenAI.
- **BYOK** (traga sua própria chave) armazenado no keyring do sistema operacional.
- **Editor ERD** na aba Data com export SQL (PostgreSQL, MySQL, ANSI, SQLite e MSSQL), migração up/down e export SVG.
- **Editor de vídeo** estilo OpenCut na aba Design.
- **Sandbox** estilo ai-jail na aba Security.
- **Import de plugins/skills** nas Configurações, **cadastro de servidor de deploy** (sem campo de senha ou chave privada — agente SSH ou keyring do sistema) e **atualização manual** verificável.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) injetadas no prompt, acima das preferências gerais.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- Instalador `AI-Orchestrator-Setup.exe` com download HTTPS retomável e validação Ed25519, SHA-256 e Authenticode.
- **Clean-room**: referências externas (Unsloth Studio, drawdb, opencode, soup) documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :new: Releases Notes

### :up: V.6
### :warning: Latest Changes

- **Abas de módulo no topo**: a barra esquerda passou a servir o módulo ativo (arquivos no Code, documentos no Office, paleta no Agent) em vez de navegar entre abas.
- **Aba Office**: documento vivo do workspace. O chat emite operações estruturadas validadas por formato (blocos ```office```) — a IA nunca grava o arquivo direto. Poucas operações aplicam na hora; muitas pedem aprovação com prévia do que muda. Histórico da IA com reversão por alteração. Hoje edita HTML/Markdown/CSV/TXT de verdade; DOCX/XLSX/PPTX/PDF abrem somente leitura (ver ADR abaixo).
- **Build & deploy** (Code e Agent): botão na barra superior abre a janela que carrega **repositório GitHub, pasta local ou artefato pré-compilado**, identifica a stack pelo arquivo-âncora — com o gerenciador vindo do lockfile e os comandos vindos dos scripts realmente declarados — e roda o pipeline etapa a etapa. Versionar só libera quando o pipeline passa inteiro.
- **Servidor de deploy nas Configurações**: cadastro do VPS **sem campo de senha e sem campo de chave privada**. O padrão é agente SSH (o app não vê segredo nenhum); com arquivo de chave, a passphrase vai ao keyring do sistema e some da interface. O campo de caminho **recusa** material de chave colado e aponta o cofre corporativo.
- **Painel de conexões**: o indicador da barra superior mostra a QUÊ o app está conectado — gateway, runtime local, VPS, repositório, WSL, MCP — e adiciona o que falta. Cadastrado não conta como conectado.
- **Seletor de política de aprovação** no composer, com a dica de cada opção, valendo já no turno em andamento.
- **Custo em tokens por mensagem** no rodapé de cada resposta, somando raciocínio e saída de ferramentas.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`) entram no prompt acima das preferências gerais.
- **Busca global do histórico** disponível em todas as abas (antes só no Chat).
- **Atualização manual** verificável nas Configurações — nunca instalação silenciosa.
- **`@`-menção de arquivo**, colar imagem/vídeo/arquivo com Ctrl+V, aceite de diff por hunk e autocomplete inline por Tab no editor.

### :pushpin: Fixes

- **Barra do composer estourava o painel e o botão enviar ficava inalcançável.** `.composer` é grid e a linha de chips é flex `nowrap` com `min-width: auto`: o track era dimensionado pelo min-content da linha, então a barra crescia a cada chip montado e o enviar saía do balão — em janela estreita, cortado pelo `overflow: hidden` do workspace.
- **O chip "Ferramentas" parecia abrir as Configurações.** Não abria: ele montava o chip de aprovação colado nele, e era esse que abria o modal. Com a aprovação virando seletor, nenhum controle da barra abre mais Configurações.
- **O modo agente resetava a cada reinício** — não estava no `partialize`. Virou configuração persistida, definida pela TI.
- **Chave BYOK podia trafegar sem TLS**: `provider_fetch` duplicava a validação de `baseUrl` e aceitava `http://` para qualquer host. Agora só HTTPS ou loopback.
- **Conversa anterior era sobrescrita** no primeiro envio após reiniciar o app.
- Aba Office ocupava só parte da tela: a coluna direita saiu e o documento passou a usar a largura toda.

### :construction_worker: Refactors

- Novos módulos puros e testados: `lib/ship` (detecção de stack, fontes, pipeline, servidor), `lib/office` (command engine, adapter, change log, WOPI), `lib/connections`, `lib/projectRules`, `lib/mentions`, `lib/markdownStream`, `lib/streamBuffer` — **728 testes** no desktop, mais os do gateway e do Rust.
- **ADR do motor Office** (`docs/adr-office-motor-wopi.md`): WOPI como contrato de armazenamento e **Collabora Online** como motor. O caminho Microsoft está fechado — o Cloud Storage Partner Program não é aberto a clientes M365 e o Office Online Server é descontinuado em 01/01/2027 — e a PostMessage API deles não toca no conteúdo, então não entrega edição ao vivo.


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
