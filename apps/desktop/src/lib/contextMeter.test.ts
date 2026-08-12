import { describe, expect, it } from "vitest";
import { contextUsage, contextWindowFor, formatTokens } from "./contextMeter";

describe("contextWindowFor", () => {
  it("reconhece as famílias conhecidas", () => {
    expect(contextWindowFor("claude-sonnet-5")).toBe(200_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
    expect(contextWindowFor("deepseek-chat")).toBe(128_000);
  });

  it("cai no padrão para modelo desconhecido", () => {
    expect(contextWindowFor("modelo-interno-xyz")).toBe(128_000);
  });
});

describe("contextUsage", () => {
  it("soma os tokens da conversa e calcula a fração", () => {
    const usage = contextUsage([{ content: "a".repeat(4000) }], "gpt-4o");
    expect(usage.used).toBe(1000);
    expect(usage.total).toBe(128_000);
    expect(usage.warning).toBe(false);
  });

  it("marca aviso acima de 80% da janela", () => {
    const usage = contextUsage([{ content: "a".repeat(4 * 110_000) }], "gpt-4o");
    expect(usage.warning).toBe(true);
  });

  it("limita a fração em 1 quando estoura", () => {
    const usage = contextUsage([{ content: "a".repeat(4 * 500_000) }], "gpt-4o");
    expect(usage.ratio).toBe(1);
  });

  it("conversa vazia não quebra", () => {
    expect(contextUsage([], "gpt-4o").used).toBe(0);
  });
});

describe("formatTokens", () => {
  it("formata compacto como o Studio", () => {
    expect(formatTokens(1400)).toBe("1.4k");
    expect(formatTokens(131_100)).toBe("131.1k");
    expect(formatTokens(1_047_576)).toBe("1.0M");
    expect(formatTokens(950)).toBe("950");
  });
});
