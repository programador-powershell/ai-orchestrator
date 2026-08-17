import { describe, expect, it } from "vitest";
import { DEFAULT_COMMANDS, expandCommand, parseCommandName } from "./commands";

describe("parseCommandName", () => {
  it("extrai o nome do comando de uma entrada com barra", () => {
    expect(parseCommandName("/review src/app.ts")).toBe("review");
    expect(parseCommandName("/testgen")).toBe("testgen");
  });

  it("retorna null quando não é comando", () => {
    expect(parseCommandName("explique este código")).toBeNull();
    expect(parseCommandName("")).toBeNull();
    expect(parseCommandName("/")).toBeNull();
  });
});

describe("expandCommand", () => {
  const commands = {
    review: { description: "Revisa código", template: "Revise o seguinte e aponte problemas:\n\n$ARGS" },
    saudar: { description: "Saúda", template: "Olá, $NOME! Bem-vindo ao $LUGAR." }
  };

  it("expande $ARGS com todo o texto após o nome do comando", () => {
    expect(expandCommand("/review função foo()", commands)).toBe(
      "Revise o seguinte e aponte problemas:\n\nfunção foo()"
    );
  });

  it("expande variáveis nomeadas na ordem dos argumentos", () => {
    expect(expandCommand("/saudar Ana Orchestrator", commands)).toBe("Olá, Ana! Bem-vindo ao Orchestrator.");
  });

  it("nome herdado do protótipo não vira comando", () => {
    // "/toString" devolvia Object.prototype.toString: passava pelo `if
    // (!command)` e estourava TypeError no `.template` ANTES do try do envio,
    // então a mensagem simplesmente não era enviada e nada aparecia na tela.
    for (const herdado of ["/toString x", "/valueOf", "/constructor a", "/hasOwnProperty b"]) {
      expect(expandCommand(herdado, commands)).toBeNull();
    }
  });

  it("deixa variável sem argumento como string vazia", () => {
    expect(expandCommand("/saudar Ana", commands)).toBe("Olá, Ana! Bem-vindo ao .");
  });

  it("retorna null para entrada que não é comando ou comando desconhecido", () => {
    expect(expandCommand("texto comum", commands)).toBeNull();
    expect(expandCommand("/inexistente x", commands)).toBeNull();
  });

  it("o catálogo padrão inclui review, explain e testgen", () => {
    expect(Object.keys(DEFAULT_COMMANDS)).toEqual(expect.arrayContaining(["review", "explain", "testgen"]));
    expect(expandCommand("/explain const x = 1", DEFAULT_COMMANDS)).toContain("const x = 1");
  });
});
