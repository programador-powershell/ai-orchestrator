/**
 * A régua do Quick Open. Os casos fixam o COMPORTAMENTO que o dedo espera:
 * sigla acha camelCase, sequência vale mais que letras espalhadas, caminho
 * curto desempata — a mesma régua da referência do orquestrador.
 */
import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("sem casamento é -Infinity — o item sai da lista, não fica com nota baixa", () => {
    expect(fuzzyScore("xyz", "src/main.go")).toBe(-Infinity);
  });

  it("busca vazia é neutra (0) para preservar a ordem do índice", () => {
    expect(fuzzyScore("", "qualquer/coisa.ts")).toBe(0);
  });

  it("sigla acha fronteiras camelCase e de separador", () => {
    // "es" em EditorSurface: E no início (+4) e S na fronteira camel (+4).
    expect(fuzzyScore("es", "EditorSurface.tsx")).toBeGreaterThan(fuzzyScore("es", "testes.tsx"));
  });

  it("sequência contígua vale mais que letras espalhadas SEM fronteira", () => {
    // Nota da régua: letras espalhadas EM fronteiras (m/a/i/n) pontuam alto de
    // propósito (+4 por limite de palavra > +2 por sequência) — o caso que a
    // sequência tem de vencer é o espalhado no MEIO das palavras.
    expect(fuzzyScore("main", "main.go")).toBeGreaterThan(fuzzyScore("main", "mxaxixn.go"));
  });
});

describe("fuzzyRank", () => {
  const caminhos = [
    "src/lib/ide/ideStore.ts",
    "src/specialists/EditorSurface.tsx",
    "src/shell/rails/FilesRail.tsx",
    "README.md"
  ];

  it("ordena por pontuação e corta quem não casa", () => {
    const hits = fuzzyRank("edsur", caminhos);
    expect(hits[0]?.path).toBe("src/specialists/EditorSurface.tsx");
    expect(hits.every((hit) => hit.path !== "README.md")).toBe(true);
  });

  it("busca vazia devolve a ordem de entrada, limitada", () => {
    expect(fuzzyRank("", caminhos, 2).map((hit) => hit.path)).toEqual([
      "src/lib/ide/ideStore.ts",
      "src/specialists/EditorSurface.tsx"
    ]);
  });

  it("empate cai para o caminho mais curto — menos ruído para o mesmo acerto", () => {
    const hits = fuzzyRank("a", ["pasta/a.ts", "a.ts"]);
    expect(hits[0]?.path).toBe("a.ts");
  });

  it("respeita o limite", () => {
    expect(fuzzyRank("s", caminhos, 1)).toHaveLength(1);
  });
});
