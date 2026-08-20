# Execução na janela do bot — o contrato da correção

Três defeitos, uma raiz comum: o sub-turno delegado é um turno de verdade — com
modelo, ferramentas, aprovações e um resultado que a pessoa espera ver — mas o
fork o trata como um detalhe interno do turno do dono. O trabalho é emitido na
sessão errada, morre num teto que joga fora dezesseis chamadas boas com um
motivo genérico, e nunca envolve o Design porque a composição foi deixada para
um roteador que decide UMA vez.

Este documento é o CONTRATO da correção. Cada item tem três partes: como o
original (`C:/Users/daniel.paim/Documents/Code/ai-orchestrator-main`) resolve o
mesmo problema, como o fork está hoje, e o delta mínimo. Nada aqui é
implementação; é o que a implementação não pode contrariar.

Uma advertência antes de tudo: o original NÃO tem sub-turno delegado, não tem
envelopes e não tem roteador de intenção. Copiar "como o original faz" ao pé da
letra é impossível — o que se copia é o princípio, e o princípio do original é
um só, repetido em três lugares: **a janela que mostra o trabalho é dona do
container onde o trabalho é escrito.**

---

## 1. O sub-turno delegado emite NA SESSÃO DA FILHA

### Como o original faz

No original não existe delegação — mas existe o análogo exato do nosso
problema: o nó `agent` do DAG (`apps/desktop/src/modes/AgentView.tsx`). O
`runGraph` (linha 367) executa cada nó com `chatOnce`, e o `onDelta` do nó
escreve em `useFlow.runs[id]` via `patchRun` (linhas 500-512) — **nunca** em
`threads.agent`, o thread da conversa. O inspector renderiza os dois containers
lado a lado ("Execução do nó" e "Resposta do composer", linhas 1046-1120) e a
janela que exibe a execução lê exatamente o container em que ela foi gravada.
O mesmo princípio vale nas superfícies com ops: `DataView` e `WorkView` nunca
renderizam o texto cru do modelo — só a mutação aplicada na própria superfície
(`opsBus` em `apps/desktop/src/lib/ops.ts`; assinatura nas views). E o fusion
(`apps/desktop/src/lib/engine.ts`, `quietTurn` linhas 286-302) cala os estágios
intermediários por contrato: intermediário mudo, final na janela.

### Como o fork está

`services/gateway/internal/supervisor/delegate.go`, `delegateWithRoute` (linha
324): o laço do sub-turno (linhas 482-566) emite **tudo na sessão do dono**
(`sessionID`) — o `thinking` do delegado (486), os deltas do `runModel` (487; o
`streamSink` de `supervisor.go:616` publica em `s.session`, que é a raiz), os
`tool.call`/`tool.result` e os `approval.request` do `executeTool` (544; ver
`supervisor.go:1074` e `1171`). A conversa FILHA (`filho`, criada por
`mirrorDelegation`, linha 648) recebe apenas: a rota (caminho do master, linha
413), o pedido como fala do usuário (661) e — no `finish` (429) — a resposta
final e o `done`.

O cliente assina UMA sessão por vez (`apps/desktop/src/lib/transport.ts`:
`hello` com `sessionHint`, replay por sessão; o barramento é por tópico —
`services/gateway/internal/eventbus/eventbus.go`). Consequências concretas:

- quem olha a RAIZ vê o trabalho cru do delegado — inclusive uma bolha de
  deltas que o replay da raiz **não reconstrói** (delta é efêmero e a resposta
  do delegado deliberadamente não vira mensagem no log da raiz, delegate.go
  linha 524-530): a tela ao vivo e a tela reaberta contam histórias diferentes;
- quem clica na linha da filha durante a execução encontra a janela morta: só
  a pergunta, nenhuma ferramenta, nenhum progresso — exatamente o "log de quem
  pediu" que a leitura do original condenou;
- o replay da filha reconstrói pergunta + resposta final. A IDE/superfície da
  filha não tem por onde derivar o que foi gravado no projeto, porque os
  `tool.result` que diriam isso moram no log da raiz.

### O delta mínimo

Dentro do laço do sub-turno, **o alvo dos envelopes de execução passa a ser
`filho`** quando ele existe (fallback para a raiz quando `mirrorDelegation`
devolveu vazio — o espelho falhar não pode calar o trabalho):

