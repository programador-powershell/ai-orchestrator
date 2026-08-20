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

### :up: V.2.2
### :warning: Latest Changes

- **A Conversa — a tela padrão — ficou completa (Onda 5, a última da paridade).**
  - **Medidor de contexto na topbar**: percentual estimado da janela do modelo em
    uso, derivado das falas e saídas de ferramenta (~4 caracteres por token,
    heurística declarada no próprio title). É um PISO honesto: prompts de
    sistema e memórias que o cliente não vê não entram na conta — e isso está
    dito ali mesmo.
  - **Métricas por mensagem**: duração do turno (pelos timestamps dos envelopes,
    então sobrevive ao replay) e tokens de saída no rodapé de cada resposta, com
    botão copiar e feedback "copiado".
  - **Markdown completo sem dependência nova**: links clicáveis (allowlist
    https/mailto — `javascript:` vira texto), tabelas GFM com alinhamento,
    blockquote aninhável e hr, no parser incremental da casa.
  - **Raciocínio recolhível**: o gateway distinguiu raciocínio de rótulo de
    etapa (campo novo no payload Thinking, decode tolerante ao antigo) e o texto
    que antes era DESCARTADO agora chega num bloco fechado por padrão.
  - **Regenerar a última resposta / editar a última pergunta**: rota nova de
    truncar o log de forma durável (temp+rename, recusa turno em execução) —
    sem ela, reenviar duplicava a pergunta para sempre.
  - **Busca Ctrl+K por conteúdo** em todas as conversas (varredura
    case-insensitive no gateway, snippet seguro para acentos) com navegação por
    teclado.
  - **Excluir conversa** pela lixeira em dois cliques (arma e desarma sozinha —
    modal para linha de lista é interrupção demais) e **exportar .md/.json**.
  - **/review, /explain e /testgen expandem no cliente** antes do envio — deixam
    de ir literais ao modelo.
- **As três telas-casca finalmente FUNCIONAM.** `flow.validate`, `secrets.scan`,
  `osv.query` e `finetune.status` devolvem, além do relatório legível, um bloco
  JSON demarcado que as superfícies detectam: o Fluxo desenha o grafo real
  (@xyflow/react, homologado — e o "Exportar JSON" deixou de estar eternamente
  desabilitado), Segurança vira cartões com chips "N críticos/altos" e link para
  o advisory no osv.dev, e o Tuning sai do empty-state perpétuo. Bloco picotado
  vira estado vazio digno, nunca cartão inventado.
- **Botões superiores que faltavam**: ações de topbar no Trabalho (Board) e no
  Tuning (Train) — tudo pelo composer, nada executa por fora do funil.
- **Equipe no rodapé**: objetivo em curso fixado e estado "orquestrando…"
  derivados no StatusBar — o único elemento que sobrevive à troca de tela,
  porque a equipe continua rodando enquanto a pessoa olha outra superfície.

### :pushpin: Fixes

- **O app abria e fechava sozinho quando não havia gateway de pé.** O
  bootstrapper procurava o `aibotd.exe` ao lado do app e no PATH — nunca no
  `dist/` do repositório. Em dev isso sempre passou despercebido porque um
  gateway antigo estava eternamente escutando na porta e era ADOTADO; no dia em
  que o órfão morreu, o boot não achou binário nenhum, abortou o setup e a
  janela fechou sem uma palavra (o motivo ia para o stderr, que não existe num
  duplo clique). Agora: (1) o finder sobe a árvore procurando `dist/aibotd.exe`
  — com teto de oito níveis, para um app instalado em Program Files não sair
  varrendo o disco; e (2) toda falha de setup deixa o motivo em
  `boot-erro.log` na pasta de dados — "fecha sozinho" nunca mais fica sem
  rastro. Deliberadamente NÃO se copia o exe para o lado do app em dev: a
  cópia sombrearia o `dist/` e recriaria o problema do binário defasado.

- **Clicar numa conversa do histórico não abria nada — e a causa era um gateway
  FANTASMA.** O processo do gateway de ontem sobrevivia ao fechamento do app,
  segurava a pasta de dados (`.lock`) e a porta; o gateway novo desistia na
  trava e o app conectava NO VELHO — recompilar não mudava nada, silenciosamente.
  Como o binário antigo era de antes do re-hello, o clique trocava o título
  (que é local) e o replay nunca vinha: hero + "0 linhas". Agora o aibotd que
  encontra a trava ocupada verifica com o núcleo se o dono é um ÓRFÃO DE BUILD
  VELHO — mesmo executável, iniciado ANTES da última escrita dele (impossível
  estar rodando o binário atual) — e o derruba, assumindo a pasta. Qualquer
  dúvida (outro exe, horário inconclusivo) preserva a trava: derrubar um
  gateway legítimo faria dois donos numerarem `seq` nas mesmas sessões. Quatro
  testes: a decisão de mesa pelos dois lados da faca, a sonda contra o próprio
  processo, a recusa de ponta a ponta com um processo vivo que não é nosso, e
  as travas estranhas (pid ilegível, pid próprio).

- **Recusa do modelo contada como sucesso na Equipe.** "Não posso ajudar" saía
  com ✓ e contaminava as tarefas dependentes. Agora recusa é FALHA do
  trabalhador, com heurística conservadora (teto de 280 caracteres, prefixo com
  verbo de recusa, nunca verbo técnico — resposta técnica contendo "não" passa)
  e casos de mesa provando os dois lados.
- **Documento trocado pelo relatório da edição.** O coletor aceitava qualquer
  `office.*` e o relatório do `office.edit` ("N ocorrências trocadas…")
  substituía o TEXTO do documento na tela. Agora só a saída do leitor real
  (`office.open`) alimenta o corpo; edição bem-sucedida dispara releitura
  automática, o histórico de trocas deriva das edições REAIS (não só do
  formulário) e o cabeçalho ganhou chips de formato e somente-leitura.

### :construction_worker: Refactors

- O bloco JSON demarcado das ferramentas ganhou helper único no gateway
  (`tools_structured.go`) e extrator único no cliente (`lib/toolJson.ts`) — o
  padrão anti-casca da Onda 1 virou peça reutilizável em vez de quatro cópias.

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
