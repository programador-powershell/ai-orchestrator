# Benchmark funcional — AI-Orchestrator vs líderes de mercado

Data: 2026-08-10 · Método: **nenhuma vitória sem evidência executável.** Cada "ganha/empata"
aponta para código e teste real; o que o líder faz melhor está declarado em "Lacunas".
Nada aqui usa dado simulado: quando uma capacidade exige desktop/gateway ausente, a UI
rotula isso explicitamente em vez de fingir.

## Evidência global

- **237 testes vitest verdes** em 14 arquivos (`corepack pnpm --filter @orchestrator/desktop test`).
- **E2E real com rede**: `src/lib/osv.e2e.test.ts` parseia o `pnpm-lock.yaml` real deste repo
  e consulta a API OSV.dev ao vivo (controle lodash@4.17.15 → advisories GHSA reais com resumo,
  CVSS e versão corrigida). Gate por `OSV_E2E=1`.
- **Verificação viva no dev server** (documentada por módulo abaixo): geometria idêntica ao
  pixel nas 7 abas, fuzzy do Ctrl+P, SVG exportado interceptado e validado, DAG executado com
  gate humano (8/8 nós, durações reais), regra de automação disparando, scan de segredos com
  valores mascarados.
- Typecheck estrito e build de produção verdes; bundle inicial 259 KB (code-split por aba).

## Chat vs ChatGPT

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Markdown rico (código com copiar, tabelas, listas) | Empata | `components/Markdown.tsx` (render seguro por tokens, sem innerHTML) |
| Copiar / regenerar (reenvio real) / editar última pergunta | Empata | `ChatView.tsx` + `chatUtils.buildRegeneratePayload` (23 testes verdes) |
| Métricas reais por resposta (duração medida, palavras/caracteres) | Ganha (ChatGPT não expõe) | `chatUtils.ts` `formatDuration/wordCount` testados |
| Busca no histórico (case/acento-insensível, snippet real) | Empata (local; líder busca na nuvem) | `chatUtils.filterConversations` testado; verificado vivo |
| Fontes com score de credibilidade + gate de confirmação | Ganha (citações do líder não pontuam credibilidade) | `lib/research.ts` (cap 0.35 para fonte não verificada — honestidade por construção) |
| Memória persistente entre fornecedores | Ganha (a do líder é presa ao ecossistema OpenAI) | `lib/memory.ts` + injeção em `Composer.tsx`; import Claude/OpenAI |

**Lacunas:** syntax highlight/LaTeX no markdown; edição com branching de qualquer turno;
voz e imagens; busca em histórico ilimitado na nuvem; coleta de fontes no navegador puro (CORS — real só no desktop).

## Code vs Cursor

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Quick Open Ctrl+P fuzzy sobre árvore real | Empata (500 arquivos, prof. 4) | `lib/fuzzy.ts` 14 testes; vivo: "apptsx" → `App.tsx` em 1º |
| Diff de edições não salvas (LCS real) | Empata no essencial (modal, não gutter) | `lib/diff.ts` 10 testes |
| Aplicar código da IA com preview em diff obrigatório | Empata (single-file) | `CodeView.tsx` (fs_write no desktop; no navegador só buffer, avisado) |
| Busca global literal arquivo:linha clicável | Empata parcial (200 arquivos; líder usa ripgrep/regex) | `CodeView.tsx` |
| Terminal multi-runtime real | Empata | `terminal.rs` (10+ runtimes) |
| Orquestrador de pipeline + fusion por aba | Ganha (Cursor não tem fusion de modelos) | `lib/engine.ts` fusionTurn |

**Lacunas:** autocomplete preditivo/LSP (núcleo do Cursor); agente multi-arquivo com checkpoints;
busca regex/semântica em escala; diff inline no gutter.

## Design vs Figma

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Canvas editável (criar/mover/redimensionar frame/rect/elipse/texto) | Empata (subconjunto) | `lib/canvasDoc.ts` 21 testes; vivo: shape criado por pointer events |
| Inspector que edita de verdade (x/y/w/h/fill/radius/texto) | Empata | `DesignView.tsx` inputs controlados → `updateNode` |
| Export SVG/PNG real | Empata | `exportSvg` testado (escape, viewBox); vivo: blob interceptado = SVG válido |
| Tokens de HTML/CSS colado (cores/fontes/spacing por frequência, offline) | Ganha (no Figma exige plugin pago) | `lib/htmlTokens.ts` 11 testes |
| Editor de vídeo com timeline/split/export ffmpeg (estilo OpenCut) | Ganha (Figma não edita vídeo) | `DesignView.tsx` modo Vídeo |
| Replicação de site inteiro | Condicional (requer gateway, rotulado) | `replicateDesign` |

**Lacunas:** auto-layout/constraints/componentes+variants; caneta/vetores/boolean ops;
multiplayer/comentários/versões em nuvem; redo; texto rico por trecho.

## Data vs drawdb

| Capacidade | Nosso status | Evidência |
|---|---|---|
| ERD visual completo (drag, bezier, PK/UQ/NULL/FK) | Empata | `DataView.tsx` |
| Undo/redo real (pilha 50, drag = 1 entrada) | Empata | `DataView.tsx:222-287` |
| Índices compostos/UNIQUE no modelo, UI e SQL | Empata | `schema.ts` + testes CREATE INDEX por dialeto |
| **Migração por diff de snapshot** (ADD/DROP COLUMN, ALTER TYPE, FK, INDEX, por dialeto) | **Ganha** (drawdb não gera migração; dbdiagram cobra) | `diffSchemas` + 9 testes de migração |
| Auto-layout determinístico sem sobreposição | Ganha vs drawdb | teste "nunca sobrepõe retângulos" |
| Chat-to-schema com ops estruturadas + undo | Ganha vs drawdb | canal `ops:data` + `applyOps` testado |
| Export PG/MySQL/ANSI + import round-trip | Empata parcial (menos dialetos que drawdb) | testes de round-trip |

