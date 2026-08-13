<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

> **Estado do produto.** O objetivo é ser a suíte corporativa de IA que substitui ChatGPT, Cursor, drawDB, OpenCut, Canva, OpenCode, openclaw e Unsloth. **Ainda não substitui**: falta **Tuning** (treino local em GPU própria é outra categoria de produto) e faltam **backup e redundância** — os dois adiados por decisão, não por esquecimento. O resto das capacidades já produz arquivo de verdade.

- Interface **liquid glass**: app desktop Tauri 2 + **Next.js 16.3** (React 19, export estático).
- **Shell**: abas de módulo no topo com **cor própria por aba**, barra lateral servindo o módulo ativo, badge de ambiente no rodapé e Configurações em modal (Ctrl+,).
- **9 abas** — Chat, Code, Office, Design, Data, Work, Security, Agent e Tuning — com comandos de barra (`/review`, `/explain`, `/testgen`), `@`-menção de arquivo e busca global do histórico no composer.
- **Resposta em streaming** (token a token) nos três caminhos: gateway, modelo direto (BYOK) e runtime local.
- **Modo agente**: o modelo executa ferramentas (ler/buscar/editar/rodar) com aprovação, diagnostics pós-edição e auto-compact de contexto; **MCP** externo e interno.
- **Plugins com dois donos**: o **admin** define os plugins **globais** na política do grupo (união entre grupos, id único); a **pessoa** cria os dela, válidos só no agente dela — e só se a política liberar, o que nasce fechado. Plugin de usuário **nunca sobrepõe** ferramenta da administração: a colisão é recusada com o motivo. Eles são **declarativos** (ferramenta HTTPS, ferramenta MCP ou trecho de contexto), não código: um plugin que executasse JavaScript abriria a porta que a edição `managed` fecha compilando as saídas diretas para fora do binário.
- **Cliente SSH: o ambiente do rodapé passa a rotear de verdade.** Escolher VPS manda o comando para o servidor cadastrado pelo `ssh` do sistema, e o badge mostra o **destino real**. Não embutimos biblioteca de SSH nem escrevemos uma: SSH é criptografia, e chamar o OpenSSH do sistema herda o agente, o `~/.ssh/config` e o `known_hosts` que a TI já administra. Segredo nenhum passa pelo app, senha é impossível por construção, e a fingerprint fixada no cadastro é **conferida a cada uso**.
- **O PROJETO INTEIRO segue o ambiente, não só o terminal.** Rotear só os comandos era pior que não rotear nada: o agente compilava no servidor e lia/gravava os arquivos no disco da estação — montava aqui e buildava lá, sem ninguém perceber. Agora ler, listar, gravar, buscar e **abrir documento binário** passam pela mesma rota, com caminho relativo confinado ao diretório do projeto remoto (`..`, raiz e `~` recusados). Ficam locais de propósito: mídia de vídeo e o ffmpeg, que são da estação.
- **Code mode**: o modelo entrega **um programa** que combina várias ferramentas, em vez de uma ida e volta por chamada — oito passos deixam de custar oito requisições. O programa **não é executado com `eval`**: ele é analisado e interpretado por um subconjunto fechado escrito aqui, sem função própria, `while`, reatribuição nem acesso por índice, e sem caminho até `window`, `globalThis`, rede ou qualquer objeto do app. Cada ferramenta chamada lá dentro **mantém a aprovação** de uma chamada avulsa — senão escrever um programa seria a forma barata de driblar o gate. Tetos de passos, de chamadas e de itens por laço. Liberado pelo admin, fechado por padrão.
- **Trilha da execução**: registro append-only do que o modelo viu, por origem, com participação de cada fonte no prompt e export em texto para anexar a chamado. O que parece segredo é mascarado na entrada.
- **Modo mínimo do harness**: corta as injeções de conveniência para separar "o modelo é ruim nisso" de "o nosso contexto atrapalhou". O prompt master do admin **continua entrando** — nenhum modo o remove, senão trocar de modo seria uma saída da política.
- **Equipe de agentes montada pelo orquestrador** (aba Agent): a pessoa escreve o que quer **no mesmo campo de mensagem das outras abas** — a aba não tem formulário, seletor **nem modos**. O **modelo orquestrador** lê o pedido e decide o tamanho da equipe; ela segue sempre a espinha spec-driven (constituição → spec → plano → tarefas → revisão → CI). Os nós surgem conforme os agentes são contratados e a barra lateral lista `modelo - papel` ao vivo. Os papéis que tocam o repositório (`code`, `review`, `CI`) rodam no **runtime de ferramentas**, com a mesma aprovação humana do resto do app — e o **modelo de cada papel é o que o admin definiu**, não um rótulo na tela.
- **Produz arquivo de verdade, não maquete**: edita o binário **DOCX/PPTX**, lê **PDF** com extrator próprio, compõe **vídeo** (transição, faixa sobreposta, texto) pelo ffmpeg local, **clona o layout real** de um site e exporta **SQL/ERD** em 5 dialetos.
- **Completar por modelo no cursor** (aba Code), aceito com Tab, mais **índice de símbolos** próprio com `@` no Ctrl+P para pular à declaração.
- **Modelos fusion** com preset por estratégia e modelos específicos por tipo de atividade.
- **Edição gerenciada**: política (módulos por grupo do AD, motores, aprovação, prompt master) definida pelo admin no servidor, assinada em Ed25519 e verificada no Rust do cliente; a interface apenas reflete. Na edição `managed`, os caminhos diretos ao provedor são compilados fora do binário.
- **Janela Conectar Apps** (galeria MCP) com seletor de ambiente — Local, WSL, VPS ou Nuvem.
- **Memória persistente** local (SQLite/IndexedDB) independente de fornecedor, com import de histórico Claude/OpenAI e **busca por sentido** — vetores pelo gateway, e uma camada morfológica que funciona sem rede.
- **Relatoria de uso**: tokens contados nos três caminhos de provedor e **custo por usuário, grupo, modelo e dia** no console do admin.
- **Área de trabalho isolada** para o agente executar comando: pasta própria apagada no fim, **Job Object do Windows** matando a árvore inteira de processos, aprovação por execução e **trilha de auditoria** no gateway. Ligada só se a política do grupo permitir — e ela **não reduz privilégio** (ver ADR).
- **Blocklist de domínios** definida pelo admin, aplicada no Rust sobre a política assinada — vale para pesquisa, webhook e MCP.
- **BYOK** armazenado no keyring do sistema operacional; cadastro de servidor VPS sem campo de senha ou chave privada.
- **Regras por projeto** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) injetadas no prompt.
- Gateway próprio (Rust/Axum, PostgreSQL e Redis) e runtime local opcional.
- **Clean-room**: referências externas documentadas em `docs/creditos-inspiracao.md` — zero código de terceiros no repositório.

