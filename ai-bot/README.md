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

### :up: V.2
### :warning: Latest Changes

- **As Configurações ganharam o MENU do orquestrador**, item por item e na mesma
  ordem: Conexão, Motores & Fusion, Provedores (BYOK), Memória, Extensões,
  Plugins & trilha, Conectores (MCP), Runtime local, Ship (build & deploy),
  Servidor VPS, Administração e Aparência. Quem usa os dois apps não deveria ter
  de reaprender onde mora cada assunto.
  - **Cinco falam com o gateway**: Conexão (endereço descoberto pelo Rust,
    estado, ambiente e contagem do catálogo), Motores & Fusion (os modelos do
    catálogo, com adicionar e remover), Provedores (BYOK) (cadastrar, testar e
    remover provedor, com a chave indo do campo direto ao cofre), Runtime local
    (os cinco ambientes com a disponibilidade que o gateway mediu — o
    indisponível não é escolhível) e Aparência (tema e a equipe de
    especialistas).
  - **Sete abrem dizendo o que falta**, com uma frase concreta cada: qual pacote
    já existe no gateway e qual rota não existe. Nenhuma delas mostra campo
    editável — controle bonito que não faz nada é pior que a seção vazia, e o
    teste falha se aparecer um `input` ali dentro.
- **O corpo do bot deixou de ser uma esfera escalada: ele DEFORMA.** O núcleo
  (`avatar/GrokSlimeCore.ts`) é um caminho fechado de 48 pontos, cada um com
  sua própria mola — o contorno respira, estica na direção do gesto e volta,
  sem nenhuma etapa de escala. Os olhos brancos continuam sendo os do módulo do
  Avatar Lab; o que mudou é a massa preta em volta deles.
- **A pose da cabeça move a MASSA, não só o olhar.** `headX/headY/headZ`
  deslocam o centro, giram, achatam e esticam o corpo, com bolha na borda que
  lidera e compressão na que fica para trás; a mola é subamortecida de
  propósito, para o corpo continuar balançando depois que o alvo já parou. Os
  ciclos têm a mesma linguagem temporal do laboratório (2300 ms parado + 500 ms
  de transição; 5200 ms no ocioso, 3600 ms dormindo) e um desvio lento e
  irregular por ruído suave, para dois bots do mesmo ofício não baterem passo.
- **Cada especialista trabalha numa CENA do próprio ofício**, desenhada por
  cima do corpo: terminal para o Código, gráfico para os Dados, curva de Bézier
  para o Design, grafo de workflow para o Fluxo, faders para o Ajuste, scanner
  para a Segurança, painel de status para o Agente. A cena só aparece em
  tamanho de retrato; no bot pequeno da lista fica só o corpo em movimento.
- **A ordem das camadas é a da especificação e está travada por teste**:
  `backSvg` (braços e blobs atrás do corpo) → `AVATAR` (silhueta preta +
  olhos) → `frontSvg` (cena do ofício e status). A ordem do DOM é a ordem de
  pintura, e é ela que decide o que fica visível.
- **Cobertura (18 casos):** `avatar/grokSpecialistAvatar.test.ts` valida o mapa
  runtime→estado, o catálogo de comportamento (8 especialistas × 5 estados) e o
  controller com um módulo fake injetado por `data:` URL. A camada do corpo
  acrescenta seis guardas: o caminho do slime muda de um quadro para o outro, a
  esfera redonda do módulo é escondida (`opacity: 0`), a ordem das três camadas
  é exatamente a de cima, o brilho tem contagem de pontos constante, o brilho
  existe nos cinco estados e `deformation: 0` desenha diferente de `0.65`. O
  motor é chamado direto, com `time` e `dt` fixos — sem relógio real, sem
  tolerância.

### :pushpin: Fixes

- **A barra lateral enchia de conversas que ninguém começou.** A sessão nasce no
  aperto de mão do WebSocket, então abrir a janela, recarregar a página ou
  reconectar criava mais uma — todas com zero turno e sem título. Duas
  correções: o app agora **lembra a conversa aberta** (só o id, um ponteiro; as
  linhas continuam vindo do replay do gateway) e a manda como `sessionHint` na
  primeira conexão, em vez de pedir uma nova; e a barra **só lista conversa com
  turno**, mantendo a ativa visível mesmo vazia, que é para onde o próximo texto
  vai.