**Lacunas:** menos dialetos (sem SQLite/MSSQL/Oracle); sem export de imagem do diagrama;
import SQL é subset; diff não detecta rename (vira DROP+CREATE, documentado).

## Work vs Claude Cowork / Trello+Butler

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Motor de automação trigger→action com encadeamento e anti-loop | Empata | `lib/automations.ts` `runRules` — 27 testes (anti-loop MAX_CHAIN=5) |
| Regras por linguagem natural via chat | Empata parcial | `ruleFromTexts` (op `add_automation`); não reconhecido → log honesto |
| Labels, due dates com atraso REAL, editor de cartão | Empata | `isOverdue` testado; revalidação por minuto; verificado vivo |
| Log de execuções com horário real | Empata | painel de log; verificado vivo após regra disparar |
| Export/Import do quadro em Markdown | Ganha (Trello não tem import md) | `exportBoardMarkdown` round-trip testado |
| Conectores M365 | Lacuna declarada | cards dizem "não conectado — requer aprovação de TI" (política Orchestrator) |

**Lacunas:** integrações reais de e-mail/calendário (exigem OAuth aprovado pela TI);
agendamento cron em background; colaboração multi-usuário na nuvem.

## Security vs Snyk / Dependabot

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Audit real de dependências (npm) contra base viva | Empata — e sem conta, enviando só nome+versão | OSV.dev querybatch; e2e real com o lockfile deste repo; vivo: lodash → 6 GHSA reais |
| Parse package-lock v1/v2/v3 e pnpm-lock v5/v6/v9 | Empata | `osv.ts` + fixtures do lockfile real (25 testes) |
| Score CVSS calculado da spec 3.1 + versão corrigida + link | Empata | `cvssBaseScore` com vetores conhecidos (9.8/10.0/6.1) |
| Scan de segredos com valores sempre mascarados | Empata | `scan.ts` 10 testes; vivo: "pass…(34 caracteres)" |
| Diff aplicável aceitar/rejeitar estilo Cursor | Empata | `parseUnifiedDiff`/`applyUnifiedDiff` testados |
| Sandbox de execução (env limpo, cwd isolado, timeout) estilo ai-jail | Ganha (Snyk não executa nada) | `sandbox.rs` (real no desktop, rotulado no navegador) |
| Revisão multi-modelo (fusion Kimi orquestrador + executor) | Ganha (líderes usam pipeline fixo) | `settings.engines.security` + `chatOnce` |

**Lacunas:** PR/bump automático (Dependabot); monitoramento contínuo agendado;
ecossistemas além de npm; análise de alcançabilidade.

## Agent vs OpenClaw / Hermes / n8n

| Capacidade | Nosso status | Evidência |
|---|---|---|
| Grafo real editável (add/connect/disconnect/delete com validação) | Empata | `lib/dag.ts` 19 testes |
| Detecção de ciclo mostrando o caminho completo | Ganha | vivo: "criaria ciclo: idea → human-merge → … → idea" |
| Ondas topológicas explícitas (paralelismo visível) | Ganha (n8n executa mas não mostra ondas) | `topoWaves` teste diamante `[[a],[b,c],[d]]` |
| Execução real com LLM por nó, contexto dos dependsOn | Empata | vivo: 8/8 nós em 43s com durações reais por nó |
| Gate humano com pausa e aprovação real | Empata | vivo: nó CI esperou o clique Aprovar (32s de espera humana medida) |
| Import/Export JSON do fluxo validado | Empata | `toJson/fromJson` (9 rejeições de JSON inválido testadas) |
| Fusion por papel (aba → orquestrador+executor) | Ganha | seção na AgentView + `setEngine` persistido |

**Lacunas:** arestas desenhadas livres estilo n8n (layout é por ondas); paralelismo real
dentro da onda (sequencial hoje; `topoWaves` já expõe a estrutura); nós tool executando
ferramentas externas.

## Fusion de produção (política de papéis)

Sem sobreposição por contrato de prompt (testado): orquestrador nunca produz o entregável; executor nunca replaneja. Por aba — **Security** (política de salvaguarda): o modelo menos restrito orquestra a exploração e o restrito entrega; **Code** (política de custo/inteligência): o modelo mais capaz especifica e revisa, o mais barato implementa. **Merge** decompõe em focos mutuamente exclusivos (um por executor) e integra sem reescrever. Evidência: `lib/fusionPrompts.ts` + 12 testes; estágios verificados ao vivo ("Fusion (salvaguarda) · kimi especificando → gpt executando → kimi revisando").

## Veredito honesto

Onde este app é genuinamente superior ao "ChatGPT + Cursor + Figma + OpenClaw" somados:
**integração** (um contexto, memória e fusion atravessando as 7 superfícies), **independência
de fornecedor** (memória local + BYOK no keyring + catálogo de modelos gerenciável),
**transparência** (ondas de execução, credibilidade de fontes, migração SQL por diff) e
**custo** (OSV sem conta, tokens de design offline). Onde os líderes seguem à frente:
ecossistemas (plugins Figma, extensões VS Code), colaboração multiusuário em nuvem,
autocomplete LSP, voz/imagem, e automação em background — lacunas declaradas acima,
com o caminho de fechamento anotado em cada módulo.
