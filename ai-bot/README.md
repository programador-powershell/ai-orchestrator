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
> **Estado desta versão.** A interface compila (`tsc` limpo), passa nos testes e
> roda. O gateway Go **não foi compilado aqui** — não há toolchain Go nesta
> estação, e instalá-la depende de aprovação da TI. O código foi revisado
> símbolo a símbolo, mas o primeiro `go build` é o teste que falta.
> **Sete ferramentas** (`web.search`, `image.generate`, `design.replicate`,
> `flow.validate`, `finetune.submit`, `finetune.status`, `schedule.create`) estão
> no catálogo e **recusam com motivo** em vez de existir — é de propósito: uma
> ferramenta ausente faz o modelo inventar outra saída, uma recusa explícita ele
> lê e contorna. O **Needle** está atrás da tag de build `needle` e depende de
> análise de TI/SI antes de virar padrão.

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
  roteamento.

### :pushpin: Fixes

- **A matiz por módulo funciona.** No produto anterior havia um `transition` sobre
  `--accent-h`: ele encalhava no valor de partida e as nove abas ficavam com o verde
  do Chat — a "cor própria por aba" anunciada nunca existiu. Aqui a matiz troca sem
  animação, e o comentário no `tokens.css` explica por quê para ninguém "melhorar"
  isso de novo.
- **O especialista `fluxo` tem matiz própria** (174). No CSS anterior ele era o
  único sem regra `[data-mode=fluxo]` e caía no verde do Chat.

### :construction_worker: Refactors

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
