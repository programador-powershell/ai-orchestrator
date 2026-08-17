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

### :up: V.1.3
### :warning: Latest Changes

- **O bot de especialista da barra lateral é o "Grok bot": a esfera preta de
  olhos brancos, animada pelas EXPRESSÕES do Avatar Lab.** A arquitetura é a da
  especificação fornecida em 2026-08-17 (`avatar/grokSpecialistAvatar.ts`,
  mantida verbatim): o retrato vem de um MÓDULO carregado por URL com a
  interface do export JavaScript do Bible Strong Avatar Lab (`createAvatar` +
  `availableAnimations`), e o wrapper escolhe a ANIMAÇÃO NOMEADA certa para
  cada especialista em cada estado — o Código trabalha em `working` e celebra
  em `celebrate`, a Segurança vigia em `suspicious` e varre em `searching`, o
  Chat atende em `listening`, todo mundo dorme em `sleeping` na espera e se
  orgulha em `proud` quando é o dono da conversa.
- **Os cinco estados viram cues visuais ao redor da esfera, nunca no rosto:**
  ativo respira com um anel sutil; **owner** gira um anel tracejado com três
  pontos de coroa; **trabalhando** acelera um anel pontilhado com partículas;
  **em espera** apaga o campo e solta "Zz"; **concluído** pulsa e sela o
  check. O glifo do ofício (balão, `< >`, gráfico, bézier, rede, pipeline,
  faders, escudo) fica no canto, na cor do especialista.
- **O módulo do avatar é SUBSTITUÍVEL sem tocar código.** Hoje
  `public/avatars/grok-avatar.js` é um stand-in próprio (esfera + 13 animações
  nomeadas, nenhuma linha do Lab); quando o pacote exportado do estúdio for
  aprovado (o Lab é AGPL — análise TI/SI pendente, ver
  `docs/creditos-inspiracao.md`), basta trocar esse arquivo pelo export. A URL
  do módulo é absoluta de propósito: o dev server do Vite recusa import de
  `/public` por caminho relativo.
- **O trilho ganhou o CARTÃO DE PRESENÇA e as tarefas ganharam o bot do
  trabalhador.** No topo do corpo do trilho, o bot da vez (124px) faz a
  animação do estado — dono da conversa em repouso (roteamento sticky),
  trabalhando durante o turno, concluído por alguns segundos quando a resposta
  chega, master quando a conversa não tem dono. Cada tarefa da equipe mostra o
  bot do especialista no estado que `taskState` deriva; a falha não existe no
  vocabulário do wrapper (cinco estados, por decisão da especificação) — o bot
  dorme e quem diz "falhou" é o ícone e o rótulo da linha. O retrato
  personalizável do laboratório continua intocado no topo da barra.
- **Cobertura:** `avatar/grokSpecialistAvatar.test.ts` valida o mapa
  runtime→estado (`grokVisualStateFromRuntime`), o catálogo de comportamento
  (8 especialistas × 5 estados), o controller (monta, troca animação por
  estado, desmonta sem vazar) com um módulo fake injetado por `data:` URL — o
  mesmo mecanismo do export real — e a interface do stand-in público.

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
