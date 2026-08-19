/**
 * Medidor de contexto — a estimativa que a barra superior mostra.
 *
 * É uma ESTIMATIVA declarada, não uma medição: o cliente não tokeniza (cada
 * modelo tokeniza diferente, e trazer um tokenizador seria dependência nova).
 * A heurística é a clássica ~4 caracteres por token, que erra pouco em texto
 * corrido e erra para MAIS em código — errar para mais é o lado certo aqui,
 * porque o medidor existe para avisar que a janela está enchendo.
 *
 * O que entra na conta: o texto das falas e a saída das ferramentas — que é o
 * que o gateway dobra de volta no prompt (ver `history` no supervisor). O que
 * fica de fora, de propósito: prompts de sistema e memórias, que o cliente não
 * vê. Por isso o número é um piso, nunca um teto.
 */

import type { ConversationLine, ModelInfo } from "@aibot/contracts";

/** A heurística inteira mora nesta constante — e no title que a explica. */
export const CHARS_PER_TOKEN = 4;

/** Estima quantos tokens a conversa desenhada ocupa da janela. */
export function estimateTokens(lines: readonly ConversationLine[]): number {
  let chars = 0;
  for (const line of lines) {
    chars += line.text.length;
    for (const result of line.toolResults ?? []) {
      chars += (result.output ?? "").length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ContextUsage {
  /** Tokens estimados em uso. */
  used: number;
  /** Janela do modelo ativo, em tokens. */
  window: number;
  /** 0..100, arredondado — saturado em 100 porque a estimativa pode passar. */
  percent: number;
}

/**
 * O uso estimado da janela, ou `null` quando não há o que medir: sem modelo
 * ativo (ou modelo sem janela declarada) qualquer percentual seria invenção —
 * e o medidor some em vez de mentir.
 */
export function contextUsage(
  lines: readonly ConversationLine[],
  models: readonly ModelInfo[],
  activeModel: string
): ContextUsage | null {
  if (lines.length === 0) return null;
  const model = models.find((item) => item.id === activeModel);
  if (!model || !Number.isFinite(model.context) || model.context <= 0) return null;
  const used = estimateTokens(lines);
  const percent = Math.min(100, Math.round((used / model.context) * 100));
  return { used, window: model.context, percent };
}

/** A frase do `title` — é ela que faz o número discreto ser honesto. */
export function describeContextUsage(usage: ContextUsage): string {
  return (
    `Estimativa da janela de contexto: ~${usage.used.toLocaleString("pt-BR")} de ` +
    `${usage.window.toLocaleString("pt-BR")} tokens (${usage.percent}%). ` +
    `Heurística de ${CHARS_PER_TOKEN} caracteres por token sobre o texto da conversa e a saída das ferramentas — ` +
    `prompts de sistema e memórias ficam de fora, então o real é um pouco maior.`
  );
}
