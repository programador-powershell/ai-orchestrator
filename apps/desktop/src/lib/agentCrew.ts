/**
 * Escalação da equipe — quem é contratado, para quê, e em que ordem.
 *
 * Esta é a correção de rumo da aba Agent. Antes existiam dois extremos ruins:
 * o flow builder, em que a pessoa desenhava o grafo antes de rodar, e o
 * acionamento livre, em que o modelo decidia sozinho a divisão e o resultado
 * mudava a cada execução.
 *
 * Agora no prompt vai **só o objetivo** (e correções, quando houver). O fluxo é
 * **pré-determinado pela complexidade** do que foi pedido e segue sempre a
 * mesma espinha spec-driven — constituição → spec → plano → tarefas — com
 * revisão e CI no fim. Previsibilidade é o ponto: o mesmo tipo de pedido
 * produz a mesma escalação, e dá para auditar por que aquela equipe entrou.
 *
 * O que este módulo NÃO faz: chamar modelo. Ele só decide a escalação. Quem
 * executa é `agentCrewRun.ts`.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por agentCrew.test.ts.
 */

import { STAGE_LABEL, type StageId } from "./specKit";

/** Papel do agente na equipe — é o que aparece na barra lateral. */
export type CrewRole = "idea" | "scope" | "plan" | "code" | "review" | "ci";

export const ROLE_LABEL: Record<CrewRole, string> = {
  idea: "idea",
  scope: "scope",
  plan: "plan",
  code: "code",
  review: "review",
  ci: "CI"
};

/** Etapa spec-driven que cada papel materializa. `null` = fora da espinha. */
export const ROLE_STAGE: Record<CrewRole, StageId | null> = {
  idea: "constitution",
  scope: "spec",
  plan: "plan",
  code: "tasks",
  review: null,
  ci: null
};

export function roleStageLabel(role: CrewRole): string {
  const stage = ROLE_STAGE[role];
  return stage ? STAGE_LABEL[stage] : role === "review" ? "Revisão" : "Integração";
}

export type Complexity = "trivial" | "simples" | "media" | "alta";

export const COMPLEXITY_LABEL: Record<Complexity, string> = {
  trivial: "trivial",
  simples: "simples",
  media: "média",
  alta: "alta"
};

/* --------------------------- Classificação --------------------------- */

/**
 * Sinais de trabalho grande. Cada um vale um ponto — nenhum decide sozinho,
 * porque qualquer palavra isolada erra: "criar" aparece tanto em "criar um
 * botão" quanto em "criar o módulo de faturamento".
 */
const SINAIS_AMPLOS = [
  /\bm[óo]dulo\b/i,
  /\bsistema\b/i,
  /\bplataforma\b/i,
  /\barquitetura\b/i,
  /\bmigra[çc][ãa]o\b/i,
  /\brefator(?:ar|a[çc][ãa]o)\b/i,
  /\bintegra[çc][ãa]o\b/i,
  /\bbanco de dados\b/i,
  /\bautentica[çc][ãa]o\b/i,
  /\bmulti-?tenant\b/i,
  /\bponta a ponta\b/i,
  /\bdo zero\b/i
];

/** Sinais de trabalho pequeno e localizado. Cada um subtrai um ponto. */
const SINAIS_ESTREITOS = [
  /\bcorrig(?:ir|e)\b/i,
  /\bajust(?:ar|e)\b/i,
  /\brenomear\b/i,
  /\btrocar?\b/i,
  /\bremover\b/i,
  /\bt[íi]pi?co?\b/i,
  /\bum[a]? (?:linha|campo|bot[ãa]o|label|r[óo]tulo|cor)\b/i,
  /\btypo\b/i
];

/** Conjunções que denunciam entregas somadas ("faça X e Y e Z"). */
const CONJUNCOES = /(?:^|[\s,;])(?:e|mais|tamb[ée]m|al[ée]m disso|depois)(?=[\s,;])/gi;

export interface ComplexitySignal {
  /** Texto curto do porquê — a UI mostra para a decisão não ser opaca. */
  reason: string;
  weight: number;
}

export interface ComplexityVerdict {
  complexity: Complexity;
  score: number;
  signals: ComplexitySignal[];
}

/**
 * Classifica o objetivo.
 *
 * Heurística declarada, não um modelo: a escalação precisa ser **a mesma**
 * para o mesmo pedido, e uma classificação por modelo variaria entre execuções
 * — exatamente o que este redesenho veio consertar. Os sinais ficam visíveis
 * para a pessoa discordar e forçar outro nível.
 */