## :new: Releases Notes

### :up: V.9
### :warning: Latest Changes

- **A aba Agent perdeu as abas — e a equipe passou a executar.** Havia quatro superfícies ("Agentes", "Livre", "Spec" e "Fluxo") e cabia ao usuário escolher COMO os agentes trabalhariam: grafo desenhado à mão, delegação livre ou passo a passo manual. Escolher método não é trabalho de quem pede — era o mesmo pedido com três comportamentos e nenhum padrão. Sobrou um caminho: você escreve o que quer no campo de mensagem, o **modelo orquestrador** decide o tamanho da equipe e ela roda sempre na espinha spec-driven. Ao remover as outras superfícies apareceu o buraco que elas escondiam: a equipe só **conversava**. Agora os papéis que tocam o repositório (`code`, `review`, `CI`) rodam no **runtime de ferramentas** — leem o projeto, gravam arquivo e rodam comando com a mesma aprovação humana do resto do app. Saíram junto o flow builder, o acionamento livre, a spec manual e cerca de mil linhas de CSS que ninguém mais alcançava.
- **Aprovação virou FILA.** Os subordinados de uma onda rodam em paralelo e pedem aprovação ao mesmo tempo; o segundo pedido apagava o `resolve` do primeiro e a execução inteira ficava presa em "running" — nem o botão Parar destravava, porque ele só resolvia a aprovação visível. Fechar a aba agora recusa o que estava pendente, em vez de deixar o agente esperando um clique que não vem.
- **Modelo por papel deixou de ser rótulo.** A política do admin dizia "review: opus 5", a barra lateral mostrava isso — e a chamada usava o modelo do módulo. Num cliente gerenciado, escolher modelo é escolher quanto gastar: a tela afirmava uma coisa e a fatura registrava outra.
- **Token de conector MCP saiu do `localStorage` e foi para o cofre do sistema.** Ele ficava em texto puro no perfil do webview, em disco e em qualquer backup. Quem chama o conector agora é o **Rust**: ele lê o token do cofre, resolve o DNS antes de conectar e aplica a blocklist assinada — as três coisas que o renderer não consegue garantir. Remover o conector apaga o segredo junto.
- **Colar no terminal não executa mais.** Texto multilinha reconhecido era gravado e executado na hora, sem Enter e sem prévia: uma página hostil que troque o clipboard no evento `copy` rodava um script inteiro onde a pessoa achava ter copiado um comando de uma linha. Colar agora **arma** e mostra as primeiras linhas; quem executa é o `run`.

