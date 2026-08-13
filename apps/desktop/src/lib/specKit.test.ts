import { describe, expect, it } from "vitest";
import {
  approveStage,
  canEnterStage,
  emptyDoc,
  isApproved,
  isStageFilled,
  nextPendingTask,
  parseDoc,
  parseTasks,
  patchTask,
  serializeDoc,
  setStage,
  STAGE_ORDER,
  stagePrompt,
  taskProgress,
  taskPrompt,
  toMarkdown,
  type SpecDoc
} from "./specKit";

/** Documento com constituição e spec já aprovadas. */
function ateSpec(): SpecDoc {
  let doc = emptyDoc("Feature X");
  doc = setStage(doc, "constitution", "1. Toda função pública tem teste.", 1000);
  doc = approveStage(doc, "constitution", 1000);
  doc = setStage(doc, "spec", "O usuário precisa exportar o relatório.", 2000);
  doc = approveStage(doc, "spec", 2000);
  return doc;
}

describe("ordem das etapas", () => {
  it("a primeira etapa está sempre liberada", () => {
    expect(canEnterStage(emptyDoc(), "constitution").ok).toBe(true);
  });

  it("etapa vazia bloqueia a seguinte", () => {
    const check = canEnterStage(emptyDoc(), "spec");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria bloquear");
    expect(check.message).toContain("Constituição");
  });

  /**
   * Gerar o plano antes da spec aprovada produziria um plano para um alvo que
   * ainda pode mudar — e a revisão humana perderia o sentido.
   */
  it("etapa preenchida mas NÃO aprovada ainda bloqueia", () => {
    const doc = setStage(emptyDoc(), "constitution", "1. Regra.", 1000);
    const check = canEnterStage(doc, "spec");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("deveria bloquear");
    expect(check.message).toContain("precisa ser aprovada");
  });

  it("com a anterior aprovada, libera", () => {
    expect(canEnterStage(ateSpec(), "plan").ok).toBe(true);
  });
});

describe("aprovação e invalidação", () => {
  it("aprovar marca a etapa", () => {
    const doc = approveStage(setStage(emptyDoc(), "constitution", "x", 1), "constitution", 2);
    expect(isApproved(doc, "constitution")).toBe(true);
  });

  /** O ponto: editar não pode carimbar trabalho que ninguém revisou de novo. */
  it("editar a spec derruba a aprovação do plano feito em cima dela", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "plano antigo", 3000);
    doc = approveStage(doc, "plan", 3000);
    expect(isApproved(doc, "plan")).toBe(true);

    doc = setStage(doc, "spec", "escopo mudou", 4000);
    expect(isApproved(doc, "spec")).toBe(false);
    expect(isApproved(doc, "plan")).toBe(false);
    // A constituição, que veio ANTES, continua aprovada.
    expect(isApproved(doc, "constitution")).toBe(true);
  });

  it("aprovar uma etapa anterior invalida as posteriores", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "plano", 3000);
    doc = approveStage(doc, "plan", 3000);
    doc = approveStage(doc, "constitution", 4000);
    expect(isApproved(doc, "constitution")).toBe(true);
    expect(isApproved(doc, "plan")).toBe(false);
  });

  it("aprovar duas vezes não duplica", () => {
    let doc = approveStage(setStage(emptyDoc(), "constitution", "x", 1), "constitution", 2);
    doc = approveStage(doc, "constitution", 3);
    expect(doc.approved).toEqual(["constitution"]);
  });
});

