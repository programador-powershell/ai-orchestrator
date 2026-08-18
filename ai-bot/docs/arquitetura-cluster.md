# Cluster de computadores para os bots

> Estado: **desenho para revisão**. Nada aqui foi implementado. O que existe hoje
> está descrito em "O que já está pronto"; o resto é proposta.

## O pedido

Em vez de alugar VM, ter **N computadores** rodando ao mesmo tempo — um deles o
**orquestrador** —, com **banco compartilhado**, e **cada bot trabalhando dentro
de um computador**. A hierarquia de dados pedida:

```
Input
├ Objetivo: Criar sistema CRM
│  ├ Sessão 01  "Vamos definir arquitetura"
│  ├ Sessão 02  "Agora implemente backend"
│  └ Sessão 03  "Corrija autenticação"
└ Objetivo: Criar um site
   ├ Sessão 01
   └ Sessão 02
```

## O que o Puter faz, e o que não faz

Isto precisa ficar registrado porque decide a peça central do desenho.

| Superfície do Puter | O que é | Serve de computador do bot? |
| --- | --- | --- |
| `puter.fs` | sistema de arquivos na nuvem | **sim**, como disco do bot |
| `puter.kv` | chave-valor por app/usuário | como estado leve, sim |
| `puter.hosting` | publica uma pasta numa URL | **sim**, para o preview do que o bot construiu |
| `puter.ai` | proxy para modelos | não usamos: o AI-BOT tem catálogo e cofre próprios |
| Workers | funções serverless, **só JavaScript** | não roda build de outra linguagem |
| Phoenix (shell) | shell em JavaScript puro; a documentação diz que é work-in-progress | não substitui um shell de sistema |
| v86 | emulador x86 em WebAssembly (projeto de terceiro), Ubuntu ≤18.04 / Alpine | demonstração, não build de projeto real |

**Conclusão:** o Puter é um **disco com área de trabalho**, não uma máquina.
Ele não compila Java, não roda `pytest`, não executa `git`. O bot de Código e a
Equipe precisam exatamente disso.

Por isso o desenho separa dois papéis que o pedido juntava:

- **Workspace** — onde os arquivos do bot vivem, onde a pessoa vê o que ele fez,
  e onde o resultado é publicado. **Puter serve.**
- **Executor** — onde `proc.run`, `git` e o build acontecem. **Puter não serve**;
  quem serve é container, WSL ou servidor.

## O que já está pronto (e é mais do que parece)

| Peça | Onde | O que faz |
| --- | --- | --- |
| `sandbox.Runner` | `internal/sandbox/sandbox.go` | a abstração de máquina: `Run(ctx, workdir, command)`, `Available(ctx)`, `ID()` |
| Cinco executores | mesmo pacote | Local, Docker/sbx, WSL, VPS, Nuvem — com disponibilidade **medida**, não presumida |
| `Registry` | mesmo pacote | ambiente ativo por sessão, cache de 30 s na sondagem |
| `PlanTasks` | `internal/supervisor/dag.go` | objetivo já em lista → ondas topológicas, com teto de concorrência |
| `runCrew` / `runWorker` | `internal/supervisor/crew.go` | ondas em série, tarefas da onda em paralelo, portão entre ondas |
| `worktree.Manager` | `internal/worktree` | isolamento por cópia de repositório |
| `MarkSynced` / `SyncedSeq` | `internal/store/store.go` | **cursor de espelho para um servidor — escrito, documentado e sem nenhum chamador** |
| `SessionMeta.ProjectID` | `internal/store/store.go` | **o "Objetivo" do diagrama — declarado, herdado no fork, e lido por ninguém** |

Ou seja: a interface de "computador" existe, o plano de ondas existe, e os dois
ganchos que faltavam ligar (agrupar sessões, espelhar o log) já estão escritos.

## O que quebra hoje, exatamente

Estes quatro pontos são o trabalho real. Nenhum é opinião: todos saíram da
leitura do código.

### 1. O plano de ARQUIVOS não acompanha o de EXECUÇÃO

