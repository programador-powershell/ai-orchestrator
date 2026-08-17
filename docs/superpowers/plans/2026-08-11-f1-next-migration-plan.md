# Plano F1 — Migração Next.js 16.3 + limpeza third_party

Design de origem: [2026-08-11-llm-harness-unsloth-interface-design.md](../specs/2026-08-11-llm-harness-unsloth-interface-design.md)
Status: **aguardando aprovação** · Fases F2–F4 planejadas ao final deste arquivo (nível milestone).

## Camadas afetadas

- `apps/desktop` (frontend + `src-tauri/tauri.conf.json`)
- raiz do monorepo (`.gitignore`, `README.md`, `third_party/`)
- `packages/contracts` (só comentário)
- `.github/workflows/release.yml` (validação, sem edição prevista)

## Tarefa 0 — Baseline (bloqueante, antes de tudo)

**T0. `git init` + commit baseline.** O workspace NÃO é repositório git (confirmado
pelo crítico: sem `.git` aqui nem no pai) — deleções seriam irreversíveis.
`git init`, commit `:tada: <chamado> baseline V.2.3 pré-migração`.
*Verificar:* `git log` mostra o baseline; `git status` limpo.
⚠️ Pendência do dev: **nº do chamado** para os commits (convenção gitmoji + chamado).

## Trilha A — Next 16.3 como empacotador de SPA

Ordem corrigida pelo crítico: dependências primeiro; verificações executáveis só no gate.

| # | Tarefa | Arquivos | Verificação | Depende |
|---|--------|----------|-------------|---------|
| A1 | Trocar deps: remover `vite` e `@vitejs/plugin-react`; adicionar `next@16.3.0`; scripts `dev='next dev -p 1420'`, `build='next build'`; conferir **peer warnings** (Next 16.3 pode exigir React ≥19.2 → bump `react`/`react-dom` se preciso) e `pnpm-lock.yaml` atualizado (CI usa `--frozen-lockfile`) | `apps/desktop/package.json`, `pnpm-lock.yaml` | `pnpm install` sem peer error; `pnpm --filter @ai-bot/desktop test` verde (17 arquivos .test.ts, incl. `osv.e2e.test.ts`) | T0 |
| A2 | `next.config.ts`: `output:'export'`, `images.unoptimized:true`, `transpilePackages:['@ai-bot/contracts']`, `reactStrictMode:true` | `apps/desktop/next.config.ts` | gate A8 | A1 |
| A3 | `app/layout.tsx` (server): html `lang="pt-BR"`, `metadata` título, `viewport` themeColor `#071013`, `import '../src/styles.css'` | `apps/desktop/app/layout.tsx` | gate A8 | A1 |
| A4 | `app/page.tsx` `'use client'`: `dynamic(() => import('../src/App'), { ssr:false })`; side-effects do boot (`migrateLegacyLocalSettings`, `configureBackgroundUpdater`) em `useEffect` **com guarda de execução única** (StrictMode roda efeito 2× em dev; `configureBackgroundUpdater` registra `onCloseRequested` sem guarda própria) e verificação de idempotência das migrations | `apps/desktop/app/page.tsx` | gate A8 + teste unitário da guarda | A1 |
| A5 | Unificar tsconfig: um `tsconfig.json` (moduleResolution bundler, plugin `next`, include `app/` + `.next/types` tolerando pasta ausente), **preservando `exclude: ["src/**/*.test.ts"]`** (testes usam `vi`/stubGlobal e quebrariam o type-check do `next build`); `next-env.d.ts` no `.gitignore` | `apps/desktop/tsconfig.json`, remover `tsconfig.app.json`/`tsconfig.node.json` | `pnpm check` verde | A1 |
| A6 | Remover `index.html`, `src/main.tsx`, `vite.config.*`, `src/vite-env.d.ts`, `*.tsbuildinfo`; apagar `apps/desktop/dist/` | (deleções) | `next build` gera `out/` completo | A2–A5 |
| A7 | `tauri.conf.json`: `frontendDist:'../out'`; `beforeDevCommand` com checagem de porta 1420 (Next sem strictPort sobe em outra porta e o webview abre no vazio) | `apps/desktop/src-tauri/tauri.conf.json` | gate A8 | A6 |
| A8 | **Gate da trilha:** `pnpm test` → `next build` (validar **Turbopack** com CodeMirror/zustand/lucide; fallback `next build --webpack`) → inspecionar `out/` → `tauri dev` (9 abas, atalhos Ctrl+1..9, View Transitions, drag-region) → `tauri build` local **sem updater** (`createUpdaterArtifacts` exige chave de assinatura que só o CI tem — verificar flag/env local e documentar) conferindo que `out/` foi empacotado | — | todos os comandos acima com saída esperada | A1–A7 |
| A9 | `.gitignore`: adicionar `out/`, `.next/`, `next-env.d.ts`; remover regras mortas (`apps/*/vite.config.js`, `apps/*/vite.config.d.ts`) | `.gitignore` | `git status` sem artefatos de build | A6 |

## Trilha B — Remoção do modo local do soup + third_party (paralelizável com A até B3)

