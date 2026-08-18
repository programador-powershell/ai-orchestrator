# Cluster de computadores para os bots

> Estado: **desenho para revisão**. Nada aqui foi implementado. O que existe hoje
> está em "O que já está pronto"; o resto é proposta.

## A arquitetura

```
                    ┌─────────────────────────────┐
                    │ ORQUESTRADOR / aibotd       │
                    │                             │
                    │ objetivo → plano            │
                    │ ondas / dependências        │
                    │ scheduler                   │
                    │ aprovação                   │
                    │ sequenciador do log         │
                    └────────────┬────────────────┘
                                 │
                         fila / protocolo
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
       │ WORKER PC-1 │    │ WORKER PC-2 │    │ WORKER PC-N │
       │  Docker     │    │  Docker     │    │  Docker     │
       │  Runtime    │    │  Runtime    │    │  Runtime    │
       │  snapshot   │    │  snapshot   │    │  snapshot   │
       │  temporário │    │  temporário │    │  temporário │
       └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 │
                    monta workspace do Bot
                                 │
                 ┌───────────────▼────────────────┐
                 │        PUTER COMPARTILHADO     │
                 │ bot-code     → workspace A     │
                 │ bot-design   → workspace B     │
                 │ bot-security → workspace C     │
                 │ arquivos / desktop / estado    │
                 └───────────────┬────────────────┘
                                 │
                 ┌───────────────▼────────────────┐
                 │ ESTADO COMPARTILHADO           │
                 │ sessions / goals / tasks       │
                 │ append-only event log          │
                 │ snapshots metadata             │
                 └────────────────────────────────┘
```

### O eixo que organiza tudo

| PERSISTENTE | EFÊMERO |
| --- | --- |
| Bot | Worker |
| Goal | Container |
| Session | CPU / RAM / GPU |
| Puter Workspace | Runtime snapshot |
| Files | |
| Event log | |

Esta é a decisão de arquitetura, e dela sai o resto: **o bot tem identidade e
disco; a máquina que o hospeda é descartável.** `bot-code` volta sempre para o
workspace A, tenha ele rodado no PC-1 ontem e no PC-7 hoje. Um worker que morre
no meio da tarefa não perde nada que importe — perde CPU.

Consequência prática, e é ela que dita o desenho de falha: **tudo que precisa
sobreviver tem de estar no persistente ANTES de o worker ser liberado.** Um
resultado que só existe no container é um resultado que não existe.

## O ciclo de uma tarefa

```
 plano → aloca worker → materializa → trabalha → publica → libera
```

1. **Aloca.** O scheduler tira um worker do pool (ou sobe um), com teto de
   concorrência (hoje `MaxChildren`, padrão 4 por onda).
2. **Materializa.** O workspace do bot é **copiado para o disco local do
   container**, e não montado por rede. Ver "por que não compilar direto no
   Puter", abaixo.
3. **Trabalha.** O bot roda modelo ↔ ferramentas ali dentro: `fs.*`, `git.*` e
   `proc.run` no MESMO lugar — que é o defeito nº 1 de hoje, resolvido.
4. **Publica.** O que mudou volta para o workspace do bot no Puter, e o
   resultado estruturado (diff, ramo, arquivos, saída) vai para o event log pelo
   orquestrador.
5. **Libera.** O container morre. O snapshot de runtime pode ficar em cache.

### Por que não compilar direto no Puter

`puter.fs` é um sistema de arquivos **sobre HTTP**. Um `npm install` faz dezenas
de milhares de operações de arquivo; um build Java, idem. Fazer isso por rede
transforma um build de 40 s em minutos, e cada falha de rede vira falha de build.

Por isso o desenho tem a seta **"monta workspace do Bot"**: materializa para o
disco do container (rápido, POSIX de verdade), trabalha local, publica o
resultado de volta. O Puter é o **estado durável do bot**, não o disco de
trabalho.

Regra de corte: só sobe de volta o que é resultado (código, artefato,
relatório). `node_modules`, `target/`, `.venv` ficam no snapshot, não no
workspace.

### O que é o "runtime snapshot"

