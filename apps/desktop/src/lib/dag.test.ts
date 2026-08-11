import { describe, expect, it } from "vitest";
import {
  addNode,
  connect,
  createDoc,
  detectCycle,
  disconnect,
  edgeCount,
  fromJson,
  nextId,
  releaseTrainDoc,
  removeNode,
  toJson,
  topoWaves,
  updateNode,
  type DagDoc
} from "./dag";

/** Grafo diamante: a → b, a → c, b → d, c → d. */
function diamond(): DagDoc {
  let doc = createDoc("Diamante");
  doc = addNode(doc, { id: "a", name: "A", kind: "input" });
  doc = addNode(doc, { id: "b", name: "B", kind: "agent" });
  doc = addNode(doc, { id: "c", name: "C", kind: "agent" });
  doc = addNode(doc, { id: "d", name: "D", kind: "merge" });
  doc = connect(doc, "a", "b");
  doc = connect(doc, "a", "c");
  doc = connect(doc, "b", "d");
  doc = connect(doc, "c", "d");
  return doc;
}

describe("addNode / nextId", () => {
  it("adiciona nó e rejeita id duplicado", () => {
    let doc = createDoc("t");
    doc = addNode(doc, { id: "x", name: "X", kind: "agent" });
    expect(doc.nodes).toHaveLength(1);
    expect(() => addNode(doc, { id: "x", name: "X2", kind: "tool" })).toThrow(/duplicado/i);
  });

  it("rejeita dependência inexistente e auto-referência", () => {
    const doc = createDoc("t");
    expect(() => addNode(doc, { id: "x", name: "X", kind: "agent", dependsOn: ["ghost"] })).toThrow(/desconhecida/i);
    expect(() => addNode(doc, { id: "x", name: "X", kind: "agent", dependsOn: ["x"] })).toThrow(/auto-referência/i);
  });

  it("nextId nunca colide com ids existentes", () => {
    let doc = createDoc("t");
    doc = addNode(doc, { id: "agent-1", name: "A1", kind: "agent" });
    doc = addNode(doc, { id: "agent-2", name: "A2", kind: "agent" });
    expect(nextId(doc, "agent")).toBe("agent-3");
    expect(nextId(doc, "tool")).toBe("tool-1");
  });
});

describe("connect / disconnect", () => {
  it("cria aresta origem → destino (destino passa a depender da origem)", () => {
    const doc = diamond();
    expect(doc.nodes.find((node) => node.id === "d")?.dependsOn).toEqual(["b", "c"]);
    expect(edgeCount(doc)).toBe(4);
  });

  it("valida auto-referência, nó inexistente e aresta duplicada", () => {
    const doc = diamond();
    expect(() => connect(doc, "a", "a")).toThrow(/auto-referência/i);
    expect(() => connect(doc, "a", "ghost")).toThrow(/inexistente/i);
    expect(() => connect(doc, "ghost", "a")).toThrow(/inexistente/i);
    expect(() => connect(doc, "a", "b")).toThrow(/já existe/i);
  });

  it("disconnect remove a aresta e valida inexistência", () => {
    let doc = diamond();
    doc = disconnect(doc, "b", "d");
    expect(doc.nodes.find((node) => node.id === "d")?.dependsOn).toEqual(["c"]);
    expect(() => disconnect(doc, "b", "d")).toThrow(/inexistente/i);
    expect(() => disconnect(doc, "d", "d")).toThrow(/auto-referência/i);
  });
});

describe("removeNode", () => {
  it("remove o nó e limpa as arestas que apontavam para ele", () => {
    let doc = diamond();
    doc = removeNode(doc, "b");
    expect(doc.nodes.map((node) => node.id)).toEqual(["a", "c", "d"]);
    // "d" dependia de b e c; a aresta b → d some junto com o nó.
    expect(doc.nodes.find((node) => node.id === "d")?.dependsOn).toEqual(["c"]);
    expect(() => removeNode(doc, "ghost")).toThrow(/inexistente/i);
  });
});

describe("updateNode", () => {
  it("altera name/prompt sem tocar no resto", () => {
    let doc = diamond();
    doc = updateNode(doc, "b", { name: "B2", prompt: "faça algo" });
    const node = doc.nodes.find((entry) => entry.id === "b");
    expect(node?.name).toBe("B2");
    expect(node?.prompt).toBe("faça algo");
    expect(node?.dependsOn).toEqual(["a"]);
  });
});

