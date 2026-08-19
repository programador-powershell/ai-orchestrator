/**
 * O medidor de contexto é uma ESTIMATIVA declarada — estes testes fixam a
 * heurística (4 chars/token) e, mais importante, os casos em que o medidor
 * tem de SUMIR em vez de inventar número: sem modelo, sem janela, sem linha.
 */

import { describe, expect, it } from "vitest";
import type { ConversationLine, ModelInfo } from "@aibot/contracts";
import { CHARS_PER_TOKEN, contextUsage, describeContextUsage, estimateTokens } from "./contextMeter";

function linha(text: string, extra: Partial<ConversationLine> = {}): ConversationLine {
  return { id: "l1", seq: 1, role: "assistant", text, ts: "2026-08-19T12:00:00Z", ...extra };
}

const MODELOS: ModelInfo[] = [
  { id: "m-8k", provider: "local", label: "Oito mil", context: 8000 },
  { id: "m-sem-janela", provider: "local", label: "Sem janela", context: 0 }
];

describe("estimateTokens", () => {
  it("estima pelo texto das falas e pela saída das ferramentas", () => {
    const lines = [
      linha("a".repeat(400)),
      linha("b".repeat(100), {
        toolResults: [{ callId: "c1", tool: "fs.read", ok: true, output: "c".repeat(300) }]
      })
    ];
    expect(estimateTokens(lines)).toBe(800 / CHARS_PER_TOKEN);
  });
});

describe("contextUsage", () => {
  it("calcula o percentual contra a janela do modelo ativo", () => {
    const usage = contextUsage([linha("x".repeat(8000))], MODELOS, "m-8k");
    // 8000 chars / 4 = 2000 tokens de 8000 = 25%.
    expect(usage).toEqual({ used: 2000, window: 8000, percent: 25 });
  });

  it("satura em 100% em vez de passar dele — a estimativa pode errar para cima", () => {
    const usage = contextUsage([linha("x".repeat(80_000))], MODELOS, "m-8k");
    expect(usage?.percent).toBe(100);
  });

  it("some (null) sem linhas, sem modelo ativo ou com janela desconhecida", () => {
    expect(contextUsage([], MODELOS, "m-8k")).toBeNull();
    expect(contextUsage([linha("oi")], MODELOS, "")).toBeNull();
    expect(contextUsage([linha("oi")], MODELOS, "modelo-que-nao-existe")).toBeNull();
    expect(contextUsage([linha("oi")], MODELOS, "m-sem-janela")).toBeNull();
  });
});

describe("describeContextUsage", () => {
  it("declara a heurística no texto — é o que torna o número honesto", () => {
    const frase = describeContextUsage({ used: 2000, window: 8000, percent: 25 });
    expect(frase).toContain("25%");
    expect(frase).toContain(`${CHARS_PER_TOKEN} caracteres por token`);
  });
});
