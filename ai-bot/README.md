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

- **O degrau local do roteamento passou a funcionar — por processo, e no binário
  normal.** O caminho nativo (cgo) estava parado por duas paredes que não são
  técnicas: o motor C do Needle vive num projeto à parte, com licença própria e
  header `cactus_engine.h` (o shim tinha sido escrito contra uma API `needle_*`
  que **não existe**), e ligar a tag exigiria toolchain C em toda máquina que
  compila o gateway. O caminho por Python contorna as duas — `pip install
  cactus-needle` e `needle fetch` trazem um binário único de ~14 MB com modelo,
  tokenizer e engine **selados dentro**. O gateway sobe o processo, aperta a mão
  e pergunta por linha JSON; se ele não subir, morrer, responder lixo ou passar
  de 3 s, o degrau sai e a cascata segue para o modelo grande. A resposta é
  **conferida** contra os candidatos — processo de terceiro não escolhe
  especialista que a política da sessão não liberou. Ver
  `services/needle-sidecar/`.
- **Cascata completa, exercitada de ponta a ponta contra o gateway de verdade:**
  `"crie uma aplicação em next.js completa"` decide no **degrau 1** (léxico, µs,
  sem processo e sem rede) e `"melhora isso aqui"` — que o léxico não resolve —
  decide no **degrau 2**, o processo local. `cmd/fakeneedle` fala o mesmo
  protocolo do script Python, para exercitar a fiação inteira em máquina sem
  Python.

- **Os bots aparecem na barra lateral com PRESENÇA: cinco estados animados por
  especialista.** O retrato procedural ganhou uma camada de estado
  (`avatar/presence.ts`) que diz COMO o bot está agora, sem tocar o contrato
  `Avatar` nem o Go: **ativo** (olhar passeando, piscada em ritmo próprio),
  **dono da conversa** (anel de ouro pulsando — é o especialista sticky do
  primeiro input), **trabalhando**, **em espera** (pálpebra caída, esmaecido),
  **concluído** (pulinho único e os olhos viram arcos felizes) e **falhou**
  (postura caída, dessaturado). A vida mora nos olhos: o rosto inteiro desliza e
  pisca por keyframes com `animation-delay` derivado da SEMENTE — dez bots na
  mesma lista não piscam em coro, e nada usa `Math.random`.
- **Trabalhando mostra O QUE o especialista faz, não só que está ocupado.** Cada
  ofício varre com os olhos do seu jeito — o Código LÊ linha a linha, Dados
  sobem DEGRAUS, a Revisão faz o PÊNDULO, o Design segue a CURVA — e um adereço
  animado aparece ao lado do corpo: cursor piscando entre colchetes (code),
  lápis traçando (design), barras medindo (data), pena escrevendo (office),
  escudo pulsando (security), engrenagem girando (work), faders buscando o ponto
  (tune), pacote viajando entre nós (fluxo), balão digitando (chat) e delegação
  pulsando (agent/master). O mapa é `craftOf(id)` em `lib/specialists.ts` — id
  desconhecido coordena, como o master.
- **A lista de conversas e as tarefas da equipe trocaram o ícone chapado pelo
  bot vivo.** Cada conversa mostra o avatar do especialista dono; a ABERTA ganha
  presença (dono da conversa → trabalhando durante o turno → concluído por
  alguns segundos quando a resposta chega) e as demais ficam paradas — uma lista
  inteira de bots agitados seria ruído. Nas tarefas da equipe o tom que
  `taskState` já derivava vira presença: planejada espera, despachada trabalha,
  concluída celebra, falha entristece — e quem escalou ESPERA, porque fez uma
  pergunta e está parado, não quebrado. O master no topo é o termômetro do app:
  atento em repouso, coordenando durante o turno.
- **Sem presença, nada muda — garantido por teste.** O SVG exportado pelo
  laboratório sai byte-idêntico ao de antes; `prefers-reduced-motion` desliga o
  movimento sem apagar a informação (o esmaecido da espera e a postura da falha
  são regra estática); e a presença entra na CHAVE do CSS, então o mesmo retrato
  em estados diferentes não colide no documento. `avatar/presence.test.ts` cobre
  as três garantias.

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