Imagem de container com as dependências já instaladas, identificada pela
**impressão digital do manifesto** (`package.json` + lock, `pom.xml`,
`requirements.txt`…). Duas tarefas do mesmo objetivo, com o mesmo manifesto,
pegam o mesmo snapshot e começam quentes.

É efêmero por definição: se sumir, o pior que acontece é a próxima tarefa
reinstalar. **Nunca pode ser fonte de verdade de nada** — por isso ele está na
coluna direita do eixo, e por isso "snapshots metadata" (o índice: qual
impressão digital, qual imagem, quando) fica no estado compartilhado, enquanto a
imagem em si é descartável.

## O que já está pronto

| Peça | Onde | Papel no diagrama |
| --- | --- | --- |
| `PlanTasks` | `internal/supervisor/dag.go` | **objetivo → plano / ondas**: Kahn com ordem estável, fatia a onda no teto de concorrência |
| `runCrew` / `runWorker` | `internal/supervisor/crew.go` | ondas em série, tarefas em paralelo, portão entre ondas |
| `sandbox.Runner` | `internal/sandbox/sandbox.go` | a interface do **worker**: `Run(ctx, workdir, command)`, `Available`, `ID` |
| Docker/sbx | `internal/sandbox` | o container do worker, já com disponibilidade **medida** |
| `Store.Append` | `internal/store/store.go` | o **sequenciador do log**: `seq` 1..N por sessão, `fsync` nos verbos duráveis |
| `MarkSynced` / `SyncedSeq` | idem | o cursor para o **estado compartilhado** — escrito, documentado, **sem chamador** |
| `SessionMeta.ProjectID` | idem | o **Goal** — declarado, herdado no fork, **lido por ninguém** |
| Aprovação e portão | `internal/supervisor` | a caixa "aprovação" do orquestrador |

O orquestrador do diagrama **já é** o `aibotd`: as cinco caixas dele existem,
com nomes diferentes.

## O que quebra hoje, exatamente

Nenhum destes é opinião — todos saíram da leitura do código.

### 1. Arquivo e execução moram em planos diferentes

Só `proc.run` consulta o ambiente ativo. `fs.read/write/patch/list/search` e
`git.*` usam `os.ReadFile`/`os.WriteFile` e `git -C <raiz local>` no disco do
**gateway**. Um bot no worker **editaria aqui e compilaria lá**.

> `Toolbox.Root func(sessionID) string` precisa deixar de ser caminho e virar um
> **plano de arquivos** com implementação local e remota.

### 2. O ambiente é por SESSÃO, não por bot

`Registry.Active(ctx, sessionID)`, e todos os trabalhadores de uma equipe usam a
**mesma** `sessionID`. Não há como dizer "a tarefa t3 roda no PC-2". Falta
máquina em `protocol.Task` e ambiente por trabalhador.

### 3. Não existe entidade "Bot"

Hoje há **especialista** (definição estática: prompt, ferramentas, avatar) e
**trabalhador** (goroutine efêmera). O diagrama pede um terceiro: `bot-code` com
identidade, workspace próprio e estado que atravessa sessões. É entidade nova no
protocolo e no armazenamento.

### 4. O controle vive na memória de UM processo

`s.gates`, `s.waiting`, `s.asks`, `s.running` são mapas do supervisor. Portão,
aprovação e cancelamento não alcançam um bot fora dele; os **eventos** são
duráveis, as **decisões pendentes** não. E os tetos viajam por `context.Context`
— uma equipe montada num worker cairia num orçamento novo, e o teto de 24
trabalhadores por turno sumiria em silêncio.

### 5. O estado compartilhado esbarra em duas peças deliberadas

- **A trava.** `.lock` guarda o **PID** e decide se é órfã com `os.FindProcess` /
  `kill(pid,0)` — semântica que só vale na mesma máquina.
- **A numeração.** `seq` é atribuído em memória (`LastSeq++`) sob mutex de
  processo: dois escritores geram dois eventos com o mesmo número, e o `seq` é o
  que sustenta o replay.

