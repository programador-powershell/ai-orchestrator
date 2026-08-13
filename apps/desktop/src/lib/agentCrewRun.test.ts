import { describe, expect, it, vi } from "vitest";

import { classifyComplexity, type CrewMember, type ModelsByRole } from "./agentCrew";
import { runCrew, type CrewCall, type CrewHooks } from "./agentCrewRun";

const models: ModelsByRole = {
  fallback: "sonnet 5",
  byRole: { idea: "opus 5", scope: "sonnet 5", code: "kimi 3", review: "kimi 3" }
};

const TRIVIAL = "corrigir o typo do botão";
const MEDIA = "criar o módulo de faturamento com integração ao ERP";

function recorder() {
  const hired: CrewMember[] = [];
  const fired: Array<{ id: string; status: string; output: string }> = [];
  const waves: Array<{ wave: number; outputs: string[] }> = [];
  const hooks: CrewHooks = {
    onHire: (member) => hired.push({ ...member }),
    onActivity: () => undefined,
    onFire: (id, status, output) => fired.push({ id, status, output }),
    onWave: (wave, outputs) => waves.push({ wave, outputs })
  };
  return { hired, fired, waves, hooks };
}

const echo: CrewCall = async ({ member }) => `entrega de ${member.id}`;

describe("runCrew", () => {
  it("contrata na ordem das ondas e demite cada um ao terminar", async () => {
    const { hired, fired, hooks } = recorder();
    const result = await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal
    });
    expect(hired.map((member) => member.id)).toEqual(["code#1", "review#1"]);
    expect(fired.map((entry) => entry.status)).toEqual(["done", "done"]);
    expect(result.cancelled).toBe(false);
  });

  it("roda os programadores da mesma onda em PARALELO", async () => {
    const { hooks } = recorder();
    let emVoo = 0;
    let pico = 0;
    const call: CrewCall = async ({ member }) => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
      return `ok ${member.id}`;
    };
    await runCrew({ goal: MEDIA, models, call, hooks, signal: new AbortController().signal });
    expect(pico).toBe(2);
  });

  it("só libera a revisão depois que TODOS os programadores terminam", async () => {
    const ordem: string[] = [];
    const { hooks } = recorder();
    const call: CrewCall = async ({ member }) => {
      // O programador 1 é lento de propósito: se a revisão começasse ao
      // primeiro que termina, ela revisaria metade do trabalho.
      if (member.id === "code#1") await new Promise((resolve) => setTimeout(resolve, 20));
      ordem.push(member.id);
      return `ok ${member.id}`;
    };
    await runCrew({ goal: MEDIA, models, call, hooks, signal: new AbortController().signal });
    expect(ordem.indexOf("review#1")).toBeGreaterThan(ordem.indexOf("code#1"));
    expect(ordem.indexOf("review#1")).toBeGreaterThan(ordem.indexOf("code#2"));
  });

  it("entrega a cada papel o objetivo e o que as ondas anteriores produziram", async () => {
    const { hooks } = recorder();
    const prompts: Record<string, string> = {};
    const call: CrewCall = async ({ member, user }) => {
      prompts[member.id] = user;
      return `entrega de ${member.id}`;
    };
    await runCrew({ goal: TRIVIAL, models, call, hooks, signal: new AbortController().signal });
    expect(prompts["code#1"]).toContain(TRIVIAL);
    expect(prompts["code#1"]).not.toContain("ENTREGAS ANTERIORES");
    expect(prompts["review#1"]).toContain("ENTREGAS ANTERIORES");
    expect(prompts["review#1"]).toContain("entrega de code#1");
  });

  it("passa as correções da pessoa para todos os papéis", async () => {
    const { hooks } = recorder();
    const prompts: string[] = [];
    const call: CrewCall = async ({ user }) => {
      prompts.push(user);
      return "ok";
    };
    await runCrew({
      goal: TRIVIAL,
      corrections: "usar o rótulo em maiúsculas",
      models,
      call,
      hooks,
      signal: new AbortController().signal
    });
    expect(prompts.every((prompt) => prompt.includes("usar o rótulo em maiúsculas"))).toBe(true);
  });

  it("dá fatias diferentes a cada programador em paralelo", async () => {
    const { hooks } = recorder();
    const systems: Record<string, string> = {};
    const call: CrewCall = async ({ member, system }) => {
      systems[member.id] = system;
      return "ok";
    };
    await runCrew({ goal: MEDIA, models, call, hooks, signal: new AbortController().signal });
    expect(systems["code#1"]).toContain("programador 1 de 2");
    expect(systems["code#2"]).toContain("programador 2 de 2");
    expect(systems["code#1"]).not.toBe(systems["code#2"]);
  });

  it("não fatia quando há um programador só", async () => {
    const { hooks } = recorder();
    const systems: string[] = [];
    const call: CrewCall = async ({ system }) => {
      systems.push(system);
      return "ok";
    };
    await runCrew({ goal: TRIVIAL, models, call, hooks, signal: new AbortController().signal });
    expect(systems.some((system) => system.includes("programador 1 de"))).toBe(false);
  });

  it("um agente que falha é demitido como falho e não derruba a onda", async () => {
    const { fired, hooks } = recorder();
    const call: CrewCall = async ({ member }) => {
      if (member.id === "code#1") throw new Error("modelo indisponível");
      return `ok ${member.id}`;
    };
    const result = await runCrew({ goal: MEDIA, models, call, hooks, signal: new AbortController().signal });
    const falho = fired.find((entry) => entry.id === "code#1");
    expect(falho?.status).toBe("failed");
    expect(falho?.output).toContain("modelo indisponível");
    // O outro programador entregou, então a execução segue.
    expect(result.outputs.some((entry) => entry.text.includes("code#2"))).toBe(true);
  });

  it("para quando a onda inteira falha — construir sobre o vazio não ajuda", async () => {
    const { hired, hooks } = recorder();
    const call: CrewCall = async () => {
      throw new Error("gateway fora");
    };
    await runCrew({ goal: MEDIA, models, call, hooks, signal: new AbortController().signal });
    // Contratou só a primeira onda (scope), não a equipe inteira.
    expect(hired.map((member) => member.role)).toEqual(["idea"]);
  });

  it("resposta vazia conta como falha, não como entrega", async () => {
    const { fired, hooks } = recorder();
    const call: CrewCall = async () => "   ";
    await runCrew({ goal: TRIVIAL, models, call, hooks, signal: new AbortController().signal });
    expect(fired[0].status).toBe("failed");
  });

  it("cancelamento interrompe antes da próxima onda", async () => {
    const controller = new AbortController();
    const { hired, hooks } = recorder();
    const call: CrewCall = async ({ member }) => {
      controller.abort();
      return `ok ${member.id}`;
    };
    const result = await runCrew({
      goal: MEDIA,
      models,
      call,
      hooks,
      signal: controller.signal
    });
    expect(result.cancelled).toBe(true);
    expect(hired).toHaveLength(1);
  });

  it("sinal já abortado não chega a contratar ninguém", async () => {
    const controller = new AbortController();
    controller.abort();
    const { hired, fired, hooks } = recorder();
    const call = vi.fn(echo);
    await runCrew({ goal: TRIVIAL, models, call, hooks, signal: controller.signal });
    expect(call).not.toHaveBeenCalled();
    expect(hired).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("anuncia cada onda concluída com o que ela produziu", async () => {
    const { waves, hooks } = recorder();
    await runCrew({ goal: MEDIA, models, call: echo, hooks, signal: new AbortController().signal });
    const ondaDoCode = waves.find((entry) => entry.outputs.length === 2);
    expect(ondaDoCode?.outputs).toEqual(["entrega de code#1", "entrega de code#2"]);
  });

  it("registra as entregas com a etapa spec-driven correspondente", async () => {
    const { hooks } = recorder();
    const result = await runCrew({ goal: MEDIA, models, call: echo, hooks, signal: new AbortController().signal });
    const etapas = result.outputs.map((entry) => entry.stage);
    expect(etapas).toContain("constitution");
    expect(etapas).toContain("spec");
    expect(etapas).toContain("plan");
    expect(etapas).toContain("tasks");
  });

  it("quem decide a equipe é o ORQUESTRADOR, não a heurística", async () => {
    const { hired, hooks } = recorder();
    // O pedido é trivial pela heurística; o orquestrador diz que é alta.
    const resultado = await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal,
      orchestrate: async () => '{"complexity":"alta","reason":"toca o faturamento inteiro"}'
    });
    expect(resultado.decision.by).toBe("orchestrator");
    expect(resultado.decision.reason).toContain("faturamento");
    expect(hired.map((member) => member.role)).toContain("ci");
  });

  it("o pedido do orquestrador leva o objetivo", async () => {
    const { hooks } = recorder();
    let recebido = "";
    await runCrew({
      goal: MEDIA,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal,
      orchestrate: async ({ user }) => {
        recebido = user;
        return '{"complexity":"simples"}';
      }
    });
    expect(recebido).toContain(MEDIA);
  });

  it("orquestrador ilegível cai na reserva, e a decisão DIZ que caiu", async () => {
    const { hooks } = recorder();
    const resultado = await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal,
      orchestrate: async () => "acho que é simples, mas depende"
    });
    expect(resultado.decision.by).toBe("heuristic");
    expect(resultado.decision.reason).toContain("formato");
    // E a execução acontece: não rodar por falta de classificação seria pior.
    expect(resultado.plan.slots.length).toBeGreaterThan(0);
  });

  it("orquestrador que falha não derruba a execução", async () => {
    const { hooks } = recorder();
    const resultado = await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal,
      orchestrate: async () => {
        throw new Error("gateway fora");
      }
    });
    expect(resultado.decision.by).toBe("heuristic");
    expect(resultado.decision.reason).toContain("gateway fora");
    expect(resultado.outputs.length).toBeGreaterThan(0);
  });

  it("sem orquestrador, a reserva assume e declara", async () => {
    const { hooks } = recorder();
    const resultado = await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal
    });
    expect(resultado.decision).toEqual({ by: "heuristic", reason: "sem orquestrador disponível" });
  });

  it("a equipe é anunciada ANTES da primeira contratação", async () => {
    const eventos: string[] = [];
    const hooks: CrewHooks = {
      onHire: (member) => eventos.push(`hire:${member.id}`),
      onActivity: () => undefined,
      onFire: () => undefined,
      onPlan: (plan) => eventos.push(`plan:${plan.slots.length}`)
    };
    await runCrew({
      goal: TRIVIAL,
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal,
      orchestrate: async () => '{"complexity":"trivial"}'
    });
    expect(eventos[0]).toBe("plan:2");
    expect(eventos[1]).toBe("hire:code#1");
  });

  it("aceita a complexidade forçada pela pessoa", async () => {
    const { hired, hooks } = recorder();
    await runCrew({
      goal: TRIVIAL,
      verdict: classifyComplexity("criar a plataforma do zero com autenticação, banco de dados e migração"),
      models,
      call: echo,
      hooks,
      signal: new AbortController().signal
    });
    expect(hired.map((member) => member.role)).toContain("ci");
  });

  it("respeita o teto de agentes simultâneos", async () => {
    const { hooks } = recorder();
    let emVoo = 0;
    let pico = 0;
    const call: CrewCall = async () => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
      return "ok";
    };
    await runCrew({
      goal: MEDIA,
      models,
      call,
      hooks,
      maxParallel: 1,
      signal: new AbortController().signal
    });
    expect(pico).toBe(1);
  });
});
