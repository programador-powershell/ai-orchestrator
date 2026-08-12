/**
 * Fusion adaptativo — o ORQUESTRADOR decide, por complexidade, quantos
 * executores acionar e o foco de cada um. Nada é fixo: pergunta simples usa 1
 * executor; problema complexo abre um painel. Tudo pensado para STREAMING —
 * o plano vira cartões visíveis e a síntese final é transmitida token a token.
 */
import type { AnyMode } from "./fusionPrompts";
import { fusionRolePolicy } from "./fusionPrompts";
import type { ChatMessage } from "./gateway";

export interface FusionExecutorSpec {
  /** Papel curto exibido no cartão ("Pesquisa", "Análise", "Crítica"). */
  role: string;
  /** Recorte exclusivo daquele executor. */
  focus: string;
}

export interface FusionPlan {
  /** 0..1 estimada pelo orquestrador. */
  complexity: number;
  /** Executores escolhidos (1..N). */
  executors: FusionExecutorSpec[];
}

/**
 * Heurística barata de complexidade (0..1) — usada como PISO e para o fallback
 * quando o orquestrador não devolve JSON. Sinais: tamanho, conjunções de
 * multi-tarefa, pedidos de comparação/análise/código.
 */
export function classifyComplexity(question: string): number {
  const text = question.toLowerCase();
  let score = 0.2;
  if (question.length > 240) score += 0.2;
  if (question.length > 800) score += 0.2;
  const multi = /\b(e também|além de|compare|comparar|vantagens e|prós e contras|passo a passo|arquitetura|trade-?offs?)\b/;
  if (multi.test(text)) score += 0.2;
  if (/\b(analis|avali|critiqu|revis|audit|risco|seguran)/.test(text)) score += 0.15;
  if ((text.match(/\?/g) ?? []).length > 1) score += 0.1;
  if (/\b(liste|enumere|várias|múltipl)/.test(text)) score += 0.1;
  return Math.min(1, score);
}

/** Nº de executores sugerido pela complexidade, limitado ao painel disponível. */
export function suggestedExecutorCount(complexity: number, maxExecutors: number): number {
  const ceiling = Math.max(1, maxExecutors);
  if (complexity < 0.3) return 1;
  if (complexity < 0.6) return Math.min(2, ceiling);
  if (complexity < 0.85) return Math.min(3, ceiling);
  return Math.min(4, ceiling);
}

/** Pede ao orquestrador o plano adaptativo (complexidade + focos por executor). */
export function buildAdaptivePlanRequest(mode: AnyMode, question: string, maxExecutors: number): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    {
      role: "system",
      content:
        `${role.orchestratorRole}\n\n` +
        "Avalie a COMPLEXIDADE do pedido (0 a 1) e decida quantos executores acionar " +
        `(1 = pergunta simples; até ${Math.max(1, maxExecutors)} = problema complexo). ` +
        "Para cada executor, defina um PAPEL curto e um FOCO exclusivo e complementar (sem sobreposição). " +
        'Responda APENAS com um bloco ```json: {"complexity": number, "executors": [{"role": "...", "focus": "..."}]}. ' +
        "Não responda a pergunta — apenas o plano."
    },
    { role: "user", content: question }
  ];
}

/** Faz o parse do plano do orquestrador; null se malformado (usa o fallback). */
export function parseFusionPlan(text: string, maxExecutors: number): FusionPlan | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      complexity?: unknown;
      executors?: unknown;
    };
    const executorsRaw = Array.isArray(parsed.executors) ? parsed.executors : [];
    const executors = executorsRaw
      .map((item) => item as { role?: unknown; focus?: unknown })
      .filter((item) => typeof item.focus === "string" && item.focus.trim().length > 0)
      .slice(0, Math.max(1, maxExecutors))
      .map((item) => ({ role: typeof item.role === "string" && item.role.trim() ? item.role.trim() : "Executor", focus: (item.focus as string).trim() }));
    if (!executors.length) return null;
    const complexity = typeof parsed.complexity === "number" ? Math.min(1, Math.max(0, parsed.complexity)) : 0.5;
    return { complexity, executors };
  } catch {
    return null;
  }
}

/** Plano determinístico quando o orquestrador não devolve JSON válido. */
export function fallbackPlan(question: string, maxExecutors: number): FusionPlan {
  const complexity = classifyComplexity(question);
  const count = suggestedExecutorCount(complexity, maxExecutors);
  const lenses: FusionExecutorSpec[] = [
    { role: "Núcleo", focus: "o essencial da resposta, direto e correto" },
    { role: "Riscos", focus: "casos de borda, riscos e o que pode dar errado" },
    { role: "Alternativas", focus: "abordagens alternativas, comparações e trade-offs" },
    { role: "Prática", focus: "passos práticos de implementação e verificação" }
  ];
  return { complexity, executors: lenses.slice(0, count) };
}
