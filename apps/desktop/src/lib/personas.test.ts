import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAS,
  PERSONA_NAME_MAX,
  PERSONA_PROMPT_MAX,
  personaId,
  personaSystemMessage,
  validatePersona
} from "./personas";

describe("personaId", () => {
  it("gera slug sem acentos nem pontuação", () => {
    expect(personaId("Revisor de Código Sênior")).toBe("revisor-de-codigo-senior");
    expect(personaId("  Analista   de Dados  ")).toBe("analista-de-dados");
    expect(personaId("Redator/Técnico (v2)")).toBe("redator-tecnico-v2");
  });

  it("cai num id genérico quando o nome não tem caracteres úteis", () => {
    expect(personaId("!!!")).toBe("persona");
    expect(personaId("")).toBe("persona");
  });
});

describe("validatePersona", () => {
  it("aceita persona mínima e gera o id a partir do nome", () => {
    const result = validatePersona({ name: "Revisor de Código", systemPrompt: "Revise o diff." });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.persona).toEqual({
      id: "revisor-de-codigo",
      name: "Revisor de Código",
      description: "",
      systemPrompt: "Revise o diff."
    });
  });

  it("preserva o id informado (normalizado como slug)", () => {
    const result = validatePersona({ id: "Meu Revisor", name: "Revisor", systemPrompt: "Revise." });

    expect(result.persona?.id).toBe("meu-revisor");
  });

  it("exige nome e systemPrompt", () => {
    const result = validatePersona({ name: "   ", systemPrompt: "" });

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.persona).toBeUndefined();
  });

  it("limita o tamanho do nome e do systemPrompt", () => {
    const result = validatePersona({
      name: "n".repeat(PERSONA_NAME_MAX + 1),
      systemPrompt: "p".repeat(PERSONA_PROMPT_MAX + 1)
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.join(" ")).toContain(String(PERSONA_NAME_MAX));
    expect(result.issues.join(" ")).toContain(String(PERSONA_PROMPT_MAX));
  });

  it("aceita o limite exato", () => {
    const result = validatePersona({
      name: "n".repeat(PERSONA_NAME_MAX),
      systemPrompt: "p".repeat(PERSONA_PROMPT_MAX)
    });

    expect(result.ok).toBe(true);
  });

  it("mantém o modo válido e rejeita modo desconhecido", () => {
    const valid = validatePersona({ name: "Dados", systemPrompt: "Analise.", mode: "data" });
    expect(valid.ok).toBe(true);
    expect(valid.persona?.mode).toBe("data");

    const invalid = validatePersona({ name: "Dados", systemPrompt: "Analise.", mode: "planilha" });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.join(" ")).toContain("planilha");
  });
});

describe("personaSystemMessage", () => {
  it("entrega o prompt da persona como mensagem de sistema", () => {
    const message = personaSystemMessage({
      id: "revisor",
      name: "Revisor de Código",
      description: "Revisa PRs",
      systemPrompt: "Aponte bugs antes de estilo."
    });

    expect(message.role).toBe("system");
    expect(message.content).toContain("Revisor de Código");
    expect(message.content).toContain("Aponte bugs antes de estilo.");
  });
});

describe("DEFAULT_PERSONAS", () => {
  it("traz três personas válidas e com ids únicos", () => {
    expect(DEFAULT_PERSONAS).toHaveLength(3);
    for (const persona of DEFAULT_PERSONAS) {
      expect(validatePersona(persona).ok).toBe(true);
    }
    expect(new Set(DEFAULT_PERSONAS.map((persona) => persona.id)).size).toBe(3);
  });
});
