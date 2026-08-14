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
- **As 47 stacks portadas passaram a ser usadas de verdade.** Elas existiam no código e não chegavam a lugar nenhum: nada importava o catálogo fora do próprio teste, e o painel de deploy continuava com a detecção antiga de 11 linguagens. Faltava a peça do meio — a função de detecção. Agora o painel mostra **duas** respostas, porque são duas perguntas diferentes: a *stack* diz a linguagem e os comandos do pipeline (instalar, testar, empacotar) e o *framework* diz porta, pasta de saída, comando de start e imagem base — o que o Dockerfile precisa. Um projeto é "node" para o pipeline e "Next.js" para o container ao mesmo tempo, e o Dockerfile gerado pode ser conferido na tela antes de qualquer build.
- **O terminal não perde mais o começo da sessão.** A thread de leitura do Rust emite no instante em que o filho nasce; o front só assinava depois do `pty_spawn` voltar, mais três round-trips de IPC. Evento do Tauri sem ouvinte é **descartado**, não enfileirado — o que se perdia era a faixa do shell e o primeiro prompt, e o terminal parecia travado até o primeiro Enter. A inscrição agora acontece **antes** do spawn e o id é amarrado depois.
- **O produtor tem freio.** O buffer de escrita do xterm.js descarta acima de 5×10⁷ bytes pendentes: um `cat` de arquivo grande não ficava lento, ficava **faltando pedaço no meio**, calado. O Rust passou a emitir no máximo 256 blocos sem confirmação e a parar de ler o PTY passando disso — o freio chega ao processo filho, que bloqueia na escrita, como em qualquer terminal (é o que faz `comando | head` terminar). A confirmação sai do callback do `term.write`, que é quando a tela **de fato** processou o pedaço.
- **A saída da aba Assistido saiu do texto cru.** `parseAnsi` existia, com testes, e não era chamado por ninguém: `git status`, `npm`, `cargo` e `docker` despejavam `ESC[32m` visível no meio da frase. Agora cada trecho é pintado com a cor que o próprio programa pediu, usando a mesma paleta do emulador.


### :pushpin: Fixes

- **O `ESC(B` aparecia escrito na tela.** O interpretador ANSI tratava todo escape curto como dois bytes, e a designação de conjunto de caracteres — que todo shell emite ao iniciar — tem três: o `B` sobrava e virava texto.
- **O terminal parava de abrir depois de oito sessões, com zero shells vivos.** Sessão que encerra sozinha (`exit`, Ctrl+D, ssh caindo) nunca saía do mapa do Rust: só `pty_kill` removia, e o front não chamava `pty_kill` justamente nesse caso, porque o `onExit` zerava o id antes. O limite conta entradas, então oito ciclos de "encerrou, reabri" fechavam a porta até reiniciar o app — e cada entrada morta ainda segurava um handle do ConPTY. Corrigido nos três pontos: a thread de espera se remove, o `pty_spawn` descarta as mortas antes de contar, e a limpeza do efeito mata o id que ela mesma abriu.
- **Trocar para a aba "Assistido" matava o shell.** O emulador era desmontado, o que dispara a limpeza do efeito de sessão — o `cd`, o histórico e o processo em execução iam junto. Agora ele fica montado e escondido, como o painel vizinho sempre esteve.
- **A atualização para 0.11.0 apagaria os dados de quem já usava o app.** O rebranding trocou três chaves de busca ao mesmo tempo: o nome do serviço no cofre do sistema, os diretórios de dados e o `identifier` do Tauri — e no Windows a pasta do WebView2 fica sob o identifier, o que move a **origem física inteira** do `localStorage`. Preservar as chaves (`orchestrator.v2`, `aio.*`) não adiantava nada: elas ficaram num armazenamento que ninguém mais abre. Conversas, configurações, memória, política, chaves de API e os modelos GGUF baixados (gigabytes) continuariam no disco, invisíveis. O módulo `rebrand.rs` migra os diretórios antes de a janela nascer e converte a credencial do cofre na primeira leitura.
- **Busca engasgava a digitação.** `normalizeSearchText` chamava a normalização **caractere a caractere** para montar um mapa de posições que jogava fora em seguida — 244 ms por tecla com 50 conversas, 958 ms com 120. Além disso, o trecho de cada resultado era calculado para **toda** conversa encontrada e depois 292 de 300 iam para o lixo no corte de oito linhas: 472 ms no pior caso. Somando a memória do corpo já dobrado, a busca caiu de ~515 ms para 21 ms.
- **O `localStorage` era reescrito a cada tecla.** O `persist` do zustand grava a cada `setState`, sem comparar nada — inclusive em mudanças que nem são persistidas (`setInput`, `setError`, avanço de estágio). Cada tecla no composer serializava o histórico das dez abas e gravava em disco. Agora a escrita é coalescida (uma por segundo, no máximo), pulada quando o conteúdo é idêntico ao gravado, e descarregada na hora ao fechar ou esconder a janela.
- **Cota estourada derrubava a AÇÃO do usuário.** O `QuotaExceededError` subia de dentro do `setState`, então o envio da mensagem morria junto — quando o problema era só a gravação. Agora a falha é tratada onde nasce: descarta as conversas mais antigas do conjunto, tenta de novo, e avisa.
- **A política do admin não valia para as duas coisas que ela proíbe.** `byokAllowed` e `localRuntimeAllowed` eram lidos num lugar só — a lista suspensa, que apenas escondia as opções. Só que a escolha é **persistida**: quem selecionou chave própria antes de o admin desligar o BYOK continuava usando a chave própria, e `local`/`model` não passam pelo gateway, ou seja, não tinham outro portão. A regra passou a ser aplicada também no `chatOnce`, que cai para a rota do workspace e avisa. Política ausente com gateway configurado deixou de significar "pode": antes, bootstrap que não respondeu virava permissão.
- **A imagem gerada para site estático não rodava.** Nove stacks (Vite, Angular, CRA, Vue, React, Blazor, HTML solto…) constroem para uma pasta e não têm processo para subir; o gerador simplesmente não emitia `CMD`, e o `docker run` terminava na hora. Agora recebem um servidor de arquivos com fallback para `index.html` — sem o qual toda rota de SPA devolve 404 ao recarregar.
- **`$PORT` não existia no container.** Três stacks (dotnet, laravel, symfony) trazem `$PORT` no comando de start, vindo de uma plataforma que injeta a variável. Aqui ninguém injetava: o .NET subia com `ASPNETCORE_URLS=http://0.0.0.0:` e morria na largada; o FrankenPHP escutava em `:` e o deploy ficava "no ar" sem responder.
- **Valor de variável com quebra de linha gerava Dockerfile inválido.** O nome era validado, o valor não: o `\n` encerrava a instrução `RUN` e o resto virava diretiva por conta própria.
- **Barra de progresso virava dezenas de linhas.** O `\r` sozinho não é quebra de linha — é o cursor voltando ao início dela —, e era convertido em `\n`. Um `docker pull` despejava um estágio congelado da barra por linha.
- **Emoji corrompia o resto da linha.** `aplicarRetornos` contava colunas por code point e escrevia indexando por unidade UTF-16: no primeiro caractere fora do BMP os dois contadores saíam de sincronia e a escrita seguinte cortava o par substituto ao meio.
- **Ponta de linha 4px fora do lugar na aba Fluxo.** O React Flow lê `x`/`y` da alça como canto superior-esquerdo e soma `width/2`; estavam declarados como centro. O mesmo defeito já corrigido no Data. Junto foi a seleção múltipla, que era desfeita a cada sincronia, e a seleção pedida de fora do canvas, que centralizava a tabela sem destacá-la.
- **Perda de `unlisten` no terminal.** Se o desmonte acontecesse durante o `await ptyListen`, os três handlers de janela ficavam vivos para sempre — e o de `pty-error` aceita erro sem id, então uma sessão encerrada voltava a escrever na faixa vermelha de outro terminal.
- **O `NOTICE` e a licença Apache-2.0 não iam no instalador**, o que a §4 da licença exige de quem redistribui.
- **Sobrou a marca antiga em texto visível**: o cabeçalho de Configurações ainda dizia "ai orchestrator · v2", e o `runstore.rs` era o único arquivo Rust ainda apontando para a pasta "AI Orchestrator".
- **`OIDC_AUDIENCE` passou a aceitar lista.** O rebranding mudou o `aud` esperado; um redeploy pelo manifesto passaria a exigir o novo enquanto o IdP ainda emite o antigo, e **todo login** devolveria 401 sem nada no log explicando. Aceitar as duas durante a virada é o que permite trocar sem indisponibilidade.


