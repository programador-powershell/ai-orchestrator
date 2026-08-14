<div align="center">

# Multiplike-AI

![App Screenshot](https://placehold.co/960x540?text=Multiplike-AI)

🧠

</div>

## :heavy_check_mark: Features

> **Estado do produto.** O objetivo é ser a suíte corporativa de IA que substitui ChatGPT, Cursor, drawDB, OpenCut, Canva, OpenCode, openclaw e Unsloth. **Ainda não substitui**: falta **Tuning** (treino local em GPU própria é outra categoria de produto) e faltam **backup e redundância** — os dois adiados por decisão, não por esquecimento. O resto das capacidades já produz arquivo de verdade.

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell**: abas de módulo no topo com **cor própria por aba**, barra lateral servindo o módulo ativo, badge de ambiente no rodapé e Configurações em modal (Ctrl+,).
- **9 abas** — Chat, Code, Office, Design, Data, Work, Security, Agent e Tuning — com comandos de barra (`/review`, `/explain`, `/testgen`), `@`-menção de arquivo e busca global do histórico no composer.
- **Resposta em streaming** (token a token) nos três caminhos: gateway, modelo direto (BYOK) e runtime local.
- **Modo agente**: o modelo executa ferramentas (ler/buscar/editar/rodar) com aprovação, diagnostics pós-edição e auto-compact de contexto; **MCP** externo e interno.
- **Plugins com dois donos**: o **admin** define os plugins **globais** na política do grupo (união entre grupos, id único); a **pessoa** cria os dela, válidos só no agente dela — e só se a política liberar, o que nasce fechado. Plugin de usuário **nunca sobrepõe** ferramenta da administração: a colisão é recusada com o motivo. Eles são **declarativos** (ferramenta HTTPS, ferramenta MCP ou trecho de contexto), não código: um plugin que executasse JavaScript abriria a porta que a edição `managed` fecha compilando as saídas diretas para fora do binário.
- **Cliente SSH: o ambiente do rodapé passa a rotear de verdade.** Escolher VPS manda o comando para o servidor cadastrado pelo `ssh` do sistema, e o badge mostra o **destino real**. Não embutimos biblioteca de SSH nem escrevemos uma: SSH é criptografia, e chamar o OpenSSH do sistema herda o agente, o `~/.ssh/config` e o `known_hosts` que a TI já administra. Segredo nenhum passa pelo app, senha é impossível por construção, e a fingerprint fixada no cadastro é **conferida a cada uso**.
- **O PROJETO INTEIRO segue o ambiente, não só o terminal.** Rotear só os comandos era pior que não rotear nada: o agente compilava no servidor e lia/gravava os arquivos no disco da estação — montava aqui e buildava lá, sem ninguém perceber. Agora ler, listar, gravar, buscar e **abrir documento binário** passam pela mesma rota, com caminho relativo confinado ao diretório do projeto remoto (`..`, raiz e `~` recusados). Ficam locais de propósito: mídia de vídeo e o ffmpeg, que são da estação.
- **Code mode**: o modelo entrega **um programa** que combina várias ferramentas, em vez de uma ida e volta por chamada — oito passos deixam de custar oito requisições. O programa **não é executado com `eval`**: ele é analisado e interpretado por um subconjunto fechado escrito aqui, sem função própria, `while`, reatribuição nem acesso por índice, e sem caminho até `window`, `globalThis`, rede ou qualquer objeto do app. Cada ferramenta chamada lá dentro **mantém a aprovação** de uma chamada avulsa — senão escrever um programa seria a forma barata de driblar o gate. Tetos de passos, de chamadas e de itens por laço. Liberado pelo admin, fechado por padrão.
- **Trilha da execução**: registro append-only do que o modelo viu, por origem, com participação de cada fonte no prompt e export em texto para anexar a chamado. O que parece segredo é mascarado na entrada.
- **Modo mínimo do harness**: corta as injeções de conveniência para separar "o modelo é ruim nisso" de "o nosso contexto atrapalhou". O prompt master do admin **continua entrando** — nenhum modo o remove, senão trocar de modo seria uma saída da política.
- **Equipe de agentes montada pelo orquestrador** (aba Agent): a pessoa escreve o que quer **no mesmo campo de mensagem das outras abas** — a aba não tem formulário, seletor **nem modos**. O **modelo orquestrador** lê o pedido e decide o tamanho da equipe; ela segue sempre a espinha spec-driven (constituição → spec → plano → tarefas → revisão → CI). Os nós surgem conforme os agentes são contratados e a barra lateral lista `modelo - papel` ao vivo. Os papéis que tocam o repositório (`code`, `review`, `CI`) rodam no **runtime de ferramentas**, com a mesma aprovação humana do resto do app — e o **modelo de cada papel é o que o admin definiu**, não um rótulo na tela.
- **Produz arquivo de verdade, não maquete**: edita o binário **DOCX/PPTX**, lê **PDF** com extrator próprio, compõe **vídeo** (transição, faixa sobreposta, texto) pelo ffmpeg local, **clona o layout real** de um site e exporta **SQL/ERD** em 5 dialetos.
- **Completar por modelo no cursor** (aba Code), aceito com Tab, mais **índice de símbolos** próprio com `@` no Ctrl+P para pular à declaração.
- **Modelos fusion** com preset por estratégia e modelos específicos por tipo de atividade.
- **Edição gerenciada**: política (módulos por grupo do AD, motores, aprovação, prompt master) definida pelo admin no servidor, assinada em Ed25519 e verificada no Rust do cliente; a interface apenas reflete. Na edição `managed`, os caminhos diretos ao provedor são compilados fora do binário.
- **Janela Conectar Apps** (galeria MCP) com seletor de ambiente — Local, WSL, VPS ou Nuvem.
- **Memória persistente** local (SQLite/IndexedDB) independente de fornecedor, com import de histórico Claude/OpenAI e **busca por sentido** — vetores pelo gateway, e uma camada morfológica que funciona sem rede.
- **Relatoria de uso**: tokens contados nos três caminhos de provedor e **custo por usuário, grupo, modelo e dia** no console do admin.
- **Área de trabalho isolada** para o agente executar comando: pasta própria apagada no fim, **Job Object do Windows** matando a árvore inteira de processos, aprovação por execução e **trilha de auditoria** no gateway. Ligada só se a política do grupo permitir — e ela **não reduz privilégio** (ver ADR).
- **Blocklist de domínios** definida pelo admin, aplicada no Rust sobre a política assinada — vale para pesquisa, webhook e MCP.
- **BYOK** armazenado no keyring do sistema operacional; cadastro de servidor VPS sem campo de senha ou chave privada.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) injetadas no prompt.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- **Procedência declarada**: as referências de inspiração ficam em `docs/creditos-inspiracao.md`; o código de terceiro que existe no repositório está listado no `NOTICE`, com a licença em `licenses/` e a origem no cabeçalho do próprio arquivo. Hoje é um só: o registro de stacks e o gerador de Dockerfile portados do **openship** (Apache-2.0).