Só `proc.run` consulta o ambiente ativo. `fs.read`, `fs.write`, `fs.patch`,
`fs.list`, `fs.search` e `git.*` usam `os.ReadFile`/`os.WriteFile` e
`git -C <raiz local>` no disco do **gateway**.

Com um computador remoto, o bot **edita aqui e compila lá**. É literalmente o
defeito que o cabeçalho de `tools_process.go` diz existir para não repetir.

> `Toolbox.Root func(sessionID) string` precisa deixar de ser uma string de
> caminho e virar um **plano de arquivos** com implementação local e remota.

### 2. O ambiente é por SESSÃO, não por bot

`Registry.Active(ctx, sessionID)` — e todos os trabalhadores de uma equipe rodam
com a **mesma** `sessionID`. Não existe como dizer "a tarefa t3 roda na máquina
B". Falta um campo de máquina em `protocol.Task` e um ambiente ativo por
trabalhador.

### 3. O controle vive na memória de UM processo

`s.gates`, `s.waiting`, `s.asks`, `s.running` são mapas do supervisor. Portão,
aprovação e cancelamento não alcançam um trabalhador que rode fora dele. Os
**eventos** são duráveis; as **decisões pendentes** não.

E os tetos viajam por `context.Context`: uma equipe montada por um trabalhador
remoto cairia num `crewBudget` novo — o teto de 24 trabalhadores por turno
sumiria em silêncio.

### 4. O banco não é compartilhável como está

Duas peças impedem, e as duas são deliberadas:

- **A trava.** `.lock` guarda o PID e decide se é órfã com `os.FindProcess` /
  `kill(pid,0)` — semântica que só vale na **mesma máquina**. Numa pasta de rede,
  dois gateways se dariam permissão mutuamente.
- **A numeração.** `seq` é atribuído em memória (`handle.meta.LastSeq++`) sob
  mutex de processo. Dois escritores geram dois eventos com o mesmo número, e o
  `seq` é justamente o que sustenta o replay.

## A arquitetura proposta

```
                    ┌─────────────────────────────┐
                    │  ORQUESTRADOR (1)           │
                    │  gateway aibotd             │
                    │  - decompõe objetivo        │
                    │  - planeja ondas            │
                    │  - portão e aprovação       │
                    │  - ÚNICO escritor do log    │
                    └──────────┬──────────────────┘
                               │ protocolo de trabalho
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
      │ COMPUTADOR 1  │ │ COMPUTADOR 2  │ │ COMPUTADOR N  │
      │ ┌───────────┐ │ │               │ │               │
      │ │ executor  │ │ │   executor    │ │   executor    │  ← roda comando
      │ │ container │ │ │   container   │ │   container   │
      │ └───────────┘ │ │               │ │               │
      │ ┌───────────┐ │ │               │ │               │
      │ │ workspace │ │ │   workspace   │ │   workspace   │  ← arquivos + tela
      │ │  (Puter)  │ │ │    (Puter)    │ │    (Puter)    │
      │ └───────────┘ │ │               │ │               │
      └───────────────┘ └───────────────┘ └───────────────┘
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                    ┌─────────────────────────────┐
                    │  BANCO COMPARTILHADO        │
                    │  log append-only por sessão │
                    └─────────────────────────────┘
```

### O que é um "computador"

Um par: **executor** + **workspace**.

```go
// Proposta: internal/cluster/computer.go
type Computer interface {
    ID() string
    Runner() sandbox.Runner      // executa comando — já existe
    Files() FilePlane            // lê/escreve arquivo ONDE o comando roda
    Available(ctx) (bool, string)
    Release(ctx) error           // devolve ao pool
}
```

`FilePlane` é a peça nova, e é ela que conserta o defeito 1:

```go
type FilePlane interface {
    Read(ctx, path string) ([]byte, error)
    Write(ctx, path string, data []byte) error
    List(ctx, path string) ([]Entry, error)
    Patch(ctx, path string, edits []Edit) error
}
```

