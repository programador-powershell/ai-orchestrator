import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { createIncrementalMarkdown, stableBoundary } from "./markdownStream";

describe("stableBoundary", () => {
  it("para depois do último parágrafo fechado", () => {
    const source = "Um parágrafo.\n\nOutro em construção";
    expect(source.slice(0, stableBoundary(source))).toBe("Um parágrafo.\n\n");
  });

  it("não considera nada estável sem quebra dupla", () => {
    expect(stableBoundary("ainda escrevendo a primeira linha")).toBe(0);
  });

  it("não congela dentro de cerca de código aberta", () => {
    const source = "Texto.\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    // A cerca está aberta: o estável tem de parar ANTES dela, senão a linha em
    // branco de dentro do código seria tratada como fim de bloco.
    expect(source.slice(0, stableBoundary(source))).toBe("Texto.\n\n");
  });

  it("volta a avançar quando a cerca fecha", () => {
    const source = "Texto.\n\n```ts\nconst a = 1;\n```\n\ndepois";
    expect(source.slice(0, stableBoundary(source))).toContain("```ts");
  });
});

describe("createIncrementalMarkdown", () => {
  it("produz o mesmo resultado do parse completo, token a token", () => {
    const full =
      "# Título\n\nParágrafo com **negrito**.\n\n- item um\n- item dois\n\n```ts\nconst x = 1;\n```\n\nFim.";
    const incremental = createIncrementalMarkdown();
    let acc = "";
    let last = incremental.parse("");
    for (const char of full) {
      acc += char;
      last = incremental.parse(acc);
    }
    expect(JSON.stringify(last)).toBe(JSON.stringify(parseMarkdown(full)));
  });

  it("reaproveita o prefixo: blocos fechados são as MESMAS referências", () => {
    const incremental = createIncrementalMarkdown();
    const first = incremental.parse("Fechado.\n\nabrindo");
    const second = incremental.parse("Fechado.\n\nabrindo mais texto");
    // O bloco do prefixo não foi re-parseado (mesma referência de objeto).
    expect(second[0]).toBe(first[0]);
  });

  it("invalida o cache quando o texto muda de prefixo (regenerar)", () => {
    const incremental = createIncrementalMarkdown();
    incremental.parse("Antigo.\n\ncauda");
    const novo = incremental.parse("Novo texto completamente diferente.");
    expect(JSON.stringify(novo)).toBe(JSON.stringify(parseMarkdown("Novo texto completamente diferente.")));
  });

  it("texto vazio não quebra", () => {
    expect(createIncrementalMarkdown().parse("")).toEqual([]);
  });
});
