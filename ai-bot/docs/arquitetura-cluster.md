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
plano → aloca worker → materializa Puter→disco local → BASELINE
      → bot trabalha → diff → validação → publica em staging/<task>/<época>
      → o orquestrador confere a época → promove → event log → libera worker
```

O **baseline** entra antes de o bot encostar em qualquer arquivo (ver "Checkpoint
e rollback"), e o container **não escreve no workspace**: ele publica numa área
de espera que o orquestrador promove — ver "Duas máquinas, uma tarefa".

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
| **Correlação durável** | hoje é `s.hostCalls`, um mapa em memória: o reinício do orquestrador transforma resultado que chega em `409` (HTTP) ou em silêncio (WebSocket) |
| **Reentrega e reconciliação** | ao reconectar, o daemon diz o que ainda tem em execução e o que já concluiu; sem isso, resultado perdido vira tarefa refeita |

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

## Duas máquinas, uma tarefa: cerca, área de espera e promoção

O desenho tinha um buraco, e ele só aparece quando a rede falha.

**O problema.** "Workers reportam, não gravam" vale para o **event log**. A
publicação de ARQUIVO ia do container direto para o Puter, fora do caminho do
orquestrador — então nenhuma checagem dele barrava um PC que já não é o dono da
tarefa:

```
PC-02 fica 40 s sem rede
   → o lease vence, t2 vai para o PC-03
   → PC-03 termina e publica
   → PC-02 volta, termina e publica POR CIMA
   → o log mostra o PC-03; os arquivos são os do PC-02
```

E a próxima tarefa da onda lê esses arquivos.

**A raiz.** O requeue usa "o resultado não chegou" como prova de "nada foi
aplicado". Dentro de um processo isso vale — e o código diz por que, em
`crew.go:378`: reexecutar quem deu certo repetiria efeito colateral já aplicado,
"um commit, um arquivo escrito, uma mensagem enviada". **Atravessando rede, a
procuração deixa de valer**: resultado que não chegou pode ter sido aplicado
inteiro.

### As três regras

1. **Cerca (fence).** A tarefa tem dono: `pc_id` + a época do lease. Reporte de
   quem não é mais o dono é **recusado**, não aplicado. A matéria-prima já está
   no modelo (`Task` guarda `pc_id` e `estado`); o que faltava era a regra.
2. **Área de espera em vez de escrita direta.** O container não escreve no
   workspace: ele publica em `staging/<task>/<época>/`. Duas publicações da mesma
   tarefa não se misturam, porque estão em lugares diferentes.
3. **Promoção pelo orquestrador.** Quem move da área de espera para o workspace
   é o orquestrador — e só a época que ainda é dona. Assim a regra do escritor
   único, que já valia para o log, passa a valer para os arquivos.

O ciclo fica:

```
… → bot trabalha → diff → validação → publica em staging/<task>/<época>
  → o orquestrador CONFERE a época → promove → event log → libera worker
```

### O que o daemon faz quando perde o orquestrador

A pergunta precisa de resposta explícita, senão cada implementação escolhe uma:

> **Publica na área de espera e para.** Não promove, não apaga, não decide.

Publicar é barato e não estraga nada — a área de espera é dele, por época. Quem
decide se aquilo vira verdade é o orquestrador, quando o daemon reconectar e a
época ainda for a dona. Se não for, a área de espera é lixo, e lixo se recolhe.

A alternativa — abortar antes de publicar — jogaria fora trabalho bom toda vez
que a rede piscar no fim da tarefa.

## Checkpoint e rollback

O event log guarda **o que aconteceu**. Ele não guarda **como os arquivos
estavam** — e é justamente isso que falta quando um bot faz besteira: um
`patch` que estragou o arquivo, um `rm` largo demais, um `git reset` no lugar
errado. Replay reconstrói a conversa, não o diretório.

```
baseline
   ├─ o bot trabalhou
   └─ resultado ruim → rollback → volta ao baseline, NÃO publica