export function classifyComplexity(goal: string): ComplexityVerdict {
  const text = goal.trim();
  const signals: ComplexitySignal[] = [];
  if (!text) return { complexity: "trivial", score: 0, signals };

  let score = 0;

  const palavras = text.split(/\s+/).length;
  if (palavras >= 60) {
    score += 2;
    signals.push({ reason: `pedido longo (${palavras} palavras)`, weight: 2 });
  } else if (palavras >= 25) {
    score += 1;
    signals.push({ reason: `pedido detalhado (${palavras} palavras)`, weight: 1 });
  } else if (palavras <= 6) {
    score -= 1;
    signals.push({ reason: "pedido de uma frase", weight: -1 });
  }

  for (const padrao of SINAIS_AMPLOS) {
    const hit = padrao.exec(text);
    if (hit) {
      score += 1;
      signals.push({ reason: `menciona "${hit[0]}"`, weight: 1 });
    }
  }

  for (const padrao of SINAIS_ESTREITOS) {
    const hit = padrao.exec(text);
    if (hit) {
      score -= 1;
      signals.push({ reason: `escopo localizado ("${hit[0].trim()}")`, weight: -1 });
    }
  }

  // Lista numerada ou com marcadores = entregas contadas, não uma só.
  const itens = (text.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  if (itens >= 3) {
    score += 2;
    signals.push({ reason: `${itens} itens listados`, weight: 2 });
  } else if (itens === 2) {
    score += 1;
    signals.push({ reason: "2 itens listados", weight: 1 });
  }

  const conjuncoes = (text.match(CONJUNCOES) ?? []).length;
  if (conjuncoes >= 3) {
    score += 1;
    signals.push({ reason: "várias entregas somadas na mesma frase", weight: 1 });
  }

  const complexity: Complexity = score >= 4 ? "alta" : score >= 2 ? "media" : score >= 0 ? "simples" : "trivial";
  return { complexity, score, signals };
}

/* ----------------------------- Escalação ----------------------------- */

export interface CrewSlot {
  /** Estável dentro de um plano: `code#2`, `review#1`. */
  id: string;
  role: CrewRole;
  /** Rótulo do modelo, como aparece na barra lateral ("opus 5"). */
  model: string;
  /** Índice da onda: mesma onda roda em PARALELO. */
  wave: number;
}

export interface CrewPlan {
  complexity: Complexity;
  slots: CrewSlot[];
}

/** Quantos programadores em paralelo cada nível pede. */
const CODERS: Record<Complexity, number> = { trivial: 1, simples: 1, media: 2, alta: 3 };

/**
 * Espinha por complexidade.
 *
 * Trivial não passa por constituição nem spec de propósito: escrever três
 * documentos para trocar o rótulo de um botão é cerimônia que faz a pessoa
 * abandonar o fluxo — e um fluxo abandonado não governa nada.
 */
const ESPINHA: Record<Complexity, CrewRole[]> = {
  trivial: ["code", "review"],
  simples: ["scope", "code", "review"],
  media: ["idea", "scope", "plan", "code", "review"],
  alta: ["idea", "scope", "plan", "code", "review", "ci"]
};

export interface ModelsByRole {
  /** Modelo por papel; o que faltar cai no `fallback`. */
  byRole?: Partial<Record<CrewRole, string>>;
  fallback: string;
}

/**
 * Monta a escalação.
 *
 * Os modelos vêm de fora (política do gateway) — este módulo não escolhe
 * modelo, só distribui papéis. O papel `ci` não é um modelo: é a esteira de
 * build, e por isso aparece como "Ship".
 */
export function planCrew(goalOrVerdict: string | ComplexityVerdict, models: ModelsByRole): CrewPlan {
  const verdict = typeof goalOrVerdict === "string" ? classifyComplexity(goalOrVerdict) : goalOrVerdict;
  const espinha = ESPINHA[verdict.complexity];
  const slots: CrewSlot[] = [];
  let wave = 0;

  for (const role of espinha) {
    if (role === "code") {
      const quantos = CODERS[verdict.complexity];
      for (let i = 0; i < quantos; i += 1) {
        slots.push({ id: `code#${i + 1}`, role, model: modelFor(role, models), wave });
      }
      // Todos os programadores dividem a MESMA onda: é o paralelo.
      wave += 1;
      continue;
    }
    slots.push({ id: `${role}#1`, role, model: modelFor(role, models), wave });
    wave += 1;
  }
  return { complexity: verdict.complexity, slots };
}

function modelFor(role: CrewRole, models: ModelsByRole): string {
  if (role === "ci") return "Ship";
  return models.byRole?.[role]?.trim() || models.fallback;
}

/* ------------------------------ Roster ------------------------------ */

export type CrewStatus = "hired" | "working" | "done" | "failed" | "cancelled";

export interface CrewMember extends CrewSlot {
  status: CrewStatus;
  /** Uma linha do que está fazendo agora — some quando termina. */
  activity: string;
  startedAt: number;
  finishedAt?: number;
}

/**
 * A lista viva da barra lateral: `modelo - papel`.
 *
 * Só entra quem já foi **contratado**. Mostrar o plano inteiro de antemão
 * pareceria progresso que não existe — a lista tem que crescer conforme os
 * agentes entram, e é isso que deixa visível o que roda em paralelo (dois
 * `code` lado a lado) e o que roda em série.
 */
export function rosterLine(member: CrewMember): string {
  return `${member.model} - ${ROLE_LABEL[member.role]}`;
}

/**
 * Ondas ainda não concluídas, na ordem. Vazio = a equipe toda terminou.
 *
 * Uma onda só conta como concluída quando **todos** os seus slots terminaram:
 * com dois programadores em paralelo, o primeiro a acabar não libera a revisão.
 */
export function pendingWaves(plan: CrewPlan, crew: CrewMember[]): number[] {
  const porId = new Map(crew.map((member) => [member.id, member]));
  const todas = [...new Set(plan.slots.map((slot) => slot.wave))].sort((a, b) => a - b);
  return todas.filter((onda) =>
    plan.slots.some((slot) => slot.wave === onda && porId.get(slot.id)?.status !== "done")
  );
}

export interface CrewSummary {
  total: number;
  working: number;
  done: number;
  failed: number;
}

export function summarizeCrew(crew: CrewMember[]): CrewSummary {
  return {
    total: crew.length,
    working: crew.filter((member) => member.status === "hired" || member.status === "working").length,
    done: crew.filter((member) => member.status === "done").length,
    failed: crew.filter((member) => member.status === "failed").length
  };
}
