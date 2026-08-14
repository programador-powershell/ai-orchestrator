import { describe, expect, it, vi } from "vitest";

import { buildRequest, createOpStream, heuristicOps, SYSTEM } from "./assistant";
import { applyOps } from "./ops";
import { emptyDefinition } from "./types";

describe("createOpStream", () => {
  it("entrega a operação no instante em que a LINHA fecha", () => {
    // É o que faz o nó aparecer durante a resposta, e não só no fim.
    const vistas: string[] = [];
    const stream = createOpStream((op) => vistas.push(op.op));
    stream.push('{"op":"clear"}\n{"op":"add","id":"t1",');
    expect(vistas).toEqual(["clear"]);
    stream.push('"type":"trigger","label":"Novo lead"}\n');
    expect(vistas).toEqual(["clear", "add"]);
  });

  it("a última linha sem quebra ainda vale no fim do stream", () => {
    const vistas: string[] = [];
    const stream = createOpStream((op) => vistas.push(op.op));
    stream.push('{"op":"rename","name":"Fluxo X"}');
    expect(vistas).toEqual([]);
    stream.end();
    expect(vistas).toEqual(["rename"]);
  });

  it("prosa do modelo entre as operações é descartada", () => {
    const vistas: string[] = [];
    const stream = createOpStream((op) => vistas.push(op.op));
    stream.push('Claro! Vou montar:\n```json\n{"op":"clear"}\n```\n');
    stream.end();
    expect(vistas).toEqual(["clear"]);
  });
});

describe("buildRequest", () => {
  it("manda o fluxo ATUAL com os ids — sem isso não dá para editar", () => {
    const request = buildRequest("remova a espera", {
      nodes: [{ id: "w1", type: "wait", position: { x: 0, y: 0 }, data: { label: "Aguardar" } }],
      edges: []
    });
    expect(request[0].content).toBe(SYSTEM);
    expect(request[1].content).toContain("w1: wait");
    expect(request[1].content).toContain("remova a espera");
  });

  it("o system ensina as operações de edição, não só as de criação", () => {
    for (const op of ["update", "remove", "disconnect", "rename"]) {
      expect(SYSTEM).toContain(`"op":"${op}"`);
    }
  });
});

describe("heuristicOps", () => {
  const monta = (pedido: string) => applyOps(emptyDefinition(), heuristicOps(pedido));

  it("sempre entrega um fluxo válido, começando por gatilho", () => {
    const fluxo = monta("qualquer coisa");
    expect(fluxo.nodes[0].type).toBe("trigger");
    expect(fluxo.nodes.length).toBeGreaterThan(1);
    expect(fluxo.edges.length).toBeGreaterThan(0);
  });

  it("lê o valor do orçamento da frase, inclusive com 'mil'", () => {
    const fluxo = monta("marcar como quente quando o orçamento passar de 5 mil e avisar o gestor");
    const condicao = fluxo.nodes.find((node) => node.type === "condition");
    expect(condicao?.data.value).toBe(5000);
    expect(fluxo.nodes.some((node) => node.data.actionType === "mark_hot")).toBe(true);
    expect(fluxo.nodes.some((node) => node.data.actionType === "notify_manager")).toBe(true);
  });

  it("reconhece a espera com a unidade dita na frase", () => {
    const fluxo = monta("se o lead não responder em 3 dias, enviar mensagem de retomada");
    const espera = fluxo.nodes.find((node) => node.type === "wait");
    expect(espera?.data.waitAmount).toBe(3);
    expect(espera?.data.waitUnit).toBe("days");
  });

  it("escolhe o gatilho pelo assunto da frase", () => {
    expect(monta("quando o cartão atrasar, avisar o gestor").nodes[0].data.triggerType).toBe("card_overdue");
    expect(monta("quando o contato responder no whatsapp, criar tarefa").nodes[0].data.triggerType).toBe(
      "whatsapp_reply"
    );
  });

  it("as operações passam pelo MESMO caminho do modelo", () => {
    // Sem isto, o modo sem gateway teria um comportamento próprio — e só se
    // descobriria o que ele faz de diferente em produção.
    const aplicadas = heuristicOps("enviar boas-vindas no whatsapp");
    const spy = vi.fn();
    const stream = createOpStream(spy);
    for (const op of aplicadas) stream.push(`${JSON.stringify({ ...op, ...("data" in op ? op.data : {}) })}\n`);
    expect(spy).toHaveBeenCalled();
  });
});
