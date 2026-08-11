import { describe, expect, it } from "vitest";
import { computeDiff, diffStats, toHunks } from "./diff";

describe("computeDiff", () => {
  it("textos iguais produzem apenas contexto com números pareados", () => {
    const lines = computeDiff("a\nb\nc", "a\nb\nc");
    expect(lines).toEqual([
      { type: "context", text: "a", aLine: 1, bLine: 1 },
      { type: "context", text: "b", aLine: 2, bLine: 2 },
      { type: "context", text: "c", aLine: 3, bLine: 3 }
    ]);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("detecta inserção no meio", () => {
    const lines = computeDiff("um\ndois", "um\nnovo\ndois");
    expect(lines).toEqual([
      { type: "context", text: "um", aLine: 1, bLine: 1 },
      { type: "add", text: "novo", bLine: 2 },
      { type: "context", text: "dois", aLine: 2, bLine: 3 }
    ]);
  });

  it("detecta remoção no meio", () => {
    const lines = computeDiff("um\nvelho\ndois", "um\ndois");
    expect(lines).toEqual([
      { type: "context", text: "um", aLine: 1, bLine: 1 },
      { type: "remove", text: "velho", aLine: 2 },
      { type: "context", text: "dois", aLine: 3, bLine: 2 }
    ]);
  });

  it("detecta troca como remove + add", () => {
    const lines = computeDiff("um\nantigo\ndois", "um\nnovo\ndois");
    expect(lines).toEqual([
      { type: "context", text: "um", aLine: 1, bLine: 1 },
      { type: "remove", text: "antigo", aLine: 2 },
      { type: "add", text: "novo", bLine: 2 },
      { type: "context", text: "dois", aLine: 3, bLine: 3 }
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("preserva o LCS quando há linhas em comum fora de ordem", () => {
    const lines = computeDiff("a\nb\nc", "c\nb\na");
    // LCS tem tamanho 1 → 2 removes e 2 adds.
    expect(diffStats(lines)).toEqual({ added: 2, removed: 2 });
    expect(lines.filter((line) => line.type === "context")).toHaveLength(1);
  });

  it("lida com inserção no fim e no começo", () => {
    expect(computeDiff("a", "a\nb")).toEqual([
      { type: "context", text: "a", aLine: 1, bLine: 1 },
      { type: "add", text: "b", bLine: 2 }
    ]);
    expect(computeDiff("a", "b\na")).toEqual([
      { type: "add", text: "b", bLine: 1 },
      { type: "context", text: "a", aLine: 1, bLine: 2 }
    ]);
  });

  it("arquivo vazio → tudo add; conteúdo apagado → remove + linha vazia", () => {
    const added = computeDiff("", "x\ny");
    expect(diffStats(added)).toEqual({ added: 2, removed: 1 });
    const removed = computeDiff("x\ny", "");
    expect(diffStats(removed)).toEqual({ added: 1, removed: 2 });
  });

  it("fallback acima de maxArea vira substituição em bloco com números corretos", () => {
    const lines = computeDiff("k\na\nb\nk2", "k\nc\nd\nk2", { maxArea: 0 });
    expect(lines).toEqual([
      { type: "context", text: "k", aLine: 1, bLine: 1 },
      { type: "remove", text: "a", aLine: 2 },
      { type: "remove", text: "b", aLine: 3 },
      { type: "add", text: "c", bLine: 2 },
      { type: "add", text: "d", bLine: 3 },
      { type: "context", text: "k2", aLine: 4, bLine: 4 }
    ]);
  });
});

describe("toHunks", () => {
  it("colapsa contexto longe das mudanças e mantém a vizinhança", () => {
    const lines = computeDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\nX\n6\n7\n8\n9");
    const hunks = toHunks(lines, 2);
    expect(hunks).toEqual([
      { type: "skip", count: 2 },
      { type: "context", text: "3", aLine: 3, bLine: 3 },
      { type: "context", text: "4", aLine: 4, bLine: 4 },
      { type: "remove", text: "5", aLine: 5 },
      { type: "add", text: "X", bLine: 5 },
      { type: "context", text: "6", aLine: 6, bLine: 6 },
      { type: "context", text: "7", aLine: 7, bLine: 7 },
      { type: "skip", count: 2 }
    ]);
  });

  it("sem mudanças → um único skip com o total", () => {
    const lines = computeDiff("a\nb", "a\nb");
    expect(toHunks(lines)).toEqual([{ type: "skip", count: 2 }]);
  });
});
