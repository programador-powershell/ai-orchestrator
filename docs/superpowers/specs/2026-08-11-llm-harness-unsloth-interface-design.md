# Design — Harness de LLM com interface estilo Unsloth Studio (V.3)

Data: 2026-08-11 · Status: **aprovado pelo usuário** (brainstorm concluído)

## Problema

O AI Orchestrator V2 embute clones completos de terceiros (`third_party/`: soup,
opencode, drawdb) e o fluxo de fine-tuning depende de um único job em
localStorage, sem histórico nem backend. O usuário quer um **harness de LLM**
com a **interface do Unsloth Studio**, reescrito por completo em tecnologia
própria (Next.js 16.3 + TypeScript + Rust), **sem herdar repositórios de
terceiros** e **sem perder nenhuma feature** das funções que os 3 clones
representam — tudo com saída visual conversacional (chat, diff, cartões).

Achados que reenquadraram o pedido:

- O "peso" do repo (4,4 GB) é artefato de build Rust (`src-tauri/target`,
  gitignorado) — os clones somam só 26 MB. `cargo clean` resolve o volume local.
- O app já é TS + Rust moderno (React 19, Tauri 2, Axum); drawdb e opencode já
  são referência com abas nativas; só o soup era executado.
- O repositório unsloth atual É o **Unsloth Studio**: app desktop (Tauri!) de
  chat + treino local, **AGPL-3.0** — mesma classe de restrição do drawdb.

## Decisões do usuário

| Decisão | Escolha |
| --- | --- |
| "Interface do unsloth" | Fluxo/UX recriado nativamente; **zero código do unsloth** no app |
| Frontend | **Migrar Vite → Next.js 16.3.0** (App Router, `output: 'export'`) dentro do Tauri 2 |
| Treino | **Só nuvem** (API de fine-tuning BYOK); sem execução Python local |
| third_party | Remover os 3 clones; mesmas funções reescritas em TS/Rust, sem perda de feature |
| Shell | **Sidebar estilo Studio** substitui a topbar de abas |
| Identidade visual | **Própria** (tokens liquid glass) com os conceitos do Studio |
| Entrega | **4 fases**, cada uma commitável e funcional |

## Abordagem escolhida

**B — Harness incremental por fases.** Descartadas: A (big bang de todas as
telas do Studio — escopo inviável) e C (só motor, sem a interface pedida).

## Blocos do design

### Bloco 1 — Frontend Next.js 16.3 + shell estilo Studio

- Next como empacotador de SPA: `app/layout.tsx` (html pt-BR, metadata,
  `import '../src/styles.css'`) + `app/page.tsx` `'use client'` com
  `dynamic(() => import('../src/App'), { ssr: false })` — evita tocar nos ~14
  módulos com `window` no top-level.
- `next.config.ts`: `output: 'export'`, `images.unoptimized: true`,
  `transpilePackages: ['@ai-orchestrator/contracts']`, `reactStrictMode: true`.
- `tauri.conf.json`: `frontendDist: '../out'`; dev = `next dev -p 1420`
  (devUrl mantido); remover Vite/`index.html`/`main.tsx` (side-effects de boot
  migram para `useEffect` no shell); apagar `dist/` antigo. Vitest intocado.
- Shell novo: sidebar esquerda colapsável (rail de ícones) com navegação
  fixável — Chat, Code, Data, Design, Work, Security, Agent, **Train**,
  Export —, seção **Recents** (chats e runs com dot de status), menu de perfil
  no rodapé, **Settings em modal** (Ctrl+,). Padrões visuais do Studio como
  conceito: superfícies separadas por tom (sem sombra), raio grande em pílula,
  accent só em ações primárias — com a paleta própria do liquid glass.

### Bloco 2 — Harness no gateway (Rust/Axum)

- Rotas novas: `POST/GET /v1/workspaces/{ws}/finetune/jobs`,
  `GET …/finetune/jobs/{id}/events` (SSE com replay `Last-Event-ID` + fallback
  polling), `POST …/finetune/jobs/{id}/cancel`,
  `POST …/finetune/datasets` (validação server-side, multipart),
  `GET …/models` (catálogo incluindo fine-tunados → alimenta `route_configs`).
- Tabelas: `fine_tune_jobs`, `fine_tune_job_events`, `fine_tuned_models`.
  Reconciliador tokio pollando o provedor (job sobrevive ao app fechado).
- Semântica espelhada do Studio (clean-room): start idempotente
  (`start_request_id` pending/accepted/rejected + acknowledge/cancel), fases
  (idle → loading → configuring → training → finalizing →
  completed/error/stopped), stop cooperativo com `expected_job_id` (409
  superseded), `learning_rate` como string validada, rejeição de infinito em
  floats de clip.
- Trait `FineTuneProvider`: OpenAI primeiro; depois Mistral/Gemini/
  openai-compatible. Anthropic: fora (sem API pública de FT) — recorte
  explícito.
- Segurança: restringir/remover `provider_fetch` genérico do desktop; unificar
  os dois cofres de chave (keyring local vs providers cifrados no gateway);
  retenção/mascaramento LGPD antes de persistir datasets; isentar SSE do rate
  limit de 120 req/min.

