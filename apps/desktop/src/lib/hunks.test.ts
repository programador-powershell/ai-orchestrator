import { describe, expect, it } from "vitest";
import { applySelectedHunks, splitIntoHunks } from "./hunks";

/** Caso concreto com 3 blocos de mudança separados por contexto suficiente. */
const BEFORE_3 = ["a1", "OLD1", "a2", "a3", "a4", "OLD2", "a5", "a6", "a7", "OLD3", "a8"].join("\n");
const AFTER_3 = ["a1", "NEW1", "a2", "a3", "a4", "NEW2", "a5", "a6", "a7", "NEW3", "a8"].join("\n");

describe("splitIntoHunks", () => {
  it("textos iguais não produzem hunk", () => {
    expect(splitIntoHunks("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("separa 3 mudanças em 3 hunks com header, ids e contagens", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    expect(hunks.map((hunk) => hunk.id)).toEqual(["h1", "h2", "h3"]);
    expect(hunks.map((hunk) => hunk.header)).toEqual([
      "@@ -1,3 +1,3 @@",
      "@@ -5,3 +5,3 @@",
      "@@ -9,3 +9,3 @@"
    ]);
    for (const hunk of hunks) {
      expect(hunk.added).toBe(1);
      expect(hunk.removed).toBe(1);
      expect(hunk.aCount).toBe(3);
    }
    expect(hunks[1].lines.map((line) => line.text)).toEqual(["a4", "OLD2", "NEW2", "a5"]);
    expect(hunks[1].aStart).toBe(5);
  });

  it("funde mudanças próximas num único hunk com o contexto padrão", () => {
    const before = ["x1", "OLD1", "x2", "x3", "x4", "x5", "x6", "OLD2", "x7"].join("\n");
    const after = ["x1", "NEW1", "x2", "x3", "x4", "x5", "x6", "NEW2", "x7"].join("\n");
    const hunks = splitIntoHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].added).toBe(2);
    expect(hunks[0].removed).toBe(2);
  });

  it("inserção pura vira hunk sem linhas removidas, ancorado no ponto de inserção", () => {
    const hunks = splitIntoHunks("a\nb", "a\nX\nb", { context: 0 });
    expect(hunks).toHaveLength(1);
    expect(hunks[0].aStart).toBe(2);
    expect(hunks[0].aCount).toBe(0);
    expect(hunks[0].header).toBe("@@ -2,0 +2,1 @@");
    expect(hunks[0].added).toBe(1);
    expect(hunks[0].removed).toBe(0);
  });

  it("remoção pura conta as linhas retiradas", () => {
    const hunks = splitIntoHunks("a\nb\nc", "a\nc", { context: 0 });
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removed).toBe(1);
    expect(hunks[0].added).toBe(0);
    expect(hunks[0].aStart).toBe(2);
    expect(hunks[0].aCount).toBe(1);
  });
});

describe("applySelectedHunks", () => {
  it("nenhum hunk selecionado devolve o texto original", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    expect(applySelectedHunks(BEFORE_3, hunks, [])).toBe(BEFORE_3);
  });

  it("todos os hunks selecionados reconstroem exatamente o texto novo", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    const ids = hunks.map((hunk) => hunk.id);
    expect(applySelectedHunks(BEFORE_3, hunks, ids)).toBe(AFTER_3);
  });

  it("aplicar só o 2º de 3 hunks produz exatamente o texto esperado", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    expect(applySelectedHunks(BEFORE_3, hunks, ["h2"])).toBe(
      ["a1", "OLD1", "a2", "a3", "a4", "NEW2", "a5", "a6", "a7", "OLD3", "a8"].join("\n")
    );
  });

  it("aplicar o 1º e o 3º preserva o miolo original", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    expect(applySelectedHunks(BEFORE_3, hunks, ["h3", "h1"])).toBe(
      ["a1", "NEW1", "a2", "a3", "a4", "OLD2", "a5", "a6", "a7", "NEW3", "a8"].join("\n")
    );
  });

  it("ordem dos ids e ids repetidos ou inexistentes não mudam o resultado", () => {
    const hunks = splitIntoHunks(BEFORE_3, AFTER_3, { context: 1 });
    expect(applySelectedHunks(BEFORE_3, hunks, ["h3", "h3", "h1", "hX"])).toBe(
      applySelectedHunks(BEFORE_3, hunks, ["h1", "h3"])
    );
  });

  it("aplica inserção e remoção puras", () => {
    const insert = splitIntoHunks("a\nb", "a\nX\nb", { context: 0 });
    expect(applySelectedHunks("a\nb", insert, ["h1"])).toBe("a\nX\nb");
    const remove = splitIntoHunks("a\nb\nc", "a\nc", { context: 0 });
    expect(applySelectedHunks("a\nb\nc", remove, ["h1"])).toBe("a\nc");
  });

  it("preserva quebra de linha final e linhas vazias", () => {
    const before = "um\n\ndois\n";
    const after = "um\n\nDOIS\n";
    const hunks = splitIntoHunks(before, after);
    expect(applySelectedHunks(before, hunks, hunks.map((hunk) => hunk.id))).toBe(after);
    expect(applySelectedHunks(before, hunks, [])).toBe(before);
  });

  it("arquivo inteiro substituído é um hunk só", () => {
    const before = "linha um\nlinha dois";
    const after = "outra\ncoisa\ntotal";
    const hunks = splitIntoHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(applySelectedHunks(before, hunks, ["h1"])).toBe(after);
  });
});