```

### Como, sem sujar o repositório da pessoa

Um armazenamento **endereçado por conteúdo** paralelo, e não o Git de verdade do
projeto. Em Git isso é um `GIT_DIR` separado apontando para a mesma árvore:

```
git --git-dir=<sombra>/.git --work-tree=<workspace> add -A
git --git-dir=<sombra>/.git --work-tree=<workspace> commit -m "baseline t3"
```

Três coisas vêm de graça daí, e por isso não vale a pena inventar formato:

- **Dedup**: arquivo que não mudou não é copiado de novo — é o mesmo objeto.
- **Diff pronto**: o "gera diff" do ciclo é `git diff` contra o baseline.
- **Nada vaza para o projeto**: o `.git` real não ganha commit que ninguém pediu,
  e o `git status` que o próprio bot roda continua dizendo a verdade sobre o
  trabalho dele.

### Por tarefa, ou por operação?

Um baseline por tarefa é o **piso**: barato, sempre, e resolve o caso comum.

Mas uma tarefa roda até 6 rodadas de modelo↔ferramenta e pode escrever dezenas de
vezes. Se ela azedar na quinta rodada, voltar ao baseline joga fora quatro
rodadas boas. Por isso vale também o checkpoint **antes de cada operação
destrutiva** (`fs.write`, `fs.patch`, remoção, `git reset`): como o
armazenamento é endereçado por conteúdo, cada checkpoint custa um objeto de
commit, não uma cópia da árvore. Barato o bastante para o ganho de poder desfazer
UM passo em vez de o dia inteiro.

### Onde o checkpoint mora

| Alcance | Onde | Vive quanto |
| --- | --- | --- |
| Desfazer **dentro** da tarefa | sombra no disco do container | morre com o container |
| Histórico do que o bot entregou | o **diff publicado**, no event log | permanente |

O checkpoint serve ao ciclo da tarefa, então ele não precisa atravessar a rede
nem ocupar o Puter — e assim a regra "o Puter recebe só estado durável" continua
valendo. O que atravessa é o resultado: diff, ramo, arquivos.

Isso também explica por que o container efêmero **basta** como fronteira: se o
bot destruir algo fora do workspace, o container morre com o estrago dentro.

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
| Bot removido (atualização tirou o especialista) | workspace vai para `/Arquivo/<id>/`, somente leitura; outro bot só chega nele com autorização explícita |
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
   E **`s.hostCalls` é o mesmo defeito na peça que este documento elege como
   forma do protocolo do daemon**: a correlação pedido↔resultado é um mapa em
   memória. Um `aibotd` que reinicia perde a correlação, e o resultado que chega
   depois leva `409 sem_pendencia` pelo HTTP (`http.go:503`) ou é descartado
   **sem status nenhum** pelo WebSocket (`stream.go:275-279`) — o daemon nem
   fica sabendo que perdeu. Correlação durável e reentrega entram na lista do
   daemon.
5. **Estado compartilhado esbarra em duas peças deliberadas.** A trava guarda
   **PID** (só vale na mesma máquina); o `seq` é numerado **em memória**,
   pressupondo um escritor. O diagrama já resolve ao pôr o sequenciador no
   orquestrador: workers **reportam**, não gravam. A trava vira **lease com
   prazo**.

## O Bot é um perfil, não um processo

O bot guarda especialidade, modelo, memória, skills, avatar e configuração — e
**não fica executando**. Quem executa é o container, quando há tarefa. É o mesmo
eixo persistente/efêmero, agora com nome de gente.

| O que adotar | O que custa aqui |
| --- | --- |
| **Conversa canônica do bot** — uma conversa principal e contínua dentro do Goal, que `/new` não destrói | `Session` ganha um tipo (canônica × avulsa). A ramificação já existe: `ForkSession` copia o prefixo do log e mantém os `seq` |
| **Skills / ferramentas / MCP por bot** | hoje o catálogo de ferramentas é do ESPECIALISTA (definição estática). Passar a ser por instância significa o portão avaliar por bot, não por especialista |
| **Pool de credenciais do usuário** | já é a regra do cofre: o bot recebe **referência**, nunca valor, e o segredo só existe dentro de um callback. Vale igual para OAuth |
| **Presença: trabalhando / esperando / concluído** | já existe — cinco estados no avatar e no trilho. Falta alimentá-los pelo estado da TAREFA, não pelo turno |
| **Rotinas ligadas ao bot** | já há agendamento (`internal/schedule`). O delta é a rotina referenciar `bot_id` e só criar worker quando dispara |
| **Grupos de bots com rodadas finitas** | já existe, com outro nome: a equipe tem teto de profundidade (3), de filhos (4), de total por turno (24), de tentativas por onda (3) e de rodadas por trabalhador (6) |
| **@menção entre bots pelo orquestrador, nunca direto** | já é assim: o trabalhador que tenta delegar é recusado com instrução, e o event log é a autoridade |

Duas consequências que precisam estar escritas:

- **Conversa que não termina precisa de compactação.** Uma conversa canônica
  cresce para sempre; o orçamento de contexto corta o que não cabe, mas cortar
  não é lembrar. Sem um resumo progressivo, o bot esquece o começo da relação
  exatamente onde a relação começou.
- **Ferramenta por bot muda o portão.** Hoje a política decide por
  especialista+ferramenta. Com skills por instância, "dar terminal ao bot de
  Código" vira uma concessão — e cai na terceira faixa de permissão, pelo mesmo
  portão de aprovação. Não é mecanismo novo.

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

### Especialista que sai: arquiva, não apaga

Especialista removido do catálogo **não leva o workspace junto**. O dado
continua útil: outro especialista pode precisar dele.

```
/Bots/agent/          →   /Arquivo/agent/     (somente leitura)
```

Três regras que caem daí:

- **O arquivo é uma FONTE, não um destino.** Somente leitura: workspace de
  especialista que não existe mais não deveria continuar mudando, e um
  arquivo que muda não é arquivo.
- **Outro especialista chega nele pela terceira faixa.** Não há exceção nova:
  `/Arquivo/<id>/` é recurso, e recurso exige **autorização explícita**, pelo
  mesmo portão de aprovação. O bot de Dados lendo o que o Agente deixou é uma
  decisão da pessoa, registrada na trilha de acesso — não um efeito colateral de
  o Agente ter sido removido.
- **Especialista que volta, reidrata.** Se uma atualização traz `agent` de novo,
  `EnsureBot` acha o arquivo pelo id e **restaura** em vez de criar pasta vazia.
  Sem isso, uma remoção temporária apagaria o histórico da pessoa sem ninguém ter
  pedido.

Arquivar **não** significa guardar para sempre: significa que a saída do
especialista, sozinha, não apaga nada. Apagar de verdade continua possível por
ação humana explícita, e o arquivo entra na política de retenção da empresa como
qualquer outro dado — se houver dado de cliente ali, quem decide o prazo é a
TI/SI, não este documento.

### `schema_version` do workspace

```
UserWorkspace schema_version = 7        atual = 9
      → aplica 7→8, depois 8→9
