<div align="center">

# AI Orchestrator V2

![App Screenshot](https://placehold.co/960x540?text=AI+Orchestrator+V2)

🧠

</div>

## :heavy_check_mark: Features

> **Estado do produto.** O objetivo é ser a suíte corporativa de IA que substitui ChatGPT, Cursor, drawDB, OpenCut, Canva, OpenCode, openclaw e Unsloth. **Ainda não substitui** — faltam Tuning (treino local) e execução na VPS. A tabela de maturidade abaixo diz, por capacidade, o que já funciona ponta a ponta e o que é plano, auditado contra o código e não contra a intenção.

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
- **Equipe de agentes montada pelo orquestrador** (aba Agent): a pessoa escreve o que quer **no mesmo campo de mensagem das outras abas** — a aba não tem formulário nem seletor. O **modelo orquestrador** lê o pedido e decide o tamanho da equipe; ela segue sempre a espinha spec-driven (constituição → spec → plano → tarefas → revisão → CI). Os nós surgem conforme os agentes são contratados e a barra lateral lista `modelo - papel` ao vivo; o modelo de cada papel é do admin.
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

### :bar_chart: Maturidade por capacidade

Auditoria de 2026-08-12, revisada em 2026-08-13 com as capacidades entregues na V.8. Cada veredito é verificado contra o código, não contra a intenção — a coluna "o que falta" só perde uma linha quando ela deixa de ser verdade.

| Capacidade | Alvo | Estado | O que já funciona | O que falta |
| --- | --- | --- | --- | --- |
| Chat | ChatGPT | 🟡 Parcial | Streaming real nos 3 caminhos, memória persistente, anexos de texto, cartões de ferramenta, **leitura de PDF** e **busca semântica na memória** — com gateway os vetores aproximam por sentido ("como coloco no ar" acha "procedimento de deploy"); sem ele, a camada morfológica ainda junta plural, `-ção`/`-ar` e erro de digitação. A busca do painel usa o mesmo ranqueamento que o modelo recebe. Na **pesquisa profunda** cada página é **lida de verdade** (comando Rust, com guarda de SSRF); a fonte que falhou é **rotulada como não verificada** com o motivo e tem a credibilidade capada — nunca simulada em silêncio | Não há **índice de busca**: quem propõe as URLs candidatas é o modelo, então o alcance é o que ele lembra, não a web. Leitura de áudio/vídeo. A camada sem vetor cobre variação de **forma**, não de sentido — sem provedor de embeddings, "coloco no ar" continua sem achar "deploy" |
| Code | Cursor + OpenCode | 🟡 Parcial | CodeMirror real, loop agêntico com aprovação, diff por hunk, diagnostics, terminal e **completar por modelo no cursor** — o modelo recebe o que vem antes e depois e devolve o miolo, aceito com Tab; a resposta passa por limpeza (cerca de markdown, eco do prefixo, avanço sobre o sufixo) para não duplicar fechamento de chave. **Índice de símbolos** próprio (TS/JS, Python, Rust, SQL, Markdown), com `@` no Ctrl+P para pular à declaração | O índice cobre só os **arquivos abertos** e é por expressão regular, não um analisador semântico: não resolve tipos, referências nem importações. Sem LSP; o completar por modelo depende da rede e não roda offline |
| Data / ERD | drawDB | 🟡 Parcial | Desenhar tabelas, **FK criada arrastando a porta de um campo até outro**, export SQL (5 dialetos), migrações up/down, **imagem fiel ao layout desenhado**, **import de dump real** (nome qualificado, comentário de bloco), persistência | O import ainda é regex, não um parser SQL completo (CHECK, tipos compostos e partições passam batido) |
| Agent | agent-zero / spec-kit | 🟡 Parcial | **Equipe montada pelo orquestrador**: a aba não tem formulário — a pessoa pede no campo de mensagem, e um **modelo orquestrador** decide o tamanho da equipe e diz por quê na tela. Sem gateway ou com resposta ilegível cai numa heurística de reserva, e a tela **declara** que caiu. A equipe segue sempre a mesma espinha spec-driven (constituição → spec → plano → tarefas → revisão → CI). Os **nós aparecem conforme os agentes são contratados** e a barra lateral lista `modelo - papel` ao vivo, com o que cada um está fazendo; agentes da mesma onda correm em paralelo e a etapa seguinte só abre quando **todos** terminam. O **modelo de cada papel é do admin** (política do grupo). Delegação livre, spec manual e flow builder continuam nas outras abas. Cada execução de comando na máquina é **auditada no gateway** (tabela própria, comando redigido) | Execução server-side: a equipe morre se a aba fechar; o papel `CI` ainda descreve os passos em vez de disparar a esteira |
| Work | Butler/Zapier | 🟡 Parcial | Regras gatilho→ação com motor, log e toggle; **webhook HTTPS e ferramenta MCP saem do app de verdade** (URL guardada no cofre do SO, guarda de SSRF no Rust, fila de aprovação); **agendador roda em qualquer aba** | Nada roda com o app fechado (exigiria bandeja + autostart); e-mail só via webhook/MCP, sem conector M365 |
| Design | Canva / Pencil / Open Design | 🟡 Parcial | Canvas editável com export SVG/PNG; **clona o LAYOUT REAL** — a página é renderizada e a geometria sai de `getBoundingClientRect`, não de estimativa de CSS; **stencils de prototipagem** (botão, campo, cartão, navbar, navegador, celular, fluxograma) e **conectores que acompanham as formas**; **sistema de design que governa de verdade** — paleta/escala/raios/princípios que entram no prompt de toda geração, com conferência de conformidade nó a nó, correção automática e aviso quando a própria paleta não tem contraste; export `DESIGN.md` | **SPA não aparece**: o iframe roda sem script de propósito (HTML de terceiro não executa código no app), então tela montada por JS fica de fora. Captura é um retrato estático de uma largura só |
| Vídeo | OpenCut | 🟡 Parcial | Timeline de corte, preview, projeto que persiste entre sessões e **composição de verdade no export**: **transições** entre clipes (fade, dissolver, wipe, slide) com o offset acumulado calculado certo, **segunda faixa sobreposta** (logo/PiP, com PTS deslocado para entrar na hora marcada) e **texto sobre a imagem** com janela de tempo e escape do que quebraria o filtro | O preview mostra só a faixa base — transição, sobreposição e texto aparecem no arquivo, não na prévia; o áudio não acompanha o `xfade` (o app avisa); a mídia é apontada por pasta (sem diálogo de arquivo); exige ffmpeg no PATH e, para texto, um `.ttf` informado |
| Security / Sandbox / computer use | Snyk + openclaw | 🟡 Parcial | **Revisão profunda com segunda opinião**: uma pré-varredura por expressão regular escolhe os arquivos que tocam autenticação, entrada, execução, SQL, disco ou criptografia; cada candidato é investigado **sozinho** (não mais N arquivos truncados num prompt só) e um segundo agente tenta **derrubar** cada achado — na dúvida, refuta. O que foi refutado fica visível e recolhido, com o motivo, em vez de apagado. Varredura de segredos e painel do sandbox — diretório efêmero, ambiente limpo, e **Job Object do Windows**: processo nasce suspenso, teto de processos/memória, restrições de UI e **a árvore inteira morre no fim, inclusive netos órfãos** | A **área de trabalho do agente** confina caminho (`..`, absoluto e symlink apontando para fora são recusados) e encerra a árvore de processos, mas **não reduz privilégio**: não é AppContainer nem contêiner — o comando roda com o token do usuário e alcança a rede. Ver `docs/adr-computer-use.md` |
| Office / PDF | Word/Excel/PowerPoint + leitor de PDF | 🟡 Parcial | **Edita o binário DOCX/PPTX de verdade** e **lê PDF com extrator próprio** — sem biblioteca de terceiros: descomprime os streams e interpreta os operadores de texto do formato. Recusa PDF cifrado com motivo e explica quando o arquivo é digitalizado | PDF com fonte sem mapa `/ToUnicode` devolve os códigos internos, não as letras; sem OCR (PDF digitalizado é recusado com essa explicação); a ordem é a do stream, então layout de duas colunas pode sair intercalado |
| Governança e relatoria | Console corporativo (ChatGPT Enterprise) | 🟡 Parcial | **Kernel de plugins com dois donos** — globais do admin na política do grupo, próprios da pessoa só no agente dela (fechado por padrão), com a colisão recusada em favor do admin; **trilha append-only do que o modelo viu**, por origem, com export para anexar a chamado; **modo mínimo** para separar falha do modelo de falha do contexto. Política por grupo do AD assinada em Ed25519 e verificada no Rust; **uso medido de verdade** — tokens de entrada/saída contados nos três caminhos de provedor (inclusive em streaming, sem quebrar o stream) e **custo por usuário, grupo, modelo e dia**, calculado em SQL como `numeric` para não sofrer erro de ponto flutuante; **blocklist de domínios** definida pelo admin (união entre grupos); **trilha de auditoria** de cada comando executado na máquina, em tabela própria; modelo por papel da equipe de agentes | As migrações 0006–0008 e as rotas novas do gateway **nunca rodaram contra um PostgreSQL real** — só há teste unitário do que é puro, e por isso os interruptores novos do console (plugins globais, plugin próprio, code mode) foram verificados em teste, não na tela: o console exige grupos cadastrados. Sem tela de orçamento/alerta: o relatório mostra o gasto, não o impede |
| **Tuning** | Unsloth | 🔴 Ausente | Orquestra fine-tuning **em nuvem**, roteado pelo gateway corporativo quando conectado (chave do workspace, uso registrado), com validação de dataset e acompanhamento | Unsloth é **treino local em GPU própria** — não existe treinador local, nem modelos abertos, nem export de pesos. É outra categoria de produto |
| **Deploy na VPS + backup** | SSH + rotina da TI | 🟡 Parcial | **Cliente SSH ligado**: o ambiente VPS roteia a execução de verdade — o comando sai pelo `ssh` do sistema para o servidor cadastrado, e o badge do rodapé mostra o **destino real** (`usuário@host`) em vez da intenção. Nenhum segredo passa pelo app: autenticação por agente ou por caminho de chave, `BatchMode` e `PasswordAuthentication=no` fecham qualquer prompt de senha, e `StrictHostKeyChecking` nunca vira `no`. A **fingerprint fixada no cadastro é conferida a cada uso** — chave trocada recusa a conexão. VPS sem servidor habilitado (ou com dois) **bloqueia com o motivo**, em vez de cair para a estação em silêncio | Exige o OpenSSH Client do Windows (recurso do próprio sistema, mas instalado pela TI). **Não foi testado contra um servidor real** — só há teste da montagem de argumentos, do confinamento de caminho e da escolha de rota. WSL e nuvem seguem sem executor próprio. **Backup e redundância continuam ausentes** no código |

**Leitura honesta:** o app hoje é um **cliente agêntico corporativo com governança** — política do admin, SSO, gating por grupo, streaming, ferramentas com aprovação — e nessa função está sólido. Nas capacidades de produção ele deixou de simular: Office **edita** o binário DOCX/PPTX e lê PDF com extrator próprio, Design clona o layout real, Vídeo compõe (transição, sobreposição, texto), Code completa pelo modelo e Data cria FK arrastando. Nenhuma dessas é mais maquete.

Como substituto **definitivo** das sete ferramentas, ainda não está — e as duas frentes que faltam são de núcleo, não de acabamento: **Tuning** exige um treinador local em GPU própria (outra categoria de produto) e **execução na VPS com backup** exige um cliente SSH que não existe no binário. Enquanto isso, o trabalho roda na estação. Os dois itens estão adiados por decisão sua, não por esquecimento.

## :new: Releases Notes

### :up: V.8
### :warning: Latest Changes

- **A aba Agent vira uma equipe, não um workflow — e perdeu o formulário.** Não há campo de objetivo, campo de correções nem seletor de complexidade no corpo: a pessoa escreve o que quer **no campo de mensagem**, como em qualquer outra aba. Um segundo campo faria a mesma coisa de dois jeitos, e ninguém saberia qual manda. Quem decide o tamanho da equipe é o **modelo orquestrador**, não a interface; a equipe segue sempre a espinha spec-driven — constituição → spec → plano → tarefas → revisão → CI. A decisão e o motivo ficam na tela, porque escalação sem justificativa não dá para julgar. Sem gateway (ou com resposta ilegível) há uma heurística de reserva, e a tela **diz que caiu nela** — um agente que não roda por falta de classificação seria pior que um escalado por aproximação.
- **Os nós surgem conforme os agentes são contratados.** Mostrar a equipe inteira de antemão pareceria progresso que não existe. Na barra lateral, a lista viva `modelo - papel` cresce a cada contratação e mostra o que cada um está fazendo, alimentada pelo streaming. Agentes da mesma onda correm em paralelo e ficam lado a lado; a etapa seguinte só abre quando **todos** terminam — liberar no primeiro revisaria metade do trabalho.
- **Modelo por papel definido pelo admin**: `idea`, `scope`, `plan`, `code` e `review` recebem modelos diferentes pela política do grupo, com merge por prioridade. Escolher o modelo é escolher quanto gastar, e isso não é decisão do usuário. Papel sem definição cai no modelo do módulo. A delegação livre, a spec manual e o flow builder continuam nas abas **Livre**, **Spec** e **Fluxo**.
- **Vídeo deixa de ser só um cortador**: transições entre clipes (fade, dissolver, wipe, slide), **segunda faixa sobreposta** para logo/PiP e **texto sobre a imagem** com janela de tempo. O offset acumulado do `xfade` desconta cada sobreposição anterior — a conta que, feita crua, só erra a partir do terceiro clipe; e o overlay tem o PTS deslocado, senão entraria no segundo 0 apenas invisível. Quando a composição muda o resultado (áudio que não acompanha a transição, fonte que o ffmpeg não acha sozinho no Windows), o app **avisa antes** de renderizar.
- **O Tab do Code passa a ser do modelo.** A heurística do buffer continua para o caso barato — completar um identificador que já existe — e o modelo entra exatamente quando ela não tem nada a dizer, que é o caso do código novo. A limpeza da resposta é o que faz o recurso prestar: modelo de chat embrulha em cerca de markdown, repete o prefixo e segue escrevendo o que já existe depois do cursor. Sem cortar essa invasão, cada aceite duplicaria o fechamento de chave.
- **Índice de símbolos escrito aqui**, sem LSP: não há analisador de linguagem homologado para embarcar, então o escaneamento é por linha (nunca multilinha, para o número da linha bater) e cobre TS/JS, Python, Rust, SQL e Markdown. `@` no Ctrl+P pula para a declaração. Ele ignora comentário de bloco e docstring — exemplo em comentário é a fonte clássica de símbolo fantasma no índice.
- **A memória passa a ser encontrada por sentido.** A busca era por token exato: quem perguntasse "como publico o sistema" não achava a memória escrita como "procedimento de deploy" e concluía que nada tinha sido guardado — falha silenciosa, a pior delas. Agora há duas camadas reais: **vetores** do gateway, que aproximam por sentido, e uma camada **morfológica** que roda sem rede (junta plural, `-ção`/`-ar`, pesa termo raro acima de termo comum e perdoa erro de digitação no token). O vetor de cada memória é calculado uma vez e guardado com a chave derivada do texto, então editar a memória invalida sozinho. Sem provedor de embeddings tudo continua funcionando: semântica é melhoria, não requisito.
- **Revisão de segurança com segunda opinião.** A revisão mandava todos os arquivos num prompt só, cortados em 6.000 caracteres cada — o corte cai no meio de uma função e a atenção do modelo se divide. Agora uma pré-varredura **sem modelo** escolhe os candidatos por superfície (autenticação, entrada, execução, SQL, disco, criptografia), cada um é investigado sozinho em paralelo com teto, e um **segundo agente tenta derrubar** cada achado: a pergunta é "prove que isto NÃO é explorável", e a dúvida conta a favor de refutar. Falso positivo é o que faz um painel de segurança ser ignorado, inclusive quando ele acerta. O refutado **não é apagado** — fica recolhido com o motivo, senão uma refutação exagerada pararia de mostrar coisa real sem ninguém perceber.
- **Kernel de plugins com dois donos.** O **admin** define os globais na política do grupo; a **pessoa** cria os dela, válidos só no agente dela e só se a política liberar — o que nasce fechado. Plugin de usuário **nunca sobrepõe** ferramenta da administração: a colisão é recusada com o motivo. Eles são **declarativos** (ferramenta HTTPS, ferramenta MCP ou trecho de contexto), não código — um plugin que executasse JavaScript abriria a porta que a edição `managed` fecha compilando as saídas diretas para fora do binário.
- **Trilha da execução**: registro append-only do que o modelo viu, **por origem**, com a participação de cada fonte no prompt e export em texto para anexar a chamado. O que parece segredo é mascarado na entrada, porque quem lê a trilha é outra pessoa. É a pergunta que faltava entre "quanto custou" e "o que a IA rodou": **por que ele respondeu isso**.
- **Modo mínimo do harness**, para separar "o modelo é ruim nisso" de "o nosso contexto atrapalhou". O prompt master do admin **continua entrando** — nenhum modo o remove, senão trocar de modo na interface seria uma saída da política.
- **Code mode**: o modelo entrega **um programa** que combina várias ferramentas, em vez de uma ida e volta por chamada. Ele **não roda com `eval`** — é interpretado por um subconjunto fechado escrito aqui, sem função própria, `while`, reatribuição nem acesso por índice, e sem caminho até `window`, `globalThis`, rede ou qualquer objeto do app. Cada ferramenta chamada lá dentro **mantém a aprovação**. Liberado pelo admin, fechado por padrão.
- **Cliente SSH, e o ambiente do rodapé passa a rotear de verdade.** Escolher VPS manda a execução para o servidor cadastrado pelo `ssh` do sistema, e o badge mostra o **destino real**. Não embutimos biblioteca nem escrevemos uma: SSH é criptografia, e chamar o OpenSSH herda o agente, o `~/.ssh/config` e o `known_hosts` que a TI já administra. Senha é impossível por construção e a fingerprint fixada no cadastro é **conferida a cada uso**.
- **O projeto inteiro segue o ambiente, não só o terminal**: ler, listar, gravar, buscar e abrir documento binário passam pela mesma rota, com o caminho remoto confinado ao diretório do projeto. Mídia de vídeo e ffmpeg ficam locais de propósito — são da estação.

### :pushpin: Fixes

- **`drawtext` do ffmpeg quebrava com `%` e com apóstrofo** — descoberto rodando o binário depois da liberação da TI, não pelos testes de string. Sem `expansion=none`, um `%` solto aborta a renderização inteira ("Stray %"). E o apóstrofo não tem escape que preste: dentro de `'…'` a barra invertida não escapa nada, e `'\''` também falha — a aspas reaberta engole `:x=…:fontsize=…` para dentro da legenda. Verificado **extraindo um quadro**, não deduzido: um teste que só confere que o ffmpeg não retornou erro passa com o texto errado. Os dois pontos do caminho da fonte tinham o mesmo problema.
- **A busca do painel de memória era substring e mentia para o usuário**: ele não achava o que o modelo recebia normalmente. Duas buscas diferentes sobre a mesma memória é como se perde a confiança na função inteira — agora as duas usam o mesmo ranqueamento.
- **A tolerância a erro de digitação estava no lugar errado.** Comparar o texto inteiro por trigramas não resgata a consulta: "prodicao" radicaliza para `prod` e "producao" para `produ` — o erro mudou onde o sufixo termina, e no meio das outras palavras essa diferença some. Passou a ser por token.
- **O corte da memória era na nota final, não na relevância**: uma memória recente e importante entrava em toda consulta, inclusive nas que não tinham nada a ver com ela.
- **Digitar só `@` na paleta de símbolos não listava nada**, tendo símbolo indexado — parecia "não achei". Agora lista tudo, para dar para navegar sem saber o nome.
- **O code mode escapava da área isolada.** A tela passava as ferramentas de projeto mesmo com o sandbox aberto, então o programa gravava fora do confinamento que a pessoa acabara de ligar. A lista deixou de ser escolha da tela: é derivada da sessão. E passou a **falhar fechado** — sessão isolada pedida e não aberta deixa o programa sem ferramenta alguma, em vez de cair para as do projeto.
- **Roteava o comando e não o arquivo.** No ambiente VPS o agente rodava o build no servidor e lia/gravava no disco da estação — montava aqui e compilava lá. Pior que não rotear, porque parecia funcionar.
- **O seletor de ambiente era decorativo**: `settings.environment` era lido em dois lugares, os dois só para desenhar. Quem lia "VPS" no rodapé assumia que o comando não tocava a máquina dele, e tocava.
- **Recusa do modelo virava entrega concluída.** Na equipe de agentes, qualquer resposta não vazia era registrada como `done` — então "não posso ajudar com isso" entrava no contexto da onda seguinte e a revisão acabava revisando uma recusa. Agora há um classificador, e ele olha só o começo de respostas curtas: uma entrega longa que menciona "não posso confirmar que…" no meio continua valendo.
- **Agente que devolvia vazio contava como entrega da onda**, o que impedia a detecção de "onda inteira falhou" de disparar.

### :construction_worker: Refactors

- `videoExport` **removido**: o compositor cobre tudo que ele fazia, e módulo superseded com teste continua sendo código morto.
- Novos módulos puros e testados: `lib/videoCompose` (composição ffmpeg), `lib/agentCrew` + `lib/agentCrewRun` (escalação e execução por ondas), `lib/symbols` (índice), `lib/fim` (completar no cursor), `lib/semantic` + `lib/memoryVectors` (busca por sentido), `lib/plugins` (kernel), `lib/trajectory` (trilha), `lib/contextAssembly` (montagem do contexto) `lib/codeMode` (tokenizador, parser e interpretador do subconjunto), `lib/ssh` (roteamento por ambiente) e `lib/securityReview` (candidatos, investigação e refutação) — **1478 testes** no desktop, 84 no gateway e **138 no Rust do cliente**.
- **As oito fontes de contexto passaram a ser montadas num lugar só.** Elas eram empurradas direto no array de sistema por sete pontos diferentes do composer; agora são coletadas e entregues a `assembleContext`, que aplica o modo e registra a trilha. Sem esse ponto único, qualquer fonte nova nasceria fora do registro — e a trilha só vale se for completa.
- Aprendizado do **DeepSeek Harness** (MIT) sobre trilha por origem e modos de runtime, reimplementado do zero como as demais referências. O kernel de plugins **não** copia o modelo deles: lá o plugin é um módulo executável para terceiros estenderem o harness; aqui é um manifesto declarativo com dono definido, porque o produto governa em vez de abrir.
- ADRs em `docs/`: [edição gerenciada](docs/adr-edicao-gerenciada.md), [motor do Office](docs/adr-office-motor-wopi.md) e [computer use](docs/adr-computer-use.md) (modelo de risco e as perguntas abertas para TI/SI).


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
