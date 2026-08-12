import { describe, expect, it } from "vitest";
import { addNode, connect, createDoc, updateNode, type DagDoc } from "./dag";
import {
  describeResume,
  docFingerprint,
  isRefusal,
  makeRun,
  parseRun,
  planResume,
  serializeRun,
  type NodeRun,
  type PersistedRun
} from "./agentRun";

/** a → b → c, linear. */
function chain(): DagDoc {
  let doc = createDoc("fluxo", 2);
  doc = addNode(doc, { id: "a", name: "A", kind: "input", prompt: "raiz" });
  doc = addNode(doc, { id: "b", name: "B", kind: "agent", prompt: "faz b", dependsOn: ["a"] });
  doc = addNode(doc, { id: "c", name: "C", kind: "agent", prompt: "faz c", dependsOn: ["b"] });
  return doc;
}

const done = (output: string): NodeRun => ({ status: "done", output });

function savedFor(doc: DagDoc, runs: Record<string, NodeRun>): PersistedRun {
  return { ...makeRun(doc, 1000), runs };
}

describe("docFingerprint", () => {
  it("ignora renomear nó — não muda o que será executado", () => {
    const doc = chain();
    const renamed = updateNode(doc, "b", { name: "Outro nome" });
    expect(docFingerprint(renamed)).toBe(docFingerprint(doc));
  });

  it("muda quando o prompt muda", () => {
    const doc = chain();
    const edited = updateNode(doc, "b", { prompt: "faz b diferente" });
    expect(docFingerprint(edited)).not.toBe(docFingerprint(doc));
  });

  it("muda quando uma aresta é criada", () => {
    const doc = chain();
    const linked = connect(doc, "a", "c");
    expect(docFingerprint(linked)).not.toBe(docFingerprint(doc));
  });

  it("não depende da ordem dos nós no array", () => {
    const doc = chain();
    const shuffled: DagDoc = { ...doc, nodes: [...doc.nodes].reverse() };
    expect(docFingerprint(shuffled)).toBe(docFingerprint(doc));
  });
});

describe("parseRun", () => {
  it("faz round-trip", () => {
    const run = savedFor(chain(), { a: done("raiz"), b: { status: "failed", output: "", note: "502" } });
    expect(parseRun(serializeRun(run))).toEqual(run);
  });

  it("recusa JSON inválido, versão errada e status desconhecido", () => {
    expect(parseRun("não é json")).toBeNull();
    expect(parseRun(JSON.stringify({ version: 2 }))).toBeNull();
    const bad = savedFor(chain(), {});
    expect(
      parseRun(JSON.stringify({ ...bad, runs: { a: { status: "inventado", output: "" } } }))
    ).toBeNull();
    expect(parseRun(JSON.stringify({ ...bad, runs: { a: { status: "done" } } }))).toBeNull();
  });

  it("recusa runs que não é objeto", () => {
    const bad = savedFor(chain(), {});
    expect(parseRun(JSON.stringify({ ...bad, runs: [] }))).toBeNull();
  });
});

describe("planResume", () => {
  it("recusa sem execução salva", () => {
    const plan = planResume(chain(), null);
    expect(isRefusal(plan) && plan.reason).toBe("sem-execucao");
  });

  it("recusa quando o DAG mudou — não reaproveita saída de outro grafo", () => {
    const doc = chain();
    const saved = savedFor(doc, { a: done("raiz"), b: done("saída b") });
    const edited = updateNode(doc, "b", { prompt: "prompt novo" });
    const plan = planResume(edited, saved);
    expect(isRefusal(plan) && plan.reason).toBe("dag-mudou");
  });

  it("recusa quando nada terminou bem", () => {
    const doc = chain();
    const saved = savedFor(doc, { a: { status: "failed", output: "" } });
    const plan = planResume(doc, saved);
    expect(isRefusal(plan) && plan.reason).toBe("nada-a-retomar");
  });

  it("reaproveita o prefixo concluído e reexecuta o resto", () => {
    const doc = chain();
    const saved = savedFor(doc, {
      a: done("raiz"),
      b: done("saída b"),
      c: { status: "failed", output: "", note: "provedor caiu" }
    });
    const plan = planResume(doc, saved);
    if (isRefusal(plan)) throw new Error(plan.message);
    expect(plan.reuse).toEqual(["a", "b"]);
    expect(plan.rerun).toEqual(["c"]);
    expect(plan.outputs.get("b")).toBe("saída b");
    expect(describeResume(plan)).toContain("2 nó(s) reaproveitado(s)");
  });

  it("nó done cujo pai vai reexecutar NÃO é reaproveitado", () => {
    // c ficou "done" numa execução antiga, mas b falhou: o contexto que gerou
    // c deixou de existir, então c tem de rodar de novo.
    const doc = chain();
    const saved = savedFor(doc, {
      a: done("raiz"),
      b: { status: "failed", output: "" },
      c: done("saída antiga de c")
    });
    const plan = planResume(doc, saved);
    if (isRefusal(plan)) throw new Error(plan.message);
    expect(plan.reuse).toEqual(["a"]);
    expect(plan.rerun).toEqual(["b", "c"]);
    expect(plan.outputs.has("c")).toBe(false);
  });

  it("nó em aprovação volta para a fila", () => {
    const doc = chain();
    const saved = savedFor(doc, { a: done("raiz"), b: { status: "waiting", output: "" } });
    const plan = planResume(doc, saved);
    if (isRefusal(plan)) throw new Error(plan.message);
    expect(plan.rerun).toContain("b");
  });

  it("nó novo sem registro entra em rerun sem quebrar o fingerprint da comparação", () => {
    // fingerprint idêntico exige mesmo doc: aqui o registro é que está incompleto.
    const doc = chain();
    const saved = savedFor(doc, { a: done("raiz") });
    const plan = planResume(doc, saved);
    if (isRefusal(plan)) throw new Error(plan.message);
    expect(plan.rerun).toEqual(["b", "c"]);
  });

  it("respeita a topologia com dois pais", () => {
    let doc = createDoc("diamante", 4);
    doc = addNode(doc, { id: "a", name: "A", kind: "input", prompt: "" });
    doc = addNode(doc, { id: "b", name: "B", kind: "agent", prompt: "b", dependsOn: ["a"] });
    doc = addNode(doc, { id: "c", name: "C", kind: "agent", prompt: "c", dependsOn: ["a"] });
    doc = addNode(doc, { id: "d", name: "D", kind: "merge", dependsOn: ["b", "c"] });
    const saved = savedFor(doc, {
      a: done("raiz"),
      b: done("b ok"),
      c: { status: "failed", output: "" },
      d: done("d antigo")
    });
    const plan = planResume(doc, saved);
    if (isRefusal(plan)) throw new Error(plan.message);
    expect(plan.reuse.sort()).toEqual(["a", "b"]);
    expect(plan.rerun.sort()).toEqual(["c", "d"]); // d depende de c, que reexecuta
  });
});
