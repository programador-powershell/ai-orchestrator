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
- **A raiz é do master; trabalho nasce em SUB-BOT.** Pedido de trabalho
  ("construa um html…") não sequestra a conversa: o especialista (Código,
  Design, Dados…) ganha conversa FILHA aninhada na barra, e a raiz guarda o
  espelho. O mesmo bot pedido de novo continua NA MESMA filha, com a memória
  dela. Conversa aberta já no bot (`/mode`, "novo schema", filha) tem UM modo,
  decidido na abertura e gravado nela — ali nada é reclassificado.
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

### :up: V.2.5
### :warning: Latest Changes

- **O cenário Vercel completo: construir DENTRO do sandbox e entregar o
  produto pronto.** A visão do dono virou produto em três peças:
  - **Execução isolada por padrão**: `proc.run` de turno de trabalho prefere o
    sandbox Docker/sbx quando ele está são (prioridade: escolha explícita da
    pessoa > sandbox disponível > padrão de sempre), com o **staging montado
    como workdir** — `npm install` e build acontecem no container, agindo na
    cópia; a máquina da pessoa não ganha nem `node_modules`. Sem sandbox,
    degrada honesto: UM aviso por turno e segue Local com aprovação.
  - **Entrega é o PRODUTO**: o espelho da promoção exclui reproduzíveis
    (`node_modules`, `.pnpm-store`, `__pycache__`, `.venv`, `.git` do staging)
    nos dois sentidos — não chegam ao projeto e não apagam os pré-existentes
    da pessoa; `dist/` entra, porque é o produto.
  - **Aba Site viva no Design**: o app entregue renderiza em iframe
    `sandbox=""` **sem script** (sanitização própria: script/iframe/object/
    embed/base/link fora, todo `on*`, `javascript:`/`data:` não-imagem
    bloqueados, CSS com cerca escapada), e o botão **"editar no canvas"**
    importa o HTML entregue como nós editáveis com undo.
  - **Persona sem terceirizar trabalho**: o Código não manda mais a pessoa
    abrir terminal — scaffold, dependência, build e verificação são ele quem
    roda, pelo funil, com teste impedindo o flagrante de voltar.
  - **Interrupção honesta na borda**: o `done` interrompido é carimbado na
    linha e o editor não abre aba de arquivo descartado — nem no vácuo do
    stop, nem de carona no turno seguinte.
  - **Provado no fio**: `npm install` rodou `[ambiente: docker]` com cwd na
    cópia congelada, funil exercido em `proc.run` e `fs.write`, e o projeto
    entregue terminou com `index.html` e `dist/` — sem `node_modules`.

### :pushpin: Fixes

- **MAX_PATH no workdir do sandbox** (flagrado pelo conferente com o sbx REAL
  da estação): staging com caminho acima de 260 caracteres fazia o
  CreateProcess recusar o diretório com um erro que não diz a causa. O nome da
  pasta de staging ficou curto (prefixo de 24 + hash) — a unicidade vem do
  hash, não do comprimento.

### :construction_worker: Refactors

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
