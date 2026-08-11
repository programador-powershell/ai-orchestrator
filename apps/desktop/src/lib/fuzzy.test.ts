import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("query vazia é neutra (0)", () => {
    expect(fuzzyScore("", "qualquer/coisa.ts")).toBe(0);
  });

  it("sem subsequência → -Infinity", () => {
    expect(fuzzyScore("xyz", "abc")).toBe(-Infinity);
    expect(fuzzyScore("ba", "ab")).toBe(-Infinity);
  });

  it("qualquer subsequência casada é finita", () => {
    expect(Number.isFinite(fuzzyScore("cdv", "src/modes/CodeView.tsx"))).toBe(true);
  });

  it("é case-insensitive", () => {
    expect(fuzzyScore("codeview", "src/CodeView.tsx")).toBe(fuzzyScore("CODEVIEW", "src/CodeView.tsx"));
  });

  it("sequências consecutivas pontuam mais que espalhadas", () => {
    expect(fuzzyScore("abc", "abc")).toBeGreaterThan(fuzzyScore("abc", "a1b2c3"));
  });

  it("limites de palavra pontuam mais (separadores de caminho)", () => {
    // "cv" bate em limites de palavra em code-view; em cover o v é interno.
    expect(fuzzyScore("cv", "code-view.ts")).toBeGreaterThan(fuzzyScore("cv", "cover.ts"));
  });

  it("fronteira camelCase ganha bônus", () => {
    expect(fuzzyScore("v", "CodeView")).toBeGreaterThan(fuzzyScore("v", "codeview"));
  });

  it("alvo mais curto vence com o mesmo casamento", () => {
    expect(fuzzyScore("a.ts", "src/a.ts")).toBeGreaterThan(fuzzyScore("a.ts", "src/muito/longo/a.ts"));
  });
});

describe("fuzzyRank", () => {
  const paths = [
    "apps/desktop/src/modes/CodeView.tsx",
    "apps/desktop/src/lib/store.ts",
    "apps/desktop/src/lib/fsx.ts",
    "packages/contracts/src/index.ts"
  ];

  it("query vazia preserva a ordem e respeita o limite", () => {
    expect(fuzzyRank("", paths, 2).map((hit) => hit.path)).toEqual(paths.slice(0, 2));
  });

  it("filtra não-casados e ordena por pontuação", () => {
    const hits = fuzzyRank("codeview", paths);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("apps/desktop/src/modes/CodeView.tsx");
  });

  it("coloca o melhor casamento primeiro", () => {
    const hits = fuzzyRank("fsx", paths);
    expect(hits[0].path).toBe("apps/desktop/src/lib/fsx.ts");
  });

  it("prefere o caminho mais curto para o mesmo casamento", () => {
    const hits = fuzzyRank("x.ts", ["bb/x.ts", "b/x.ts"]);
    expect(hits[0].path).toBe("b/x.ts");
  });

  it("empate exato desempata em ordem alfabética", () => {
    const hits = fuzzyRank("x.ts", ["b/x.ts", "a/x.ts"]);
    expect(hits[0].score).toBe(hits[1].score);
    expect(hits[0].path).toBe("a/x.ts");
  });

  it("respeita o limite com query", () => {
    expect(fuzzyRank("s", paths, 2)).toHaveLength(2);
  });
});
