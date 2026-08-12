/**
 * Medidor de contexto — "1.4k / 131.1k" no topo, como no Studio. Mostra quanto
 * da janela do modelo a conversa já ocupa, para o usuário perceber ANTES de o
 * auto-compact entrar em ação.
 */
import { estimateTokens } from "./compact";

/** Janelas conhecidas (tokens). Chave = trecho do id do modelo, minúsculo. */
const CONTEXT_WINDOWS: Array<[string, number]> = [
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["claude", 200_000],
  ["deepseek", 128_000],
  ["kimi", 128_000],
  ["qwen", 128_000],
  ["mistral", 128_000],
  ["gemini", 1_048_576]
];

const FALLBACK_WINDOW = 128_000;

/** Janela de contexto estimada para um id de modelo. */
export function contextWindowFor(model: string): number {
  const id = model.toLowerCase();
  const hit = CONTEXT_WINDOWS.find(([key]) => id.includes(key));
  return hit ? hit[1] : FALLBACK_WINDOW;
}

export interface ContextUsage {
  used: number;
  total: number;
  /** 0..1 — fração ocupada, já limitada a 1. */
  ratio: number;
  /** true quando passa de 80% (a UI destaca). */
  warning: boolean;
}

/** Uso de contexto de uma conversa contra a janela do modelo. */
export function contextUsage(messages: Array<{ content: string }>, model: string): ContextUsage {
  const used = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const total = contextWindowFor(model);
  const ratio = Math.min(1, used / total);
  return { used, total, ratio, warning: ratio > 0.8 };
}

/** Formata como "1.4k" / "131.1k" / "1.0M" — compacto como no Studio. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