### :pushpin: Fixes

Varredura completa do repositório (14 revisores por área + refutação adversarial por arquivo). O que saiu dela:

- **SSRF fechado de ponta a ponta.** `::ffff:169.254.169.254` — o endpoint de metadados da nuvem escrito em forma IPv6 — não casava nenhum padrão v6 e era classificado como público, no gateway e no cliente. E a checagem que existia não valia para a conexão: ela resolvia o nome, aprovava e ia embora, enquanto o `reqwest` resolvia **de novo** na hora de conectar (um domínio com TTL curto entrega IP público na checagem e IP interno na conexão). Agora o endereço aprovado é **fixado** no cliente a cada salto, e o redirect é seguido à mão porque a política do reqwest só consegue reavaliar a URL, não o destino da conexão.
- **Code mode gravava o texto do modelo dentro do arquivo do usuário.** O programa recebia a saída embrulhada ("Resultado da ferramenta `fs_read`:") e cortada em 8.000 caracteres; um read-modify-write comum escrevia o cabeçalho no arquivo e, em arquivo grande, a versão truncada por cima do original.
- **Prévia e aplicação do diff divergiam** na aba de segurança: `+++i;` e `--- senha` ficavam invisíveis na revisão humana e iam para o disco assim mesmo — furo no único gate que existe ali. E o patch **nunca aplicava em arquivo CRLF** (a plataforma-alvo), culpando o arquivo com um "mudou desde o scan" falso.
- **Trocar a pasta do projeto no Code mantinha as abas abertas** e o Ctrl+S gravava o conteúdo do projeto antigo dentro do novo — `README.md`, `package.json`, qualquer caminho que coincidisse. Cada aba agora sabe de onde veio.
- **Trocar de conversa durante o stream** colava a resposta na conversa recém-aberta e a persistia lá; como o envio era liberado junto, dava para ver dois streams intercalando tokens na mesma mensagem.
- **Redação de segredo deixava passar as duas formas mais comuns**: `authorization: Bearer <token>` (o padrão parava no espaço e mascarava a palavra "Bearer") e `"api_key": "valor"` (a aspa do nome quebrava o casamento) — na trilha lida pelo admin e no export anexado a chamado.
- **Console admin revertia a própria edição**: o PATCH era montado sobre o estado da tela, que só atualiza depois do roundtrip, então duas marcações rápidas desfaziam a primeira — inclusive flags de segurança. E digitar "10" num teto gravava 1 e depois 0 (teto 0 = delegação bloqueada).
- **Relatório de custo ordenava dinheiro como texto**: "9.000000" aparecia acima de "80.000000" e, com o limite de 200 linhas, o maior gastador podia sumir do relatório que existe para encontrá-lo.
- **Bloco ```tool``` com cerca de código dentro do JSON** era cortado no meio: a chamada sumia em silêncio e o agente encerrava como se tivesse terminado — o arquivo nunca era gravado e ninguém era avisado.
- **Cache de vetores da memória não sabia de que espaço era**: trocar o provedor de embeddings por outro de mesma dimensão misturava dois espaços vetoriais e o cosseno espúrio (peso 0,65 na nota) enterrava a memória certa.
- **Panic por fatia UTF-8** derrubava a requisição no parser de CSS da captura (um emoji na posição errada bastava) e a extração de Office/PDF em documento acentuado grande.
- Mais 40 correções menores: `/toString` sumia a mensagem sem erro, preço com vírgula gravava zero em silêncio, o diff aberto se recolhia a cada token, o listener do Office vazava a cada troca de aba, a rota VPS bloqueada caía para o disco local, `.ultra_tmp` ficava no working tree, a segunda captura do Design gerava ids duplicados, o `releaseLock` travava o arquivo por 30 minutos depois de destravar.

