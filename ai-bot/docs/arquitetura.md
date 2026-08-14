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
                             │  NEEDLE    │  45M params, 14 MB, cgo
                             │ internal/  │  milissegundos, offline
                             │  needle    │  sem custo por token
                             └─────┬──────┘
                                   │
                          intent + confidence
                                   │
                   ┌───────────────┴──────────────┐
                   │                              │
            confiança ≥ 0.70                   incerto
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
- **Limiar de 0.70, não 0.5.** Um modelo de 45 M erra, e o custo do erro aqui é a
  conversa **inteira** ir para o executor errado, porque o modo é gravado e não se
  reavalia. Empurrar o caso duvidoso para o modelo grande custa segundos uma vez.

### Cada linha carrega seu especialista

O envelope traz `from.specialist`, e a interface desenha o ícone antes de cada
linha do assistente. Quando o especialista muda (por `/mode` ou pelo seletor), a
linha nova entra com a faixa **"agora é X"** e o motivo da rota. Guardar o
especialista só na conversa faria a conversa inteira mudar de ícone ao trocar de
modo — apagando de quem era cada resposta anterior.

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
| roteamento, sessão, memória, permissão, segredo, barramento | `proc.run` (processo com Job Object), `term.open` / PTY |
| arquivos do projeto, git, worktree | `office.*`, `pdf.extract` (binário no disco da pessoa) |
| `secrets.scan`, `sql.render`, `schema.export`, `osv.query`, `webhook.post` | `runtime.status` (processo local do modelo) |
| chamada de modelo (OpenAI, Anthropic, Gemini, local) | cofre do SO, login OIDC em loopback, janelas |

O critério é um só: **precisa de algo que a máquina tem e o servidor não?**
ConPTY, Job Object e Credential Manager precisam. Ler arquivo, montar SQL e
consultar vulnerabilidade não — e deixá-los no Go faz o gateway funcionar também
quando roda num servidor, sem interface nenhuma.

A ponte é o próprio protocolo: o gateway emite `tool.call` endereçado ao host, o
Rust executa e devolve `tool.result`. O aplicativo nativo é **mais um
participante**, não um caso especial.

### Uma regra que não muda

`pty_write` **não é ferramenta do agente**. Um shell interativo é execução sem
portão de aprovação — bastaria o modelo escrever `rm -rf .\n`. Quem precisa de
shell usa `proc.run`, que passa pelo portão. As três superfícies de execução
(comando único com aprovação, caixa isolada com Job Object, terminal interativo
humano) são separadas de propósito; fundi-las desfaz o modelo de aprovação.

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
