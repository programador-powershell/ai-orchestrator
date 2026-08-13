import { describe, expect, it } from "vitest";

import {
  classifyComplexity,
  pendingWaves,
  planCrew,
  ROLE_STAGE,
  rosterLine,
  summarizeCrew,
  type CrewMember,
  type ModelsByRole
} from "./agentCrew";

const models: ModelsByRole = {
  fallback: "sonnet 5",
  byRole: { idea: "opus 5", scope: "sonnet 5", code: "kimi 3", review: "kimi 3" }
};

const membro = (id: string, over: Partial<CrewMember> = {}): CrewMember => ({
  id,
  role: "code",
  model: "kimi 3",
  wave: 0,
  status: "done",
  activity: "",
  startedAt: 0,
  ...over
});

describe("classifyComplexity", () => {
  it("trata uma frase curta e localizada como trivial", () => {
    expect(classifyComplexity("corrigir o typo do botão").complexity).toBe("trivial");
  });

  it("trata um pedido de uma linha sem sinais como simples", () => {
    expect(classifyComplexity("adicionar um endpoint de listagem de clientes").complexity).toBe("simples");
  });

  it("sobe para média quando o pedido menciona escopo amplo", () => {
    expect(classifyComplexity("criar o módulo de faturamento com integração ao ERP").complexity).toBe("media");
  });

  it("chega em alta com vários sinais somados", () => {
    const verdict = classifyComplexity(
      "criar a plataforma de cobrança do zero, com autenticação, banco de dados e migração dos contratos existentes"
    );
    expect(verdict.complexity).toBe("alta");
    expect(verdict.score).toBeGreaterThanOrEqual(4);
  });

  it("conta itens de lista como entregas somadas", () => {
    const verdict = classifyComplexity("Fazer:\n- tela de login\n- tela de senha\n- e-mail de recuperação");
    expect(verdict.signals.some((signal) => signal.reason.includes("itens listados"))).toBe(true);
  });

  it("explica cada sinal, para a decisão não ser opaca", () => {
    const verdict = classifyComplexity("refatorar a arquitetura do sistema");
    expect(verdict.signals.length).toBeGreaterThan(0);
    for (const signal of verdict.signals) expect(signal.reason.length).toBeGreaterThan(3);
  });

  it("é determinística: o mesmo pedido dá sempre a mesma equipe", () => {
    const goal = "criar o módulo de relatórios com exportação";
    expect(classifyComplexity(goal)).toEqual(classifyComplexity(goal));
  });

  it("objetivo vazio não escala equipe nenhuma", () => {
    const verdict = classifyComplexity("   ");
    expect(verdict.complexity).toBe("trivial");
    expect(verdict.signals).toEqual([]);
  });
});