```

Migrations pequenas e idempotentes, aplicadas **quando a pessoa toca no
workspace** — não numa varredura de todas as contas na subida. As mesmas regras
do provisionador valem: cada passo tem de poder rodar duas vezes sem estragar, e
tem de ser seguro sob concorrência.

Uma armadilha que vem junto do arquivo: workspace arquivado fica parado no schema
de quando foi arquivado, porque ninguém o toca. **A reidratação tem de rodar a
cadeia inteira** — arquivado no 4, atual no 9, restaura aplicando 4→5→…→9. Sem
isso, o especialista que volta volta quebrado.

Vale registrar a assimetria: migration **avança**. Uma pessoa que abriu o app com
uma versão nova do gateway e depois volta para uma antiga tem workspace no futuro
— o gateway antigo precisa recusar com frase clara em vez de tentar entender.

## Modelo de dados

```
SpecialistDefinition  id, versão, prompt, ferramentas, avatar     (GLOBAL)
PuterAccount          user_id, conta, schema_version, criado_em   (POR PESSOA)
BotInstance           user_id, especialista, versão_materializada, workspace,
                      modelo, skills[], avatar, conversa_canônica,
                      estado (ativo|arquivado), criado_em
                                                      (POR PESSOA+ESPECIALISTA)

Goal       id, dono, título, objetivo, criado_em, arquivado
Grant      bot_id, recurso, permissão, origem (goal|explícito), expira_em
Session    id, goal_id, bot_id, tipo (canônica|avulsa), título, modelo, last_seq
Task       id, session_id, bot_id, runtime, pc_id, estado, depende_de,
           baseline (hash do checkpoint), diff, resultado
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
| Daemon / PC | o lease vence, as tarefas voltam à fila e a época velha perde a cerca: o que o PC publicar depois fica na área de espera e não é promovido |
| Snapshot | próxima tarefa reinstala |
| Orquestrador | bots, goals, sessions, tasks e log estão no compartilhado; **decisões pendentes (portão, aprovação) e a correlação pedido↔resultado (`s.hostCalls`) hoje se perdem** — as três precisam virar registro, senão a tarefa que já publicou é refeita |
| Puter | o bot perde o disco. É persistente: **precisa de cópia** |

