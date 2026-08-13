<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

> **Estado do produto.** O objetivo é ser a suíte corporativa de IA que substitui ChatGPT, Cursor, drawDB, OpenCut, Canva, OpenCode e Unsloth. **Ainda não substitui.** A tabela de maturidade abaixo diz, por capacidade, o que já funciona ponta a ponta e o que é plano — auditado contra o código, não contra a intenção.

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell**: abas de módulo no topo com **cor própria por aba**, barra lateral servindo o módulo ativo, badge de ambiente no rodapé e Configurações em modal (Ctrl+,).
- **9 abas** — Chat, Code, Office, Design, Data, Work, Security, Agent e Tuning — com comandos de barra (`/review`, `/explain`, `/testgen`), `@`-menção de arquivo e busca global do histórico no composer.
- **Resposta em streaming** (token a token) nos três caminhos: gateway, modelo direto (BYOK) e runtime local.
- **Modo agente**: o modelo executa ferramentas (ler/buscar/editar/rodar) com aprovação, diagnostics pós-edição e auto-compact de contexto; **MCP** externo e interno.
- **Modelos fusion** com preset por estratégia e modelos específicos por tipo de atividade.
- **Edição gerenciada**: política (módulos por grupo do AD, motores, aprovação, prompt master) definida pelo admin no servidor, assinada em Ed25519 e verificada no Rust do cliente; a interface apenas reflete. Na edição `managed`, os caminhos diretos ao provedor são compilados fora do binário.
- **Janela Conectar Apps** (galeria MCP) com seletor de ambiente — Local, WSL, VPS ou Nuvem.
- **Memória persistente** local (SQLite/IndexedDB) independente de fornecedor, com import de histórico Claude/OpenAI.
- **BYOK** armazenado no keyring do sistema operacional; cadastro de servidor VPS sem campo de senha ou chave privada.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) injetadas no prompt.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- **Clean-room**: referências externas documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

### :bar_chart: Maturidade por capacidade

Auditoria de 2026-08-12, cada veredito verificado contra o código por um segundo revisor.

| Capacidade | Alvo | Estado | O que já funciona | O que falta |
| --- | --- | --- | --- | --- |
| Chat | ChatGPT | 🟡 Parcial | Streaming real nos 3 caminhos, memória persistente, anexos de texto, cartões de ferramenta | Motor de busca real (as fontes são palpite do modelo), leitura de PDF/áudio/vídeo, busca semântica na memória |
| Code | Cursor + OpenCode | 🟡 Parcial | CodeMirror real, loop agêntico com aprovação, diff por hunk, diagnostics, terminal | Autocomplete por modelo (hoje é heurística do buffer, **não** é o Tab do Cursor), LSP, índice semântico do repo |
| Data / ERD | drawDB | 🟡 Parcial | Desenhar tabelas, **FK criada arrastando a porta de um campo até outro**, export SQL (5 dialetos), migrações up/down, **imagem fiel ao layout desenhado**, **import de dump real** (nome qualificado, comentário de bloco), persistência | O import ainda é regex, não um parser SQL completo (CHECK, tipos compostos e partições passam batido) |
| Agent | agent-zero / spec-kit | 🟡 Parcial | **Acionamento de agentes** (o modelo decide dividir e aciona subordinados com contexto próprio, tetos de profundidade/filhos/total), **fluxo spec-driven** (constituição → spec → plano → tarefas, com aprovação humana entre etapas) e **computer use confinado** (sessão isolada + Job Object + aprovação por execução). Flow builder segue na aba "Fluxo" | Execução server-side (a árvore morre se a aba fechar); tetos e computer use ainda são escolha do cliente, não da política do grupo; computer use **não reduz privilégio** (ver ADR) |
| Work | Butler/Zapier | 🟡 Parcial | Regras gatilho→ação com motor, log e toggle; **webhook HTTPS e ferramenta MCP saem do app de verdade** (URL guardada no cofre do SO, guarda de SSRF no Rust, fila de aprovação); **agendador roda em qualquer aba** | Nada roda com o app fechado (exigiria bandeja + autostart); e-mail só via webhook/MCP, sem conector M365 |
| Design | Canva / clone de sites | 🟡 Parcial | Canvas editável com formas e export SVG/PNG; extração de paleta e fontes de uma URL | Reconstruir o **layout** do site (hoje só semeia tokens), captura com renderização para SPA |
| Vídeo | OpenCut | 🟡 Parcial | Timeline de corte, preview, **export que renderiza o arquivo** (ffmpeg local, áudio opcional) e projeto que persiste entre sessões | Multi-track, transições, texto/overlays e efeitos; a mídia é apontada por pasta (sem diálogo de arquivo); exige ffmpeg no PATH |
| Security / Sandbox | Snyk + execução isolada | 🟡 Parcial | Varredura de segredos e painel do sandbox — diretório efêmero, ambiente limpo, e **Job Object do Windows**: processo nasce suspenso, teto de processos/memória, restrições de UI e **a árvore inteira morre no fim, inclusive netos órfãos** | A **área de trabalho do agente** confina caminho (`..`, absoluto e symlink apontando para fora são recusados) e encerra a árvore de processos, mas **não reduz privilégio**: não é AppContainer nem contêiner — o comando roda com o token do usuário e alcança a rede. Ver `docs/adr-computer-use.md` |
| Office | Word/Excel/PowerPoint | 🟡 Parcial | **Lê DOCX, XLSX e PPTX de verdade** (extração OOXML no Rust) — a IA lê e comenta; edita HTML/MD/CSV/TXT | Edição ao vivo do binário (motor Collabora, ver ADR); PDF (extrator próprio) |
| **Tuning** | Unsloth | 🔴 Ausente | Orquestra fine-tuning **em nuvem**, roteado pelo gateway corporativo quando conectado (chave do workspace, uso registrado), com validação de dataset e acompanhamento | Unsloth é **treino local em GPU própria** — não existe treinador local, nem modelos abertos, nem export de pesos. É outra categoria de produto |
| **Deploy na VPS + backup** | SSH + rotina da TI | 🔴 Ausente | Cadastro do servidor e pipeline de build **local** com detecção de stack | Sem cliente SSH no binário: **nada executa na VPS**. Backup e redundância não existem no código |