### Bloco 3 — Aba Train estilo Studio (só nuvem)

- 3 sub-abas: **Configure** (cards Model / Dataset / Parameters
  Simple-Advanced / Configuration; coluna direita sticky "Run preview" com
  status Ready/Not ready e **custo estimado**) → **Current Run** (fase, eventos
  ao vivo, gráfico de loss via `result_files`, stop com confirmação) →
  **History** (grid com sparkline, rename, delete).
- Paridade soup portável para nuvem: hiperparâmetros + `validation_file` +
  método **DPO** no payload; lista/cancel/histórico de jobs + métricas;
  conversores alpaca/sharegpt→chatml e formato de preferência; ops de dados em
  TS puro (dedup, split train/val, PII básico, stats/tokens); estimativa de
  custo pré-upload; eval custom + LLM-judge base-vs-tunado antes de catalogar;
  geração sintética fechada (parse do retorno para o dataset); catálogo de
  modelos fine-tunáveis por provedor + presets (substitui recipes).
- **Drops explícitos comunicados na UI** (exigem posse de pesos/GPU): treino
  local e PEFT zoo, merge/export GGUF/ONNX/etc., push de pesos ao HF, serve
  local, sweep de hiperparâmetros (caro em nuvem), doctor/monitor de GPU.
  Mensagem: "modelos tunados na nuvem não geram pesos exportáveis".

### Bloco 4 — Saída conversacional e loop agêntico (gaps opencode/drawdb)

- **Loop agêntico de ferramentas** no chat: expor primitivas já existentes
  (fs_list/fs_read/fs_write, terminal_execute, busca) como tool-calls em
  `chatOnce`, com aprovação humana (base: gate de diff do CodeView + approvals
  do AgentView). Cartões na conversa para tudo: diff aplicável, código com
  highlight, eventos de treino, validação de dataset, schema.
- Auto-compact de contexto com contagem de tokens (substitui `slice(-200)`).
- Diagnostics pós-edição devolvidos na conversa (ciclo editar→verificar→corrigir).
- Cliente **MCP** (stdio/SSE) sob o mesmo diálogo de permissão.
- Comandos customizados em markdown com argumentos (`/review`, `/testgen`…).
- Data (gaps drawdb, clean-room): mais dialetos SQL (SQLite, MariaDB, MSSQL) +
  parser de import robusto, export de imagem PNG/SVG, múltiplos diagramas +
  import/export JSON, ON UPDATE/ON DELETE + cardinalidade editável, migração
  down, enums/tipos custom; corrigir n-n sem tabela de junção no export.

### Bloco 5 — Limpeza

- Remover `third_party/` inteiro (soup, opencode, drawdb), recursos do soup no
  `tauri.conf.json`, `vendored.ts`, escada de detecção, botão "Treinar local",
  editor soup.yaml, botão GPU/nvidia-smi, `SOUP_TEMPLATE`.
- Clone do unsloth fica FORA do repo (referência de estudo em pasta local).
- `THIRD_PARTY.md` substituído por nota de créditos/inspiração (sem código).

## Fases de entrega

1. **F1 — Fundação:** migração Next 16.3 + remoção de `third_party/` e do modo
   local do soup. App idêntico em funcionalidade visível.
2. **F2 — Shell Studio:** sidebar + recents + settings modal + padrões visuais.
3. **F3 — Harness:** rotas/tabelas/reconciliador no gateway + aba Train em 3
   sub-abas + paridade soup em nuvem (DPO, custo, eval/judge, conversores).
4. **F4 — Agêntico e paridade final:** loop de ferramentas + MCP +
   auto-compact + diagnostics + comandos markdown + gaps drawdb.

README versiona **V.3** ao final (mudança de UI/UX = versão inteira).

## Riscos e obrigações

- **AGPL-3.0 (unsloth e drawdb): processo clean-room.** Implementar somente a
  partir dos relatórios funcionais desta pesquisa; nunca copiar código/markup/
  CSS/strings/assets. Zero verde #17b88b, sem mascote, sem fonte Hellix.
- **Política Multiplike (item 4):** submeter a TI/SI o uso do unsloth como
  referência de UX antes da implementação. (Mesmo trilho já usado p/ drawdb.)
- **LGPD:** datasets JSONL podem conter dado pessoal; definir retenção e
  mascaramento antes de persistir no gateway.
- **Migração de estado:** job em localStorage precisa de rota de importação
  para os jobs persistidos (não perder acompanhamento na troca).
- **Next 16 / Turbopack:** validar `next build` cedo; fallback `--webpack`.
- **Porta 1420 sem strictPort no Next:** checar porta no `beforeDevCommand`.

## Fontes

- Relatórios da pesquisa paralela (7 agentes, run `wf_7f3a6c85-de1`):
  UX do Studio, semântica da API, paridade soup/opencode/drawdb, migração
  Next-em-Tauri, auditoria do gateway. Transcripts na pasta da sessão.
