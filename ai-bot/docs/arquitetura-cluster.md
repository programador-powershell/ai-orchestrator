# Cluster de computadores para os bots

> Estado: **desenho para revisão**. Nada aqui foi implementado. O que existe hoje
> está em "O que já está pronto"; o resto é proposta.

## A arquitetura

```
                    ┌─────────────────────────────┐
                    │ ORQUESTRADOR / aibotd       │
                    │ objetivo → plano            │
                    │ ondas / dependências        │
                    │ scheduler                   │
                    │ aprovação                   │
                    │ sequenciador do log         │
                    └────────────┬────────────────┘
                                 │ fila / protocolo
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ PC-01        │          │ PC-02        │          │ PC-10        │
│ worker-daemon│          │ worker-daemon│          │ worker-daemon│
│              │          │  ┌────────┐  │          │              │
│   ocioso     │          │  │container│ │          │   ocioso     │
│              │          │  │efêmero  │ │          │              │
└──────────────┘          │  └────────┘  │          └──────────────┘
                          └──────┬───────┘
                                 │ materializa / publica
                 ┌───────────────▼────────────────┐
                 │  PUTER — UMA INSTÂNCIA         │
                 │                                │
                 │  conta: Paim   (1 por PESSOA)  │
                 │   ├ /Bots/code/                │
                 │   ├ /Bots/design/              │
                 │   ├ /Bots/security/            │
                 │   ├ /Goals/<id>/               │
                 │   └ /Shared/                   │
                 │                                │
                 │  conta: Maria  (outra pessoa)  │
                 │   └ …                          │
                 └───────────────┬────────────────┘
                                 │
                 ┌───────────────▼────────────────┐
                 │ ESTADO COMPARTILHADO           │
                 │ bots / goals / sessions / tasks│
                 │ workers (PCs) / grants         │
                 │ append-only event log          │
                 │ snapshots metadata             │
                 └────────────────────────────────┘
```

### O eixo que organiza tudo

| PERSISTENTE | EFÊMERO |
| --- | --- |
| Bot | Container |
| Goal | CPU / RAM / GPU |
| Session | Runtime snapshot |
| Task | |
| Puter workspace | |
| Files | |
| Event log | |

O **PC** fica fora das duas colunas de propósito: ele é *cadastrado* (persistente
como registro) e *descartável* (pode sumir da rede a qualquer momento). O que é
efêmero é o **container**, não a máquina.

Regra que sai daqui, e é ela que dita o desenho de falha: **tudo que precisa
sobreviver está no persistente ANTES de o container ser destruído.** Resultado
que só existe no container é resultado que não existe.

## Worker é computador, container é execução

```
PC-01 ─ worker-daemon      10 PCs cadastrados
PC-02 ─ worker-daemon       2 trabalhando
PC-03 ─ worker-daemon       8 ociosos
```

Ciclo de uma tarefa:

```
scheduler → escolhe PC-02 → cria container → materializa workspace
          → executa → publica → destrói container
```

O daemon é leve: ele **não** decide nada. Anuncia-se, diz o que tem, recebe
tarefa, cria e destrói container, devolve resultado.

### O daemon é o componente mais sensível do sistema

Ele executa comando que chega **pela rede**. Isso não é efeito colateral do
desenho: é a função dele. Portanto:

- **Enrolamento explícito.** Um PC não entra no pool por se anunciar. Alguém da
  administração aprova a máquina, e só então ela recebe um **token próprio**,
  guardado no cofre (`secrets.Vault`, que só entrega segredo dentro de um
  callback — nunca devolve o valor a quem chama).
- **O portão de aprovação continua no orquestrador.** O daemon não avalia risco
  de ferramenta; ele recebe comando já aprovado. Duplicar a decisão do lado do
  PC criaria duas políticas divergentes.
- **O container é a fronteira.** O daemon nunca roda o comando no PC — sempre
  dentro do container, com o workspace materializado e nada mais montado.

### O protocolo do daemon já tem forma no código

`transport.Server.Call` (`HostBridge`) hoje despacha uma ferramenta ao aplicativo
Tauri: publica um `tool.call` efêmero no WebSocket da sessão e espera o
`POST /host/result` com o mesmo `callID`. **É exatamente a forma de que o daemon
precisa** — pedido para fora, resultado para dentro, correlacionado por id. O que
falta acrescentar:

| Peça | Para quê |
| --- | --- |
| Registro | o PC se apresenta com o token e as capacidades |
| Heartbeat + lease | PC que parou de responder perde as tarefas; elas voltam à fila |
| Capacidades | CPU, RAM, GPU, versão do Docker, sistema |
| Inventário de snapshots | quais imagens aquele PC já tem em cache |