**Leitura honesta:** o app hoje é um **cliente agêntico corporativo com governança** — política do admin, SSO, gating por grupo, streaming, ferramentas com aprovação. Nessa função ele está sólido. Como substituto das sete ferramentas, **ainda não está**: Tuning (treino local) e execução remota são as frentes que exigem trabalho de núcleo. Office já LÊ os binários; falta a edição ao vivo.

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
- **Build & deploy** (Code e Agent) em janela própria na barra superior: carrega **repositório GitHub, pasta local ou artefato pré-compilado**, identifica a stack pelo arquivo-âncora e roda o pipeline etapa a etapa — **na máquina local**. A execução na VPS depende de um cliente SSH que ainda não existe no binário.
- **Cadastro de servidor VPS** sem campo de senha e sem campo de chave privada: o padrão é agente SSH (o app não vê segredo nenhum) e o campo de caminho **recusa** material de chave colado, apontando o cofre corporativo.
- **Office lê DOCX/XLSX/PPTX de verdade**: extração de texto do OOXML no Rust (crate zip), então a IA lê e comenta esses binários — antes o app mostrava lixo. Edição ao vivo do binário segue dependendo do motor externo (ADR); PDF, de um extrator próprio. Salvar fica bloqueado em arquivo extraído, para não gravar texto sobre o binário.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`), **busca global do histórico** em todas as abas, **custo em tokens por mensagem** e **atualização manual** verificável.

### :pushpin: Fixes

- **O cliente reescrevia `office` e `tune` para `chat`** antes de chamar o gateway — o servidor nunca via o módulo real e não tinha como bloqueá-lo. O modo agora vai intacto, com os dois no contrato de wire e no enum do servidor.
- **Barra do composer estourava o painel e o botão enviar ficava inalcançável** em janela estreita. `.composer` é grid e a linha de chips é flex `nowrap`: o track era dimensionado pelo min-content da linha, então a barra crescia a cada chip montado.
- **O chip "Ferramentas" parecia abrir as Configurações.** Não abria: ele montava o chip de aprovação colado nele, e era esse que abria o modal.
- **A janela de apps abria atrás da barra lateral** — ela nascia dentro do workspace, cujo contexto de empilhamento já perde para o rail. Passou a ser renderizada por portal no `body`.
- **A troca de aba não recolorava nada** porque as variáveis derivadas eram resolvidas no `:root`, antes da matiz do módulo existir.
- **Refresh revogado deixava credencial zumbi** no cofre, retentada a cada reinício; agora é apagada. E o 401 só renovava por expiração de relógio — revogação e rotação de chave passavam batido.
- **O modo agente resetava a cada reinício** (não estava no `partialize`); virou configuração persistida da administração.
- **Chave BYOK podia trafegar sem TLS**: `provider_fetch` aceitava `http://` para qualquer host. Agora só HTTPS ou loopback.

- **Anexo de imagem chegava vazio ou derrubava a requisição.** No desktop, o Rust desserializava `content` como texto e o serde rejeitava a mensagem multimodal inteira; no gateway, as rotas Anthropic e Gemini transformavam conteúdo multimodal em string vazia — a pergunta sumia em silêncio.
- **A aba Office dizia "conteúdo exibido como texto extraído" para DOCX/PDF** — não há extração nenhuma no app, então o usuário via lixo binário rotulado como texto. Agora ela avisa que o formato não é suportado.

### :construction_worker: Refactors

- Módulo `policy` nos três lados: resolução por grupo no gateway (Rust), verificação de assinatura no Rust do desktop — **nunca no JavaScript**, que é justamente a superfície não confiável — e derivação de interface no cliente.
- **Auditoria de capacidades** (2026-08-12): cada promessa do produto verificada contra o código por um revisor e desafiada por um segundo, adversarial. Resultado na tabela de maturidade acima — nenhuma das sete ferramentas-alvo é substituída hoje.
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
