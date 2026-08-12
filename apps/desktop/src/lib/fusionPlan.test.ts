import { describe, expect, it } from "vitest";
import {
  classifyComplexity,
  fallbackPlan,
  parseFusionPlan,
  suggestedExecutorCount,
  buildAdaptivePlanRequest
} from "./fusionPlan";

describe("classifyComplexity", () => {
  it("pergunta curta e direta é simples", () => {
    expect(classifyComplexity("qual a capital da França?")).toBeLessThan(0.3);
  });

  it("pedido de comparação/análise sobe a complexidade", () => {
    const score = classifyComplexity(
      "Compare as arquiteturas e liste prós e contras, avaliando riscos de segurança e trade-offs de cada uma"
    );
    expect(score).toBeGreaterThan(0.6);
  });

  it("texto muito longo sobe a complexidade", () => {
    expect(classifyComplexity("x".repeat(900))).toBeGreaterThan(classifyComplexity("x".repeat(50)));
  });
});

describe("suggestedExecutorCount", () => {
  it("simples usa 1 executor; complexo abre o painel", () => {
    expect(suggestedExecutorCount(0.1, 4)).toBe(1);
    expect(suggestedExecutorCount(0.45, 4)).toBe(2);
    expect(suggestedExecutorCount(0.7, 4)).toBe(3);
    expect(suggestedExecutorCount(0.95, 4)).toBe(4);
  });

  it("nunca passa do painel disponível", () => {
    expect(suggestedExecutorCount(0.99, 2)).toBe(2);
    expect(suggestedExecutorCount(0.99, 1)).toBe(1);
  });
});

describe("parseFusionPlan", () => {
  it("lê complexidade e executores de um bloco json", () => {
    const text =
      '```json\n{"complexity":0.8,"executors":[{"role":"Pesquisa","focus":"levantar fontes"},{"role":"Crítica","focus":"achar falhas"}]}\n```';
    const plan = parseFusionPlan(text, 4);
    expect(plan?.complexity).toBe(0.8);
    expect(plan?.executors).toHaveLength(2);
    expect(plan?.executors[0].role).toBe("Pesquisa");
  });

  it("limita ao painel disponível", () => {
    const text = JSON.stringify({
      complexity: 1,
      executors: [{ focus: "a" }, { focus: "b" }, { focus: "c" }]
    });
    expect(parseFusionPlan(text, 2)?.executors).toHaveLength(2);
  });

  it("usa papel padrão quando ausente e limita complexidade a 0..1", () => {
    const plan = parseFusionPlan(JSON.stringify({ complexity: 5, executors: [{ focus: "x" }] }), 4);
    expect(plan?.executors[0].role).toBe("Executor");
    expect(plan?.complexity).toBe(1);
  });

  it("retorna null para JSON malformado ou sem executores", () => {
    expect(parseFusionPlan("sem json aqui", 4)).toBeNull();
    expect(parseFusionPlan('{"complexity":0.5,"executors":[]}', 4)).toBeNull();
  });
});

describe("fallbackPlan", () => {
  it("gera focos complementares conforme a complexidade", () => {
    const simples = fallbackPlan("oi", 4);
    expect(simples.executors).toHaveLength(1);
    const complexo = fallbackPlan(
      "Compare arquiteturas, avalie riscos de segurança, liste prós e contras e trade-offs " + "x".repeat(900),
      4
    );
    expect(complexo.executors.length).toBeGreaterThan(1);
    // focos não se repetem
    expect(new Set(complexo.executors.map((e) => e.focus)).size).toBe(complexo.executors.length);
  });
});

describe("buildAdaptivePlanRequest", () => {
  it("pede JSON com complexidade e executores, sem responder a pergunta", () => {
    const messages = buildAdaptivePlanRequest("chat", "pergunta", 3);
    expect(messages[0].content).toContain("complexity");
    expect(messages[0].content).toContain("Não responda a pergunta");
    expect(messages[1].content).toBe("pergunta");
  });
});