### Como o scheduler escolhe

```
 Code   Design   Security        A mesma equipe, PCs diferentes,
   │      │        │             porque o RUNTIME é da tarefa —
   ▼      ▼        ▼             e amanhã pode cair em outros.
 PC-2   PC-1     PC-3
 Node  Browser  Python
```

Quatro entradas, nesta ordem:

1. **Runtime** — a tarefa pede Node, Python, JVM, navegador? É requisito de
   ADMISSÃO, não preferência: um PC sem navegador headless não atende o bot de
   Design, e mandar para ele é falhar depois de materializar o workspace.
2. **Capacidade** — GPU? cabe na RAM livre?
3. **Localidade de snapshot** — um PC que já tem `python-3.12/8ac927` começa em
   segundos; outro baixa e instala. É o que justifica o inventário por PC no
   estado compartilhado.
4. **Carga** — entre os elegíveis, o menos ocupado.

O par bot↔PC **não é fixo**: `bot-code` roda no PC-2 hoje e no PC-1 amanhã. O que
o segue é o workspace, que é persistente; o PC é escolhido por tarefa.

## Permissão: o bot é delegação da conta da pessoa

```
Conta Paim / Puter
        │
   Goal: CRM
        │
   ┌────┼─────┐
   ▼    ▼     ▼
 Code Design Security
```

A conta raiz é a **da pessoa**, não do sistema. Os bots existem debaixo dela, e
daí vem a regra que governa tudo:

> **Um bot nunca tem mais acesso que a pessoa dona dele.** A autoridade dele é
> derivada; ele age em nome dela, com um subconjunto dos direitos dela.

Isso tem uma consequência que precisa estar no código, não só no texto: o direito
é **derivado, não copiado**. Quando a pessoa perde acesso a alguma coisa, o bot
perde junto — então a concessão é reconferida no uso, e não carimbada uma vez na
criação.

### Três faixas, e negado por padrão

```
bot-code
├ workspace próprio          sempre
├ goal/<id>/ compartilhado   se participa do Goal
└ recurso específico         só com autorização explícita
                             (todo o resto: negado)
```

**O bot não recebe acesso automático ao Puter inteiro da pessoa.** Sem isso, o
bot de Segurança leria os arquivos privados do bot de Código sem precisar — e
"sem precisar" é o critério: acesso que a tarefa não exige é superfície de
vazamento sem contrapartida.

### A autorização explícita reusa o portão que já existe

"Bot X quer acesso ao recurso Y" é a mesma pergunta que "Bot X quer rodar a
ferramenta Z": uma decisão humana sobre um pedido com escopo. O AI-BOT já tem
isso — o portão de aprovação, com "permitir sempre" preso ao **digest dos
argumentos**, justamente para o primeiro sim não virar cheque em branco.

Inventar um segundo mecanismo de consentimento criaria duas políticas para
manter em pé, e elas divergiriam. A concessão de recurso entra pelo mesmo portão.

### Ciclo de vida da concessão

| Evento | O que acontece com o acesso |
| --- | --- |
| Bot entra no Goal | ganha `goal/<id>/`; nada além |
| Bot sai do Goal | perde `goal/<id>/` |
| Goal arquivado | todas as concessões daquele Goal morrem |
| Bot removido (atualização tirou o especialista) | workspace órfão — decidir retenção, não deixar apodrecer |
| Pessoa perde acesso ao recurso | o bot perde no próximo uso, porque o direito é derivado |

E **auditoria**: todo acesso de bot a espaço compartilhado precisa ser
atribuível — qual bot, qual Goal, qual tarefa. Sem isso, "o Security leu o quê?"
não tem resposta.

### Quem separa um bot do outro — e a consequência de uma conta por pessoa

É **uma conta de Puter por PESSOA**; os bots são entidades lógicas dentro dela.
Isso simplifica o provisionamento (ver abaixo) e tem um preço que precisa estar
escrito:

> Os bots de uma pessoa são, para o Puter, **o mesmo usuário**. O controle de
> permissão dele **não** separa `bot-code` de `bot-security`. Quem separa é o
> gateway.

Isso é ao mesmo tempo melhor e pior do que apoiar-se no Puter:

- **Melhor**: o isolamento deixa de depender do controle de acesso de um software
  em alfa. Passa a depender de código nosso, testável aqui.
- **Pior**: acaba a segunda linha de defesa. Uma falha na checagem de caminho do
  gateway é vazamento completo, sem ninguém atrás para barrar.

