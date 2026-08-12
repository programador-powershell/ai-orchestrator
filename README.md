<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell**: abas de módulo no topo com **cor própria por aba**, barra lateral servindo o módulo ativo, badge de ambiente no rodapé e Configurações em modal (Ctrl+,).
- **9 abas** — Chat, Code, **Office**, Design, Data, Work, Security, Agent e Tuning — com comandos de barra (`/review`, `/explain`, `/testgen`), `@`-menção de arquivo e busca global do histórico no composer.
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
- **Edição gerenciada**: política (módulos por grupo do AD, motores, aprovação, prompt master) definida pelo admin no servidor, assinada e verificada no cliente; a interface apenas reflete.
- **Janela Conectar Apps** (galeria MCP) com seletor de ambiente — Local, WSL, VPS ou Nuvem.
- **Import de plugins/skills**, **cadastro de servidor VPS** (sem campo de senha ou chave privada — agente SSH ou keyring do sistema) e **atualização manual** verificável.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) injetadas no prompt, acima das preferências gerais.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- Instalador `AI-Orchestrator-Setup.exe` com download HTTPS retomável e validação Ed25519, SHA-256 e Authenticode.
- **Clean-room**: referências externas (Unsloth Studio, drawdb, opencode, soup) documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :new: Releases Notes

### :up: V.7
### :warning: Latest Changes

- **Edição gerenciada: o admin controla a política, o cliente herda.** O servidor passou a ser a autoridade — antes as configurações viviam no `localStorage` da estação e qualquer bloqueio na interface era cosmético. Agora a política nasce no gateway, viaja **assinada (Ed25519)** e é aplicada onde o usuário não alcança.
- **Módulos por grupo do Active Directory**: o admin mapeia grupo (ObjectId ou app role do Entra) → abas liberadas. O usuário só vê o que o grupo dele permite — e o servidor responde **404**, não 403, para módulo bloqueado: o módulo simplesmente não existe para ele. A resolução é por **união** dos grupos; em conflito de segurança, o **mais restritivo** vence.
- **Console de administração** nas Configurações: grupos, módulos por clique e **prompt master do workspace**, que entra primeiro no sistema de toda conversa de todo cliente. O prompt local da estação apenas complementa — e só se o admin permitir, dentro do teto de caracteres.
- **Edição `managed` do cliente**: as quatro portas de saída direta ao provedor (BYOK) e o runtime local são **compilados fora do binário**. Esconder botão não segura nada; compilar fora, sim — todo tráfego de modelo passa pelo gateway, que aplica a política e registra o uso.
- **SSO corrigido para o Entra**: o desktop virou *public client* e troca o código **direto com o IdP** (PKCE, sem `client_secret`), com redirect `localhost/callback`. O escopo agora vai também no refresh, e um 401 renova a sessão em execução.
- **Janela "Conectar Apps"** no indicador da barra superior: galeria de conectores MCP com categorias e busca, mais o **seletor de ambiente** — Local, WSL, VPS (servidor da TI) ou Nuvem. O usuário conecta os apps dele; a TI configura os ambientes.
- **Badge de ambiente no rodapé**, estilo barra de status: mostra onde o trabalho roda e troca por lista suspensa.
- **Cor por módulo de volta**: cada aba tem sua matiz e o app inteiro acompanha — acento, foco, orbes do ambiente e botão de envio derivam da mesma variável, com transição suave na troca.
- **Build & deploy** (Code e Agent) em janela própria na barra superior: carrega **repositório GitHub, pasta local ou artefato pré-compilado**, identifica a stack pelo arquivo-âncora e roda o pipeline etapa a etapa.
- **Cadastro de servidor VPS** sem campo de senha e sem campo de chave privada: o padrão é agente SSH (o app não vê segredo nenhum) e o campo de caminho **recusa** material de chave colado, apontando o cofre corporativo.
- **Aba Office**, **regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`), **busca global do histórico** em todas as abas, **custo em tokens por mensagem** e **atualização manual** verificável.

### :pushpin: Fixes

- **O cliente reescrevia `office` e `tune` para `chat`** antes de chamar o gateway — o servidor nunca via o módulo real e não tinha como bloqueá-lo. O modo agora vai intacto, com os dois no contrato de wire e no enum do servidor.
- **Barra do composer estourava o painel e o botão enviar ficava inalcançável** em janela estreita. `.composer` é grid e a linha de chips é flex `nowrap`: o track era dimensionado pelo min-content da linha, então a barra crescia a cada chip montado.
- **O chip "Ferramentas" parecia abrir as Configurações.** Não abria: ele montava o chip de aprovação colado nele, e era esse que abria o modal.
- **A janela de apps abria atrás da barra lateral** — ela nascia dentro do workspace, cujo contexto de empilhamento já perde para o rail. Passou a ser renderizada por portal no `body`.
- **A troca de aba não recolorava nada** porque as variáveis derivadas eram resolvidas no `:root`, antes da matiz do módulo existir.
- **Refresh revogado deixava credencial zumbi** no cofre, retentada a cada reinício; agora é apagada. E o 401 só renovava por expiração de relógio — revogação e rotação de chave passavam batido.
- **O modo agente resetava a cada reinício** (não estava no `partialize`); virou configuração persistida da administração.
- **Chave BYOK podia trafegar sem TLS**: `provider_fetch` aceitava `http://` para qualquer host. Agora só HTTPS ou loopback.

### :construction_worker: Refactors

- Módulo `policy` nos três lados: resolução por grupo no gateway (Rust), verificação de assinatura no Rust do desktop — **nunca no JavaScript**, que é justamente a superfície não confiável — e derivação de interface no cliente.
- Novos módulos puros e testados: `lib/connectors`, `lib/connections`, `lib/policy`, `lib/ship` (stack, fontes, pipeline, servidor), `lib/office` (command engine, adapter, change log, WOPI), `lib/projectRules` — **756 testes** no desktop, 28 no gateway e 15 no Rust do cliente.
- Módulo **Game removido** do produto.
- ADRs em `docs/`: [edição gerenciada](docs/adr-edicao-gerenciada.md) (a política do admin e os furos que ela fecha) e [motor do Office](docs/adr-office-motor-wopi.md) (WOPI como contrato de armazenamento, Collabora como motor — o caminho Microsoft está fechado por licenciamento e por descontinuação).


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