## :new: Releases Notes

### :up: V.11
### :warning: Latest Changes

- **O produto passou a se chamar Multiplike-AI.** Nome visível, título da janela, instalador, escopo de pacote (`@multiplike/*`), identificador do app (`com.multiplike.desktop`) e nomes de crate — 192 ocorrências em 114 arquivos. **As chaves de armazenamento local ficaram como estavam** (`orchestrator.v2`, `aio.*`): renomear chave não migra dado, só faz o app abrir sem as conversas, os fluxos e o schema que a pessoa já tinha. O rename também quebrou, e consertou, uma coisa que passaria em silêncio: o crate do gateway virou `multiplike-ai-gateway` enquanto o `RUST_LOG` continuava filtrando o nome antigo — o log sairia mudo.
- **O terminal da aba Code virou um terminal de verdade.** O que existia era um scrollback de linhas tipadas, com cada linha recebendo uma cor do app: lê bem um `git status` e não é um terminal — `vim`, `htop`, `nano`, um menu de instalador, qualquer coisa que desenhe posicionando o cursor numa grade, saía como lixo ou como nada. Agora quem desenha é o **xterm.js** (MIT) ligado direto no **PTY** que já existia no Rust e não tinha tela nenhuma: grade, cursor, regiões de rolagem, modos de teclado, redimensionamento propagado (`ptyResize` — sem ele o shell segue achando que tem 80 colunas e o `less` quebra na coluna errada). O painel tem **duas metades**: *Shell* (o emulador, padrão) e *Assistido* (o prompt anterior, com `ai <pergunta>`, execução de arquivo e o gate de código colado) — o assistido não é terminal, é um lançador com IA, e apagá-lo teria jogado fora recurso que funciona.
- **A paleta do terminal é PRÓPRIA, e acompanha o tema.** As 16 cores ANSI vivem em `lib/termTheme.ts` nos dois temas, não derivadas dos tokens de papel do app: quem escreve `\e[31m` está pedindo a cor 1 do ANSI, e um programa qualquer não sabe nada sobre a identidade visual daqui. O tema claro **não é a paleta escura com o fundo trocado** — cada cor foi rebaixada mantendo o matiz, senão `#67d38a` sobre branco fica ilegível. A mesma paleta alimenta o emulador e o interpretador do scrollback, para as duas metades da tela nunca pintarem o mesmo verde de dois jeitos.
- **47 stacks e o gerador de Dockerfile, portados do openship** (Apache-2.0, atribuição em `NOTICE`, licença em `licenses/`). São 11 linguagens e 47 stacks com imagem de build e de runtime, diretório de saída, porta, comando de build e de start, caminhos de produção e regra de detecção — conhecimento operacional acumulado (que o Nuxt sai em `.output`, que o Rails precisa de `Gemfile` **mais** `config/routes.rb`, que o Create React App só se identifica pela dependência porque `public/`+`src/` é layout de meio mundo). O Dockerfile sai multi-estágio quando a imagem de build difere da de runtime, com install e build num `RUN` só (um por passo custaria uma layer commitada por passo) e as marcas de progresso impressas de dentro do build, porque o Docker não expõe progresso dentro de um `RUN`. **Não portamos** a constante que buscava logo de framework num CDN externo: isso entrega a um terceiro a lista de frameworks que o usuário tem, quebra o app offline e depende de uma URL móvel.

