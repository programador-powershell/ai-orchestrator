# Arquitetura do AI-BOT

## A ideia

O produto anterior tinha **dez abas**. Cada capacidade era uma tela, com barra
lateral própria e campo de texto próprio. Trocar de capacidade era trocar de aba
na mão — e para isso a pessoa precisava **saber de antemão** em qual aba morava o
que ela queria.

O AI-BOT tem **uma tela**. As dez capacidades viraram **especialistas** de um bot
só. A pessoa escreve; o roteador decide quem atende; a tela se transforma na
superfície daquele especialista. A barra lateral, a barra superior, o campo de
texto e a cor de acento acompanham.

## Camadas

```
React    → interface        (uma tela, dinâmica por especialista)
Rust     → integração nativa (Tauri: o que não pode sair da máquina)
Go       → cérebro           (services/gateway, binário `aibotd`)
```

```
┌───────────────────────────────────────────────┐
│              GO AGENT GATEWAY                 │
│                                               │
│  Router / Supervisor   internal/supervisor    │
│  Session Manager       internal/store         │
│  Model Router          internal/modelrouter   │
│  MCP Hub               internal/mcphub        │
│  Memory                internal/memory        │
│  Permissions           internal/permissions   │
│  Secrets               internal/secrets       │
│  Event Bus             internal/eventbus      │
│  Runtime Manager       (host, via ponte)      │
│  Worktree Manager      internal/worktree      │
│  Rede guardada         internal/netguard      │
│  Roteador local        internal/needle        │
│                                               │
│         CANONICAL AGENT PROTOCOL              │
│            internal/protocol                  │
└──┬──────────┬──────────┬──────────┬───────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
 REST/WS     SSE       MCP        CLI
 (Tauri)   (watch)   (ferramentas) (aibotd)
```

## Microkernel de plugins

`internal/plugins` é a camada de composição. O núcleo registra contratos de
contribuição; manifestos fornecem implementações com dono e efeito reversível.
O runtime monta atomicamente, resolve `requires`, recusa ciclos/colisões e faz
rollback em ordem inversa.

As costuras ativas são:

- `llm.adapter`: liga um `kind` ao protocolo OpenAI, Anthropic ou Gemini;
- `llm.catalog`: compõe provedores e modelos em camadas por prioridade;
- `mcp.server`: registra o servidor e cada ferramenta no supervisor;
- `specialist.overlay`: troca o catálogo e restaura o snapshot anterior.

Grok é um plugin embutido que contribui adaptador xAI, provedor e modelos. A
configuração da pessoa é uma camada superior, por isso chave/estado não alteram
o manifesto. Plugins locais só montam quando escolhidos pelo perfil
`profiles/default.json`. O formato completo está em [plugins.md](plugins.md).

## O roteamento — o coração do produto

### A conversa tem UM modo

O modo é decidido no **primeiro input** e **gravado na conversa**
(`SessionMeta.Specialist`). Da segunda mensagem em diante **não há classificação
nenhuma**: tudo vai para o mesmo executor.

```
Nova conversa
    ↓
Primeiro input
    ↓
Cascata de roteamento
    ↓
Escolhe o modo → grava em SessionMeta.Specialist
    ↓
Msg 2, 3, 4, 5… ──────→ mesmo executor (reason: "sticky", custo zero)
```

Reclassificar a cada linha parecia mais esperto e é pior de três jeitos:

- custa latência **antes** de cada resposta;
- faz `"agora corrija o login"` — que só existe dentro do assunto anterior — ser
  lido como pedido isolado;
- troca a tela debaixo de quem estava no meio de um trabalho.

Modo é contexto, e contexto não se renegocia a cada frase.

**Duas** coisas trocam o modo de uma conversa em andamento:

1. `/mode <id>` escrito no campo — sozinho (`/mode agent`) ou junto com o pedido
   (`/mode code corrige o login`);
2. o seletor de especialista da interface, que chega como escolha explícita.

### A cascata (só no primeiro input)

```
                    INPUT
                      │
                      ▼
            ┌───────────────────┐
            │ FAST ROUTER       │  Go puro, léxico, offline
            │ internal/         │  microssegundos, determinístico
            │  supervisor.Score │
            └─────────┬─────────┘
                      │
           ┌──────────┴──────────┐
           │                     │
     decisão óbvia          não sabemos
           │                     │
           ▼                     ▼
       executor              ┌────────────┐
                             │  NEEDLE    │  Router Pro (.cact, ~23 MB), cgo
                             │ internal/  │  milissegundos, offline
                             │  needle    │  sem custo por token
                             └─────┬──────┘
                                   │
                          intent + confidence
                                   │
                   ┌───────────────┴──────────────┐
                   │                              │
            confiança ≥ 0.78                   incerto
                   │                              │
                   ▼                              ▼
               executor                    ┌─────────────┐
                                           │ MODELO      │  rede, segundos
                                           │ GRANDE      │  tokens cobrados
                                           └──────┬──────┘
                                                  ▼
                                              executor
```

