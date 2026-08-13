import { describe, expect, it } from "vitest";
import {
  cancelPending,
  canSpawn,
  childFailures,
  childReports,
  clampLimits,
  createTree,
  DEFAULT_LIMITS,
  effectiveLimits,
  finishTask,
  flatten,
  lineage,
  patchTask,
  spawnTask,
  summarize,
  type DelegationLimits,
  type TreeState
} from "./agentTree";

const LIMITS: DelegationLimits = { maxDepth: 2, maxChildren: 2, maxTotal: 6 };

function raiz(): TreeState {
  return createTree("Raiz", "Fazer o relatório trimestral", 1000);
}

/** Cria um filho já validado, para encurtar os testes. */
function filho(state: TreeState, parentId: string, title: string) {
  const check = canSpawn(state, parentId, LIMITS);
  if (!check.ok) throw new Error(`não deveria recusar: ${check.message}`);
  return spawnTask(state, parentId, { title, prompt: `faça ${title}` }, 2000);
}

describe("createTree", () => {
  it("nasce com a raiz rodando e contando como 1 agente", () => {
    const tree = raiz();
    expect(tree.tasks[tree.rootId].status).toBe("running");
    expect(tree.tasks[tree.rootId].depth).toBe(0);
    expect(tree.spawned).toBe(1);
  });
});

describe("limites da delegação", () => {
  it("raiz pode delegar quando há profundidade", () => {
    expect(canSpawn(raiz(), "a1", LIMITS).ok).toBe(true);
  });

  /** O teto que impede um erro de julgamento de virar gasto exponencial. */
  it("recusa ao atingir a profundidade máxima", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "nível 1").state;
    tree = filho(tree, "a2", "nível 2").state;
    const check = canSpawn(tree, "a3", LIMITS);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria recusar");
    expect(check.reason).toBe("profundidade");
    // A mensagem é acionável: diz ao modelo o que fazer em vez de só negar.
    expect(check.message).toContain("execute a tarefa diretamente");
  });

  it("recusa ao atingir o número de filhos do mesmo agente", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "um").state;
    tree = filho(tree, "a1", "dois").state;
    const check = canSpawn(tree, "a1", LIMITS);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria recusar");
    expect(check.reason).toBe("filhos");
    expect(check.message).toContain("reúna os resultados");
  });

  it("teto TOTAL vence mesmo com profundidade e filhos sobrando", () => {
    const largo: DelegationLimits = { maxDepth: 5, maxChildren: 10, maxTotal: 3 };
    let tree = raiz();
    tree = spawnTask(tree, "a1", { title: "um", prompt: "" }, 2000).state;
    tree = spawnTask(tree, "a1", { title: "dois", prompt: "" }, 2000).state;
    const check = canSpawn(tree, "a1", largo);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria recusar");
    expect(check.reason).toBe("total");
  });

  it("agente inexistente não delega", () => {
    const check = canSpawn(raiz(), "fantasma", LIMITS);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria recusar");
    expect(check.reason).toBe("sem-pai");
  });

  it("contagem total inclui quem já terminou — não se recicla cota", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "um").state;
    tree = finishTask(tree, "a2", "done", "pronto", 3000);
    expect(tree.spawned).toBe(2);
    const restante: DelegationLimits = { ...LIMITS, maxTotal: 2 };
    expect(canSpawn(tree, "a1", restante).ok).toBe(false);
  });
});

describe("clampLimits", () => {
  it("usa os padrões quando não vem nada", () => {
    expect(clampLimits({})).toEqual(DEFAULT_LIMITS);
  });

  it("prende valores absurdos dentro do teto duro", () => {
    const limits = clampLimits({ maxDepth: 99, maxChildren: 999, maxTotal: 100_000 });
    expect(limits.maxDepth).toBe(5);
    expect(limits.maxChildren).toBe(10);
    expect(limits.maxTotal).toBe(60);
  });

  it("não aceita valores que travariam a execução", () => {
    const limits = clampLimits({ maxDepth: -1, maxChildren: 0, maxTotal: 0 });
    expect(limits.maxDepth).toBe(0); // 0 é válido: proíbe delegar
    expect(limits.maxChildren).toBe(1);
    expect(limits.maxTotal).toBe(1);
  });
});

describe("spawnTask", () => {
  it("liga pai e filho e marca o pai como esperando", () => {
    const { state, child } = filho(raiz(), "a1", "coletar dados");
    expect(child.parentId).toBe("a1");
    expect(child.depth).toBe(1);
    expect(state.tasks.a1.childIds).toEqual([child.id]);
    expect(state.tasks.a1.status).toBe("waiting-children");
  });

  it("título vazio ganha um rótulo em vez de ficar em branco na árvore", () => {
    const { child } = spawnTask(raiz(), "a1", { title: "   ", prompt: "x" }, 2000);
    expect(child.title).toBe("Subtarefa a2");
  });

  it("não muta o estado anterior", () => {
    const antes = raiz();
    filho(antes, "a1", "x");
    expect(antes.tasks.a1.childIds).toEqual([]);
    expect(antes.spawned).toBe(1);
  });
});