### :pushpin: Fixes

- **O `ESC(B` aparecia escrito na tela.** O interpretador ANSI tratava todo escape curto como dois bytes, e a designação de conjunto de caracteres — que todo shell emite ao iniciar — tem três: o `B` sobrava e virava texto.

### :construction_worker: Refactors

- **A paleta do terminal e o interpretador ANSI são módulos puros** (`lib/termTheme.ts`, `lib/ansi.ts`), testáveis sem tela e sem processo. São 30 testes no interpretador e 20 no registro de stacks — incluindo os valores que o pipeline usa de verdade, porque um erro de transcrição ali manda o build para o diretório errado sem reclamar de nada.
- **`NOTICE` e `licenses/` na raiz**: o repositório deixou de ser clean-room e passou a conter código de terceiro sob Apache-2.0. Os dois arquivos derivados dizem isso no próprio cabeçalho, com a origem, a versão, o commit e a lista de modificações — que é o que a §4b da licença exige.

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
│   ├── assets
│   │   ├── icons          # fonte dos glifos do produto (SVG 24×24, currentColor)
│   │   └── app-icon.svg   # arte do aplicativo
│   ├── scripts            # build local, assinatura, manifestos de release e gerador de ícones
│   └── docs               # documentação de release, specs de design e créditos (clean-room)
└── main
```

## :rocket: Executáveis

| Nome                          | Descrição                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Multiplike-AI-Setup.exe     | Instalador para o usuário final; baixa, valida e instala por usuário (sem UAC)      |
| build-local-installer.ps1     | Gera `artifacts/local/Multiplike-AI-Setup-Local.exe` com o NSIS incorporado       |
| build-bootstrapper.ps1        | Compila o bootstrapper (instalador gráfico pequeno)                                 |
| sign-windows.ps1              | Assinatura Authenticode dos binários Windows                                        |
| configure-release.ps1         | Configura repositório e chaves para o primeiro release                              |
| generate-release-manifests.mjs| Gera e assina os manifestos de release (Ed25519/SHA-256)      
| gen-icons.mjs                 | Converte `assets/icons/**.svg` no módulo de glifos do app (roda sob demanda; a saída é versionada)                      |
| gateway (cargo)               | `cargo run --manifest-path services/gateway/Cargo.toml` inicia a API Rust/Axum      |

## :computer: Acesso

Para o gateway local acesse http://127.0.0.1:8787

O app desktop não usa credencial padrão — a autenticação é via OIDC.

![App Screenshot](https://placehold.co/960x540?text=Multiplike-AI)

## :book: Documentação

### :link: [Wiki](docs/superpowers/specs/2026-08-10-liquid-glass-v2-design.md)