Por isso a checagem precisa ser **um ponto só**, e não uma regra repetida em cada
ferramenta. O código já tem esse padrão: `resolveInside`, no `Toolbox`, resolve
todo caminho dentro da raiz da sessão e **recusa caminho absoluto, `~` e `..`**.
O plano de arquivos por bot é a mesma ideia com outra raiz:

```
/Bots/<especialista>/     ← raiz do bot; tudo dele resolve aqui dentro
/Goals/<id>/              ← montado só se há concessão para este Goal
/Shared/                  ← montado só com autorização explícita
```

Nada fora dessas raízes é alcançável, porque a resolução não produz caminho fora
delas — não porque alguém lembrou de conferir.

- **A credencial do Puter da pessoa** vai para o cofre do gateway, com a mesma
  regra das chaves de provedor: o valor entra e só sai dentro de um callback.
- **A credencial de administração do Puter é a joia da coroa** — é ela que cria
  as contas das pessoas. Nunca na interface, nunca no bundle.

**Os testes que têm de FALHAR o acesso** (e agora quem precisa recusar é o
gateway, não o Puter):

1. `bot-code` lendo `/Bots/security/`;
2. `bot-code` lendo `/Goals/<outro>/` de um Goal em que ele não entrou;
3. qualquer bot lendo a raiz da conta, ou saindo da própria raiz por `..`;
4. um bot da pessoa A alcançando qualquer coisa da pessoa B.

Isolamento que ninguém testou é isolamento que ninguém tem — e aqui, sem a rede
de segurança do Puter, o teste é a única prova.

## Snapshot em duas camadas

Uma imagem nova a cada mudança pequena é desperdício. Duas camadas resolvem:

```
BASE RUNTIME  +  DEPENDENCY SNAPSHOT

python:3.12  →  requirements.lock  →  python-3.12/8ac927
node:24      →  package.json + pnpm-lock.yaml → node-24/19f810
```

```
Base cache                Dependency cache
├ python-3.12             ├ python-3.12/8ac927
├ node-24                 ├ node-24/19f810
├ java-25                 └ …
└ rust
```

Detalhes que fazem a diferença entre funcionar e dar problema silencioso:

- **A chave inclui a base.** `8ac927` sozinho colidiria entre `python-3.12` e
  `python-3.11`. A chave é o par, como no exemplo acima.
- **A impressão digital é do LOCK, não do manifesto solto.** `requirements.txt`
  com `>=` não determina o que foi instalado; `requirements.lock`,
  `pnpm-lock.yaml`, `pom.xml` com versões fixas, sim.
- **Descarte por menos-usado**, com teto de espaço por PC. Sumir é sempre seguro:
  a próxima tarefa reinstala.
- **Nunca é fonte de verdade.** Por isso o *índice* (`snapshots metadata`: base,
  impressão digital, imagem, último uso, em quais PCs) fica no estado
  compartilhado, e a imagem é descartável.

### O que sobe para o Puter, e o que não sobe

O workspace recebe **estado durável**. Não sobem:

```
node_modules/   .venv/   target/   dist-cache/   .gradle/   .m2/
```

Isso vive no snapshot, que é efêmero e reconstruível pela impressão digital.

### Por que não compilar direto no Puter

`puter.fs` é sistema de arquivos **sobre HTTP**. Um `npm install` faz dezenas de
milhares de operações; um build Java, idem. Por rede, um build de 40 s vira
minutos e cada oscilação vira falha. Daí a seta **materializa → trabalha →
publica**: copia para o disco do container, trabalha em POSIX de verdade,
devolve só o resultado.

## O que já está pronto

| Peça | Onde | Papel no diagrama |
| --- | --- | --- |
| `PlanTasks` | `internal/supervisor/dag.go` | **objetivo → plano / ondas** |
| `runCrew` / `runWorker` | `internal/supervisor/crew.go` | ondas em série, tarefas em paralelo, portão |
| `sandbox.Runner` | `internal/sandbox` | a interface de execução: `Run`/`Available`/`ID` |
| Docker/sbx | `internal/sandbox` | o container efêmero, com disponibilidade medida |
| `HostBridge` | `internal/transport/http.go` | **a forma do protocolo do daemon**, já em uso com o app |
| `Store.Append` | `internal/store` | o **sequenciador do log** |
| `secrets.Vault` | `internal/secrets` | cofre com acesso por callback — onde vão os tokens de PC e as contas de bot |
| `MarkSynced` | `internal/store` | cursor para o estado compartilhado — **escrito, sem chamador** |
| `SessionMeta.ProjectID` | `internal/store` | o **Goal** — declarado, **lido por ninguém** |

