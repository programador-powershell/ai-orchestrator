# AI-Orchestrator — "Liquid Glass" — Design Spec

Data: 2026-08-10 · Status: aprovado por execução autônoma (pedido detalhado do usuário)

## Objetivo

Recriar o produto como o harness mais fluido e otimizado possível: app desktop de verdade
(core nativo Rust/Tauri, não apenas webview), UI inteira em liquid glass com transições
fluidas, memória persistente independente de fornecedor (inspirado em akitaonrails/ai-memory),
modelos "fusion" (orquestrador + executor / merge), e 7 superfícies — todas com input de chat
e modo planejamento.

## Decisões

| Tema | Decisão | Racional |
| ---- | ------- | -------- |
| Stack | Tauri 2 (Rust) + React 19 + Vite 7, frontend 100% reescrito | Core nativo já existe (terminal, keyring, OIDC, runtime local GGUF, extensões). "Nova tecnologia" = novo design system CSS moderno (@property, color-mix, backdrop-filter, SVG refraction), View Transitions API, springs GPU-only |
| Abas | Chat, Code, Design, Data, Work, Security, Agent (Game sai da UI; contrato mantido p/ gateway) | Lista explícita do pedido |
| Consistência | AppShell de geometria fixa: topbar 56px, rail lateral 232px (colapsável), viewport 1fr, composer dock fixo. Toda aba renderiza num mesmo frame com os mesmos primitivos (Surface/Panel/Toolbar/StatusBar) e grid padrão esquerda 232 / centro 1fr / direita 284 | Requisito "nenhuma tela maior que a outra, sem distorção" vira invariante estrutural, não convenção |
| Transições | `document.startViewTransition` com crossfade direcional (slide 12px + blur + scale 0.985), 260–420ms, apenas transform/opacity; fallback CSS puro; `prefers-reduced-motion` respeitado | Fluidez sem jank (compositor-only) |
| Memória | Núcleo TS provider-agnostic (`lib/memory.ts`): itens {kind, title, content, tags, importance, uses, timestamps}, recall top-K por score (relevância FTS + recência + importância + uso), injeção como preâmbulo de sistema em toda conversa, captura pós-resposta. Adapters: SQLite via comandos Rust (desktop) e IndexedDB (fallback/web). Import: pasta de memória do Claude (MEMORY.md/*.md) e export JSON do ChatGPT. Export JSON | Memória permanece qualquer que seja a API no "motor" |
| Fusion | `FusionPreset {orchestrator, executor, strategy}`; estratégias: `orchestrate` (orquestrador planeja → executor gera → orquestrador revisa), `merge` (N modelos em paralelo → combinador funde, estilo OpenRouter), `race`. Mapa papel→modelo/preset por aba (chat/work/code/design/data/security/agent) | Pedido explícito, ex.: security = Kimi K3 (orquestrador) + GPT (executor) |
| Plan mode | Toggle no composer; prompt de sistema pede plano JSON estruturado; PlanCard com passos, aprovar/ajustar; aprovação dispara execução | Pedido: todas as janelas com modo planejamento |
| Chat research | Pipeline: gerar consultas → buscar/abrir fontes (comando Rust `research_fetch`; mock no web) → avaliar credibilidade por modelo → síntese com citações (sites e vídeos via oEmbed) → gate de confirmação antes da resposta final | "Nível Grok 4.5, avalia sites, vídeos, confirma antes da resposta" |
| Code | Explorer FS real (comandos Rust fs_*), editor CodeMirror 6, terminal existente (10 runtimes), diff, orquestrador DAG, seletor modelo/fusion | "Roda nativamente qualquer linguagem" já coberto por terminal.rs + catálogo de runtimes |
| Design | Canvas infinito (pan/zoom), replicação de site via gateway (existe), inspector de tokens, painel de vídeo estilo OpenCut (timeline, clipes, trim; export requer ffmpeg detectado) | Incorporar OpenCut como superfície de vídeo |
| Data | Editor ERD estilo drawdb 100% funcional: criar/arrastar tabelas, editar campos/tipos, relações FK (SVG), zoom/pan, chat-to-schema (ops JSON aplicadas ao diagrama), export SQL PostgreSQL/MySQL/ANSI, import básico de CREATE TABLE | Pedido explícito |
| Work | Kanban + automações (receitas) + conectores Microsoft 365 (somente conectores aprovados, conta corporativa — política Orchestrator refletida na copy) | Superior ao cowork: integrações declaradas, tarefas automatizáveis |
| Security | Pasta do projeto → scan (heurísticas locais de segredos + revisão multi-modelo via fusion), findings com patch em diff lado a lado, aplicar/rejeitar por hunk (fs_write), execução em sandbox estilo ai-jail (`sandbox_execute`: env limpo, cwd isolado, timeout) | Pedido explícito; interface estilo Cursor |
| Agent | Canvas DAG, roster de agentes, config fusion por papel, validação via gateway (existe) | Melhor que Hermes: DAG validável + fusion por papel |
| Settings | Gateway/OIDC (mantém), Providers & Fusion, Memória (CRUD/import/export), Extensões (plugins/skills Claude/OpenAI — bridge Rust existente), Runtime local (mantém), Aparência | Import de plugins, skills e memória no Settings |
| Segredos | Chaves só no gateway ou keyring nativo (comando existente); nunca em localStorage; copy orienta cofre corporativo | Política Orchestrator |

## Módulos Rust novos (compilação ocorre em máquina com Rust/CI)

- `memory.rs`: rusqlite (bundled) + FTS5; comandos memory_add/search/list/update/delete/export/import
- `fs.rs`: fs_list/fs_read/fs_write com canonicalização presa à raiz do projeto selecionado
- `research.rs`: research_fetch(url) → título/texto/links (reqwest + strip de tags)
- `sandbox.rs`: sandbox_execute(cmd, timeoutMs) com env_clear + dir temporário

O frontend degrada graciosamente se um comando não existir (memória cai para IndexedDB,
research usa fontes simuladas no web preview).

## Estrutura (apps/desktop/src)

```
styles/{tokens,glass,motion,shell,views}.css
components/{GlassFilters,Primitives,Composer,PlanCard,Settings}.tsx
components/shell/{TabBar,Sidebar,Topbar}.tsx
modes/{Chat,Code,Design,Data,Work,Security,Agent}View.tsx
lib/{memory,fusion,planner,research,schema,fsx,sandbox,store}.ts (+ existentes)
```

## Verificação

1. `tsc -b` e `vite build` verdes; vitest para schema SQL, ranking de memória, parse de plano/ops.
2. Revisão visual aba por aba no Browser pane (vite dev): screenshots das 7 abas × 2 temas,
   conferindo geometria idêntica do frame, composer presente, transições fluidas, sem overflow.
3. `cargo check` fica para CI/máquina com Rust (não disponível aqui) — risco mitigado por
   código espelhando padrões existentes + fallbacks no frontend.
