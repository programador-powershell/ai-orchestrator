<div align="center">

# AI-BOT

![App Screenshot](https://placehold.co/960x540?text=AI-BOT)

🤖

</div>

## :heavy_check_mark: Features

> **Uma tela só.** O produto anterior tinha dez abas e a pessoa precisava saber
> de antemão em qual delas morava o que ela queria. Aqui as dez capacidades
> viraram **especialistas de um bot só**: você escreve, o roteador decide quem
> atende, e a tela se transforma na superfície daquele especialista.
>
> **O que este app é.** A suíte corporativa de IA que substitui as ferramentas
> avulsas da empresa. O quadro abaixo diz o que já substitui DE VERDADE e o que
> ainda não — porque prometer o que não entrega é o defeito que este produto não
> pode ter:
>
> | Substitui | Pelo quê | Estado |
> | --- | --- | --- |
> | ChatGPT | conversa multi-modelo com pesquisa, memória e chaves no cofre | **substitui** |
> | Cursor / opencode | especialista de código: lê, edita, roda e revisa com aprovação | **substitui** (terminal visual ainda não) |
> | drawDB | schema por conversa, ERD e SQL em 3 dialetos | **substitui** |
> | Canva (docs/slides) | edição do binário DOCX/PPTX/XLSX e leitura de PDF | **substitui** para texto; layout visual parcial |
> | OpenCut | corte, concatenação, texto e export de vídeo pelo ffmpeg aprovado | **substitui** o essencial |
> | Grok Build | app por conversa com plano aprovável e execução em sandbox | parcial — preview/publicar em um clique no roteiro |
> | openship | detecção de 47 stacks + Dockerfile correto (porta Apache-2.0) | **substitui** a geração; deploy automático no roteiro |
> | Slate/Salte | templates por Capability Pack | parcial |
>
> **Verificado nesta versão**: gateway Go com gofmt e todos os pacotes de teste
> verdes; Rust com clippy limpo e 136 testes; interface com tsc/build limpos e
> 78 testes. Roteamento exercitado de ponta a ponta com provedor SSE de mentira.

- **Tela única dinâmica** — sem abas, sem menu de modos. A barra lateral
  esquerda, a barra superior, o campo de texto e a cor de acento do app mudam
  conforme o especialista ativo.
- **A conversa tem UM modo**, decidido no **primeiro input** e gravado nela. Da
  segunda mensagem em diante nada é reclassificado: `"agora corrija o login"` vai
  direto para o executor de código porque a conversa já é de código. Reclassificar
  a cada linha custaria latência antes de toda resposta e leria uma frase de
  continuação como pedido isolado.
- **Roteamento em cascata, do barato para o caro** —
  `FAST ROUTER (Go puro, léxico, offline, microssegundos)` →
  `NEEDLE Router Pro (.cact treinado no harness, ~23 MB, cgo, offline, milissegundos)` →
  `MODELO GRANDE (rede, segundos)`. Nem toda decisão precisa de IA; e quando
  precisa, quase nunca precisa da cara.
- **Trocar de modo é explícito**: `/mode code`, `/mode agent`, `/mode swarm` — ou
  o seletor da interface. Nada mais muda o modo de uma conversa em andamento.
- **Cada linha carrega seu especialista**: o ícone do bot aparece antes de cada
  resposta, e a troca de modo entra com a faixa *"agora é X"* e o motivo da rota.
- **Dez especialistas** — Conversa, Código, Documentos, Design, Dados, Trabalho,
  Segurança, Equipe, Fluxo e Tuning — cada um com superfície, barra lateral,
  ferramentas, prompt, atalhos de composer e **retrato próprios**.
- **O modelo é escolhido pelo usuário.** No produto anterior o servidor decidia
  (escolher o modelo é escolher quanto gastar). Aqui a precedência é
  *escolha do usuário > preferência do especialista > padrão do catálogo*, e a
  política decide o que entra no catálogo.
- **xAI/Grok de ponta a ponta** — o catálogo semente traz `grok-4.5` e Grok
  Imagine, com chave no cofre, Chat Completions em streaming, raciocínio separado
  da resposta e afinidade de conversa para aproveitar o cache da xAI.
- **Microkernel de plugins** — provedores/adaptadores LLM, modelos, MCP e
  overlays de especialistas entram por manifestos, perfis e efeitos reversíveis.
  Falha no meio da montagem faz rollback; unload remove todas as capacidades do
  dono. Grok é o primeiro plugin embutido, não uma exceção hardcoded.
- **Laboratório de avatares** — clicar no ícone do AI-BOT na barra lateral abre um
  personalizador: cada bot especialista tem retrato **procedural** (forma, olhos,
  boca, acessório, movimento, matiz, semente), com prévia nos três tamanhos reais
  e exportação em SVG. Não é arquivo de imagem: ninguém ia versionar onze PNGs
  por tema.
- **Equipe de agentes** (especialista `agent`): o orquestrador decompõe o objetivo
  em tarefas com dependências, roda em ondas topológicas, escala quando um
  trabalhador não sabe decidir e abre portão entre ondas. Toda tarefa que escreve
  no repositório roda em **git worktree próprio** — dois agentes editando o mesmo
  arquivo em paralelo produzem um resultado que compila e perdeu metade de uma das
  mudanças.
- **Aprovação humana de verdade**: cada ferramenta é classificada por risco
  (ler / escrever / executar / rede / segredo), o portão intercepta, e "permitir
  sempre" fica preso ao **digest dos argumentos** — senão o primeiro "sim" vira
  cheque em branco. Silêncio **não** é consentimento: sem decisão em 10 minutos, a
  execução é recusada.
- **Canonical Agent Protocol**: um envelope append-only numerado por sessão, igual
  em REST, WebSocket, SSE, MCP e CLI. É a numeração que permite **replay** — quem
  cai reconecta dizendo o último `seq` que viu e recebe o resto, em vez de
  recomeçar a resposta.
- **Local-first**: o disco desta máquina é a fonte da verdade; servidor é cópia. O
  app abre, conversa com o modelo local e não perde nada sem rede.
- **Zero dependências no gateway**: `go.mod` sem um único `require`. WebSocket
  (RFC 6455), armazenamento durável e JSON-RPC escritos à mão — o gateway é o
  processo que segura chave, executa ferramenta e fala com a rede, e cada
  dependência ali é uma análise de TI/SI e uma superfície a mais.
- **Rede guardada**: anti-SSRF com IP **fixado** no dial (validar a URL e depois
  chamar o cliente HTTP deixa o DNS rebinding aberto), bloqueio de domínio por
  fronteira de rótulo (`exemplo.com` não bloqueia `malexemplo.com`) e redirect
  seguido à mão, com as guardas reaplicadas a cada salto.
- **Segredo nunca cruza para a interface**: o cliente manda referência
  (`provider:anthropic`), nunca valor. O cofre só permite **usar** o segredo dentro
  de um callback — a URL de um webhook *é* o segredo, e devolvê-la a quem chama a
  coloca em log e em mensagem de erro.

## :new: Releases Notes

### :up: V.1.2
### :warning: Latest Changes

- **O cérebro do roteamento agora é o Needle Router Pro treinado.** O modelo do
  harness de pesquisa (needle-router-pro/) — treinado SÓ para entender o contexto
  do primeiro input e chamar o especialista dono — entrou como o degrau local da
  cascata. O artefato (needle-router-pro.cact, ~23 MB) é descoberto em
  AIBOT_NEEDLE_MODEL, em <dados>/models/ e ao lado do executável, nessa ordem; o
  log de subida separa os DOIS pré-requisitos (arquivo de pesos e binding cgo),
  para ninguém depurar o lado errado. Pesos, adapter e dataset de treino NÃO são
  versionados — ficam em needle-router-pro/checkpoints/, que o harness já ignora
  de propósito.
- **O limiar do degrau local subiu para 0,78 — calibrado, não chutado.** É o
  confidence_threshold medido sobre holdout pelo próprio harness
  (config/router.json). O harness avisa: o Needle 2.0.5 desabilita a confiança
  calibrada em pesos LoRA, então o .cact treinado só vale com esse portão
  externo por cima — e é exatamente o portão que a cascata aplica.

### :pushpin: Fixes

- **A janela fecha, minimiza e sai do lugar.** Ela sobe sem moldura do sistema
  (`decorations: false`) e a barra superior não tinha controle nenhum: sem X, sem
  minimizar, sem faixa de arrasto. Agora os três botões ficam à direita da barra e
  o espaço vazio dela é a região de arrasto — em faixas próprias, porque botão
  dentro de região de arrasto vira arrasto e para de responder. No navegador do
  `pnpm dev` eles não aparecem: botão de fechar que não fecha é pior que botão
  nenhum.
- **Fechar a janela encerra de verdade o que o app subiu.** O `app_shutdown`
  existia e ninguém o chamava. Quem clicava no X deixava vivos o `aibotd`
  (segurando a porta 8799), os servidores MCP filhos dele e um `powershell.exe`
  por sessão de terminal — e como a abertura seguinte ADOTA o gateway órfão, nada
  parecia quebrado enquanto os processos se acumulavam. O encerramento agora está
  no `CloseRequested` da janela `main`, no Rust, porque a interface pode estar
  travada justamente quando isso importa. Fechar o laboratório de avatares
  continua fechando só ele.
- **`term.open` saiu do catálogo de ferramentas.** Ela abria um ConPTY de verdade
  e respondia "terminal aberto para a pessoa usar" — só que não existe painel de
  terminal na interface. O modelo lia sucesso e seguia raciocinando sobre uma
  janela que ninguém tem, enquanto cada chamada deixava um shell invisível vivo
  até o teto de oito sessões recusar tudo para sempre. Ferramenta ausente é melhor
  que ferramenta que promete o que não entrega: sem ela o modelo usa `proc.run`,
  que passa pela aprovação. Volta quando o painel existir; os comandos `pty_*`
  continuam de pé.
- **A sessão de terminal sai do mapa quando o processo morre.** A thread que
  espera o fim emitia `pty-exit` e ia embora, deixando a entrada — e com ela o
  master do ConPTY, o writer e o killer — presa até o próximo `pty_spawn` varrer.
- **A matiz por módulo funciona.** No produto anterior havia um `transition` sobre
  `--accent-h`: ele encalhava no valor de partida e as nove abas ficavam com o verde
  do Chat — a "cor própria por aba" anunciada nunca existiu. Aqui a matiz troca sem
  animação, e o comentário no `tokens.css` explica por quê para ninguém "melhorar"
  isso de novo.
- **O especialista `fluxo` tem matiz própria** (174). No CSS anterior ele era o
  único sem regra `[data-mode=fluxo]` e caía no verde do Chat.
- **Mandar outra mensagem no meio da resposta não deixa a sessão fantasma.** O
  turno substituído limpava o registro de execução sem conferir de quem ele era, e
  apagava o cancelamento do turno que o substituiu: dali em diante a sessão se
  dizia livre com um turno correndo dentro dela, e o botão de parar não parava
  nada. Agora o registro tem a identidade do turno, e só o dono se desregistra.
- **`worker.done` traz o CAMINHO da cópia isolada.** O supervisor pedia a cópia
  pela ferramenta do modelo e guardava o que ela devolve — a frase "cópia isolada
  criada em C:\… (ramo aibot/x)" — num campo documentado como caminho. Quem fosse
  usar o campo (a tela, um diff) recebia uma frase. O isolamento da equipe agora
  fala com o `worktree.Manager` direto, que devolve caminho e ramo tipados; a
  ferramenta continua em texto, porque ela é para o modelo ler.
- **Escalar não conta como falha da onda — mas ainda para a onda.** O trabalhador
  que se recusa a adivinhar e escreve `ESCALAR:` era contado como falha, e o portão
  dizia "1 tarefa falhou", empurrando quem lê para "refazer" — que não é o que se
  responde a quem pediu esclarecimento. Agora são duas contagens: escalação sai do
  número de falhas e do `✗` do relatório, e o texto do portão diz quantas falharam
  e quantas estão esperando resposta. O que **não** mudou é a pausa: escalação
  continua abrindo o portão, porque `results` só é escrito por quem entregou — sem
  a pausa, a tarefa dependente receberia o bloco do upstream vazio e adivinharia
  exatamente o que o trabalhador se recusou a adivinhar.
- **E a tela também para de chamar isso de falha.** `worker.done` passou a carregar
  `escalated`, e quem escalou ganhou estado próprio: **amarelo** no grafo, "escalou"
  no rótulo, mão levantada no lugar do triângulo de alerta, fora do contador de
  falhas e fora do de concluídas. Antes o nó ficava **vermelho** ao mesmo tempo que
  a faixa logo acima pedia resposta — a mesma coisa contada duas vezes, com dois
  significados —, e o número de falhas da tela discordava do que o gateway usa para
  abrir o portão. A regra virou uma função só (`lib/crew.ts`), com teste: as três
  telas que julgavam `worker.done` por conta própria — Equipe, Quadro e o trilho —
  davam **três respostas diferentes** para o mesmo evento, e o trilho ainda deixava
  a tarefa em "aguardando resposta" para sempre depois de respondida.
- **O estado do nó no grafo deixa de ser um fio de 1px.** A cor do estado vivia só
  na borda de 1,25px, e medida contra o fundo do grafo **três dos quatro estados
  reprovavam** o 3:1 que a WCAG 1.4.11 pede para identificar estado de componente:
  não começou 2,18 · concluído 2,93 · falhou 3,92 (o único que passava) — e
  escalado, que entrou agora, 2,66. O conserto é nos dois eixos, porque nenhum
  resolve sozinho: o **preenchimento** recebe 10% da matiz do estado (um retângulo
  de 186×62 é visível, um fio não — mas tom suave não move o número), e a **borda**
  mistura o tanto de tinta que cada matiz precisa para chegar a 3:1, medido nos
  dois temas e nas dez matizes de especialista. O rótulo dentro do nó escureceu
  20% junto: sobre o preenchimento tingido ele caía para 3,79:1 e reprovava o AA
  de texto miúdo; agora é 4,81:1 no pior caso, melhor que os 4,53:1 de antes.
- **O estado da tarefa no trilho passa pelo ícone, não pela cor.** Havia três
  regras `.rail-task[data-state=…]` que não casavam com nada — o trilho sempre
  escreveu `data-tone`, com `run|ok|fail|ask`. Consertar o seletor era de uma linha
  e foi medido antes de entrar: naquele tamanho (9px, caixa-alta, espaçada) nenhum
  matiz da paleta passa o AA no tema claro (`ask` 2,76:1, `run` 2,75:1, `ok`
  3,04:1, `fail` 4,06:1) contra os 4,11:1 do cinza que já estava lá. As regras
  mortas estavam, por acidente, protegendo a legibilidade. Quem diferencia agora é
  o ícone — mão levantada para quem escalou, triângulo para falha.
- **O marco do replay só anda depois que o envelope foi aplicado.** O transporte
  guardava o `seq` ANTES de chamar a redução do store: uma exceção lá dentro subia
  por `receive` e por `onmessage`, onde ninguém a pega, e o envelope ficava sem ser
  aplicado — com o marco já adiantado. Na reconexão, o `resumeFrom` pedia a partir
  de um ponto **depois** do buraco e a linha sumia da conversa para sempre, que é
  exatamente a invariante que o `seq` existe para garantir. Agora aplica primeiro,
  marca depois, e a falha vai para o console em vez de sumir com o dado.
- **A preferência não grava mais a cada tecla.** O `persist` do zustand escreve a
  cada `setState` sem comparar nada, e este store recebe um `set` por token de
  resposta: um turno de 800 tokens eram 800 `JSON.stringify` e 800 escritas
  síncronas na thread que desenha (o `partialize` encolhe o payload, mas o custo é
  por `set`, não por byte). O armazenamento agora **coalesce** a rajada numa
  gravação por janela, **pula** o valor idêntico ao que já está no disco e
  **descarrega no fechamento** (`pagehide`/`visibilitychange`). O
  `QuotaExceededError` é engolido com aviso: ele nascia dentro do `setState` e
  derrubava o **envio da mensagem** — perder a preferência de tema é aceitável,
  perder a mensagem não.
- **O 409 do gateway virou frase.** O `post` lançava `o gateway recusou … com 409`
  e jogava o corpo fora, justamente onde mora o texto acionável ("o Docker
  Sandboxes não está instalado — instale o Docker Desktop e o sbx…"). Agora o corpo
  é lido, o `error.message` do contrato vira a mensagem do erro (com o status
  junto) e ela chega ao alerta do composer pelo desfazer do `setEnvironment`. O
  crachá do rodapé também passou a levar o motivo na dica: antes escrevia
  "indisponível" sem dizer o que fazer para passar a ser disponível.
- **"Refazer" no portão da equipe agora refaz.** A tela tinha o botão, o
  WebSocket levava a decisão, o gateway a validava, publicava e escrevia
  "portão da onda 1: retry" no relatório — e `runCrew` só tratava `abort`. Retry
  caía no mesmo caminho de `proceed`: a onda NUNCA era reexecutada e quem clicou
  seguia para a onda seguinte com a dependência vazia, achando que tinha mandado
  refazer. Agora a onda volta a rodar, só com as tarefas que ficaram sem
  resultado — reexecutar quem deu certo repetiria efeito colateral já aplicado
  (um commit, um arquivo escrito) — e no máximo três vezes, senão dois cliques
  prendem a equipe num laço.
- **A árvore de equipes tem fim.** O especialista `agent` tem `task.dispatch` no
  catálogo, e um trabalhador é um especialista rodando com as ferramentas dele —
  logo um trabalhador `agent` podia montar outra equipe, que montava outra, sem
  teto nenhum, cada nível multiplicando por até 128 tarefas. A delegação tinha
  dois limites desde sempre; este caminho não tinha nenhum.
- **Os limites da política deixaram de ser decorativos.** `MaxDepth`,
  `MaxChildren` e `MaxTotal` eram declarados, tinham padrão, podiam ser
  configurados pelo JSON do administrador — e **nenhuma linha do gateway os
  lia**. Agora governam a profundidade da árvore de equipes, o paralelismo de
  cada onda e o total de trabalhadores do turno inteiro, e ainda APERTAM os tetos
  da delegação (só para baixo: uma política frouxa não afrouxa o teto do
  produto). Limite que se configura e não se aplica é pior que limite nenhum —
  quem o configurou passa a acreditar que está protegido.
- **O bloco de delegação de um trabalhador não vaza mais como texto.**
  `runWorker` só entendia `aibot:tool`; um `aibot:delegate` emitido dentro de uma
  equipe não era executado nem removido, e o JSON cru virava o "resultado" da
  tarefa — ia para o relatório e era servido como contexto para as tarefas
  dependentes. Agora o bloco é recusado com instrução (resolva ou escale) e o
  resultado final passa por `stripBlocks`.
- **"Crie uma aplicação em next.js completa" agora vai para o Código — no
  primeiro degrau, sem gastar modelo.** Uma sonda no roteador mostrou que o jeito
  mais comum de pedir software não pontuava em especialista NENHUM: o léxico só
  conhecia o vocabulário de quem já está DENTRO do código (bug, refator, stack
  trace), e não o de quem está pedindo um. O pedido caía na clarificação. Junto
  veio o segundo problema: o peso de um radical era o COMPRIMENTO dele, e "sql",
  "erd", "css" e "gif" têm três letras sem ser ambíguos em nada — "desenhe o
  banco e exporte o SQL" pontuava 0,46, abaixo do limiar, e ia para o modelo
  grande decidir o óbvio. **Palavra inteira** passou a pesar mais que prefixo, o
  que de quebra desinfla o falso positivo de "cor" dentro de "corta". Medido:
  aplicação Next.js 0,00 → **1,00**; banco+SQL 0,46 → **0,68**; vídeo 0,46 →
  **0,60**; equipe em paralelo 0,46 → **0,68**.
- **Uma fila de aprovações, no lugar de um slot.** Uma onda de equipe com quatro
  trabalhadores dispara quatro pedidos ao mesmo tempo, e o segundo SOBRESCREVIA o
  primeiro: a pessoa via um cartão, decidia um, e os outros ficavam presos até o
  prazo de dez minutos — recusados por silêncio, segurando a onda, o despacho e o
  turno do dono da conversa junto. Com `maxConcurrency` até 32, 31 pedidos podiam
  morrer sem nunca aparecer na tela. O cartão agora mostra "+N na fila".
- **A concessão de aprovação ficou presa a quem a recebeu.** "Aprovar sempre" com
  digest de `ferramenta+argumentos` puro valia em qualquer lugar: o sim dado
  olhando o Código no repositório A liberava o mesmo caminho relativo no
  repositório B, e liberava também o Design, que tem `fs.write` no catálogo.
  Agora o digest carrega o par (projeto, especialista), e a liberação "para a
  sessão" é por especialista.
- **A decisão humana entra no log durável.** Ficava `tool.call → approval.request
  → tool.result(ok)`, e lendo depois não dava para distinguir "a pessoa
  autorizou" de "a política era aprovar tudo" — sumia justamente o registro do
  último degrau antes do efeito colateral.
- **Orçamento de contexto: a colagem grande não mata mais a conversa.** O corte
  era por CONTAGEM (40 mensagens) e nunca por tamanho, e a janela do modelo
  (`Model.Context`) não era lida em lugar nenhum. Colar 116 KB de log fazia o
  turno 1 falhar com 400 — e o turno 2 ("oi") falhar com o MESMO 400, para
  sempre, porque a colagem voltava no prompt. Agora o prompt é cortado por
  tamanho, mensagem de sistema nunca é descartada (a política não é negociável) e
  uma colagem que não cabe sozinha entra truncada com a marca do corte.
- **O resultado das ferramentas voltou ao histórico.** Só `KindMessage` era
  dobrado: no turno seguinte o modelo via a própria afirmação ("o arquivo diz
  42") e nenhum traço do que o arquivo continha. Ou relia — custo e nova
  aprovação — ou seguia em cima da própria alegação, que é como resposta
  plausível vira invenção.
- **Cada bot fala na própria bolha.** Numa onda, dois trabalhadores streamavam no
  mesmo turno e o segundo não abria linha: o texto dos dois era concatenado, token
  a token, sob o avatar do primeiro. E depois de uma delegação, a conclusão de
  quem delegou caía na bolha aberta pelo delegado — a resposta final aparecia
  assinada pelo bot errado. A linha agora é achada por `turn` + **quem falou**.
- **O cartão da escalação parou de prometer o que não cumpre.** Responder por ali
  envia uma mensagem nova, e mensagem nova cancela o turno em curso — que, com o
  portão aberto, é o turno que segura a equipe. O plano morria enquanto o texto
  dizia "o orquestrador retoma a tarefa". Agora o cartão avisa, e quem quer só
  destravar a onda usa os botões do portão.
- **Anexo sem texto voltou a ser um pedido.** O composer libera esse envio de
  propósito, e o turno o recusava na PRIMEIRA linha — antes de existir id de
  turno para carimbar qualquer envelope. Nada chegava à tela: o `busy` do cliente
  nunca fechava, o orbe girava, e o chip do anexo já tinha sido apagado. A pessoa
  perdia o arquivo e o pedido sem uma palavra, justamente no caso que o
  roteamento por extensão existe para atender (`.docx` resolve para o
  especialista de escritório com confiança 1). Agora o texto é sintetizado dos
  nomes. E, como rede independente, **toda** saída antecipada do turno passou a
  publicar um erro na sessão em vez de só registrar no log do servidor.
- **`task.dispatch` deixou de ser a porta dos fundos da política.** O plano da
  equipe agora passa pelas mesmas regras da delegação: o especialista tem de
  existir no catálogo, não pode ser o `master` — que só decide quem atende — e
  precisa estar liberado pela política da sessão. O id inexistente era o pior dos
  três, porque não falhava: `GetOrDefault` devolvia o `chat` calado, e o
  relatório dizia que a tarefa de segurança tinha sido feita, por outro
  especialista e com outras ferramentas.
- **A política do admin chega ao trabalhador da equipe.** Ele recebia apenas o
  `system` do especialista: bastava o modo agente despachar uma tarefa para que a
  política corporativa e o prompt dos pacotes deixassem de valer, em silêncio —
  nada falha quando um system prompt simplesmente não vai junto. As três
  montagens (turno, delegação, trabalhador) passaram a usar **um** cabeçalho só.
- **`/mode <id>` com quebra de linha volta a ser comando.** O corte era no
  literal `" "`, nunca em `\n` ou `\t`: quem escrevia `/mode office`, apertava
  Shift+Enter e digitava o pedido na linha de baixo não trocava de modo, e sem
  aviso. E **`/mode` de especialista barrado pela política** agora é recusado com
  o motivo, em vez de esvaziar o texto, descer a cascata inteira classificando
  nada e gravar na conversa um modo que ninguém pediu.
- **Trabalhador que não escreve nada não conta como concluído.** Resposta vazia
  do provedor (filtro de conteúdo, completion vazia, só espaço em branco) virava
  ✓ no relatório com resultado vazio: o portão não abria e a tarefa dependente
  recebia o bloco do upstream em branco e adivinhava.
- **Duas equipes ao mesmo tempo não disputam a mesma cópia isolada.** O id da
  tarefa vem do modelo, e modelo gera `t1`; a cópia do repositório era criada com
  esse id e nada mais. Duas equipes coincidindo no tempo — duas conversas
  abertas, ou uma sub-equipe ao lado da que a criou — pediam a MESMA cópia, o
  `git worktree add` recusava a segunda e a tarefa morria com "não foi possível
  isolar a tarefa", um erro sem relação nenhuma com o trabalho dela. Agora o
  turno da equipe (único) prefixa o id. O isolamento em si nunca esteve furado: a
  falha era ruidosa, não silenciosa.
- **A decisão do portão ecoa no log — e reabrir a conversa não repete a
  pergunta.** A tela fecha o cartão na hora, sem esperar resposta, então nada
  parecia errado enquanto a conversa estava aberta. O `gate` GRAVADO, porém, não
  tinha decisão nenhuma — e o log é reencenado ao reabrir: o cartão voltava, em
  `role="alertdialog"`, chamando a pessoa para decidir uma onda que terminou faz
  tempo. Uma segunda janela na mesma sessão também nunca ficava sabendo. Agora a
  decisão é publicada com o motivo junto, o que de quebra distingue no log o
  "seguir" escolhido do "seguir" por esgotamento do prazo de dois minutos.
- **O gateway volta a compilar em máquina com compilador C.** `needle_shim.c` não
  tinha restrição de build, ao contrário do `session_cgo.go` que o acompanha. Onde
  há gcc, `CGO_ENABLED` vale 1 por padrão, o Go passa a considerar os arquivos `.c`
  do pacote e um `.c` sem nenhum `.go` importando "C" é **erro de compilação**.
  Nesta estação, sem compilador C, `CGO_ENABLED` é 0 e nada disso aparecia; no
  primeiro CI com gcc, `go build ./...` quebraria sem que uma linha tivesse mudado.

### :construction_worker: Refactors

- **O motor multi-bot passou a ser executado nos testes, não só lido.** O que
  existia cobria duas funções puras (`escalation` e `gateReason`); o CAMINHO —
  de `task.dispatch` ao relatório de volta — nunca tinha rodado. A bancada nova
  exercita os três modos de verdade: **um bot só** (uma chamada de modelo, uma
  resposta, zero equipe), **um bot chamando outro** (duas delegações no mesmo
  turno, cada popup com seu par abre/fecha) e **vários bots** (DAG em ondas, com
  o resultado de uma tarefa chegando ao prompt de quem depende dela — a prova de
  que a onda 2 não trabalhou às cegas). Três dos quatro defeitos corrigidos acima
  foram encontrados por ela. O provedor de mentira roteia por **conteúdo**, não
  por ordem: numa equipe os trabalhadores rodam concorrentes, e um roteiro
  sequencial entregaria a fala de um trabalhador a outro conforme o escalonador
  do dia — um teste que passa e falha sozinho é pior que teste nenhum. O
  paralelismo é medido pelo **pico real de chamadas simultâneas**, não pela
  confiança no que o plano prometeu.
- **Desempenho medido, não achado.** Todo ganho abaixo saiu de um A/B **intercalado
  no mesmo processo**, e não de "antes" e "depois" em execuções separadas — esta
  máquina faz *throttling* térmico, e o mesmo código chegou a medir 21 µs numa
  rodada e 58 µs na seguinte. Medir errado teria vendido ruído como otimização. Os
  benchmarks ficaram no repositório: regressão que ninguém mede volta.

  | caminho | antes | depois | ganho |
  | --- | --- | --- | --- |
  | streaming de 800 pedaços (markdown) | 298,5 ms | 15,8 ms | **18,9x** |
  | fio de 10 linhas + 200 deltas | 141,0 ms | 4,2 ms | **33,7x** |
  | `office.edit` — 3001 trocas em 2,8 MiB | 600,4 ms | 17,0 ms | **35x** |
  | `store.Append` (envelope durável) | 3,15 ms | 0,36 ms | **8,7x** |
  | `store.Append` (delta de streaming) | 2,14 ms | 0,011 ms | **193x** |
  | replay completo de 5.000 envelopes | 210 ms | 41,9 ms | **5,0x** |
  | abrir sessão com log de 5.000 | 21,6 ms | 2,5 ms | **8,5x** |
  | roteamento sticky (90% das mensagens) | 1623 ns · 4096 B | 99,8 ns · **0 B** | **16x** |
  | `pdf.extract` — 2 MiB | 14,8 ms | 5,4 ms | **2,7x** |

  As causas, em uma linha cada: o markdown reparseava a resposta inteira a cada
  token (agora só o bloco em aberto, e os fechados voltam por referência, então o
  React nem entra na subárvore); o `office.edit` aplicava cada troca com
  `replace_range`, que **move o resto da string** — quadrático no número de trocas;
  o `store` dava `fsync` no cabeçalho a cada envelope, **inclusive nos deltas** que
  o próprio código tinha o cuidado de não sincronizar; o replay relia o log do
  começo a cada página, e abrir sessão varria tudo só para achar o último `seq`; e
  o caminho sticky — o que a arquitetura promete custar zero — copiava o catálogo
  inteiro de especialistas só para perguntar se um id estava na lista.
- **Um protocolo, cinco transportes.** REST, WebSocket, SSE, MCP e CLI serializam o
  mesmo envelope; nenhum decide nada. No produto anterior cada caminho tinha sua
  mensagem, e foi assim que a aprovação de ferramenta valia na interface e não valia
  no caminho MCP.
- **A regra de bloqueio de domínio tem uma implementação só.** `netguard` delega
  para `permissions.HostBlocked` em vez de repetir o casamento por fronteira de
  rótulo. Duas cópias divergem, e a que diverge é a que o atacante encontra.

## :wrench: Instalação

Instala as dependências da interface.
```
corepack pnpm install
```

Compila o gateway (sem o roteador local; é o build padrão).
```
go build -o dist/aibotd ./services/gateway/cmd/aibotd
```

Inicia o app desktop em modo desenvolvimento.
```
corepack pnpm --filter @aibot/desktop tauri dev
```

Gera o build de produção.
```
corepack pnpm --filter @aibot/desktop tauri build
```

### Usar com Grok

Na primeira execução, `xAI`, `grok-4.5` e `Grok Imagine` já aparecem no catálogo,
mas o provedor nasce desligado para nenhum prompt sair da máquina sem escolha.
Abra **Configurações → Modelos e provedores**, digite a chave na linha **xAI**,
marque **habilitado**, salve e use **Testar**. Depois escolha **Grok 4.5** no
seletor de modelo.

Quem já tinha um `catalog.json` não precisa migrá-lo: o plugin embutido compõe
xAI e os dois modelos por baixo do arquivo existente. Salvar a linha xAI na tela
materializa somente a chave e o override local.

## :file_folder: Diretórios

```
├── Raiz
│   ├── apps
│   │   └── desktop
│   │       ├── src         # a tela única: shell, especialistas e avatares
│   │       └── src-tauri   # Rust: janela, PTY, Job Object, cofre do SO
│   ├── packages
│   │   └── contracts       # espelho TypeScript do protocolo
│   ├── services
│   │   └── gateway         # Go: o cérebro (binário aibotd)
│   │       ├── cmd
│   │       └── internal    # protocol, specialist, supervisor, needle, store…
│   ├── scripts             # release: manifesto assinado e par de chaves Ed25519
│   └── docs                # arquitetura, atualização e créditos de inspiração
└── main
```

## :rocket: Executáveis

| Nome                  | Descrição                                                                       |
| --------------------- | ------------------------------------------------------------------------------- |
| AI-BOT.exe            | Aplicativo desktop (Tauri); sobe o gateway como sidecar                          |
| aibotd                | Gateway Go: `aibotd` sobe o servidor; `serve`, `token`, `specialists`, `version` |
| aibotd -tags needle   | Mesmo gateway com o roteador local ligado (exige a biblioteca nativa)            |
| pnpm tauri dev        | Interface em desenvolvimento, com recarga                                        |
| gerar-manifesto.mjs   | Mede, assina (Ed25519) e confere o manifesto de atualização — `pnpm manifesto:gerar` e `pnpm manifesto:verificar` |
| gerar-chaves.mjs      | Gera o par Ed25519: a pública para embutir no build, a privada para o cofre da TI |
| go test ./...         | Bateria do gateway (roteador, DAG, store, rede, permissão, protocolo, barramento)|
| pnpm test             | Bateria da interface (redução de envelope do store)                              |
| pnpm manifesto:test   | Bateria do gerador de manifesto (assina, confere, corpo canônico estável)         |

## :computer: Acesso

Para o gateway local acesse http://127.0.0.1:8799/health

O gateway **exige token** mesmo em loopback: o processo executa ferramenta, e
"é só localhost" não é fronteira de segurança numa máquina com navegador. O token
é gerado na primeira execução em `%APPDATA%/AI-BOT/token` e sai também por
`aibotd token`. Não há usuário nem senha padrão.

![App Screenshot](https://placehold.co/960x540?text=AI-BOT)

## :book: Documentação

### :link: [Wiki](docs/arquitetura.md)

### :electric_plug: [Plugins e perfis](docs/plugins.md)