describe("parseTasks", () => {
  it("lê título, instrução e verificação", () => {
    const tasks = parseTasks(
      "## 1. Criar o endpoint\nAdicione GET /relatorio devolvendo JSON.\nVerificação: curl retorna 200 com o campo total.\n\n" +
        "## 2. Cobrir com teste\nEscreva o teste do endpoint.\nVerificação: pnpm test passa."
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Criar o endpoint");
    expect(tasks[0].detail).toBe("Adicione GET /relatorio devolvendo JSON.");
    expect(tasks[0].verify).toContain("curl retorna 200");
    expect(tasks[1].id).toBe("t2");
  });

  it("aceita lista com hífen e numeração sem cabeçalho", () => {
    const tasks = parseTasks("- Primeira coisa\ndetalhe\n1) Segunda coisa\noutro detalhe");
    expect(tasks.map((task) => task.title)).toEqual(["Primeira coisa", "Segunda coisa"]);
  });

  /** Descartar em silêncio esconderia trabalho — a UI é quem cobra. */
  it("tarefa sem verificação entra com verify vazio, não é descartada", () => {
    const tasks = parseTasks("## 1. Fazer algo\nsó a instrução");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].verify).toBe("");
  });

  it("texto sem nenhuma tarefa devolve lista vazia", () => {
    expect(parseTasks("Não há tarefas aqui, só um parágrafo.")).toEqual([]);
    expect(parseTasks("")).toEqual([]);
  });

  it("remove negrito do título", () => {
    expect(parseTasks("## **Título forte**\ncorpo")[0].title).toBe("Título forte");
  });

  it("verificação em maiúsculas ou sem cedilha também é reconhecida", () => {
    expect(parseTasks("## 1. T\ncorpo\nVERIFICACAO: rodar o teste")[0].verify).toBe("rodar o teste");
  });
});

describe("progresso das tarefas", () => {
  function comTarefas(): SpecDoc {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "plano", 3000);
    doc = approveStage(doc, "plan", 3000);
    return setStage(doc, "tasks", "## 1. A\nfazer a\n## 2. B\nfazer b\n## 3. C\nfazer c", 4000);
  }

  it("a próxima pendente respeita a ordem escrita", () => {
    let doc = comTarefas();
    expect(nextPendingTask(doc)?.title).toBe("A");
    doc = patchTask(doc, "t1", { status: "done" }, 5000);
    expect(nextPendingTask(doc)?.title).toBe("B");
  });

  it("tarefa falha não vira a próxima pendente nem some da contagem", () => {
    let doc = comTarefas();
    doc = patchTask(doc, "t1", { status: "failed" }, 5000);
    expect(nextPendingTask(doc)?.title).toBe("B");
    expect(taskProgress(doc)).toEqual({ total: 3, done: 0, failed: 1 });
  });

  it("sem pendente devolve null", () => {
    let doc = comTarefas();
    for (const id of ["t1", "t2", "t3"]) doc = patchTask(doc, id, { status: "done" }, 5000);
    expect(nextPendingTask(doc)).toBeNull();
    expect(taskProgress(doc).done).toBe(3);
  });
});

describe("prompts", () => {
  /**
   * O que diferencia este fluxo de um chat comum: sem a constituição em CADA
   * etapa, o modelo respeita as regras na primeira e esquece na terceira.
   */
  it("a constituição entra em todas as etapas seguintes", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "plano", 3000);
    doc = approveStage(doc, "plan", 3000);
    for (const stage of ["spec", "plan", "tasks"] as const) {
      expect(stagePrompt(doc, stage, "pedido")).toContain("Toda função pública tem teste");
      expect(stagePrompt(doc, stage, "pedido")).toContain("INEGOCIÁVEIS");
    }
  });

  it("o prompt da constituição não cita a si mesma", () => {
    const texto = stagePrompt(ateSpec(), "constitution", "contexto do time");
    expect(texto).toContain("contexto do time");
    expect(texto).not.toContain("CONSTITUIÇÃO DO PROJETO —");
  });

  it("constituição vazia não injeta bloco vazio", () => {
    const doc = setStage(emptyDoc(), "spec", "algo", 1000);
    expect(stagePrompt(doc, "spec", "x")).not.toContain("INEGOCIÁVEIS");
  });

  it("a spec proíbe escolher tecnologia e manda marcar o que falta", () => {
    const texto = stagePrompt(ateSpec(), "spec", "pedido");
    expect(texto).toContain("Não escolha tecnologia");
    expect(texto).toContain("EM ABERTO");
  });

  it("o plano recebe a spec aprovada", () => {
    expect(stagePrompt(ateSpec(), "plan", "")).toContain("O usuário precisa exportar o relatório");
  });

  it("o prompt de tarefas exige verificação por tarefa", () => {
    const texto = stagePrompt(ateSpec(), "tasks", "");
    expect(texto).toContain("Verificação:");
    expect(texto).toContain("autocontida");
  });

  it("o prompt de execução carrega constituição, tarefa e verificação", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "p", 3000);
    doc = approveStage(doc, "plan", 3000);
    doc = setStage(doc, "tasks", "## 1. Criar X\nfaça X\nVerificação: teste passa", 4000);
    const texto = taskPrompt(doc, doc.tasks[0]);
    expect(texto).toContain("Toda função pública tem teste");
    expect(texto).toContain("faça X");
    expect(texto).toContain("teste passa");
    expect(texto).toContain("não declare pronto o que não está");
  });
});