- `thinking` do delegado, deltas do `runModel` e o par
  `tool.call`/`tool.result` do `executeTool` saem na filha. Em `delegate.go`
  isso é o `sessionID` passado nas linhas 486-487 e 544 virar o id da filha;
- `approval.request`/`approval.decision` saem na filha (log durável, replay
  honesto) **e são espelhados na raiz**: o cliente só assina uma sessão, e a
  pessoa normalmente está olhando a raiz quando o cartão abre. O `Decide()` é
  por `callID`, não por sessão (`supervisor.go:1217`), então o cartão da raiz
  aprova o trabalho da filha sem mudança no funil; o redutor já deduplica por
  `callId` (`store.ts`, `approval.request`/`dropApproval`) e o eco da decisão
  fecha o cartão nas duas janelas. O cartão de ENTREGA
  (`workspace.promote`, contrato do cliente em
  `apps/desktop/src/lib/entrega.ts`) segue a mesma regra — a promoção pertence
  ao turno, o pedido aparece onde a pessoa está.

**O que o espelho da raiz mantém**, intacto: o par `KindDelegate`
abre/fecha com `Goal`/`Result` (linhas 424 e 433) — é o que o popup anuncia
(`shell/DelegationPopup.tsx`), o que a linha aninhada da barra usa
(`comConversaDoBot` em `store.ts:465`) e o que o `history()` dobra para o
modelo do dono (`supervisor.go`, case `KindDelegate`, linhas 912-931); o
`thinking` do master ("chamando o especialista X…", `masterDelegate` linha
749); e o aviso de sistema na recusa/falha (linha 785). A raiz continua
contando a delegação inteira — como resumo, não como transcrição.

**O que o replay da filha passa a reconstruir**: a rota, o pedido (user), cada
`tool.call`/`tool.result` (é deles que a IDE, o schema e o canvas derivam a
superfície — a vantagem estrutural que o original não tinha: o `opsBus` dele
perde publish sem listener, e o nosso log durável aplica retroativamente ao
abrir a janela), os pares de aprovação, a resposta final na voz do bot e o
`done`. Deltas e `thinking` continuam efêmeros nos dois lados — replay não
reencena digitação (invariante do `streamSink`, `supervisor.go:624-628`).

---

## 2. O laço sem teto-que-queima-trabalho

### Como o original faz

O original não tem laço aberto para estourar. A unidade é `chatOnce`
(`apps/desktop/src/lib/engine.ts:419`): uma chamada com streaming ou um
pipeline de estágios **contados de antemão** — fusion `orchestrate` são
exatamente 3 chamadas, `merge` é 1+N+1 (`fusionTurn`, linha 314). O único teto
duro é de TEMPO por chamada (`services/gateway/src/routes.rs:537`, timeout
90 s com clamp 1 s–180 s e fallback de provedor; `src-tauri/src/terminal.rs:201`,
120 s por comando). E quando algo morre, o trabalho feito sobrevive: `stopRun`
(`AgentView.tsx:361`) mantém os nós concluídos com `status done` e output
inspecionável, marca os não executados como `skipped · execução interrompida` e
o resumo diz quantos nós deram certo; o abort do Composer (linha 392) deixa os
deltas já transmitidos no balão e persiste a conversa. **Falha carrega o motivo
verdadeiro e nunca apaga o que aconteceu.**

### Como o fork está

`delegate.go:66`: `maxDelegationRounds = 4`, e ao esgotar, a linha 568 chama
`finish(false, "não concluiu em %d rodadas")` — o desfecho genérico que
mascara o motivo, o staging do turno é descartado pelo `defer`
(`masterDelegate:743`, `runTurn` em `supervisor.go:244`) e as dezesseis
chamadas boas viram um aviso vermelho. O próprio fork já documenta a classe de
falha em `crew.go:585-587`: a tarefa "morre por esgotamento com o motivo errado
no log". O agravante é de desenho: o teto de 4 foi calibrado para o bot-a-bot
("o delegado recebeu UMA coisa pontual", comentário nas linhas 62-66), mas o
caminho do master (`masterDelegate`, linha 710) reusa o MESMO laço para o
pedido **inteiro** da pessoa — "construa um site" é um turno de quem atende,
não uma coisa pontual.

