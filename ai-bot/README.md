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
> **Estado desta versão.** As três camadas compilam e passam: `go build`, `go vet`
> e `gofmt` limpos com **173 testes** no gateway; `cargo check`/`clippy` limpos com
> **81 testes** no nativo; `tsc` limpo com **32 testes** na interface. O **Needle**
> está atrás da tag de build `needle` — o build padrão não o referencia.

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
  `NEEDLE (modelo local de 14 MB via cgo, offline, milissegundos)` →
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

### :up: V.1
### :warning: Latest Changes

- **Projeto novo, em Tauri + Go.** React para a interface, Rust para a integração
  nativa, Go para o cérebro. O gateway anterior (Rust/Axum + PostgreSQL + Redis)
  virou um binário Go de dependência zero que roda como sidecar na estação — e o
  mesmo binário sobe num servidor sem mudar uma linha, porque o protocolo é o
  mesmo dos dois lados.
- **As dez abas viraram dez especialistas de um bot só.** A tela é uma, o campo é
  um, e quem escolhe é o roteador. O registro de cada especialista é **dado**, não
  código: o mesmo objeto alimenta o roteador (radicais), o prompt (sistema), a tela
  (superfície e barra lateral), o campo (placeholder e atalhos), a permissão
  (ferramentas) e o retrato (avatar). Quando isso vivia espalhado, acrescentar
  capacidade significava lembrar de seis lugares — e o Fluxo passou versões com o
  placeholder de um campo que nem aparecia.
- **Roteamento em cascata com modelo local.** O fast router léxico resolve o caso
  óbvio em microssegundos, offline. O que ele não pega desce para o **Needle** (45 M
  de parâmetros, ~14 MB, ~28 MB de RAM) via cgo, ainda na máquina. Só o que sobra
  chega ao modelo grande. O fast router ainda **alimenta** o Needle: ele entrega os
  cinco melhores candidatos, que é a faixa em que o Needle renderiza as ferramentas
  direto na gramática, em vez de ligar recuperação por embedding e escolher sozinho
  com menos informação.
- **O modo é da conversa, não da linha.** Decidido no primeiro input, gravado, e
  trocado só por `/mode <id>` ou pelo seletor. As mensagens seguintes custam zero de
  roteamento — e agora isso é **medido**: o caminho sticky é 99,8 ns e **zero
  alocação**.
- **As sete ferramentas que recusavam agora existem**, todas em Go: `web.search`
  (SearXNG, Brave ou Tavily — o SearXNG é o padrão recomendado porque é
  auto-hospedado e a consulta não sai para terceiro), `design.replicate`,
  `image.generate`, `finetune.submit`/`finetune.status`, `flow.validate` e
  `schedule.create` (com `list` e `remove` juntos — criar sem poder listar nem
  apagar é armadilha). São **36 ferramentas** no catálogo; no host ficaram só as
  seis que precisam da máquina de verdade (processo, ConPTY, binário de documento).

### :pushpin: Fixes

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
- **Escalar não conta como falha da onda.** O trabalhador que se recusa a adivinhar
  e escreve `ESCALAR:` entrava na contagem de falhas e abria o portão da onda junto
  com quem falhou de verdade — e o portão pergunta "seguir, refazer ou abortar?",
  que não é o que se responde a quem pediu esclarecimento. A pergunta já tem o
  caminho dela: o evento `escalate`, com o campo de resposta ao lado na tela.

### :construction_worker: Refactors

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
│   └── docs                # arquitetura e créditos de inspiração
└── main
```

## :rocket: Executáveis

| Nome                | Descrição                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| AI-BOT.exe          | Aplicativo desktop (Tauri); sobe o gateway como sidecar                          |
| aibotd              | Gateway Go: `aibotd` sobe o servidor; `serve`, `token`, `specialists`, `version` |
| aibotd -tags needle | Mesmo gateway com o roteador local ligado (exige a biblioteca nativa)            |
| pnpm tauri dev      | Interface em desenvolvimento, com recarga                                        |
| go test ./...       | Bateria do gateway (roteador, DAG, store, rede, permissão, protocolo, barramento)|
| pnpm test           | Bateria da interface (redução de envelope do store)                              |

## :computer: Acesso

Para o gateway local acesse http://127.0.0.1:8799/health

O gateway **exige token** mesmo em loopback: o processo executa ferramenta, e
"é só localhost" não é fronteira de segurança numa máquina com navegador. O token
é gerado na primeira execução em `%APPDATA%/AI-BOT/token` e sai também por
`aibotd token`. Não há usuário nem senha padrão.

![App Screenshot](https://placehold.co/960x540?text=AI-BOT)

## :book: Documentação

### :link: [Wiki](docs/arquitetura.md)
