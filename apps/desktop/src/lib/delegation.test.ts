import { describe, expect, it } from "vitest";
import { createTree, finishTask, spawnTask, type DelegationLimits } from "./agentTree";
import {
  DELEGATE_TOOL,
  delegationInstruction,
  goalTitle,
  parseDelegateArgs,
  reportsMessage,
  rootSystemPrompt,
  subordinateSystemPrompt
} from "./delegation";

const LIMITS: DelegationLimits = { maxDepth: 2, maxChildren: 3, maxTotal: 10 };

describe("parseDelegateArgs", () => {
  it("aceita uma instrução autocontida", () => {
    const parsed = parseDelegateArgs({
      title: "Coletar dados",
      task: "Levante os números de vendas do último trimestre por região e devolva uma tabela."
    });
    expect(parsed).toEqual({
      title: "Coletar dados",
      task: "Levante os números de vendas do último trimestre por região e devolva uma tabela."
    });
  });

  it("exige a tarefa", () => {
    expect(parseDelegateArgs({ title: "x" })).toEqual({
      error: 'argumento "task" é obrigatório e deve descrever a subtarefa por completo'
    });
    expect("error" in parseDelegateArgs({ task: "   " })).toBe(true);
  });

  /**
   * O subordinado não vê a conversa do superior. "continue" chegaria sem
   * referente — recusar cedo é melhor que gastar uma chamada num prompt vazio.
   */
  it("recusa instrução curta demais para ser autocontida", () => {
    const parsed = parseDelegateArgs({ task: "continue" });
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) throw new Error("deveria recusar");
    // A recusa tem de dizer o que falta, senão o modelo repete o mesmo erro.
    expect(parsed.error).toContain("descreva o objetivo");
    expect(parsed.error).toContain("formato esperado");
  });

  it("recusa tarefa gigante", () => {
    expect("error" in parseDelegateArgs({ task: "x".repeat(9000) })).toBe(true);
  });

  it("corta título longo em vez de recusar", () => {
    const parsed = parseDelegateArgs({ title: "t".repeat(200), task: "uma tarefa suficientemente descrita aqui" });
    if ("error" in parsed) throw new Error("não deveria recusar");
    expect(parsed.title).toHaveLength(80);
  });

  it("título ausente é aceito — a árvore gera um rótulo", () => {
    const parsed = parseDelegateArgs({ task: "uma tarefa suficientemente descrita aqui" });
    if ("error" in parsed) throw new Error("não deveria recusar");
    expect(parsed.title).toBe("");
  });
});

describe("delegationInstruction", () => {
  it("no último nível PROÍBE delegar, sem ambiguidade", () => {
    const texto = delegationInstruction(LIMITS, 2);
    expect(texto).toContain("NÃO pode acionar outros agentes");
    expect(texto).not.toContain(DELEGATE_TOOL);
  });

  it("nos níveis acima diz quantos agentes e quantos níveis restam", () => {
    const texto = delegationInstruction(LIMITS, 1);
    expect(texto).toContain(DELEGATE_TOOL);
    expect(texto).toContain("até 3 agentes");
    expect(texto).toContain("mais 1 nível(is)");
  });

  /** Sem isto o modelo delega por reflexo e cada trivialidade vira gasto. */
  it("ensina quando NÃO delegar", () => {
    const texto = delegationInstruction(LIMITS, 0);
    expect(texto).toContain("Delegue apenas quando a parte for substancial e independente");
    expect(texto).toContain("mais barato se você fizer direto");
  });

  it("avisa que o subordinado não vê a conversa", () => {
    expect(delegationInstruction(LIMITS, 0)).toContain("NÃO vê esta conversa");
  });
});

describe("prompts", () => {
  it("raiz carrega o objetivo e pede resultado, não plano", () => {
    const texto = rootSystemPrompt("Fechar o relatório trimestral", LIMITS);
    expect(texto).toContain("Fechar o relatório trimestral");
    expect(texto).toContain("não com um plano do que faria");
  });

  it("subordinado recebe a linhagem e a própria tarefa", () => {
    let tree = createTree("Raiz", "objetivo", 1000);
    tree = spawnTask(tree, "a1", { title: "Coletar", prompt: "levante os números" }, 2000).state;
    const texto = subordinateSystemPrompt(tree, tree.tasks.a2, LIMITS);
    expect(texto).toContain("Raiz → Coletar");
    expect(texto).toContain("levante os números");
    // O texto final dele VIRA o relatório — precisa saber disso.
    expect(texto).toContain("vira o relatório entregue ao seu superior");
  });
});

describe("reportsMessage", () => {
  function arvoreComFilhos() {
    let tree = createTree("Raiz", "objetivo", 1000);
    tree = spawnTask(tree, "a1", { title: "Coletar", prompt: "x" }, 2000).state;
    tree = spawnTask(tree, "a1", { title: "Revisar", prompt: "y" }, 2000).state;
    return tree;
  }

  it("junta os relatórios concluídos", () => {
    let tree = arvoreComFilhos();
    tree = finishTask(tree, "a2", "done", "vendas subiram 12%", 3000);
    tree = finishTask(tree, "a3", "done", "sem inconsistências", 3000);
    const texto = reportsMessage(tree, "a1");
    expect(texto).toContain("### Coletar");
    expect(texto).toContain("vendas subiram 12%");
    expect(texto).toContain("### Revisar");
    expect(texto).toContain("Sintetize o resultado final");
  });

  /** A separação que impede "o provedor caiu" de virar um achado. */
  it("separa falha de resultado, com aviso explícito", () => {
    let tree = arvoreComFilhos();
    tree = finishTask(tree, "a2", "done", "vendas subiram 12%", 3000);
    tree = finishTask(tree, "a3", "failed", "provedor indisponível", 3000);
    const texto = reportsMessage(tree, "a1");
    expect(texto).toContain("vendas subiram 12%");
    expect(texto).toContain("NÃO foram concluídas");
    expect(texto).toContain("informação ausente, não como resultado");
    expect(texto).toContain("provedor indisponível");
  });

  it("sem nenhum retorno manda o superior fazer sozinho", () => {
    const tree = arvoreComFilhos();
    expect(reportsMessage(tree, "a1")).toContain("Conclua a tarefa você mesmo");
  });

  it("cancelado conta como não concluído", () => {
    let tree = arvoreComFilhos();
    tree = finishTask(tree, "a2", "cancelled", "execução interrompida", 3000);
    tree = finishTask(tree, "a3", "cancelled", "execução interrompida", 3000);
    const texto = reportsMessage(tree, "a1");
    expect(texto).toContain("NÃO foram concluídas");
  });
});

describe("goalTitle", () => {
  it("resume e normaliza espaços", () => {
    expect(goalTitle("  fechar   o  relatório ")).toBe("fechar o relatório");
    expect(goalTitle("x".repeat(100))).toHaveLength(58);
    expect(goalTitle("")).toBe("Objetivo");
  });
});
