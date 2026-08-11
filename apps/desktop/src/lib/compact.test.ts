import { describe, expect, it } from "vitest";
import { estimateTokens, planCompaction } from "./compact";

const msg = (role: "user" | "assistant" | "system", content: string) => ({ role, content });

describe("estimateTokens", () => {
  it("estima ~4 caracteres por token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("planCompaction", () => {
  it("retorna null quando está dentro do orçamento", () => {
    const messages = [msg("user", "oi"), msg("assistant", "olá")];
    expect(planCompaction(messages, { maxTokens: 1000, keepRecent: 4 })).toBeNull();
  });

  it("separa mensagens antigas para resumo, mantendo as recentes", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(400)));
    const plan = planCompaction(messages, { maxTokens: 500, keepRecent: 3 });
    expect(plan).not.toBeNull();
    expect(plan!.keep).toHaveLength(3);
    expect(plan!.toSummarize).toHaveLength(7);
    expect(plan!.keep).toEqual(messages.slice(-3));
  });

  it("não compacta quando não há mensagens antigas suficientes para resumir", () => {
    const messages = [msg("user", "x".repeat(4000)), msg("assistant", "y".repeat(4000))];
    // acima do orçamento, mas keepRecent cobre tudo → nada a resumir
    expect(planCompaction(messages, { maxTokens: 100, keepRecent: 4 })).toBeNull();
  });

  it("nunca resume uma mensagem de sistema (contexto fixo)", () => {
    const messages = [
      msg("system", "s".repeat(4000)),
      ...Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(400)))
    ];
    const plan = planCompaction(messages, { maxTokens: 300, keepRecent: 2 });
    expect(plan).not.toBeNull();
    expect(plan!.toSummarize.some((m) => m.role === "system")).toBe(false);
  });
});