Com isso, o mesmo bot lê, escreve e compila **no mesmo lugar** — e o Puter entra
como uma implementação de `FilePlane` (`puter.fs`), não como executor.

### Ciclo de vida de um bot

1. O orquestrador planeja as ondas (`PlanTasks`, que já existe).
2. Para cada tarefa da onda, **aloca um computador** do pool.
3. Prepara o workspace: cópia do repositório no `FilePlane` daquele computador.
4. O bot roda: modelo ↔ ferramentas, com `proc.run` no executor **daquele**
   computador e `fs.*` no `FilePlane` **daquele** computador.
5. Ao terminar, o **artefato** volta — hoje volta só um texto; precisa voltar
   diff, ramo e lista de arquivos.
6. O computador é liberado para a próxima tarefa.

### O banco compartilhado

Proposta em duas camadas, para não perder o que o local-first garante:

- **Um escritor por sessão.** O orquestrador continua sendo o único a numerar e
  gravar. Os computadores não escrevem no log: eles **reportam** ao orquestrador,
  que numera. Isso preserva `seq` sem inventar consenso distribuído.
- **Espelho pelo cursor que já existe.** `MarkSynced`/`SyncedSeq` liga o log
  local ao banco compartilhado: cada sessão empurra do `SyncedSeq` para frente, e
  o banco é a cópia consultável por todos.

A trava por PID vira trava por **lease com prazo** (dono + expiração renovada),
que funciona entre máquinas — um dono que morreu perde a sessão quando o prazo
vence, em vez de depender de PID.

### Objetivo → Sessão (o diagrama)

O campo já existe. O que falta:

| Onde | O que fazer |
| --- | --- |
| `store.SessionMeta.ProjectID` | passar a ser escrito na criação |
| `store` | `CreateProject`, `ListProjects`, `ListSessions(projectID)` |
| `protocol` | `Project{ID, Title, Goal, CreatedAt}` no `ready` |
| `POST /v1/projects` … | criar, renomear, arquivar, mover sessão |
| Barra lateral | agrupar as conversas por objetivo, como no diagrama |
| Fork | já herda o `ProjectID` — nada a fazer |

Isto **não depende do Puter nem do cluster** e pode ser feito primeiro.

## Riscos e portões

1. **Licença.** Núcleo do Puter é **AGPL-3.0**; o SDK `puter.js` é Apache-2.0.
   Rodar AGPL como serviço de rede aciona a obrigação de oferecer o código
   correspondente a quem usa. **Vai para TI/SI antes de instalar qualquer coisa**
   — mesmo caminho do Avatar Lab.
2. **Maturidade.** Os mantenedores dizem que o auto-hospedado está em **alfa e
   não deve ir para produção**.
3. **Vazamento.** No serviço hospedado (puter.com), arquivos e chamadas de IA
   passam por terceiro. Código de cliente não pode sair da máquina sem aval.
4. **Custo do isolamento.** Um container por bot × N bots simultâneos é RAM e
   disco reais. O teto atual é 4 trabalhadores por onda (`MaxChildren`), 24 por
   turno — o pool precisa nascer com teto igual ou menor.

## Ordem sugerida

| Fase | Entrega | Depende de |
| --- | --- | --- |
| 1 | **Objetivo → Sessão** completo, com a barra lateral agrupando | nada |
| 2 | `FilePlane` — `fs.*` e `git.*` passam a perguntar onde o comando roda | fase 1 |
| 3 | Ambiente **por tarefa** (campo em `protocol.Task`, ambiente por trabalhador) | fase 2 |
| 4 | `Computer` + pool, com Docker/sbx como primeira implementação | fase 3 |
| 5 | Banco compartilhado: lease no lugar do PID, espelho pelo `MarkSynced` | fase 4 |
| 6 | Workspace Puter (`FilePlane` sobre `puter.fs`) e preview publicado | **aval da TI/SI** |

A fase 6 é a única que depende do Puter. Todas as outras entregam valor sozinhas
— e se o aval não vier, o cluster funciona igual, com o workspace no disco do
computador em vez de no Puter.