Nem toda decisão precisa de IA: `"corrige o bug de compilação"` tem cinco sinais
léxicos de código e não merece uma ida à rede. E quando precisa de IA, quase
nunca precisa da **cara**.

Três detalhes que não são óbvios:

- **O fast router alimenta o Needle.** O Needle 2 renderiza até **cinco**
  ferramentas direto na gramática; acima disso ele liga recuperação por embedding
  e escolhe as cinco sozinho, com menos informação que a nossa. Como o fast
  router já ordenou os dez especialistas, ele entrega os **cinco melhores** e o
  Needle decide na faixa em que é determinístico (`NeedleToolBudget`).
- **Um especialista = uma ferramenta sem argumento.** O nome da ferramenta *é* a
  decisão. A alternativa (uma ferramenta `route` com argumento enum) joga a
  escolha para um campo de string livre, enquanto o esquema de ferramentas vira
  gramática na decodificação — e gramática não deixa o modelo inventar um nome
  que não existe.
- **Limiar de 0.78, calibrado — não 0.5 chutado.** O número vem do harness de pesquisa (needle-router-pro/config/router.json), medido sobre holdout; o próprio harness avisa que o Needle 2.0.5 desabilita a confiança calibrada em pesos LoRA, então o .cact treinado só vale com este portão externo. Um modelo de 45 M erra, e o custo do erro aqui é a
  conversa **inteira** ir para o executor errado, porque o modo é gravado e não se
  reavalia. Empurrar o caso duvidoso para o modelo grande custa segundos uma vez.

#### O degrau local roda por PROCESSO (e o binário normal já o tem)

O caminho que funciona hoje não é o cgo: é um **sidecar**. O gateway sobe um
processo (`AIBOT_NEEDLE_CMD`), aperta a mão, e passa a perguntar por linha JSON
em stdin/stdout. Do lado de lá, `services/needle-sidecar/needle_sidecar.py` usa
o `cactus-needle`, que baixa um binário único de ~14 MB com modelo, tokenizer e
engine selados dentro.

Três propriedades sustentam isso, e as três existem porque o degrau é
**opcional** — ele acelera o primeiro input e nunca pode ser o motivo de a
conversa não andar:

1. **Nada ali derruba o roteamento.** Sidecar que não sobe, morre no meio,
   responde lixo ou demora mais de 3 s deixa o degrau fora, e a cascata segue
   para o modelo grande.
2. **A resposta é conferida** contra os candidatos. É processo de terceiro
   falando por texto; aceitar o id que ele mandar deixaria um especialista fora
   da política atender a conversa.
3. **Uma pergunta por vez.** É uma sessão só do outro lado, e duas perguntas
   concorrentes na mesma stdin devolveriam a resposta da pergunta do vizinho.

O ganho que mais importa: **sem tag de build e sem cgo**, o degrau existe no
binário padrão. `cmd/fakeneedle` fala o mesmo protocolo e permite exercitar a
fiação inteira sem Python.

#### E por que o caminho nativo (cgo) ficou parado

Vale escrever isto sem rodeio, porque o `.cact` instalado dá a impressão oposta:
**o degrau 2 não roda hoje**, e o que falta não é o build — é o motor.

| peça | o que é | estado |
| --- | --- | --- |
| `needle-router-pro.cact` | a especialização treinada (escolhe o dono do 1º input) | instalada |
| `needle2.cact` | o modelo BASE do Needle (45 M), baixado por `needle fetch` | ausente |
| motor de inferência | quem CARREGA um `.cact` | ausente, e é um projeto à parte |

O `cactus-compute/needle` fixado no `upstream.lock.json` (Apache-2.0, v2.0.5) é
um pacote **Python** de inferência e fine-tuning — **não existe `needle.h`**.
Quem expõe API C é o `cactus-compute/cactus`: header `cactus_engine.h`, entrada
`cactus_init`, que carrega pesos de um **diretório**, não de um arquivo. O
`needle_shim.c` foi escrito contra a API que não existe e está marcado como tal;
ligar `-tags needle` hoje quebra no `#include`, antes do link.