## Perguntas em aberto

1. **Cota e tamanho** por workspace no Puter auto-hospedado.
2. **GPU** está no eixo efêmero, mas nenhum executor de hoje a expõe.
3. **Prazo de retenção do arquivo.** A saída do especialista não apaga nada
   (arquiva), mas o arquivo acumula. Se houver dado de cliente ali, o prazo é
   decisão de TI/SI.

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
| 5a | **Cerca, área de espera e promoção** — e a correlação durável do daemon | fase 5 |
| 5b | **Checkpoint e rollback**: baseline por tarefa em sombra endereçada por conteúdo, diff contra ele, publicar só depois de validar | fase 5 |
| 6 | **Scheduler** por capacidade, localidade e carga; container por tarefa | fase 5 |
| 7 | **Snapshot em duas camadas** e o inventário por PC | fase 6 |
| 8 | **Lease no lugar do PID** e espelho pelo `MarkSynced` | fase 6 |
| 9 | **Provisionador idempotente** (conta por pessoa, catálogo global, `EnsureBot` preguiçoso, `schema_version`), faixas de permissão, trilha de acesso e preview publicado | fases 6–8 + **aval TI/SI** |

Só a fase 9 depende do Puter. Se o aval não vier, o cluster funciona com o
workspace num volume do PC — e a fase 9 vira a troca de uma implementação de
plano de arquivos por outra.

## Estado da implementação

Auditado em 2026-08-19, item a item, contra o código. A coluna "onde vai
morar" aponta a peça que já existe (ou que acabou de nascer) para receber a
implementação.

| Item | Estado | Onde está hoje / onde vai morar |
| --- | --- | --- |
| **WorkspacePlan v1 (Plan + Context + fs/git/proc no mesmo root)** | :white_check_mark: Feito | `internal/workspace/` — e o CICLO fechou: a tarefa executa EXATAMENTE o plano que foi despachado (congelado uma vez na onda, materializado pelo `runWorker`, PROMOVIDO na aceitação — worker de época velha não vira verdade, testado com o cenário PC-02/PC-03). |
| Worker-daemon multi-PC | :warning: Parcial | `internal/fleet`: o worker local se registra com identidade real (pc-<hostname>, arch, CPUs) e heartbeat de 30s; o plano congela worker/época da frota. Falta o DAEMON remoto (registro pela rede, capacidades, pool). |
| Runtime snapshot | :x: Falta | Não há resolver por manifesto/fingerprint/cache. O campo já viaja (`Plan.Runtime.SnapshotDigest`, hoje `"host"`); o resolver troca o valor por um digest de verdade e o daemon materializa a partir do cache. |
| Puter materialize/publish | :x: Falta | Nada conectado à execução. O `workspace.Manager` isola exatamente esta troca: `Source/Staging` com URIs `puter:///...` e um `Materialize`/`Promote` que falam com a instância. Vendorização pendente de TI/SI. |
| Staging + fence/epoch | :warning: Parcial | A cerca roda DE VERDADE na aceitação do resultado (`runWorker` → `Promote`), com época PERSISTIDA da frota (lease com TTL de 3min; vencido = época anda, nunca volta — sobrevive a reinício). Falta o STAGING real: a v1 ainda escreve direto (`local://inplace`). |
| Checkpoint shadow-git | :x: Falta | Especificado no desenho (baseline por tarefa em sombra endereçada por conteúdo). O lugar dele já existe: `Execution.ShadowGitDir`, vazio na v1. |
| Aprovação durável | :x: Falta | Os portões ainda usam `s.gates`/`s.waiting` (channels em memória) — gateway que reinicia perde a pendência. O destino é o log durável da sessão, como o `ask`/`reply` já fazem. |
| Lease distribuído | :warning: Parcial | `fleet.Acquire/CurrentLease` com época persistida e as três saídas do desenho (dono renova = mesma época; vago/vencido = época anda; alheio válido = recusa). Single-node: o lease de verdade entre PCs entra pelo banco compartilhado, pela MESMA interface `workspace.Leases`. |
| TaskRun persistente | :warning: Parcial | `fleet.RunLog`: cada execução vira registro durável por sessão (despacho → desfecho, com plano/época; teto de 200). Auditável hoje; RETOMÁVEL é a fase seguinte — o DAG em si ainda vive no turno. |
