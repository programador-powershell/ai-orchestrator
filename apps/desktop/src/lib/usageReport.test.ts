import { describe, expect, it } from "vitest";
import {
  confidenceLabel,
  confidenceOf,
  formatTokens,
  formatUsd,
  personLabel,
  share,
  sumUsd,
  type UsageTotals,
  type UserRow
} from "./usageReport";

const totals = (partial: Partial<UsageTotals> = {}): UsageTotals => ({
  calls: 10,
  measuredCalls: 10,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: "1.500000",
  callsWithoutPrice: 0,
  ...partial
});

describe("formatUsd", () => {
  it("formata no padrão brasileiro", () => {
    expect(formatUsd("1234.567")).toBe("US$ 1.234,57");
    expect(formatUsd("0.004")).toBe("US$ 0,00");
    expect(formatUsd("0")).toBe("US$ 0,00");
  });

  it("arredonda meio-para-cima propagando o vai-um", () => {
    expect(formatUsd("0.995")).toBe("US$ 1,00");
    expect(formatUsd("9.999")).toBe("US$ 10,00");
    expect(formatUsd("99.999")).toBe("US$ 100,00");
  });

  /**
   * O servidor manda `numeric` como string exatamente para não perder
   * precisão. Converter para Number no cliente jogaria fora essa garantia.
   */
  it("não perde casas que o float perderia", () => {
    expect(formatUsd("0.1", 6)).toBe("US$ 0,100000");
    expect(formatUsd("1234567.891234", 6)).toBe("US$ 1.234.567,891234");
  });

  it("aceita vazio e negativo sem quebrar", () => {
    expect(formatUsd("")).toBe("US$ 0,00");
    expect(formatUsd("-2.5")).toBe("-US$ 2,50");
  });
});

describe("sumUsd", () => {
  it("soma sem erro de ponto flutuante", () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004
    expect(Number(sumUsd(["0.1", "0.2"]))).toBe(0.3);
    expect(sumUsd(["0.1", "0.2"]).startsWith("0.300000")).toBe(true);
  });

  it("soma valores grandes sem perder centavos", () => {
    const valores = Array.from({ length: 1000 }, () => "0.001");
    expect(Number(sumUsd(valores))).toBe(1);
  });

  it("lista vazia é zero", () => {
    expect(Number(sumUsd([]))).toBe(0);
  });
});

describe("confiança do número", () => {
  it("tudo medido e com preço é completo", () => {
    expect(confidenceOf(totals())).toBe("completo");
    expect(confidenceLabel(totals())).toBe("medição completa");
  });

  /** O caso perigoso: custo baixo indistinguível de custo não medido. */
  it("nenhuma chamada medida vira 'sem medição', não custo zero", () => {
    const linha = totals({ measuredCalls: 0, costUsd: "0" });
    expect(confidenceOf(linha)).toBe("sem-medicao");
    expect(confidenceLabel(linha)).toContain("desconhecido");
  });

  it("modelo sem preço torna o custo parcial e diz quantas", () => {
    const linha = totals({ callsWithoutPrice: 3 });
    expect(confidenceOf(linha)).toBe("parcial");
    expect(confidenceLabel(linha)).toContain("3 sem preço");
  });

  it("chamada sem contagem também torna parcial", () => {
    const linha = totals({ calls: 10, measuredCalls: 7 });
    expect(confidenceOf(linha)).toBe("parcial");
    expect(confidenceLabel(linha)).toContain("3 chamada(s) sem contagem");
  });

  it("linha sem nenhuma chamada não é alarmada", () => {
    expect(confidenceOf(totals({ calls: 0, measuredCalls: 0 }))).toBe("completo");
  });
});

describe("formatTokens", () => {
  it("resume por ordem de grandeza", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1,5 k");
    expect(formatTokens(2_400_000)).toBe("2,40 M");
  });

  it("valor inválido não vira NaN na tela", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("personLabel", () => {
  const base: UserRow = { ...totals(), userId: "abcdef12-3456", email: null, name: null };

  it("prefere e-mail, depois nome, depois id curto", () => {
    expect(personLabel({ ...base, email: "a@b.com", name: "Ana" })).toBe("a@b.com");
    expect(personLabel({ ...base, name: "Ana" })).toBe("Ana");
    expect(personLabel(base)).toBe("abcdef12");
  });

  it("campo em branco não vence o próximo", () => {
    expect(personLabel({ ...base, email: "   ", name: "Ana" })).toBe("Ana");
  });
});

describe("share", () => {
  it("devolve a fração do total", () => {
    expect(share("25", "100")).toBeCloseTo(0.25);
  });

  it("total zero não vira divisão por zero", () => {
    expect(share("5", "0")).toBe(0);
  });

  it("limita entre 0 e 1", () => {
    expect(share("500", "100")).toBe(1);
    expect(share("-5", "100")).toBe(0);
  });
});
