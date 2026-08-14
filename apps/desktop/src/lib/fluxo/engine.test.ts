import { describe, expect, it } from "vitest";

import { CONTEXTO_EXEMPLO, evaluateCondition, interpolate, lintFlow, runFlow } from "./engine";
import type { FlowDefinition } from "./types";

const no = (id: string, type: FlowDefinition["nodes"][number]["type"], data: Record<string, unknown>) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: data as never
});
const liga = (from: string, to: string, branch?: "true" | "false") => ({
  id: `e-${from}-${to}`,
  source: from,
  target: to,
  sourceHandle: branch ?? null
});

describe("evaluateCondition", () => {
  it("compara número como número, não como texto", () => {
    // "9" > "80" seria verdadeiro em texto — o erro clássico.
    expect(evaluateCondition("budget", "greater_than", 80, { ...CONTEXTO_EXEMPLO, budget: 9 })).toBe(false);
    expect(evaluateCondition("budget", "greater_than", 80, CONTEXTO_EXEMPLO)).toBe(true);
  });

  it("contains e starts_with ignoram maiúscula", () => {
    expect(evaluateCondition("name", "contains", "PRADO", CONTEXTO_EXEMPLO)).toBe(true);
    expect(evaluateCondition("name", "starts_with", "ana", CONTEXTO_EXEMPLO)).toBe(true);
  });

  it("lista vazia conta como vazio", () => {
    expect(evaluateCondition("tags", "is_empty", undefined, { ...CONTEXTO_EXEMPLO, tags: [] })).toBe(true);
    expect(evaluateCondition("tags", "is_not_empty", undefined, CONTEXTO_EXEMPLO)).toBe(true);
  });

  it("condição sem campo ou operador é falsa, não quebra", () => {
    expect(evaluateCondition(undefined, "equals", 1, CONTEXTO_EXEMPLO)).toBe(false);
  });
});

describe("interpolate", () => {
  it("troca os campos do contexto", () => {
    expect(interpolate("Olá {{name}}, seu orçamento é {{budget}}", CONTEXTO_EXEMPLO)).toBe(
      "Olá Ana Prado, seu orçamento é 1200"
    );
  });

  it("campo que não existe vira vazio, não '{{x}}'", () => {
    expect(interpolate("[{{nao_existe}}]", CONTEXTO_EXEMPLO)).toBe("[]");
  });
});

describe("runFlow", () => {
  it("sem gatilho o teste falha dizendo o motivo", () => {
    const resultado = runFlow({ nodes: [no("a1", "action", { label: "x" })], edges: [] });
    expect(resultado.status).toBe("failed");
    expect(resultado.error).toContain("gatilho");
  });

  it("segue só o ramo verdadeiro da condição", () => {
    const definition: FlowDefinition = {
      nodes: [
        no("t1", "trigger", { label: "Novo lead", triggerType: "new_lead" }),
        no("c1", "condition", { label: "Caro?", field: "budget", operator: "greater_than", value: 1000 }),
        no("a1", "action", { label: "Quente", actionType: "mark_hot" }),
        no("a2", "action", { label: "Frio", actionType: "mark_cold" })
      ],
      edges: [liga("t1", "c1"), liga("c1", "a1", "true"), liga("c1", "a2", "false")]
    };
    const resultado = runFlow(definition);
    expect(resultado.status).toBe("ok");
    expect(resultado.path).toEqual(["t1", "c1", "a1"]);
    expect(resultado.context.temperature).toBe("quente");
  });

  it("a espera PARA o teste — e diz onde parou", () => {
    const definition: FlowDefinition = {
      nodes: [
        no("t1", "trigger", { label: "Novo lead" }),
        no("w1", "wait", { label: "Aguardar", waitAmount: 2, waitUnit: "days" }),
        no("a1", "action", { label: "Depois", actionType: "mark_hot" })
      ],
      edges: [liga("t1", "w1"), liga("w1", "a1")]
    };
    const resultado = runFlow(definition);
    expect(resultado.status).toBe("waiting");
    expect(resultado.path).toEqual(["t1", "w1"]);
    expect(resultado.logs.at(-1)?.message).toContain("2 days");
  });

  it("efeito é LISTADO, nunca disparado — e a mensagem já vem interpolada", () => {
    const definition: FlowDefinition = {
      nodes: [
        no("t1", "trigger", { label: "Novo lead" }),
        no("a1", "action", { label: "Oi", actionType: "send_whatsapp", message: "Olá {{name}}!" })
      ],
      edges: [liga("t1", "a1")]
    };
    const resultado = runFlow(definition);
    expect(resultado.effects).toEqual([
      expect.objectContaining({ kind: "send_whatsapp", message: "Olá Ana Prado!" })
    ]);
  });

  it("ciclo no desenho vira aviso, não travamento", () => {
    const definition: FlowDefinition = {
      nodes: [no("t1", "trigger", { label: "A" }), no("a1", "action", { label: "B", actionType: "mark_hot" })],
      edges: [liga("t1", "a1"), liga("a1", "t1")]
    };
    const resultado = runFlow(definition);
    expect(resultado.status).toBe("ok");
    expect(resultado.logs.some((log) => log.status === "skipped")).toBe(true);
  });
});

describe("lintFlow", () => {
  it("aponta nó solto, condição incompleta e http sem TLS", () => {
    const avisos = lintFlow({
      nodes: [
        no("t1", "trigger", { label: "Novo lead" }),
        no("c1", "condition", { label: "Sem campo" }),
        no("a1", "action", { label: "Chamada", actionType: "http_request", url: "http://interno/x" })
      ],
      edges: []
    });
    expect(avisos.some((aviso) => aviso.includes("Sem campo"))).toBe(true);
    expect(avisos.some((aviso) => aviso.includes("não está ligado"))).toBe(true);
    expect(avisos.some((aviso) => aviso.includes("https"))).toBe(true);
  });

  it("fluxo bem montado não gera aviso", () => {
    expect(
      lintFlow({
        nodes: [
          no("t1", "trigger", { label: "Novo lead", triggerType: "new_lead" }),
          no("a1", "action", { label: "Oi", actionType: "send_whatsapp", message: "Olá" })
        ],
        edges: [liga("t1", "a1")]
      })
    ).toEqual([]);
  });
});