## O que quebra hoje

1. **Arquivo e execução em planos diferentes.** Só `proc.run` olha o ambiente;
   `fs.*` e `git.*` usam o disco do gateway. O bot editaria aqui e compilaria lá.
   `Toolbox.Root func(sessionID) string` precisa virar **plano de arquivos**.
2. **Ambiente é por sessão, não por bot.** Todos os trabalhadores usam a mesma
   `sessionID`; não há como dizer "t3 roda no PC-02".
3. **Não existe entidade Bot.** Há especialista (definição estática) e
   trabalhador (goroutine). `bot-code` com conta, workspace e estado que
   atravessa sessões é entidade nova.
4. **Controle na memória de um processo.** `s.gates`, `s.waiting`, `s.asks`,
   `s.running` são mapas; portão e aprovação não alcançam quem roda fora. Os
   tetos viajam por `context.Context` — equipe montada num worker ganharia
   orçamento novo e o teto de 24 sumiria calado.
5. **Estado compartilhado esbarra em duas peças deliberadas.** A trava guarda
   **PID** (só vale na mesma máquina); o `seq` é numerado **em memória**,
   pressupondo um escritor. O diagrama já resolve ao pôr o sequenciador no
   orquestrador: workers **reportam**, não gravam. A trava vira **lease com
   prazo**.

## Provisionamento

Três escopos, e cada um nasce num momento diferente:

| Escopo | O que é | Quando nasce |
| --- | --- | --- |
| **GLOBAL** | `SpecialistDefinition` — o catálogo versionado | com o produto |
| **POR PESSOA** | `PuterAccount` + estrutura base | no primeiro login |
| **POR PESSOA + ESPECIALISTA** | `BotInstance` | no primeiro uso daquele especialista |

### No primeiro login

```
primeiro login → aibotd verifica PuterAccount → não existe?
              → provisiona → cria a estrutura base
                             /Bots/  /Goals/  /Shared/
```

O provisionador é **idempotente**, e roda em toda inicialização sem duplicar
nada:

```go
EnsureUserWorkspace(userID)   // conta + /Bots/ /Goals/ /Shared/
EnsureSpecialists()           // catálogo global carregado
EnsurePermissions()           // as concessões que a pessoa já tinha
```

Idempotente aqui tem um requisito que costuma passar batido: **precisa aguentar
concorrência**. Duas janelas da mesma pessoa abrindo ao mesmo tempo chamam
`EnsureUserWorkspace` em paralelo — a semântica tem de ser criar-se-não-existe de
verdade (uma trava por pessoa, ou tolerar o erro de "já existe" como sucesso),
não ler-depois-criar.

### Especialista novo não cria nada em massa

Uma atualização acrescenta uma linha ao catálogo:

```
specialist_catalog:
  code v3   design v2   data v1   security v4
+ agent v1
```

e pronto — as pessoas antigas já o enxergam. **Nada de percorrer todas as contas
criando diretório.** A materialização é preguiçosa:

```
pessoa usa "Agent" pela primeira vez → existe no catálogo?
   → EnsureBot(userID, "agent") → cria metadata + workspace → executa
```

O ganho não é só de tempo de atualização: quem nunca usa o Agente nunca tem
diretório de Agente. Estrutura que existe sem uso é lixo para migrar depois.

### Versão do catálogo na instância

`BotInstance` precisa guardar **com qual versão do catálogo foi materializado**.
Sem isso não há como saber o que está velho: o catálogo diz `code v3`, a pasta da
pessoa foi criada no `v1`, e nada no sistema sabe da diferença.

Com o campo, `EnsureBot` vira também o ponto de atualização: materializado em v1,
catálogo em v3 → aplica o que mudou entre as duas versões.

### `schema_version` do workspace

```
UserWorkspace schema_version = 7        atual = 9
      → aplica 7→8, depois 8→9
```

Migrations pequenas e idempotentes, aplicadas **quando a pessoa toca no
workspace** — não numa varredura de todas as contas na subida. As mesmas regras
do provisionador valem: cada passo tem de poder rodar duas vezes sem estragar, e
tem de ser seguro sob concorrência.

Vale registrar a assimetria: migration **avança**. Uma pessoa que abriu o app com
uma versão nova do gateway e depois volta para uma antiga tem workspace no futuro
— o gateway antigo precisa recusar com frase clara em vez de tentar entender.

## Modelo de dados

