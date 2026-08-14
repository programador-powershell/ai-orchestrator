import { describe, expect, it } from "vitest";
import type { BootstrapPolicy } from "@multiplike/contracts";
import { clampEffort, effectiveAgentTools, effectiveApproval, effectiveModes, promptMasterMessages, safeMode } from "./policy";

const policy = (patch: Partial<BootstrapPolicy> = {}): BootstrapPolicy => ({
  allowedModes: ["chat", "code"],
  agentTools: true,
  approvalPolicy: "ask",
  byokAllowed: false,
  localRuntimeAllowed: false,
  effortMax: 4,
  promptMaster: null,
  offlineGraceHours: 72,
  ...patch
});

describe("effectiveModes", () => {
  it("sem política vale a preferência local — comportamento de hoje", () => {
    expect(effectiveModes(null, ["chat", "code", "office"])).toEqual(["chat", "code", "office"]);
  });

  it("com política é a interseção, na ordem canônica das abas", () => {
    expect(effectiveModes(["code", "chat"], ["office", "code", "chat"])).toEqual(["chat", "code"]);
  });

  it("aba que o usuário ocultou continua oculta mesmo liberada", () => {
    expect(effectiveModes(["chat", "code"], ["chat"])).toEqual(["chat"]);
  });

  it("política vazia devolve vazio — não inventamos aba", () => {
    expect(effectiveModes([], ["chat", "code"])).toEqual([]);
  });
});

describe("safeMode", () => {
  it("mantém o modo atual quando permitido", () => {
    expect(safeMode("code", ["chat", "code"])).toBe("code");
  });

  it("modo bloqueado cai para a primeira aba permitida — no RENDER, não em efeito", () => {
    expect(safeMode("tune", ["chat", "code"])).toBe("chat");
  });

  it("nenhuma aba permitida devolve null: quem chama mostra o aviso", () => {
    expect(safeMode("chat", [])).toBeNull();
  });
});

describe("clampEffort", () => {
  it("o teto do grupo limita o slider", () => {
    expect(clampEffort(4, policy({ effortMax: 2 }))).toBe(2);
    expect(clampEffort(1, policy({ effortMax: 2 }))).toBe(1);
    expect(clampEffort(4, null)).toBe(4);
  });
});

describe("effectiveApproval / effectiveAgentTools", () => {
  it("com política presente o servidor manda, sempre", () => {
    expect(effectiveApproval(policy({ approvalPolicy: "edits" }), "all")).toBe("edits");
    expect(effectiveAgentTools(policy({ agentTools: false }), true)).toBe(false);
  });

  it("sem política vale o local", () => {
    expect(effectiveApproval(null, "all")).toBe("all");
    expect(effectiveApproval(null, undefined)).toBe("ask");
    expect(effectiveAgentTools(null, true)).toBe(true);
  });
});

describe("promptMasterMessages", () => {
  const withMaster = policy({
    promptMaster: { content: "Regra da empresa.", allowLocalAppend: true, localMaxChars: 20, version: 1 }
  });

  it("servidor primeiro, local depois — e o local declara a precedência", () => {
    const messages = promptMasterMessages(withMaster, "minha regra");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Regra da empresa.");
    expect(messages[1].content).toContain("prevalecem");
    expect(messages[1].content).toContain("minha regra");
  });

  it("allowLocalAppend=false descarta o prompt local", () => {
    const blocked = policy({
      promptMaster: { content: "Regra.", allowLocalAppend: false, localMaxChars: 20, version: 1 }
    });
    expect(promptMasterMessages(blocked, "minha regra")).toHaveLength(1);
  });

  it("o teto de caracteres corta o local com aviso explícito", () => {
    const messages = promptMasterMessages(withMaster, "x".repeat(200));
    expect(messages[1].content).toContain("truncado");
    expect(messages[1].content.length).toBeLessThan(300);
  });

  it("sem política o prompt local vale sozinho, sem prefixo", () => {
    const messages = promptMasterMessages(null, "minha regra");
    expect(messages).toEqual([{ role: "system", content: "minha regra" }]);
  });

  it("nada configurado, nada emitido", () => {
    expect(promptMasterMessages(null, "  ")).toEqual([]);
    expect(promptMasterMessages(policy(), "")).toEqual([]);
  });
});