### :construction_worker: Refactors

- **Fila de aprovação extraída para um módulo próprio**, testável sem montar componente — as duas telas que pedem aprovação usam a mesma, e o teste trava o caso que travava a árvore.
- **`fs_remove` no Rust**, com as mesmas guardas do `fs_write` (dentro da raiz, link simbólico recusado): existe para o app limpar o que ele mesmo cria, não como ferramenta do agente.
- **`validateMcpDraft` saiu da tela de Configurações** e virou regra compartilhada: a janela Conectar Apps salvava endereço sem esquema e exibia "Conectado" para algo que nunca funcionaria.

## :wrench: Instalação

Instala as dependências do monorepo.
```
corepack pnpm install
```

Inicia o app desktop em modo desenvolvimento.
```
corepack pnpm dev:desktop
```

Gera o build de produção.
```
corepack pnpm build
```

## :file_folder: Diretórios

```
├── Raiz
│   ├── apps
│   │   ├── desktop        # cliente Tauri 2 + Next.js 16.3/React 19 distribuído ao usuário
│   │   └── bootstrapper   # instalador gráfico que baixa e valida o NSIS do cliente
│   ├── packages
│   │   └── contracts      # contratos públicos compartilhados pelo cliente e gateway
│   ├── services
│   │   └── gateway        # API Rust/Axum, PostgreSQL e Redis (inclui harness de fine-tuning)
│   ├── scripts            # build local, assinatura e manifestos de release
│   └── docs               # documentação de release, specs de design e créditos (clean-room)
└── main
```

## :rocket: Executáveis

| Nome                          | Descrição                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| AI-Orchestrator-Setup.exe     | Instalador para o usuário final; baixa, valida e instala por usuário (sem UAC)      |
| build-local-installer.ps1     | Gera `artifacts/local/AI-Orchestrator-Setup-Local.exe` com o NSIS incorporado       |
| build-bootstrapper.ps1        | Compila o bootstrapper (instalador gráfico pequeno)                                 |
| sign-windows.ps1              | Assinatura Authenticode dos binários Windows                                        |
| configure-release.ps1         | Configura repositório e chaves para o primeiro release                              |
| generate-release-manifests.mjs| Gera e assina os manifestos de release (Ed25519/SHA-256)                            |
| gateway (cargo)               | `cargo run --manifest-path services/gateway/Cargo.toml` inicia a API Rust/Axum      |

## :computer: Acesso

Para o gateway local acesse http://127.0.0.1:8787

O app desktop não usa credencial padrão — a autenticação é via OIDC.

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

## :book: Documentação

### :link: [Wiki](docs/superpowers/specs/2026-08-10-liquid-glass-v2-design.md)