describe("persistência", () => {
  it("faz round-trip", () => {
    const doc = ateSpec();
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it("recusa nulo, lixo e versão errada", () => {
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc("não é json")).toBeNull();
    expect(parseDoc(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
  });

  it("status desconhecido vira pendente em vez de quebrar", () => {
    const bruto = JSON.stringify({
      schemaVersion: 1,
      tasks: [{ id: "t1", title: "A", detail: "", verify: "", status: "inventado" }]
    });
    expect(parseDoc(bruto)?.tasks[0].status).toBe("pending");
  });

  it("etapa aprovada desconhecida é descartada", () => {
    const bruto = JSON.stringify({ schemaVersion: 1, approved: ["constitution", "inexistente"] });
    expect(parseDoc(bruto)?.approved).toEqual(["constitution"]);
  });
});

describe("toMarkdown", () => {
  it("exporta as seções preenchidas com as tarefas como checklist", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "usar X", 3000);
    doc = approveStage(doc, "plan", 3000);
    doc = setStage(doc, "tasks", "## 1. Fazer A\ndetalhe\nVerificação: teste", 4000);
    doc = patchTask(doc, "t1", { status: "done" }, 5000);
    const md = toMarkdown(doc);
    expect(md).toContain("# Feature X");
    expect(md).toContain("## Constituição");
    expect(md).toContain("- [x] **1. Fazer A**");
    expect(md).toContain("Verificação: teste");
  });

  it("seção vazia não vira cabeçalho órfão", () => {
    const md = toMarkdown(emptyDoc("Vazio"));
    expect(md).toBe("# Vazio");
  });
});

describe("isStageFilled", () => {
  it("tarefas contam pela lista, não pelo texto", () => {
    let doc = ateSpec();
    doc = setStage(doc, "plan", "p", 3000);
    doc = approveStage(doc, "plan", 3000);
    expect(isStageFilled(doc, "tasks")).toBe(false);
    doc = setStage(doc, "tasks", "## 1. A\ncorpo", 4000);
    expect(isStageFilled(doc, "tasks")).toBe(true);
  });

  it("só espaço em branco não conta como preenchido", () => {
    expect(isStageFilled(setStage(emptyDoc(), "constitution", "   \n  ", 1), "constitution")).toBe(false);
  });

  it("STAGE_ORDER cobre as quatro etapas na ordem", () => {
    expect(STAGE_ORDER).toEqual(["constitution", "spec", "plan", "tasks"]);
  });
});

describe("parseTasks — variações reais de formato do modelo", () => {
  /**
   * Regressão: o parser exigia numeração OU marcador depois do `##`. Um
   * `## Título` simples fazia a lista inteira virar corpo da primeira tarefa,
   * e tarefas sumiam em silêncio.
   */
  it("cabeçalho sem numeração é uma tarefa", () => {
    const tasks = parseTasks("## Criar o endpoint\nfaça isso\n## Cobrir com teste\nfaça aquilo");
    expect(tasks.map((task) => task.title)).toEqual(["Criar o endpoint", "Cobrir com teste"]);
  });

  it("cabeçalho com negrito e numeração junta", () => {
    expect(parseTasks("## **1. Criar X**\ncorpo")[0].title).toBe("Criar X");
  });

  it("negrito sem cabeçalho não é confundido com marcador de lista", () => {
    // "**negrito**" no meio do corpo não pode abrir tarefa nova
    const tasks = parseTasks("## 1. A\numa linha com **destaque** no meio\nVerificação: v");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].detail).toContain("**destaque**");
  });

  it("cabeçalho vazio não vira tarefa fantasma", () => {
    expect(parseTasks("##\n\n## 1. Real\ncorpo").map((t) => t.title)).toEqual(["Real"]);
  });

  it("níveis diferentes de cabeçalho funcionam", () => {
    expect(parseTasks("# A\nx\n### B\ny").map((t) => t.title)).toEqual(["A", "B"]);
  });
});
