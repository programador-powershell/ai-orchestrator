import { describe, expect, it } from "vitest";

import { applyOp, applyOps, clearFresh, describeFlow, parseOpLine, takeOps } from "./ops";
import { emptyDefinition, type FlowDefinition } from "./types";

const linha = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe("parseOpLine", () => {
  it("lê um add completo", () => {
    const op = parseOpLine(linha({ op: "add", id: "t1", type: "trigger", triggerType: "new_lead", label: "Novo lead" }));
    expect(op).toEqual({
      op: "add",
      id: "t1",
      type: "trigger",
      data: { label: "Novo lead", triggerType: "new_lead" }
    });
  });

  it("descarta campo que não está no catálogo", () => {
    // O modelo inventa: `actionType: "hackear"` não pode virar nó executável.
    const op = parseOpLine(linha({ op: "add", id: "a1", type: "action", actionType: "hackear", label: "X" }));
    expect(op).toEqual({ op: "add", id: "a1", type: "action", data: { label: "X" } });
  });

  it("dá rótulo pelo catálogo quando falta", () => {
    const op = parseOpLine(linha({ op: "add", id: "a1", type: "action", actionType: "send_whatsapp" }));
    expect(op && op.op === "add" && op.data.label).toBe("Enviar WhatsApp");
  });

  it("update sem label não apaga o label existente", () => {
    const op = parseOpLine(linha({ op: "update", id: "a1", message: "novo texto" }));
    expect(op).toEqual({ op: "update", id: "a1", data: { message: "novo texto" } });
  });

  it("recusa linha que não é operação", () => {
    expect(parseOpLine("Claro! Vou montar o fluxo:")).toBeNull();
    expect(parseOpLine("```json")).toBeNull();
    expect(parseOpLine('{"op":"add","id":"x"}')).toBeNull(); // sem type
    expect(parseOpLine("{quebrado")).toBeNull();
  });

  it("aceita a linha com marcador de lista na frente", () => {
    // Modelo teimoso devolve "- {…}"; recusar isso perderia o fluxo inteiro.
    expect(parseOpLine(`- ${linha({ op: "clear" })}`)).toEqual({ op: "clear" });
  });
});

describe("takeOps", () => {
  it("só entrega linha COMPLETA e devolve o resto", () => {
    const parcial = `${linha({ op: "clear" })}\n{"op":"add","id":"t1","type":"tr`;
    const { ops, rest } = takeOps(parcial);
    expect(ops).toEqual([{ op: "clear" }]);
    expect(rest).toBe('{"op":"add","id":"t1","type":"tr');
  });

  it("a linha incompleta vira operação quando o resto chega", () => {
    const primeiro = takeOps('{"op":"add","id":"t1","type":"tri');
    expect(primeiro.ops).toHaveLength(0);
    const segundo = takeOps(`${primeiro.rest}gger","label":"Novo lead"}\n`);
    expect(segundo.ops).toHaveLength(1);
  });
});

describe("applyOp", () => {
  const base: FlowDefinition = {
    nodes: [
      { id: "t1", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Novo lead" } },
      { id: "a1", type: "action", position: { x: 0, y: 0 }, data: { label: "WhatsApp" } }
    ],
    edges: [{ id: "e-t1-a1", source: "t1", target: "a1" }]
  };

  it("add marca o nó como recém-criado — é o destaque na tela", () => {
    const saida = applyOp(emptyDefinition(), {
      op: "add",
      id: "t1",
      type: "trigger",
      data: { label: "Novo lead" }
    });
    expect(saida.nodes[0].data.fresh).toBe(true);
    expect(clearFresh(saida).nodes[0].data.fresh).toBe(false);
  });

  it("add repetido no mesmo id vira atualização", () => {
    const saida = applyOp(base, { op: "add", id: "a1", type: "action", data: { label: "Outro" } });
    expect(saida.nodes).toHaveLength(2);
    expect(saida.nodes[1].data.label).toBe("Outro");
  });

  it("remove leva junto as arestas penduradas", () => {
    const saida = applyOp(base, { op: "remove", id: "a1" });
    expect(saida.nodes.map((node) => node.id)).toEqual(["t1"]);
    expect(saida.edges).toEqual([]);
  });

  it("connect para nó inexistente é ignorado", () => {
    expect(applyOp(base, { op: "connect", from: "t1", to: "nao-existe" }).edges).toHaveLength(1);
  });

  it("não cria a mesma ligação duas vezes nem laço no próprio nó", () => {
    expect(applyOp(base, { op: "connect", from: "t1", to: "a1" }).edges).toHaveLength(1);
    expect(applyOp(base, { op: "connect", from: "t1", to: "t1" }).edges).toHaveLength(1);
  });

  it("ramo da condição vira rótulo legível na aresta", () => {
    const saida = applyOp(base, { op: "connect", from: "a1", to: "t1", branch: "false" });
    expect(saida.edges[1]).toMatchObject({ sourceHandle: "false", label: "não" });
  });

  it("clear zera tudo", () => {
    expect(applyOp(base, { op: "clear" })).toEqual({ nodes: [], edges: [] });
  });

  it("uma sequência monta o fluxo inteiro", () => {
    const saida = applyOps(emptyDefinition(), [
      { op: "add", id: "t1", type: "trigger", data: { label: "Novo lead" } },
      { op: "add", id: "c1", type: "condition", data: { label: "Caro?" } },
      { op: "connect", from: "t1", to: "c1" },
      { op: "add", id: "a1", type: "action", data: { label: "Quente" } },
      { op: "connect", from: "c1", to: "a1", branch: "true" }
    ]);
    expect(saida.nodes).toHaveLength(3);
    expect(saida.edges).toHaveLength(2);
  });
});

describe("describeFlow", () => {
  it("descreve com os ids — é o que permite EDITAR pelo prompt", () => {
    const texto = describeFlow({
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Novo lead", triggerType: "new_lead" } },
        { id: "w1", type: "wait", position: { x: 0, y: 0 }, data: { label: "Aguardar", waitAmount: 2, waitUnit: "days" } }
      ],
      edges: [{ id: "e", source: "t1", target: "w1" }]
    });
    expect(texto).toContain("t1: trigger");
    expect(texto).toContain("w1: wait");
    expect(texto).toContain("2 days");
    expect(texto).toContain("t1 -> w1");
  });

  it("fluxo vazio é dito, não omitido", () => {
    expect(describeFlow(emptyDefinition())).toContain("vazio");
  });
});
