import { describe, expect, it } from "vitest";

import { autoLayout, pin, ranks } from "./layout";
import type { FlowDefinition } from "./types";

const no = (id: string, type: FlowDefinition["nodes"][number]["type"], data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, ...data } as never
});
const liga = (from: string, to: string) => ({ id: `e-${from}-${to}`, source: from, target: to });

describe("ranks", () => {
  it("conta a distância até o gatilho", () => {
    const rank = ranks({
      nodes: [no("t1", "trigger"), no("c1", "condition"), no("a1", "action")],
      edges: [liga("t1", "c1"), liga("c1", "a1")]
    });
    expect([rank.get("t1"), rank.get("c1"), rank.get("a1")]).toEqual([0, 1, 2]);
  });

  it("junção fica à DIREITA de quem a alimenta (vale o caminho mais longo)", () => {
    // t1 → a1 → fim  e  t1 → fim. O "fim" tem de ficar na coluna 2, senão a
    // seta de a1 voltaria para trás.
    const rank = ranks({
      nodes: [no("t1", "trigger"), no("a1", "action"), no("fim", "end")],
      edges: [liga("t1", "a1"), liga("a1", "fim"), liga("t1", "fim")]
    });
    expect(rank.get("fim")).toBe(2);
  });

  it("nó solto não some — fica na primeira coluna", () => {
    const rank = ranks({ nodes: [no("t1", "trigger"), no("x", "action")], edges: [] });
    expect(rank.get("x")).toBe(0);
  });
});

describe("autoLayout", () => {
  it("posiciona por coluna, da esquerda para a direita", () => {
    const saida = autoLayout({
      nodes: [no("t1", "trigger"), no("a1", "action")],
      edges: [liga("t1", "a1")]
    });
    expect(saida.nodes[1].position.x).toBeGreaterThan(saida.nodes[0].position.x);
  });

  it("os dois ramos da condição ficam em linhas diferentes", () => {
    const saida = autoLayout({
      nodes: [no("t1", "trigger"), no("c1", "condition"), no("sim", "action"), no("nao", "action")],
      edges: [liga("t1", "c1"), liga("c1", "sim"), liga("c1", "nao")]
    });
    const sim = saida.nodes.find((node) => node.id === "sim");
    const nao = saida.nodes.find((node) => node.id === "nao");
    expect(sim?.position.x).toBe(nao?.position.x);
    expect(sim?.position.y).not.toBe(nao?.position.y);
  });

  it("NÃO mexe no nó que a pessoa arrastou", () => {
    const base: FlowDefinition = {
      nodes: [no("t1", "trigger"), no("a1", "action")],
      edges: [liga("t1", "a1")]
    };
    const fixado = pin(base, "a1", { x: 999, y: 555 });
    const saida = autoLayout(fixado);
    expect(saida.nodes.find((node) => node.id === "a1")?.position).toEqual({ x: 999, y: 555 });
    // O outro continua sendo posicionado normalmente.
    expect(saida.nodes[0].position.x).toBeGreaterThan(0);
  });

  it("fluxo vazio não quebra", () => {
    expect(autoLayout({ nodes: [], edges: [] }).nodes).toEqual([]);
  });
});