describe("relatórios de volta ao superior", () => {
  it("só os filhos concluídos viram relatório", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "ok").state;
    tree = filho(tree, "a1", "falhou").state;
    tree = finishTask(tree, "a2", "done", "achei três coisas", 3000);
    tree = finishTask(tree, "a3", "failed", "provedor caiu", 3000);

    expect(childReports(tree, "a1")).toEqual([{ title: "ok", report: "achei três coisas" }]);
    // A falha não some: vai por um canal separado, sem virar "resultado".
    expect(childFailures(tree, "a1")).toEqual([{ title: "falhou", reason: "provedor caiu" }]);
  });

  it("filho ainda rodando não entra em nenhum dos dois", () => {
    const tree = filho(raiz(), "a1", "em curso").state;
    expect(childReports(tree, "a1")).toEqual([]);
    expect(childFailures(tree, "a1")).toEqual([]);
  });

  it("agente sem filhos devolve listas vazias", () => {
    expect(childReports(raiz(), "a1")).toEqual([]);
    expect(childFailures(raiz(), "inexistente")).toEqual([]);
  });
});

describe("leitura da árvore", () => {
  it("lineage vai da raiz até o nó", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "meio").state;
    tree = filho(tree, "a2", "folha").state;
    expect(lineage(tree, "a3").map((task) => task.title)).toEqual(["Raiz", "meio", "folha"]);
  });

  it("flatten percorre em profundidade, na ordem de criação", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "b").state;
    tree = filho(tree, "a2", "c").state;
    tree = filho(tree, "a1", "d").state;
    expect(flatten(tree).map((task) => task.title)).toEqual(["Raiz", "b", "c", "d"]);
  });

  /** Ciclo não deveria existir, mas travaria a UI inteira se existisse. */
  it("estrutura corrompida não trava o percurso", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "b").state;
    const corrompida: TreeState = {
      ...tree,
      tasks: {
        ...tree.tasks,
        a2: { ...tree.tasks.a2, childIds: ["a1"] },
        a1: { ...tree.tasks.a1, parentId: "a2" }
      }
    };
    expect(flatten(corrompida).length).toBeLessThanOrEqual(2);
    expect(lineage(corrompida, "a1").length).toBeLessThanOrEqual(2);
  });

  it("summarize conta por estado e a profundidade alcançada", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "b").state;
    tree = filho(tree, "a2", "c").state;
    tree = finishTask(tree, "a3", "done", "ok", 4000);
    const resumo = summarize(tree);
    expect(resumo.total).toBe(3);
    expect(resumo.done).toBe(1);
    expect(resumo.running).toBe(2);
    expect(resumo.maxDepth).toBe(2);
  });
});

describe("cancelPending", () => {
  it("cancela só o que não terminou", () => {
    let tree = raiz();
    tree = filho(tree, "a1", "b").state;
    tree = finishTask(tree, "a2", "done", "pronto", 3000);
    const cancelada = cancelPending(tree, 5000);
    expect(cancelada.tasks.a1.status).toBe("cancelled");
    // O que já tinha terminado bem preserva o resultado.
    expect(cancelada.tasks.a2.status).toBe("done");
    expect(cancelada.tasks.a2.report).toBe("pronto");
  });
});

describe("patchTask", () => {
  it("id inexistente devolve o mesmo estado", () => {
    const tree = raiz();
    expect(patchTask(tree, "fantasma", { output: "x" })).toBe(tree);
  });

  it("acumula saída parcial sem tocar no resto", () => {
    const tree = patchTask(raiz(), "a1", { output: "parcial" });
    expect(tree.tasks.a1.output).toBe("parcial");
    expect(tree.tasks.a1.status).toBe("running");
  });
});

describe("effectiveLimits — o teto é do servidor", () => {
  const politica = { maxDepth: 2, maxChildren: 3, maxTotal: 10 };

  it("sem preferência local, vale exatamente o do admin", () => {
    expect(effectiveLimits(politica)).toEqual(politica);
  });

  /** O ponto: o cliente pode APERTAR o próprio limite. */
  it("cliente mais restritivo é respeitado", () => {
    expect(effectiveLimits(politica, { maxTotal: 4 })).toEqual({ ...politica, maxTotal: 4 });
  });

  /**
   * O que não pode acontecer: se o cliente conseguisse subir, o teto do
   * servidor seria decorativo — exatamente o furo que motivou a mudança.
   */
  it("cliente NÃO consegue afrouxar nenhum dos três tetos", () => {
    const tentativa = effectiveLimits(politica, { maxDepth: 5, maxChildren: 10, maxTotal: 60 });
    expect(tentativa).toEqual(politica);
  });

  it("política ausente cai nos padrões conservadores, não em 'sem limite'", () => {
    expect(effectiveLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(effectiveLimits(undefined, { maxTotal: 999 })).toEqual(DEFAULT_LIMITS);
  });

  it("profundidade zero do admin proíbe delegar, e o cliente não reabre", () => {
    const fechado = effectiveLimits({ ...politica, maxDepth: 0 }, { maxDepth: 3 });
    expect(fechado.maxDepth).toBe(0);
  });
});
