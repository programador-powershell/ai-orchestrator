/**
 * Os comandos de barra viram prompt completo NO CLIENTE — e só os conhecidos.
 * O caso que não pode regredir: `/mode` tem de passar intacto, porque ele é
 * verbo do gateway e expandi-lo aqui roubaria a troca de modo do supervisor.
 */

import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, expandSlashCommand } from "./slashCommands";

describe("expandSlashCommand", () => {
  it("expande /review, /explain e /testgen em prompts completos", () => {
    for (const command of ["/review", "/explain", "/testgen"]) {
      const out = expandSlashCommand(command);
      expect(out).not.toBe(command);
      expect(out.length).toBeGreaterThan(80);
      expect(out.startsWith("/")).toBe(false);
    }
  });

  it("carrega o alvo digitado depois do comando para dentro do prompt", () => {
    const out = expandSlashCommand("/review o arquivo transport.ts");
    expect(out).toContain("o arquivo transport.ts");
  });

  it("aceita o comando em qualquer caixa", () => {
    expect(expandSlashCommand("/REVIEW x")).toContain("revisão de código");
  });

  it("deixa passar intacto o que não conhece — inclusive /mode", () => {
    expect(expandSlashCommand("/mode code")).toBe("/mode code");
    expect(expandSlashCommand("/naoexiste alguma coisa")).toBe("/naoexiste alguma coisa");
    expect(expandSlashCommand("texto normal sem comando")).toBe("texto normal sem comando");
    expect(expandSlashCommand("")).toBe("");
  });

  it("o mapa não contém /mode — a regra mora na estrutura, não num if", () => {
    expect(Object.keys(SLASH_COMMANDS)).not.toContain("/mode");
  });
});
