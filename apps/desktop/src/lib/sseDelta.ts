/**
 * Extração de deltas de um chunk SSE de chat/completions.
 *
 * Provedores de raciocínio (DeepSeek Reasoner, o-series, Qwen QwQ…) emitem o
 * "pensamento" num campo SEPARADO do texto final. Ler só `delta.content`
 * descarta esse conteúdo silenciosamente — por isso o parser distingue os dois.
 */
export interface SseDelta {
  /** Texto da resposta visível. */
  content: string;
  /** Texto do bloco de raciocínio (mostrado recolhido na conversa). */
  reasoning: string;
  /** Motivo de término, quando o chunk o traz (sinal terminal do provedor). */
  finishReason: string | null;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Lê um objeto de chunk já parseado. Cobre as variações de campo usadas pelos
 * provedores compatíveis com OpenAI para o raciocínio.
 */
export function extractDelta(payload: unknown): SseDelta {
  const choice = (payload as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
  if (!choice) return { content: "", reasoning: "", finishReason: null };
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const reasoning =
    asText(delta.reasoning_content) || asText(delta.reasoning) || asText((delta.thinking as string) ?? "");
  return {
    content: asText(delta.content),
    reasoning,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null
  };
}

/** Interpreta uma linha `data:` do SSE; null quando é [DONE] ou inválida. */
export function parseSseLine(data: string): SseDelta | null {
  if (!data || data === "[DONE]") return null;
  try {
    return extractDelta(JSON.parse(data));
  } catch {
    return null;
  }
}