describe("detectCycle", () => {
  it("retorna null em grafo acíclico (diamante)", () => {
    expect(detectCycle(diamond())).toBeNull();
  });

  it("detecta e retorna o ciclo real (a → b → c → a)", () => {
    let doc = createDoc("c");
    doc = addNode(doc, { id: "a", name: "A", kind: "agent" });
    doc = addNode(doc, { id: "b", name: "B", kind: "agent" });
    doc = addNode(doc, { id: "c", name: "C", kind: "agent" });
    doc = connect(doc, "a", "b");
    doc = connect(doc, "b", "c");
    doc = connect(doc, "c", "a"); // fecha o ciclo
    const cycle = detectCycle(doc);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]); // fechado
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("topoWaves", () => {
  it("ondas corretas em grafo diamante: [a], [b,c], [d]", () => {
    expect(topoWaves(diamond())).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("nós isolados entram na primeira onda", () => {
    let doc = diamond();
    doc = addNode(doc, { id: "solo", name: "Solo", kind: "tool" });
    expect(topoWaves(doc)[0]).toEqual(["a", "solo"]);
  });

  it("lança erro citando o ciclo quando o grafo é cíclico", () => {
    let doc = createDoc("c");
    doc = addNode(doc, { id: "a", name: "A", kind: "agent" });
    doc = addNode(doc, { id: "b", name: "B", kind: "agent" });
    doc = connect(doc, "a", "b");
    doc = connect(doc, "b", "a");
    expect(() => topoWaves(doc)).toThrow(/ciclo/i);
  });
});

describe("toJson / fromJson", () => {
  it("round-trip preserva o documento inteiro", () => {
    const doc = releaseTrainDoc();
    expect(fromJson(toJson(doc))).toEqual(doc);
  });

  it("valida raiz, schemaVersion, name e nodes", () => {
    expect(() => fromJson("nope{")).toThrow(/malformado/i);
    expect(() => fromJson("[]")).toThrow(/objeto raiz/i);
    expect(() => fromJson(JSON.stringify({ schemaVersion: 2, name: "x", nodes: [] }))).toThrow(/schemaVersion/);
    expect(() => fromJson(JSON.stringify({ schemaVersion: 1, name: "", nodes: [] }))).toThrow(/name/);
    expect(() => fromJson(JSON.stringify({ schemaVersion: 1, name: "x", nodes: {} }))).toThrow(/array/);
  });

  it("valida nós: kind desconhecido, id duplicado, dep fantasma e auto-referência", () => {
    const base = { schemaVersion: 1, name: "x", maxConcurrency: 2 };
    const node = (patch: object) => ({ id: "n1", name: "N", kind: "agent", dependsOn: [], ...patch });
    expect(() => fromJson(JSON.stringify({ ...base, nodes: [node({ kind: "robot" })] }))).toThrow(/desconhecido/i);
    expect(() => fromJson(JSON.stringify({ ...base, nodes: [node({}), node({})] }))).toThrow(/duplicado/i);
    expect(() => fromJson(JSON.stringify({ ...base, nodes: [node({ dependsOn: ["ghost"] })] }))).toThrow(/não existe/i);
    expect(() => fromJson(JSON.stringify({ ...base, nodes: [node({ dependsOn: ["n1"] })] }))).toThrow(/auto-referência/i);
  });

  it("maxConcurrency ausente vira 4; inválido lança", () => {
    const doc = fromJson(JSON.stringify({ schemaVersion: 1, name: "x", nodes: [] }));
    expect(doc.maxConcurrency).toBe(4);
    expect(() => fromJson(JSON.stringify({ schemaVersion: 1, name: "x", maxConcurrency: 0, nodes: [] }))).toThrow(
      /maxConcurrency/
    );
  });
});

describe("releaseTrainDoc", () => {
  it("é acíclico, com 8 nós, 8 arestas e diamante code-a/code-b na mesma onda", () => {
    const doc = releaseTrainDoc();
    expect(detectCycle(doc)).toBeNull();
    expect(doc.nodes).toHaveLength(8);
    expect(edgeCount(doc)).toBe(8);
    const waves = topoWaves(doc);
    expect(waves).toHaveLength(7);
    expect(waves[3]).toEqual(["code-a", "code-b"]);
  });

  it("todo nó agent tem prompt executável", () => {
    const agents = releaseTrainDoc().nodes.filter((node) => node.kind === "agent");
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) expect(agent.prompt?.trim().length ?? 0).toBeGreaterThan(10);
  });
});