Duas travas antes de isto virar padrão, e nenhuma é técnica: a licença do
`cactus` **não foi verificada** (a Apache-2.0 do lock cobre o `needle`, não o
motor), e é dependência de terceiro **dentro do processo que lê o prompt** — vai
a TI/SI antes.

E vale medir antes de investir: desde a calibração do léxico por palavra inteira,
os pedidos comuns decidem no primeiro degrau. O degrau local rende menos hoje do
que rendia quando foi desenhado.

### O primeiro input escolhe um ELENCO, não só um dono

Escolher quem atende nunca foi o trabalho todo. "Crie uma aplicação completa" é
do Código — mas se ela tem interface, o Design tem o que fazer; depois de existir
código, alguém revisa a segurança. Sem elenco, a pessoa precisaria lembrar de
pedir cada um, devolvendo a ela o roteamento que o master existe para fazer.

A rota passa a trazer `standby[]`, e cada apoio diz **quando** entra:

| forma | significado | exemplo |
| --- | --- | --- |
| `parallel` | trabalha **junto** do dono | Design define o visual enquanto o Código monta o esqueleto |
| `after` | trabalha **sobre** o que o dono produziu | Segurança revisa o que foi escrito |

A distinção não é enfeite de tela — é o formato do plano. Paralelizar quem
depende produz um parecer sobre trabalho que ainda não existe; serializar quem é
independente dobra o tempo por nada.

**Duas fontes montam o elenco.** As *companhias* declaradas no catálogo
(`specialist.Companion`) são regra de ofício escrita como dado, com condição:
Design só entra se houver sinal de interface, porque um Design em espera numa
correção de bug de backend é ruído — e ruído ensina a ignorar o aviso. O
*léxico* completa: quem pontuou forte e não ganhou provavelmente tem trabalho ali.

**O elenco não executa.** Ele é intenção; quem despacha é a equipe e quem
confirma é a pessoa. Um elenco que já saísse rodando transformaria "crie uma
aplicação" em cinco modelos gastando dinheiro sem ninguém ter pedido.

#### O entregável decide o dono

Contar radicais não distingue o **pedido** do **ingrediente**. "Crie uma api de
cobrança com banco postgres" pontua 1,00 em Dados (`banco`, `postgres` — dois
radicais longos) e 0,25 em Código (`api` — três letras). E mesmo assim o dono é o
Código: a API é o que foi pedido, o banco é o que ela usa.

