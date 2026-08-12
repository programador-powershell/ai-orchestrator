import { describe, expect, it } from "vitest";
import {
  buildBriefRequest,
  buildDecomposeRequest,
  buildExecuteFusionRequest,
  buildIntegrateRequest,
  buildReviewRequest,
  buildSubtaskRequest,
  fallbackSubtasks,
  fusionRolePolicy,
  parseSubtasks
} from "./fusionPrompts";

describe("fusionRolePolicy — políticas por aba", () => {
  it("security: menos salvaguarda orquestra; restrito executa (papéis invertidos)", () => {
    const policy = fusionRolePolicy("security");
    expect(policy.policy).toBe("safeguard");
    expect(policy.orchestratorRole).toContain("menos salvaguardas");
    expect(policy.orchestratorRole).toContain("PROIBIDO");
    expect(policy.orchestratorRole).toContain("entregável final");
    expect(policy.executorRole).toContain("restrito");
    expect(policy.executorRole).toContain("PROIBIDO");
  });

  it("code: inteligente orquestra (não codifica); barato executa (não decide)", () => {
    const policy = fusionRolePolicy("code");
    expect(policy.policy).toBe("cost");
    expect(policy.orchestratorRole).toContain("mais inteligente");
    expect(policy.orchestratorRole).toMatch(/PROIBIDO.*código de produção/s);
    expect(policy.executorRole).toContain("mais barato");
    expect(policy.executorRole).toMatch(/PROIBIDO.*spec/s);
  });

  it("demais abas: capacidade (planeja/integra vs produz)", () => {
    for (const mode of ["chat", "design", "data", "work", "agent", "tune"] as const) {
      expect(fusionRolePolicy(mode).policy).toBe("capability");
    }
  });
});

describe("anti-sobreposição nos prompts", () => {
  it("briefing proíbe o orquestrador de responder", () => {
    const [system] = buildBriefRequest("code", "implemente um parser");
    expect(system.content).toContain("Não responda a pergunta");
  });

  it("executor recebe a spec e a proibição de replanejar", () => {
    const [system] = buildExecuteFusionRequest("code", "SPEC X", [{ role: "user", content: "faça" }]);
    expect(system.content).toContain("SPEC X");
    expect(system.content).toContain("PROIBIDO");
  });

  it("revisão proíbe reescrever do zero", () => {
    const [system] = buildReviewRequest("security", "pergunta", "rascunho");
    expect(system.content).toContain("NÃO reescreva do zero");
  });

  it("subtarefa marca o foco exclusivo e o índice do executor", () => {
    const [system, user] = buildSubtaskRequest("chat", "pergunta geral", "foco A", 1, 3);
    expect(system.content).toContain("executor 2 de 3");
    expect(system.content).toContain("não os cubra");
    expect(user.content).toContain("SEU FOCO:\nfoco A");
  });

  it("integração proíbe reescrever as partes", () => {
    const [system, user] = buildIntegrateRequest("chat", "pergunta", [
      { focus: "a", content: "parte 1" },
      { focus: "b", content: "parte 2" }
    ]);
    expect(system.content).toContain("NÃO reescreva o conteúdo das partes");
    expect(user.content).toContain("foco: a");
    expect(user.content).toContain("parte 2");
  });
});

describe("decomposição (merge cooperativo)", () => {
  it("pede exatamente N focos mutuamente exclusivos", () => {
    const [system] = buildDecomposeRequest("chat", "tarefa", 3);
    expect(system.content).toContain("EXATAMENTE 3 focos");
    expect(system.content).toContain("MUTUAMENTE EXCLUSIVOS");
  });

  it("parseSubtasks aceita JSON cercado e corta ao nº de executores", () => {
    const text = 'aqui vai:\n```json\n["foco um", "foco dois", "foco três", "foco quatro"]\n```';
    expect(parseSubtasks(text, 3)).toEqual(["foco um", "foco dois", "foco três"]);
  });

  it("parseSubtasks rejeita malformado e vazio", () => {
    expect(parseSubtasks("sem json aqui", 2)).toBeNull();
    expect(parseSubtasks("```json\n{}\n```", 2)).toBeNull();
    expect(parseSubtasks('```json\n[]\n```', 2)).toBeNull();
    expect(parseSubtasks('```json\n[1, 2]\n```', 2)).toBeNull();
  });

  it("fallbackSubtasks gera N focos distintos contendo a pergunta", () => {
    const tasks = fallbackSubtasks("qual arquitetura usar?", 3);
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks).size).toBe(3);
    for (const task of tasks) expect(task).toContain("qual arquitetura usar?");
  });
});
