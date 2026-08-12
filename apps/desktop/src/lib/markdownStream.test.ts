import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { createIncrementalMarkdown } from "./markdownStream";

/** Equivalência: qualquer sequência de chunks tem de dar o mesmo que o parse completo. */
function streamEquals(text: string, chunkSize: number): boolean {
  const incremental = createIncrementalMarkdown();
  let out = incremental.parse("");
  for (let end = chunkSize; end < text.length; end += chunkSize) out = incremental.parse(text.slice(0, end));
  out = incremental.parse(text);
  return JSON.stringify(out) === JSON.stringify(parseMarkdown(text));
}

describe("cerca de código durante o stream", () => {
  it("linha em branco DENTRO de ``` não fecha bloco", () => {
    const text = "Texto.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nfim";
    expect(streamEquals(text, 7)).toBe(true);
  });

  it("cerca aberta no fim do stream não quebra", () => {
    const incremental = createIncrementalMarkdown();
    const partial = "Texto.\n\n```ts\nconst a = 1;";
    expect(JSON.stringify(incremental.parse(partial))).toBe(JSON.stringify(parseMarkdown(partial)));
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