O diagrama já resolve isso ao pôr **"sequenciador do log"** no orquestrador: um
escritor só. Os workers **reportam**, não gravam. A trava por PID vira **lease
com prazo** (dono + expiração renovada), que funciona entre máquinas.

## Modelo de dados

```
Bot            id, especialidade, workspace, criado_em
Goal           id, título, objetivo, criado_em, arquivado
Session        id, goal_id, título, especialista, modelo, cwd, last_seq
Task           id, session_id, bot_id, worker_id, estado, depende_de, resultado
Event          seq, session_id, kind, payload        (append-only, um escritor)
Snapshot       impressão_digital, imagem, criado_em, último_uso
```

`Goal` é o `ProjectID` que já existe e ninguém lê. `Task` hoje só vive em
memória, dentro do plano — persisti-la é o que permite retomar um objetivo depois
de o gateway cair.

## Falha e retomada

O eixo persistente/efêmero dá a resposta:

| O que morre | O que acontece |
| --- | --- |
| Worker no meio da tarefa | tarefa volta para a fila; nada a recuperar, o container era descartável |
| Snapshot | próxima tarefa reinstala as dependências |
| Orquestrador | as sessões, goals, tasks e o log estão no estado compartilhado; **as decisões pendentes (portão, aprovação) hoje se perdem** — precisam virar registro, não mapa |
| Puter | o bot perde o disco. É persistente: **precisa de cópia** |

## Perguntas em aberto

1. **Isolamento entre bots no Puter.** Um Puter compartilhado com todos os bots
   na mesma conta = todo bot lê o workspace de todo mundo. `bot-security` não
   deveria enxergar o de `bot-code` sem o objetivo dizer que sim. Uma conta por
   bot, ou um app com permissão por diretório? Isso muda a configuração.
2. **Cota e tamanho.** Um workspace por bot × N bots, com histórico. Falta saber
   os limites do Puter auto-hospedado.
3. **Quem sobe os workers.** O pool nasce com N fixo, ou o scheduler cria por
   demanda? Docker local, ou máquinas de verdade na rede?
4. **GPU.** Está no eixo efêmero, mas nenhum executor de hoje a expõe.

## Riscos e portões

1. **Licença.** Núcleo do Puter é **AGPL-3.0** (o SDK `puter.js` é Apache-2.0).
   Rodar AGPL como serviço de rede aciona a obrigação de oferecer o código
   correspondente a quem usa. **TI/SI antes de instalar** — mesmo caminho do
   Avatar Lab.
2. **Maturidade.** Os mantenedores dizem que o auto-hospedado está em **alfa e
   não deve ir para produção**. Ele é o disco dos bots neste desenho, ou seja, a
   peça persistente: a cópia de segurança não é opcional.
3. **Vazamento.** No serviço hospedado, arquivos passam por terceiro. Código de
   cliente não sai da máquina sem aval.
4. **Custo.** Um container por bot × N simultâneos é RAM e disco reais. O pool
   nasce com teto igual ao de hoje (4 por onda, 24 por turno) ou menor.

## Ordem sugerida

| Fase | Entrega | Depende de |
| --- | --- | --- |
| 1 | **Goal → Session**: gravar e ler o `ProjectID`, rotas, barra lateral agrupando | nada |
| 2 | **Task persistente** e o plano indo para o estado compartilhado | fase 1 |
| 3 | **Plano de arquivos**: `fs.*` e `git.*` passam a perguntar onde o comando roda | fase 2 |
| 4 | **Ambiente por tarefa** (máquina em `protocol.Task`, ambiente por trabalhador) | fase 3 |
| 5 | **Pool de workers** com Docker/sbx e o ciclo materializa→trabalha→publica | fase 4 |
| 6 | **Lease no lugar do PID** e espelho pelo `MarkSynced` | fase 5 |
| 7 | **Entidade Bot** + workspace no Puter, e o preview publicado | fases 5–6 + **aval TI/SI** |
| 8 | **Runtime snapshot** por impressão digital de manifesto | fase 5 |

Só a fase 7 depende do Puter. Se o aval não vier, o cluster funciona igual com o
workspace num volume do próprio worker — e a fase 7 vira a troca de uma
implementação de plano de arquivos por outra.
