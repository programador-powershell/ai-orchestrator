import { describe, expect, it } from "vitest";
import { buildExecuteRequest, buildPlanRequest, parsePlan } from "./planner";

const validPlanJson = JSON.stringify({
  title: "Refatorar módulo",
  summary: "Refatoração incremental com verificação.",
  steps: [
    { title: "Mapear dependências", detail: "Listar imports do módulo." },
    { title: "Extrair funções puras", detail: "Mover lógica para lib/." },
    { title: "Rodar testes", detail: "vitest run deve passar." }
  ],
  risks: ["Quebra de contrato", "Regressão visual"]
});

describe("parsePlan", () => {
  it("aceita bloco JSON fenced válido e normaliza os passos", () => {
    const text = "```json\n" + validPlanJson + "\n```";
    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe("Refatorar módulo");
    expect(plan?.summary).toBe("Refatoração incremental com verificação.");
    expect(plan?.steps).toHaveLength(3);
    expect(plan?.steps[0]).toEqual({
      id: "step-1",
      title: "Mapear dependências",
      detail: "Listar imports do módulo.",
      status: "pending"
    });
    expect(plan?.steps[2].id).toBe("step-3");
    expect(plan?.risks).toEqual(["Quebra de contrato", "Regressão visual"]);
  });

  it("extrai o plano mesmo com texto ao redor do bloco", () => {
    const text =
      "Claro! Aqui está o plano que preparei:\n\n```json\n" +
      validPlanJson +
      "\n```\n\nMe avise se quiser ajustar algo.";
    const plan = parsePlan(text);
    expect(plan?.steps).toHaveLength(3);
    expect(plan?.title).toBe("Refatorar módulo");
  });

  it("extrai JSON sem fence quando há lixo em volta", () => {
    const text = "prefixo qualquer " + validPlanJson + " sufixo qualquer";
    const plan = parsePlan(text);
    expect(plan?.steps).toHaveLength(3);
  });

  it("retorna null para texto sem JSON", () => {
    expect(parsePlan("não há plano nenhum aqui")).toBeNull();
  });

  it("retorna null para JSON malformado", () => {
    expect(parsePlan('```json\n{"title": "x", "steps": [}\n```')).toBeNull();
  });

  it("retorna null quando steps está vazio ou ausente", () => {
    expect(parsePlan('{"title": "x", "steps": []}')).toBeNull();
    expect(parsePlan('{"title": "x"}')).toBeNull();
  });

  it("retorna null quando nenhum passo tem title string", () => {
    expect(parsePlan('{"steps": [{"detail": "sem título"}, {"title": 42}]}')).toBeNull();
  });

  it("aplica defaults para title/summary/risks ausentes e filtra risks não-string", () => {
    const plan = parsePlan('{"steps": [{"title": "Único passo"}], "risks": ["ok", 7, null]}');
    expect(plan?.title).toBe("Plano de execução");
    expect(plan?.summary).toBe("");
    expect(plan?.steps[0].detail).toBe("");
    expect(plan?.risks).toEqual(["ok"]);
  });
});

describe("buildPlanRequest", () => {
  it("monta system + user com instruções de plano JSON", () => {
    const messages = buildPlanRequest("code", "refatore o gateway");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Modo planejamento");
    expect(messages[0].content).toContain("implementar a mudança de código com verificação");
    expect(messages[0].content).toContain("```json");
    expect(messages[0].content).toContain('"steps"');
    expect(messages[0].content).toContain("Entre 3 e 8 passos");
    expect(messages[1]).toEqual({ role: "user", content: "refatore o gateway" });
  });

  it("usa objetivo genérico para modo fora do mapa", () => {
    // Modo inexistente de proposito: e o fallback que esta sob teste.
    const messages = buildPlanRequest("inexistente" as UiMode, "monte a cena");
    expect(messages[0].content).toContain("executar a tarefa");
  });
});

describe("buildExecuteRequest", () => {
  it("inclui o plano aprovado numerado e o texto original", () => {
    const plan = parsePlan("```json\n" + validPlanJson + "\n```");
    expect(plan).not.toBeNull();
    if (!plan) return;
    const messages = buildExecuteRequest(plan, "refatore o gateway");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Plano aprovado: Refatorar módulo");
    expect(messages[0].content).toContain("1. Mapear dependências — Listar imports do módulo.");
    expect(messages[0].content).toContain("3. Rodar testes — vitest run deve passar.");
    expect(messages[1]).toEqual({ role: "user", content: "refatore o gateway" });
  });
});