Quem desfaz isso é a ordem das palavras em português — **o entregável vem logo
depois do verbo de construção**. Cada especialista declara seus `Deliverables`, e
quem for o *único* a entregar o que veio depois de "crie/monte/construa/desenhe"
decide sozinho, sem precisar de margem. Dois entregáveis na mesma frase ("crie o
app **e** o banco") são empate de verdade, e empate sobe a cascata em vez de ser
resolvido no grito.

### Cada linha carrega seu especialista

O envelope traz `from.specialist`, e a interface desenha o ícone antes de cada
linha do assistente. Quando o especialista muda (por `/mode` ou pelo seletor), a
linha nova entra com a faixa **"agora é X"** e o motivo da rota. Guardar o
especialista só na conversa faria a conversa inteira mudar de ícone ao trocar de
modo — apagando de quem era cada resposta anterior.

### Um bot, dois bots, muitos bots — e onde a árvore para

São três mecanismos distintos, e vale saber qual é qual:

| | quem decide | o que acontece | quem paga |
| --- | --- | --- | --- |
| **um bot** | a rota do 1º input | o dono da conversa responde | 1 modelo |
| **delegação** | o próprio especialista, sem perguntar | um sub-turno com o prompt e as ferramentas do colega; o dono continua o mesmo | 1 modelo por delegado |
| **equipe** | o especialista `agent`, por `task.dispatch` | um DAG em ondas, com um trabalhador por tarefa e portão entre ondas | 1 modelo por trabalhador, por rodada |

Os três podem se encadear, e é aí que mora o risco: **cada nível multiplica**.
Um plano aceita até 128 tarefas; se um trabalhador `agent` pudesse montar outra
equipe sem teto, três níveis seriam mais de dois milhões de chamadas de modelo.
O laço não erra em nenhum passo — cada despacho, sozinho, é uma decisão
plausível —, e é justamente por isso que ele não se interrompe sozinho.

Os tetos vêm da **política do administrador** (`internal/permissions.Policy`), e
não de constantes escondidas:

- `MaxDepth` (3) — quantos níveis de equipe. O trabalhador que tenta montar
  equipe além disso recebe uma recusa em texto, e replaneja.
- `MaxChildren` (4) — o paralelismo de cada onda. O plano que pede mais é
  cortado, não recusado: ondas menores entregam o mesmo resultado.
- `MaxTotal` (24) — trabalhadores do **turno inteiro**, sub-equipes e refações
  incluídas. Desce por contexto, num ponteiro compartilhado; um orçamento novo
  por nível não limitaria nada.

Os mesmos números **apertam** a delegação (`maxDelegationDepth` 2,
`maxDelegationsPerTurn` 3) — só para baixo. Uma política frouxa não afrouxa o
teto do produto, senão bastaria publicar um JSON permissivo para desligar o
limite que impede dois especialistas de delegarem em pingue-pongue até o turno
acabar.

**O portão entre ondas.** A onda que deixou tarefa sem resultado não segue em
silêncio: as seguintes dependem do que ela deveria ter produzido, e receberiam o
bloco de upstream vazio — o plano terminaria plausível, com metade do trabalho
inventado. `retry` reexecuta **só as tarefas sem resultado** (refazer quem deu
certo repetiria um commit, um arquivo escrito, uma mensagem enviada), no máximo
três tentativas. Sem decisão em dois minutos o portão **segue**, ao contrário da
aprovação de ferramenta, que recusa: continuar um plano gasta tokens, executar
algo irreversível sem ninguém olhando é outra coisa.

## Canonical Agent Protocol

Um envelope, append-only, numerado por sessão:

```jsonc
{ "v":1, "id":"…", "ts":"…", "seq":42, "session":"s…", "turn":"t…",
  "kind":"delta", "from":{"kind":"specialist","specialist":"code"},
  "to":null, "payload":{ "text":"…" } }
```

Verbos: `hello` `ready` `error` `done` · `prompt` `route` `delta` `message`
`thinking` · `tool.call` `tool.result` · `approval.request` `approval.decision` ·
`task.dispatch` `task.progress` `worker.done` `escalate` `ask` `reply` `gate` ·
`state`.

Um protocolo só, para todos os transportes. Quando cada transporte tinha a sua
mensagem, "aprovar uma ferramenta" existia cinco vezes e divergia cinco vezes —
foi assim que, no produto anterior, a aprovação valia na interface e não valia no
caminho MCP.

A numeração (`seq`) é o que permite **replay**: quem cai reconecta dizendo o
último `seq` que viu e recebe o resto, em vez de recomeçar a resposta.

## Onde cada coisa roda, e por quê

| Fica no **Go** | Fica no **Rust** |
| --- | --- |
| roteamento, sessão, memória, permissão, segredo, barramento | `proc.run` **no ambiente local** (processo com Job Object), PTY (comandos `pty_*`, só para a janela) |
| arquivos do projeto, git, worktree | `office.*`, `pdf.extract` (binário no disco da pessoa) |
| `secrets.scan`, `sql.render`, `schema.export`, `osv.query`, `webhook.post` | `runtime.status` (processo local do modelo) |
| chamada de modelo (xAI/Grok, OpenAI, Anthropic, Gemini, local) | cofre do SO, login OIDC em loopback, janelas |

O critério é um só: **precisa de algo que a máquina tem e o servidor não?**
ConPTY, Job Object e Credential Manager precisam. Ler arquivo, montar SQL e
consultar vulnerabilidade não — e deixá-los no Go faz o gateway funcionar também
quando roda num servidor, sem interface nenhuma.

A ponte é o próprio protocolo: o gateway emite `tool.call` endereçado ao host, o
Rust executa e devolve `tool.result`. O aplicativo nativo é **mais um
participante**, não um caso especial.

### O ambiente de execução (`internal/sandbox`)

Cada sessão escolhe **onde** o próximo comando roda: `local`, `docker`, `wsl`,
`vps` ou `cloud`. O gateway mede a disponibilidade de cada um na máquina e
manda o resultado no `ready` — o que não dá para usar aparece **cinza com o
motivo**, em vez de sumir da lista.

O ponto que importa: o ambiente alcança o **despacho da ferramenta**, não só a
aparência do rodapé. `proc.run` consulta o ambiente ativo antes de escolher o
destino — `local` vai para o Rust, como sempre; qualquer outro vai para o
`Runner` correspondente, e o resultado volta carimbado com onde rodou. No
produto anterior o seletor roteava só o terminal, e o agente compilava no
servidor enquanto lia os arquivos na estação, sem ninguém perceber.

O ambiente **Docker** dirige o `sbx` (Docker Sandboxes) instalado na máquina, do
mesmo jeito que dirigimos o `git`. Nada do Docker é redistribuído neste
repositório — a licença do `docker/sbx-releases` é "All rights reserved" —, e
quando o `sbx` não está no PATH a resposta é uma frase que diz o que instalar. O
que é nosso e mora aqui é o [`.sbxenv.yaml`](../.sbxenv.yaml): workspace montado
só na pasta do projeto, rede restrita, limites de CPU/memória e **nenhum
segredo** dentro do container (as chaves ficam no cofre do gateway, que não roda
lá dentro).

O ambiente ativo mora em memória, por sessão: reiniciar o gateway devolve todo
mundo para `local`. É escolha — ressuscitar de um arquivo faria o primeiro
comando depois de uma queda rodar num lugar que ninguém reafirmou.

### Uma regra que não muda

`pty_write` **não é ferramenta do agente**. Um shell interativo é execução sem
portão de aprovação — bastaria o modelo escrever `rm -rf .\n`. Quem precisa de
shell usa `proc.run`, que passa pelo portão. As três superfícies de execução
(comando único com aprovação, caixa isolada com Job Object, terminal interativo
humano) são separadas de propósito; fundi-las desfaz o modelo de aprovação.

## A política

**Onde ela é buscada.** `AIBOT_POLICY_URL` é lida no boot (`internal/config`) e
buscada por `internal/policy`: um `GET` que sai pelo **netguard**, como todo
endereço de fora — um servidor de política apontado para `169.254.169.254` seria
SSRF com crachá. A busca roda em **segundo plano**, com refresh a cada 15
minutos, e **não bloqueia o boot**: o app precisa abrir offline. Sem a variável,
não há política remota — é o caso do uso pessoal.

**O que ela restringe.** Duas coisas, e a diferença importa:

| Campo                | Quem aplica                    | O quê                                  |
| -------------------- | ------------------------------ | -------------------------------------- |
| `Mode`, `DeniedTools`, `AgentTools`, `AllowedSpecialists`, `Max*` | `permissions.Gate.Evaluate` | cada chamada de ferramenta |
| `BlockedDomains`     | `netguard`                     | cada saída de rede                     |
| `AllowedModels`      | `modelrouter.SetAllowed`       | o catálogo **e** cada chamada de modelo |

O portão do modelo fica em `resolveExact`, que é onde o modelo é **usado**, e não
só em `Catalog`, que é onde ele é **listado**. Um id chega ao gateway sem ter
passado pela lista de três maneiras normais: gravado numa conversa antiga,
mandado direto no campo `model` do protocolo, ou vindo de um caminho interno
como o classificador. Política que só filtra lista é decoração — foi assim que o
`byokAllowed` do app anterior passou despercebido.

**Por que o padrão gerenciado é restritivo.** Com `AIBOT_MANAGED` ligado e sem
política remota ainda aplicada, o gateway sobe **sem o runtime local**: o
provedor `local` fica desabilitado e todo modelo marcado como local sai da lista
permitida (`policy.RestrictManaged`). Subir aberto "só até sincronizar" é subir
aberto — a janela entre o boot e o primeiro sync é justamente quando ninguém
está olhando. Pela mesma razão, **falha de busca não relaxa nada**: 500, timeout,
DNS morto ou JSON truncado mantêm o padrão restritivo, porque indisponibilidade
do servidor de política não pode virar liberação.

Detalhe que fecha o último buraco: em `AllowedModels`, lista **ausente** (`nil`)
significa "todos" e lista **vazia** significa "nenhum". São opostos porque a
lista da estação gerenciada é calculada, e um catálogo só de modelos locais
produz legitimamente uma lista vazia — que, colapsada em "todos", liberaria o
catálogo inteiro na estação mais restrita do parque.

## Zero dependências no gateway

`services/gateway/go.mod` não tem um único `require`. As três tentações normais
foram resolvidas à mão, e o `go.mod` diz onde:

- **WebSocket** → `internal/transport/ws.go` (RFC 6455, servidor, ~300 linhas)
- **Banco** → `internal/store/store.go` (log append-only + `fsync` + trava)
- **JSON-RPC** → `internal/transport/` e `internal/mcphub` (MCP e ACP falam o
  mesmo dialeto)

Não é ascetismo: é a política da casa aplicada onde ela custa. O gateway é o
processo que segura chave de provedor, executa ferramenta e fala com a rede — e
cada dependência ali é uma análise de TI/SI e uma superfície a mais.

O único ponto em que a biblioteca padrão não bastaria é o **Job Object do
Windows**, que exigiria `golang.org/x/sys`. Por isso a caixa de isolamento
continua no Rust, onde a crate já é homologada.
