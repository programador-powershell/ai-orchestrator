import { describe, expect, it } from "vitest";

import { allowedSources, assembleContext, isNegotiable, type Injection } from "./contextAssembly";
import { bySource, createTrajectory } from "./trajectory";

const trilha = () => createTrajectory("t1", "chat", 1_000);

const candidatos: Injection[] = [
  { source: "prompt-master", content: "Siga a política da empresa." },
  { source: "project-rules", content: "Use TypeScript." },
  { source: "memory", content: "O usuário prefere modo escuro." },
  { source: "plugins", content: "Plugin de CEP disponível." }
];

describe("allowedSources", () => {
  it("padrão deixa passar conveniência e política", () => {
    const lista = allowedSources("standard");
    expect(lista).toContain("prompt-master");
    expect(lista).toContain("memory");
    expect(lista).toContain("plugins");
  });

  it("mínimo mantém a política e corta as conveniências", () => {
    const lista = allowedSources("minimal");
    expect(lista).toContain("prompt-master");
    expect(lista).not.toContain("memory");
    expect(lista).not.toContain("project-rules");
  });
});

describe("o prompt master é inegociável", () => {
  it("nenhum modo o remove — senão trocar de modo escaparia da política", () => {
    // Se alguém mover o prompt master para as conveniências, este teste
    // quebra antes de o furo chegar em produção.
    expect(isNegotiable("prompt-master")).toBe(false);
    expect(allowedSources("minimal")).toContain("prompt-master");
  });

  it("as conveniências são negociáveis", () => {
    expect(isNegotiable("memory")).toBe(true);
    expect(isNegotiable("mentions")).toBe(true);
    expect(isNegotiable("plugins")).toBe(true);
  });
});

describe("assembleContext", () => {
  it("no padrão, tudo vira mensagem de sistema", () => {
    const resultado = assembleContext(candidatos, { mode: "standard", trajectory: trilha(), now: 1_100 });
    expect(resultado.messages).toHaveLength(4);
    expect(resultado.messages.every((message) => message.role === "system")).toBe(true);
    expect(resultado.skipped).toEqual([]);
  });

  it("no mínimo, só a política entra e o resto é declarado como barrado", () => {
    const resultado = assembleContext(candidatos, { mode: "minimal", trajectory: trilha(), now: 1_100 });
    expect(resultado.messages).toHaveLength(1);
    expect(resultado.messages[0].content).toContain("política da empresa");
    expect(resultado.skipped).toEqual(["project-rules", "memory", "plugins"]);
  });

  it("registra cada injeção na trilha, com a origem", () => {
    const resultado = assembleContext(candidatos, { mode: "standard", trajectory: trilha(), now: 1_100 });
    const fontes = bySource(resultado.trajectory).map((item) => item.source);
    expect(fontes).toContain("prompt-master");
    expect(fontes).toContain("memory");
    expect(resultado.trajectory.events).toHaveLength(4);
  });

  it("o que foi barrado não entra na trilha — ele não chegou ao modelo", () => {
    const resultado = assembleContext(candidatos, { mode: "minimal", trajectory: trilha(), now: 1_100 });
    expect(bySource(resultado.trajectory).map((item) => item.source)).toEqual(["prompt-master"]);
  });

  it("injeção vazia não vira mensagem nem evento", () => {
    const resultado = assembleContext(
      [
        { source: "memory", content: "   " },
        { source: "mentions", content: "" }
      ],
      { mode: "standard", trajectory: trilha(), now: 1_100 }
    );
    expect(resultado.messages).toEqual([]);
    expect(resultado.trajectory.events).toEqual([]);
    // Vazio não é "barrado": ele simplesmente não existia.
    expect(resultado.skipped).toEqual([]);
  });

  it("preserva a ordem em que as fontes foram oferecidas", () => {
    const resultado = assembleContext(candidatos, { mode: "standard", trajectory: trilha(), now: 1_100 });
    expect(resultado.messages[0].content).toContain("política");
    expect(resultado.messages[1].content).toContain("TypeScript");
  });

  it("não repete a mesma fonte na lista de barradas", () => {
    const resultado = assembleContext(
      [
        { source: "memory", content: "a" },
        { source: "memory", content: "b" }
      ],
      { mode: "minimal", trajectory: trilha(), now: 1_100 }
    );
    expect(resultado.skipped).toEqual(["memory"]);
  });

  it("não altera a trilha recebida", () => {
    const original = trilha();
    assembleContext(candidatos, { mode: "standard", trajectory: original, now: 1_100 });
    expect(original.events).toHaveLength(0);
  });
});
