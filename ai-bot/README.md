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

### :up: V.2.1
### :warning: Latest Changes

- **A tela de Código virou uma IDE de verdade — Onda 4 da paridade.** Antes ela
  era uma casca: um editor sem árvore, sem abrir arquivo, sem terminal. Agora:
  - **Árvore do projeto na barra lateral** (`FilesRail`), montada por `fs.list`
    de verdade — expandir pasta lista na hora, com ícone por extensão. E um
    **quick open** com busca difusa (Ctrl+P) sobre os caminhos já vistos.
  - **Abrir e salvar passam pelo MESMO funil do modelo.** A interface não ganhou
    porta dos fundos: cada `fs.read`/`fs.write` da IDE entra pela rota
    `POST /v1/tools/call`, que reaproveita o `executeTool` inteiro — mesmo
    portão de permissão, mesmo cartão de aprovação, mesmos envelopes no log da
    conversa. Salvar um arquivo mostra o chip de aprovação como se o bot tivesse
    pedido. A whitelist é fechada (`fs.*` de leitura e escrita, `git.status`,
    `git.diff`, `flow.validate`, `context.fetch`) e é checada ANTES de qualquer
    coisa — recusa nem deixa envelope, senão a interface teria como encher o log
    sem passar por portão nenhum.
  - **Terminal da pessoa no pé da tela** (xterm.js + pty nativo no Rust). É o
    caminho do TECLADO, não do modelo: `pty_write` continua fora do registro de
    ferramentas — o modelo não tem como digitar nele. O painel de "saída" do
    editor segue sendo o espelho do `proc.run`, com aprovação.
  - **Autocompletar curto por conta da casa**: `POST /v1/model/complete` com
    teto DURO de 512 tokens e resposta efêmera — não entra no log, não vira
    contexto, é sugestão de trecho e nada mais.

### :pushpin: Fixes

- **GRAVE: arquivo entre 12 KiB e 512 KiB abria CORROMPIDO no editor — e dava
  para salvar o corrompido por cima do real.** O Tool Output Gateway projeta
  saída grande para a janela do modelo (início + fim + referência de artefato),
  e a rota da interface recebia essa projeção como se fosse o arquivo. Um
  `fs.read` de 200 KB abria picotado com um "[… omitidos …]" no meio; Ctrl+S
  gravaria o picote. Agora a rota devolve o INTEGRAL — reconstruído do Artifact
  Store, onde o gateway já tinha guardado o inteiro ao projetar — e o log
  continua com a projeção: a janela do modelo não paga o dump. O mesmo conserto
  vale para `fs.list` (a árvore não inventa mais entradas falsas ao parsear
  listagem cortada) e `fs.search` (resultados do meio não somem mais).
- **O terminal abria na pasta errada.** Sem `cwd`, o shell nascia no diretório
  do processo — no dev, a pasta do bootstrapper — e o `ls` mostrava outra coisa
  que a árvore ao lado. Agora o `pty_spawn` cai para a MESMA raiz de projeto das
  ferramentas `fs.*`, acompanhando inclusive a troca via `set_project_root`.

### :construction_worker: Refactors

- A entrada `editor` do Stage aponta para a variante `EditorSurface.terminal` —
  a superfície original inteira MAIS o dock do terminal, composição sem tocar no
  arquivo que as outras ondas editavam em paralelo.
- O placeholder do `FilesRail` no `Rail.tsx` morreu; o de verdade mora em
  `shell/rails/FilesRail.tsx`, no mesmo padrão dos rails de Dados e Design.

## :wrench: Instalação

Instala as dependências da interface.
```
corepack pnpm install
```

Compila o gateway (sem o roteador local; é o build padrão). A **barra no fim** é
obrigatória: com um caminho de arquivo o Go grava exatamente aquele nome, e no
Windows sai um `aibotd` sem `.exe` que o aplicativo não encontra.
```
corepack pnpm gateway:build
```

Inicia o app desktop em modo desenvolvimento — compila o gateway e sobe a janela
com ele no caminho de busca. **De dentro de `ai-bot/`**:
```
corepack pnpm dev:desktop
```

> **Este repositório hospeda DOIS aplicativos.** Na raiz mora o orquestrador
> (Next.js, porta 1420) e aqui mora o AI-BOT (Vite, porta 1421). Rodar
> `dev:desktop` na RAIZ sobe o orquestrador, não este app — a janela abre com
> outra interface e é fácil achar que o build deu errado. Da raiz, o comando
> deste app é `corepack pnpm dev:aibot`.

Gera o build de produção.
```
corepack pnpm build:desktop
```

Sobe **só a interface**, sem a janela. Serve para mexer em tela e para a bancada
de avatares em `http://localhost:1421/bench.html` — mas **não conecta no
gateway**: quem conhece o token é o processo do aplicativo, e embutir o segredo
no JavaScript servido o entregaria a qualquer página do mesmo contexto. As
Configurações dizem isso e mostram o comando de cima.
```
corepack pnpm dev
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
| corepack pnpm dev:desktop | Aplicativo em desenvolvimento (janela do Tauri), com recarga                  |
| corepack pnpm dev     | Só a interface (sem gateway), em `http://localhost:1421` — e a bancada em `/bench.html` |
| gerar-manifesto.mjs   | Mede, assina (Ed25519) e confere o manifesto de atualização — `corepack pnpm manifesto:gerar` e `corepack pnpm manifesto:verificar` |
| gerar-chaves.mjs      | Gera o par Ed25519: a pública para embutir no build, a privada para o cofre da TI |
| go test ./...         | Bateria do gateway (roteador, DAG, store, rede, permissão, protocolo, barramento)|
| corepack pnpm check   | `tsc --noEmit` em todo o workspace (interface e contratos)                       |
| corepack pnpm test    | Bateria da interface e a do gerador de manifesto, nesta ordem                     |

> **Sempre `corepack pnpm`, nunca `pnpm` puro.** O pnpm não é instalado
> globalmente aqui: quem o entrega é o `corepack`, que já vem com o Node e lê a
> versão exata do campo `packageManager`. É a mesma regra do repositório que
> hospeda este projeto, inclusive dentro do `tauri.conf.json` — `pnpm` solto
> falha com "não é reconhecido como nome de cmdlet".

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