- **Cada conversa passou a mostrar o AVATAR do especialista**, e não um ícone
  genérico. O ícone dizia "isto é uma conversa", que a lista inteira já diz; o
  retrato diz de quem ela é, que é o que se procura ao correr o olho pela barra.

- **NENHUM navegador conseguia abrir o WebSocket do gateway: dois caracteres
  trocados na constante do handshake.** A RFC 6455 fixa
  `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`; o código tinha
  `258EAFA5-E914-47DA-95CA-5AB0DC85B11C` — o `C` migrou do começo do último
  grupo para o fim. Com isso o `Sec-WebSocket-Accept` saía errado, e o navegador
  (que confere esse campo) recusava **em silêncio**: `close 1006`, sem mensagem,
  sem erro no servidor, sem sessão criada. O app abria e ficava eternamente em
  "sem conexão". O defeito ficou escondido porque cliente escrito à mão não
  confere o campo — o teste de linha de comando conectava normalmente. Agora há
  o vetor de teste da própria RFC (`dGhlIHNhbXBsZSBub25jZQ==` →
  `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) e um teste que compara a constante caractere a
  caractere.
- **Recusa de handshake por token passou a aparecer no log do gateway** (origem e
  comprimento recebido × esperado, nunca o valor). O silêncio custou uma tarde:
  a tela dizia "gateway fora do ar" e o servidor não registrava nada.

- **Gateway que morre sem encerrar limpo travava a pasta de dados PARA SEMPRE.**
  A trava guarda o pid do dono e era considerada órfã quando `os.FindProcess`
  falhava — só que no Windows ele chama `OpenProcess`, e o objeto do processo
  sobrevive à morte enquanto alguém segurar um handle. Quem segura é o próprio
  aplicativo: ele é o pai do gateway e guarda o `Child` para colher no
  encerramento. Resultado: queda, `taskkill` ou atualização mal sucedida
  deixavam um pid morto que "existe", nenhum gateway subia mais naquela pasta
  enquanto a janela estivesse aberta, e a tela dizia "gateway fora do ar" sem
  saída. Agora quem responde é o handle como objeto sincronizável
  (`WaitForSingleObject` com espera zero), que distingue rodando de terminado.

- **O `dev:desktop` da raiz subia o aplicativo ERRADO.** O rename de escopo tinha
  deixado dois apps diferentes com o mesmo nome de pacote (`@ai-bot/desktop`: o
  orquestrador na raiz e este aqui), então o `--filter` casava com o primeiro e a
  janela abria com a interface do orquestrador — parecendo build quebrado. O
  escopo daqui voltou a ser `@aibot/*`, e a raiz ganhou `dev:aibot`, que aponta
  para este app sem ambiguidade.

- **A tela pedia a chave de API sem ter para onde mandá-la.** Sem gateway, a
  seção de Provedores mostrava o formulário inteiro — com campo de senha — e o
  envio morria em `Failed to fetch`. A guarda testava se o TRANSPORTE existia, e
  ele existe sempre: `gatewayInfo()` não falha, ela cai num token vazio de
  propósito quando roda fora do aplicativo. Agora a porta é a **conexão**
  (`status === "ready"`), e sem ela a seção mostra o que fazer em vez de um campo
  de segredo sem destino. `Failed to fetch` também deixou de vazar para a tela:
  vira "não foi possível falar com o gateway — ele não respondeu no endereço
  configurado".
- **O aplicativo desktop não achava o gateway no Windows.** O script de build
  gravava `dist/aibotd` — caminho de ARQUIVO, então o Go usa o nome literal —
  enquanto o Rust procura `aibotd.exe`. Quem seguisse o README à risca abria a
  janela e via "não encontrei o gateway". Agora o alvo é a PASTA (`-o dist/`), e
  quem escolhe o nome certo para o sistema é o Go.
- **`dev:desktop` deixou de exigir cópia de binário na mão.** Em produção o
  empacotamento põe o `aibotd` ao lado do executável; em desenvolvimento esse
  "ao lado" não existe, e o segundo lugar procurado é o PATH. O script novo
  compila o gateway e acrescenta `dist/` ao PATH do processo que sobe o Tauri.
- **A tela de Configurações mandava esperar uma conexão que nunca vinha.** Numa
  aba de navegador o token do gateway não existe — quem o lê do disco é o
  processo do aplicativo, e embuti-lo no pacote JavaScript o entregaria a
  qualquer página do mesmo contexto. A seção dizia "os provedores aparecem
  quando ele conectar"; agora ela distingue os dois casos e mostra o comando que
  resolve.
- **A cena do ofício estava sendo pintada ATRÁS do corpo preto — ou seja,
  invisível.** O CSS já descrevia `.gsa-art-layer` em `z-index: 3`, mas nada
  criava essa camada: terminal, gráfico, scanner e status voltavam para dentro
  do SVG único do palco, abaixo do slime. A camada da frente passou a ser
  criada de fato, e um teste guarda a ordem para a regressão não voltar calada.
- **A ponta do reflexo do topo saltava alguns pixels, três vezes por segundo.**
  O brilho escolhia os pontos por uma caixa fixa do palco enquanto o corpo
  passeia com o centro em mola: a cada quadro entrava ou saía uma amostra
  inteira. Medido em jsdom, a contagem oscilava entre seis valores (12 a 17) e
  trocava 83 vezes em 30 s, movendo a extremidade do traço 7,7 unidades de uma
  vez. Agora a faixa é ANGULAR, presa ao corpo: a contagem é constante por
  construção e o reflexo acompanha o corpo inclusive quando ele desce ou
  inclina.
- **`deformation: 0` entregava 65% da deformação.** O motor reclampava a força
  para `[0.65, 1.55]`, então o valor documentado como "nenhuma" na opção
  pública desenhava exatamente o mesmo que `0.65`. Zero voltou a significar
  zero — e desliga a deformação (pressões do ofício, slosh, impulso e wobble da
  borda), não o movimento: o corpo continua deslocando e inclinando, porque
  isso é pose de cabeça, não deformação.

- **Os scripts chamavam `pnpm` puro, que não existe nesta máquina.** O repositório
  que hospeda este projeto padroniza `corepack pnpm` em todo lugar — inclusive
  dentro do `tauri.conf.json` —, e o ai-bot tinha nascido fora desse padrão: cinco
  scripts da raiz e os dois ganchos do Tauri chamavam `pnpm` solto, que falha com
  "não é reconhecido como nome de cmdlet" para quem não tem pnpm global.

### :construction_worker: Refactors

- **A configuração do ai-bot passou a seguir a do repositório que o hospeda** no
  que não colide: os scripts da raiz ganharam o mesmo vocabulário (`build`,
  `check` e `test` recursivos com `--if-present`, `dev:desktop` para a janela do
  Tauri) e tudo passou a chamar `corepack pnpm`. O `check` só faz efeito porque
  os dois pacotes ganharam o script com esse nome: antes o do desktop não existia
  e o de contratos se chamava `typecheck`, então uma varredura recursiva passaria
  batido em silêncio.
  **O escopo dos pacotes NÃO segue, e não pode seguir.** Renomeá-lo para
  `@ai-bot/*` deixou dois aplicativos diferentes com o mesmo nome — o orquestrador
  da raiz já era `@ai-bot/desktop` —, e o `--filter` da raiz passou a subir o
  aplicativo errado. Aqui o escopo é `@aibot/*`, e é essa diferença que faz o
  filtro apontar para um app só.
- **`allowBuilds:` saiu do `pnpm-workspace.yaml`.** Não é chave do pnpm 10 — o
  arquivo declarava aprovar o build do esbuild e o instalador seguia avisando que
  o ignorava, ou seja, mais uma configuração declarada que ninguém lê. Sem ela o
  `install --frozen-lockfile` e o `build` continuam passando, que é o que o
  projeto ao redor já fazia (ele nunca teve essa chave).
- **`avatar/grokSpecialistAvatar.ts` virou um re-export** de
  `grok_professional_avatar_v3.ts`: quem importava pelo nome antigo continua
  compilando, e existe um só motor de animação.
- **A opção `organicWarp` saiu do contrato público.** Ela era aceita e
  ignorada desde a troca do corpo — opção declarada que ninguém lê é a mesma
  classe de bug que já custou tempo aqui.
- **O primeiro quadro não inventa mais velocidade.** A distância entre o palpite
  inicial do centro e o alvo da primeira pose era dividida por um `dt` artificial
  e virava velocidade de um valor nunca observado. A guarda entrou medida: nos 40
  pares especialista/estado a diferença no pico de deformação dos 25 primeiros
  quadros ficou em 1,7%, ou seja, não havia solavanco visível para tirar — a conta
  é que era infundada.

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