```
SpecialistDefinition  id, versão, prompt, ferramentas, avatar     (GLOBAL)
PuterAccount          user_id, conta, schema_version, criado_em   (POR PESSOA)
BotInstance           user_id, especialista, versão_materializada,
                      workspace, criado_em            (POR PESSOA+ESPECIALISTA)

Goal       id, dono, título, objetivo, criado_em, arquivado
Grant      bot_id, recurso, permissão, origem (goal|explícito), expira_em
Session    id, goal_id, título, especialista, modelo, last_seq
Task       id, session_id, bot_id, runtime, pc_id, estado, depende_de, resultado
Worker     pc_id, nome, token_ref, runtimes[], capacidades, visto_em, estado
Snapshot   base, impressão_digital, imagem, último_uso, pcs[]
Event      seq, session_id, kind, payload        (append-only, um escritor)
Acesso     quando, bot_id, task_id, recurso, permitido   (trilha de auditoria)
```

`Grant` guarda a **origem**: concessão que veio do Goal morre com o Goal;
concessão explícita morre no prazo. Sem esse campo não dá para revogar em lote
sem revogar o que a pessoa autorizou à mão.

## Falha e retomada

| O que morre | O que acontece |
| --- | --- |
| Container | tarefa volta à fila; era descartável |
| Daemon / PC | o lease vence, as tarefas dele voltam à fila, o PC sai do pool até voltar |
| Snapshot | próxima tarefa reinstala |
| Orquestrador | bots, goals, sessions, tasks e log estão no compartilhado; **decisões pendentes (portão, aprovação) hoje se perdem** — precisam virar registro |
| Puter | o bot perde o disco. É persistente: **precisa de cópia** |

## Perguntas em aberto

1. **Cota e tamanho** por workspace no Puter auto-hospedado.
2. **GPU** está no eixo efêmero, mas nenhum executor de hoje a expõe.
3. **Retenção do workspace órfão** — especialista removido do catálogo deixa
   `/Bots/<id>/` da pessoa para trás. Apagar, arquivar ou deixar? Se ele guarda
   dado de cliente, a resposta é de política, não de engenharia.

## Riscos e portões

1. **Licença.** Núcleo do Puter é **AGPL-3.0** (o SDK `puter.js` é Apache-2.0).
   Rodar AGPL como serviço de rede aciona a obrigação de oferecer o código
   correspondente. **TI/SI antes de instalar.**
2. **Maturidade.** O auto-hospedado está em **alfa por declaração dos
   mantenedores** — e neste desenho ele é a peça persistente e a fronteira de
   isolamento. Cópia de segurança e o teste de permissão não são opcionais.
3. **Superfície de execução remota.** O daemon é, por desenho, execução de
   comando vinda da rede. Enrolamento explícito, token por máquina e contenção no
   container.
4. **Escalada pela conta da pessoa.** Como a autoridade do bot é derivada da
   conta dela, um bot enganado (por conteúdo que ele leu, por exemplo) é um
   caminho até os arquivos dela. É o que a faixa "negado por padrão" contém: sem
   concessão, o bot não alcança nada além do próprio workspace. A trilha de
   auditoria existe para responder "o que ele leu, e sob qual autorização".
4. **Custo.** Container por tarefa × N simultâneas é RAM e disco reais. O pool
   nasce com o teto de hoje (4 por onda, 24 por turno) ou menor.

## Ordem sugerida

| Fase | Entrega | Depende de |
| --- | --- | --- |
| 1 | **Goal → Session**: gravar e ler o `ProjectID`, rotas, barra lateral agrupando | nada |
| 2 | **Task persistente**, com o plano no estado compartilhado | fase 1 |
| 3 | **Plano de arquivos**: `fs.*` e `git.*` perguntam onde o comando roda | fase 2 |
| 4 | **Máquina por tarefa** (`pc_id` em `protocol.Task`) | fase 3 |
| 5 | **worker-daemon**: registro, heartbeat, lease, capacidades — em cima do `HostBridge` | fase 4 |
| 6 | **Scheduler** por capacidade, localidade e carga; container por tarefa | fase 5 |
| 7 | **Snapshot em duas camadas** e o inventário por PC | fase 6 |
| 8 | **Lease no lugar do PID** e espelho pelo `MarkSynced` | fase 6 |
| 9 | **Provisionador idempotente** (conta por pessoa, catálogo global, `EnsureBot` preguiçoso, `schema_version`), faixas de permissão, trilha de acesso e preview publicado | fases 6–8 + **aval TI/SI** |

Só a fase 9 depende do Puter. Se o aval não vier, o cluster funciona com o
workspace num volume do PC — e a fase 9 vira a troca de uma implementação de
plano de arquivos por outra.