### :construction_worker: Refactors

- **A paleta do terminal e o interpretador ANSI são módulos puros** (`lib/termTheme.ts`, `lib/ansi.ts`), testáveis sem tela e sem processo. São 30 testes no interpretador e 20 no registro de stacks — incluindo os valores que o pipeline usa de verdade, porque um erro de transcrição ali manda o build para o diretório errado sem reclamar de nada.
- **`NOTICE` e `licenses/` na raiz**: o repositório deixou de ser clean-room e passou a conter código de terceiro sob Apache-2.0. Os dois arquivos derivados dizem isso no próprio cabeçalho, com a origem, a versão, o commit e a lista de modificações — que é o que a §4b da licença exige.
- **Código morto removido, inclusive o que custava caro.** `ModeViews.tsx` (572 linhas de UI simulada — "AGENT TASKS" e árvore de arquivos falsos) não tinha um único importador; foi substituída pelas views reais e ninguém a apagou. A busca do rail vivia atrás de uma prop que nenhum dos onze chamadores passava — busca inalcançável que ainda assim assinava `state.conversations` **inteiro**, fazendo o rail de uma aba se redesenhar quando qualquer outra mexia no histórico dela.
- **O `memo` do cartão de tabela voltou a valer.** O efeito de sincronia montava um objeto `data` novo para toda tabela a cada mudança, e `memo` compara por identidade: um schema de trinta tabelas redesenhava as trinta a cada linha que o modelo escrevia.
- **O "antes" do desfazer é lido no fim do arrasto, não no começo.** O instantâneo envelhecia: uma operação do chat durante o gesto ficava anterior a ele, e um Ctrl+Z depois de arrastar apagava também a tabela que o modelo tinha acabado de criar.
- **Revisão adversarial de 140 agentes** em oito dimensões (terminal, desempenho de render, desempenho de dados, port do openship, órfãos, React Flow, rename/build e segurança), cada achado submetido a três céticos independentes: 44 brutos, 32 sobreviveram, e são eles que estão corrigidos acima. A suíte foi de 1.692 para **1.751 testes** de TypeScript e **172** de Rust — os novos travam justamente o que a revisão encontrou: a fila da inscrição do PTY, a poda por cota, a política de motor, o Dockerfile de site estático e o cursor em texto com emoji.


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
