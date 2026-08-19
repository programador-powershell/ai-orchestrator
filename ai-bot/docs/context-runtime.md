# Context Runtime — estado da implantação

A especificação original está em [context-runtime-spec.txt](context-runtime-spec.txt).
O princípio: **JANELA DO MODELO != MEMÓRIA DO AGENTE** — o histórico integral
vive fora do prompt, e o modelo recebe só o working set da próxima decisão.

A implantação foi INTEGRADA às peças que já existiam, não adicionada ao lado
delas. O mapa, item a item:

| Peça da spec | Estado | Onde vive |
| --- | --- | --- |
| Event Store (L4) | :white_check_mark: JÁ EXISTIA | O log append-only por sessão (`internal/store`, envelopes com `seq`) É o event store — fonte autoritativa, replay numerado. Nada foi duplicado. |
| Model Adapter (§16) | :white_check_mark: JÁ EXISTIA | `internal/modelrouter` — provider-agnóstico, janela por modelo no catálogo. Nenhuma regra de memória mora nele. |
| Subagent isolation (§15) | :white_check_mark: JÁ EXISTIA | Delegação (briefing → resultado) e equipe (task → worker.done): o filho recebe o pacote de tarefa, o pai recebe o resultado — nunca a conversa inteira. |
| Budget Manager (§7) | :white_check_mark: JÁ EXISTIA | `supervisor/context_budget.go` — janela real do modelo, fatia do prompt (65%), corte com marca visível. |
| State Capsule (§5) | :white_check_mark: NOVO | `internal/contextrt` — dobra DETERMINÍSTICA e incremental por cursor, no fim de cada turno (a compactação por fase da spec). Erros viram estado (aberto/resolvido), decisões e arquivos ficam; a narrativa cai. Persistida como blob da sessão. |
| Compactação (§8) | :white_check_mark: NOVO | A cápsula substitui o que a janela recente não alcança: antes, além das últimas 40 mensagens TUDO sumia; agora o destilado entra como system message antes da cauda. Sem chamada de modelo: custo zero por dobra, sempre disponível, nunca inventa. O polimento por LLM pode entrar como refino. |
| Artifact Store (§6/§12) | :white_check_mark: NOVO | `store.SaveArtifact`/`ReadArtifact` — endereçado por conteúdo, fatias obrigatórias, offset negativo lê do fim. |
| Tool Output Gateway (§12/§29) | :white_check_mark: NOVO | `supervisor/tool_gateway.go` — acima de 12 KiB a saída vira artefato + projeção início/fim (política por tipo: compilador/log pesa o fim; listagem pesa o começo). O log guarda a projeção; o integral fica recuperável. |
| Recuperação sob demanda (§14/§36) | :white_check_mark: NOVO | Ferramenta `context.fetch {ref, offset, maxBytes}` — universal (todo especialista), risco de leitura, teto de 16 KiB por fatia. |
| Smart File Read (§13) | :white_check_mark: NOVO | `fs.read {path, offset, limit}` por FAIXA de linhas; `fs.search` já existia como passo 2 da prioridade da spec. |
| Grupos atômicos (§10) | :white_check_mark: NOVO | O par tool_call+tool_result virou UMA mensagem no histórico (casado por callID na cápsula) — o orçamento não consegue mais partir a unidade. |
| Telemetria (§25/§41) | :warning: PARCIAL | A cápsula separa CUMULATIVO (chars/eventos dobrados) de ATIVO (estimado por chamada no budget). Painel/dashboard: pendente. |
| Two-pass + prefire (§9) | :x: PENDENTE | Fase 4 da spec. A dobra determinística é barata o bastante para rodar sempre; o prefire só fará sentido com compactação por LLM. |
| Checkpoints (§24) | :x: PENDENTE | Rastreado no cluster (shadow-git em `Execution.ShadowGitDir`, ver arquitetura-cluster.md). |
| Retrieval semântico (§43.23) | :x: PENDENTE | Hoje a recuperação é por referência explícita (`context.fetch`) e pela memória (`memory.read`). Índice semântico: fase futura. |

## Critérios de aceitação da spec (§44)

- (2) Tool output de MB nunca entra integral: **sim** — gateway em todo `executeTool`.
- (3) Recuperar informação antiga sob demanda: **sim** — `context.fetch` + cápsula apontando os artefatos.
- (4) Continuar depois da compactação sem perder objetivo/próximo passo: **sim** — a cápsula valida objetivo (semente: título da sessão) e carrega erros abertos e pendências.
- (6/7) Subagentes com contexto próprio, pai recebe resumo: **sim** — já era o desenho.
- (8) Trocar de provider sem mudar o runtime: **sim** — nada de memória no modelrouter.
- (9) Ativo × cumulativo separados: **sim** — budget por chamada × telemetria da cápsula.