| # | Tarefa | Arquivos | Verificação | Depende |
|---|--------|----------|-------------|---------|
| B1 | `TuneView.tsx`: remover escada local (`detectSoup`, `runSoup`, `initInternal`/`SOUP_TEMPLATE`, chip soup, botões "Detectar soup"/"Treinar local"/GPU, import de `vendored`). **Manter** o fluxo nuvem completo E o campo de pasta do projeto (usado por "Gravar dataset no projeto" — é dataset builder, não modo local; renomear rótulo "pasta do projeto soup" → "pasta do projeto"). `tune.css`: comentário e estilos órfãos | `apps/desktop/src/modes/TuneView.tsx`, `src/styles/modes/tune.css` | `finetune.test.ts` verde; aba renderiza só fluxo nuvem + gravação de dataset | T0 |
| B2 | Remover `src/lib/vendored.ts` e referências | `apps/desktop/src/lib/vendored.ts` | `pnpm check` verde; grep `vendored` sem hits | B1 |
| B3 | `tauri.conf.json`: remover os 5 `bundle.resources` de `third_party/soup`; validar que o **release.yml** (que reescreve o json via `ConvertFrom-Json`/`ConvertTo-Json`) sobrevive à remoção do bloco | `apps/desktop/src-tauri/tauri.conf.json`, leitura de `.github/workflows/release.yml` | `tauri build` local sem os recursos; dry-run do trecho PowerShell do CI | B2 (e merge com A7) |
| B4 | Apagar `third_party/` inteiro + `THIRD_PARTY.md`; criar `docs/creditos-inspiracao.md` (clean-room: unsloth/drawdb AGPL só como referência funcional externa; opencode MIT; soup Apache-2.0 substituído pelo fluxo nuvem) | `third_party/`, `docs/creditos-inspiracao.md` | grep `third_party` sem hits em código-fonte (docs excluídos de propósito) | B3, T0 |
| B5 | Comentários residuais: `packages/contracts/src/index.ts:4` (menciona soup-cli) e afins | `packages/contracts/src/index.ts` | grep `soup` só em docs | B4 |
| B6 | `README.md`: **reescrever a seção Features** (linhas 32 e 74 descrevem soup embutido/escada/third_party), Diretórios (sem `third_party`), Instalação (comandos next); Releases Notes: **remover bloco V.2.3 e abrir V.3** (grande atualização: Next 16.3 + fine-tuning só-nuvem + remoção de third_party) | `README.md` | leitura; consistência com B4 | B4, A8 |

## Commits (convenção gitmoji + nº do chamado)

- T0 `:tada:` baseline · Trilha A `:wrench:` (build) · B1–B5 `:recycle:`/`:fire:` conforme o caso · B6 `:page_facing_up:`.
- Versionamento README por fase (regra global do usuário prevalece sobre o design):
  F1 → **V.3** (grande atualização); F2 → **V.4** (mudança de UI/UX);
  F3 → **V.4.1** (ganho de função); F4 → **V.4.2** (ganho de função).

## Riscos

1. **Sem VCS até T0** — nada destrutivo antes do baseline.
2. Turbopack (padrão no Next 16) com CodeMirror — validar cedo; fallback `--webpack`.
3. Peer deps React 19.1 vs Next 16.3 — resolver na A1, não no gate.
4. StrictMode duplicando side-effects do boot (updater) — guarda na A4.
5. CI release: `--frozen-lockfile` + reescrita PowerShell do `tauri.conf.json` + `pnpm check` antes do build — validações nas A1/A5/B3.
6. Updater local sem chave de assinatura — critério do gate A8 ajustado.
7. `tune.root`: chave localStorage continua em uso (dataset builder) — sem migração.

## Pontos levantados pelo crítico de completude (endereçados)

1. Sem `.git` → T0 novo. 2. Ordem de verificações da trilha A → corrigida (gate A8).
3. StrictMode 2× → guarda na A4. 4. Exclusão de testes no tsconfig → A5.
5. `.gitignore` sem `out/`/`.next/` → A9 nova. 6. Campo "pasta do projeto" usado pelo
dataset builder → B1 mantém e renomeia. 7. release.yml como dependência → A1/B3.
8. Gate A8 inexecutável com updater → critério ajustado. 9. README Features além das
Releases Notes → B6 ampliada. 10. Baseline de testes = 17 arquivos (não 16) + peers → A1/A8.

## Fases seguintes (milestone — planos próprios quando F1 fechar)

- **F2 — Shell Studio:** sidebar colapsável com nav fixável + Recents + Settings modal (Ctrl+,) + padrões visuais (superfícies por tom, pílulas, accent só primárias), identidade liquid glass. README → V.4.
- **F3 — Harness no gateway:** migrações sqlx (`fine_tune_jobs`, `fine_tune_job_events`, `fine_tuned_models`), trait `FineTuneProvider` (OpenAI primeiro), reconciliador tokio, rotas `/v1/workspaces/{ws}/finetune/*` (SSE + polling), validação server-side de dataset (LGPD: retenção/mascaramento), aba Train em 3 sub-abas (Configure/Current Run/History) com custo estimado, DPO, eval/judge; migração do job em localStorage; restrição do `provider_fetch`. README → V.4.1.
- **F4 — Agêntico e paridade final:** loop de tool-calls com aprovação, auto-compact, diagnostics pós-edição, cliente MCP, comandos markdown; Data: dialetos SQL extras + parser robusto, export PNG/SVG, múltiplos diagramas, ON UPDATE/DELETE, migração down, fix n-n. README → V.4.2.