describe("planCrew", () => {
  it("pula constituição e spec no trivial — cerimônia demais faz abandonar o fluxo", () => {
    const plan = planCrew(classifyComplexity("corrigir o typo do botão"), models);
    expect(plan.slots.map((slot) => slot.role)).toEqual(["code", "review"]);
  });

  it("monta a espinha spec-driven completa na complexidade alta", () => {
    const plan = planCrew(
      classifyComplexity("criar a plataforma de cobrança do zero, com autenticação, banco de dados e migração"),
      models
    );
    expect(plan.slots.map((slot) => slot.role)).toEqual([
      "idea",
      "scope",
      "plan",
      "code",
      "code",
      "code",
      "review",
      "ci"
    ]);
  });

  it("põe os programadores todos na MESMA onda — é o que os faz paralelos", () => {
    const plan = planCrew(classifyComplexity("criar o módulo de faturamento com integração"), models);
    const coders = plan.slots.filter((slot) => slot.role === "code");
    expect(coders).toHaveLength(2);
    expect(new Set(coders.map((slot) => slot.wave)).size).toBe(1);
  });

  it("dá a cada papel o modelo definido para ele", () => {
    const plan = planCrew(classifyComplexity("criar o módulo de faturamento com integração"), models);
    const porPapel = Object.fromEntries(plan.slots.map((slot) => [slot.role, slot.model]));
    expect(porPapel.idea).toBe("opus 5");
    expect(porPapel.scope).toBe("sonnet 5");
    expect(porPapel.code).toBe("kimi 3");
  });

  it("usa o fallback para o papel sem modelo próprio", () => {
    const plan = planCrew(classifyComplexity("criar o módulo de faturamento com integração"), {
      fallback: "haiku 4.5"
    });
    expect(plan.slots.every((slot) => slot.model === "haiku 4.5" || slot.model === "Ship")).toBe(true);
  });

  it("o CI não é um modelo — aparece como Ship", () => {
    const plan = planCrew(
      classifyComplexity("criar a plataforma de cobrança do zero, com autenticação, banco de dados e migração"),
      models
    );
    expect(plan.slots.find((slot) => slot.role === "ci")?.model).toBe("Ship");
  });

  it("gera ids estáveis e distintos para os programadores", () => {
    const plan = planCrew(classifyComplexity("criar o módulo de faturamento com integração"), models);
    const ids = plan.slots.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("code#1");
    expect(ids).toContain("code#2");
  });

  it("ondas são crescentes e sem buraco", () => {
    const plan = planCrew(
      classifyComplexity("criar a plataforma de cobrança do zero, com autenticação, banco de dados e migração"),
      models
    );
    const ondas = [...new Set(plan.slots.map((slot) => slot.wave))].sort((a, b) => a - b);
    expect(ondas).toEqual(ondas.map((_, index) => index));
  });

  it("aceita o objetivo direto, sem classificar antes", () => {
    expect(planCrew("corrigir o typo do botão", models).complexity).toBe("trivial");
  });
});

describe("ROLE_STAGE", () => {
  it("liga os papéis à espinha spec-driven", () => {
    expect(ROLE_STAGE.idea).toBe("constitution");
    expect(ROLE_STAGE.scope).toBe("spec");
    expect(ROLE_STAGE.plan).toBe("plan");
    expect(ROLE_STAGE.code).toBe("tasks");
  });

  it("revisão e CI ficam fora da espinha", () => {
    expect(ROLE_STAGE.review).toBeNull();
    expect(ROLE_STAGE.ci).toBeNull();
  });
});

describe("rosterLine", () => {
  it("mostra modelo e papel, como pedido", () => {
    expect(rosterLine(membro("code#1"))).toBe("kimi 3 - code");
    expect(rosterLine(membro("idea#1", { role: "idea", model: "opus 5" }))).toBe("opus 5 - idea");
    expect(rosterLine(membro("ci#1", { role: "ci", model: "Ship" }))).toBe("Ship - CI");
  });
});

describe("pendingWaves", () => {
  it("não libera a onda seguinte enquanto um paralelo não termina", () => {
    const plan = planCrew(classifyComplexity("criar o módulo de faturamento com integração"), models);
    const codeWave = plan.slots.find((slot) => slot.role === "code")!.wave;
    const crew = plan.slots
      .filter((slot) => slot.wave < codeWave)
      .map((slot) => membro(slot.id, { role: slot.role, wave: slot.wave }));
    // Só o primeiro programador terminou.
    crew.push(membro("code#1", { wave: codeWave }));
    crew.push(membro("code#2", { wave: codeWave, status: "working" }));
    expect(pendingWaves(plan, crew)).toContain(codeWave);
  });

  it("fica vazio quando a equipe inteira terminou", () => {
    const plan = planCrew(classifyComplexity("corrigir o typo do botão"), models);
    const crew = plan.slots.map((slot) => membro(slot.id, { role: slot.role, wave: slot.wave }));
    expect(pendingWaves(plan, crew)).toEqual([]);
  });

  it("lista tudo quando ninguém foi contratado ainda", () => {
    const plan = planCrew(classifyComplexity("corrigir o typo do botão"), models);
    expect(pendingWaves(plan, [])).toEqual([0, 1]);
  });
});

describe("summarizeCrew", () => {
  it("conta contratado e trabalhando como em atividade", () => {
    const crew = [
      membro("a", { status: "hired" }),
      membro("b", { status: "working" }),
      membro("c", { status: "done" }),
      membro("d", { status: "failed" })
    ];
    expect(summarizeCrew(crew)).toEqual({ total: 4, working: 2, done: 1, failed: 1 });
  });
});