### O delta mínimo

Três partes, e as três são o princípio do original adaptado — estágio contado,
trabalho preservado, progresso nomeado:

1. **Teto por papel.** O sub-turno do master (`origin.ID ==
   specialist.MasterID`) usa o teto do turno principal — `maxToolRounds = 8`
   (`supervisor.go:45`) — porque ele É o turno da pessoa, apenas emitido na
   filha. O bot-a-bot mantém 4: ali o argumento original ("um delegado que
   precisa de oito rodadas está resolvendo o problema de quem delegou")
   continua certo.

2. **Estourar não queima.** Ao esgotar as rodadas, o desfecho não é mais o
   `finish(false, …)` genérico: uma última chamada SEM contrato de ferramenta
   ("relate o que você concluiu e o que ficou faltando — não chame mais nada")
   produz o relato de encerramento. Se houve efeito consumado no sub-turno
   (`executouEfeito` já existe, linha 480), o resultado é **PARCIAL**: o
   staging é promovido pelo mesmo caminho do sucesso (cada ferramenta que o
   encheu passou pelo portão de aprovação — o trabalho é legítimo) e o texto
   diz o que entrou e o que falta, com o motivo real (rodadas usadas, última
   ferramenta executada). Sem nenhum efeito, a falha continua falha — mas com o
   motivo verdadeiro no lugar de "não concluiu em 4 rodadas". O portão de
   narração continua valendo dentro do relato: parcial descreve o que
   ACONTECEU, nunca o que foi encenado. O cancelamento (`ctx.Err()`) não muda:
   staging descartado é o invariante certo para interrupção — nada meio-escrito
   chega à pessoa; o que muda é só o esgotamento, onde cada efeito foi
   deliberado e aprovado.

3. **Progresso visível em turno longo.** `thinkingLabel`
   (`supervisor.go:1575`) colapsa toda rodada > 0 em "trabalhando"; o rótulo
   passa a contar — "rodada 3/8 · rodando ferramentas" — que é o `onStage`
   nomeado do fusion do original ("claude-sonnet-5 especificando", faixa do
   Composer) adaptado ao nosso orbe. Com o item 1, esse pulso bate na janela da
   filha, que é onde a pessoa que clicou na linha está olhando.

Armadilha registrada: **subir o número sem mudar o desfecho não corrige
nada** — a classe de falha é "rodada aberta com teto que descarta", não "teto
baixo". O 8 sem o parcial só faz a mesma fogueira demorar o dobro.

---

## 3. O envolvimento do Design

### Como o original faz

Não há roteador: o modo é uma ABA escolhida à mão (`apps/desktop/src/App.tsx`,
mode-tabs) com motor fixo (`settings.engines[mode]`), e a ponte
Código↔Design é o USUÁRIO — ele constrói na aba Code e leva o resultado ao
Design colando HTML/CSS (`extractTokens`, `apps/desktop/src/lib/htmlTokens.ts`,
100% local) ou apontando a URL do site publicado
(`design_replication`, `services/gateway/src/routes.rs:658`, captura estática
com guarda SSRF que bloqueia localhost e IP privado). O Design **nunca lê o
filesystem do projeto** (DesignView não importa fsx). O único encadeamento
automático que existe é textual: no DAG, a saída dos `dependsOn` é concatenada
como markdown no prompt do próximo nó (`runGraph`, AgentView.tsx) — esse é TODO
o contrato de passagem entre "papéis". A composição é sempre opt-in explícita
de alguém que enxerga o pedido inteiro.

### Como o fork está

O roteador em cascata (`router.go`) decide UM especialista no primeiro input e
o master delega para o vencedor (`masterDelegate`). "Crie um site completo"
vence no `code` — e o `design` nunca entra, apesar de todas as peças já
existirem: o mecanismo de delegação bot-a-bot está pronto e o
`delegateContract` (delegate.go:264) já lista o design como par chamável; a
filha herda o MESMO projeto da raiz (`store.ChildSession` herda o CWD —
comentário em `masterDelegate:729-735`); e a persona do design
(`services/gateway/internal/specialist/specialist.go:367`) já manda ler o
projeto: "o index.html que o Código gravou está no mesmo projeto, e é dele que
você extrai o sistema". O que falta não é mecânica — é a decisão de usá-la.

### O delta mínimo

**Quem decide é o especialista que atende, não o roteador.** É a adaptação
fiel do original: lá, quem compõe estrutura+visual é quem enxerga o pedido
inteiro (a pessoa trocando de aba); aqui, quem enxerga o pedido inteiro é o
Código atendendo a delegação do master — e o gesto de compor já tem nome na
casa: delegar.

- **Quando:** o contrato de delegação (ou a persona) do `code` ganha o
  gatilho explícito — pedido com camada visual (tokens, paleta, tema,
  tipografia, responsivo) → **depois de gravar a estrutura**, delegue ao
  `design` em vez de improvisar CSS. A ordem importa: o design lê o que existe;
  chamado antes do `fs.write`, ele desenha de cabeça, que é exatamente o que a
  persona dele proíbe.
- **O que trafega:** o `goal` textual citando **os caminhos gravados**
  (`index.html`, a folha de estilo) — nunca o HTML inline (estoura o goal, o
  contexto e o teto de 20 000 do resultado) e nunca uma URL local (o
  `design.replicate` deve manter a guarda anti-SSRF do original: IP privado é
  recusado, e servir o site só para o replicate buscar seria reintroduzir o
  problema que o original adiou de propósito). O canal de volta é o mesmo de
  toda delegação: o `Result` textual que o dono integra.
- **Onde o trabalho aparece:** com o item 1, as ferramentas do design
  (`fs.read`, `design.replicate`, `fs.write` de tokens) emitem na conversa
  FILHA do design — o canvas dele deriva dos `tool.result` dela, e a linha
  "Design" na barra é onde a pessoa continua a conversa visual depois.
- **Orçamento já comporta:** master→code é profundidade 1, code→design é 2 —
  o `maxDelegationDepth = 2` (delegate.go:51) aceita; uma chamada ao design
  cabe folgada nas `maxDelegationsPerTurn = 3` (linha 56).

Duas decisões registradas como desvio deliberado do original:

1. o Design do fork **lê o disco do projeto** (o original só aceita URL pública
   ou colagem). A razão: raiz e filha compartilham a mesma pasta por desenho, o
   `fs.read` passa pelo `permissions.Gate` como qualquer ferramenta, e entregar
   o HTML "colado como texto" — o caminho fiel — pagaria o custo de contexto
   sem ganhar segurança nenhuma;
2. ensinar o roteador a "detectar design" no primeiro input **não** é a
   correção: o vencedor da cascata continua sendo um só, e pedido misto sempre
   morreria no modo vencedor. A composição acontece DENTRO do turno, pela
   delegação — o roteador segue decidindo só quem começa.

E uma fronteira que não se cruza: o design não espera preview de site rodando.
O original recusa a captura "ultra" sem browser worker isolado
(`routes.rs:672-677`), e a visualização do site construído já tem dono no fork
— a aba Site com sanitização e iframe `sandbox=""`
(`apps/desktop/src/lib/siteEntregue.ts`). O design lê arquivos; quem renderiza
é a moldura que foi endurecida para isso.

---

## Resumo do contrato

| Defeito | Princípio do original | Delta no fork |
| --- | --- | --- |
| Sub-turno emite na raiz | NodeRun: a execução grava no container da janela que a exibe (`AgentView.tsx`) | Envelopes de execução do sub-turno saem na FILHA; raiz mantém delegate abre/fecha + avisos; aprovações nos dois logs (mesmo `callID`) |
| Teto queima trabalho | Estágios contados, teto só de tempo, falha preserva o feito (`engine.ts`, `AgentView.tsx stopRun`) | Teto 8 no caminho do master (4 no bot-a-bot); esgotamento → relato final sem ferramentas + PARCIAL promovido quando houve efeito; rótulo de rodada no orbe |
| Design nunca chamado | Composição é opt-in de quem vê o pedido inteiro; encadeamento é textual (`runGraph`) | O `code` delega ao `design` após gravar a estrutura; trafega goal + caminhos no projeto compartilhado; roteador não muda |
