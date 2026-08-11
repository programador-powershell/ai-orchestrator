import { describe, expect, it } from "vitest";
import { convertAlpacaJsonl, convertShareGptJsonl, estimateTrainingCost, validateDpoJsonl } from "./tunelab";

describe("convertAlpacaJsonl", () => {
  it("converte instruction/input/output para o formato chat", () => {
    const alpaca = JSON.stringify({ instruction: "Resuma", input: "texto longo", output: "resumo" });
    const result = convertAlpacaJsonl(alpaca);
    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    const line = JSON.parse(result.jsonl) as { messages: Array<{ role: string; content: string }> };
    expect(line.messages).toEqual([
      { role: "user", content: "Resuma\n\ntexto longo" },
      { role: "assistant", content: "resumo" }
    ]);
  });

  it("dispensa input vazio e pula linha inválida", () => {
    const lines = [
      JSON.stringify({ instruction: "Oi", output: "Olá" }),
      "{quebrado",
      JSON.stringify({ instruction: "sem output" })
    ].join("\n");
    const result = convertAlpacaJsonl(lines);
    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(2);
    const line = JSON.parse(result.jsonl) as { messages: Array<{ role: string; content: string }> };
    expect(line.messages[0]).toEqual({ role: "user", content: "Oi" });
  });
});

describe("convertShareGptJsonl", () => {
  it("converte conversations human/gpt/system para messages", () => {
    const sharegpt = JSON.stringify({
      conversations: [
        { from: "system", value: "persona" },
        { from: "human", value: "pergunta" },
        { from: "gpt", value: "resposta" }
      ]
    });
    const result = convertShareGptJsonl(sharegpt);
    expect(result.converted).toBe(1);
    const line = JSON.parse(result.jsonl) as { messages: Array<{ role: string; content: string }> };
    expect(line.messages).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "pergunta" },
      { role: "assistant", content: "resposta" }
    ]);
  });

  it("pula conversas sem par human/gpt", () => {
    const result = convertShareGptJsonl(JSON.stringify({ conversations: [{ from: "human", value: "só pergunta" }] }));
    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe("validateDpoJsonl", () => {
  const validDpoLine = (index: number) =>
    JSON.stringify({
      input: { messages: [{ role: "user", content: `pergunta ${index}` }] },
      preferred_output: [{ role: "assistant", content: "boa" }],
      non_preferred_output: [{ role: "assistant", content: "ruim" }]
    });

  it("aceita dataset DPO com 10+ exemplos", () => {
    const jsonl = Array.from({ length: 10 }, (_, index) => validDpoLine(index)).join("\n");
    const result = validateDpoJsonl(jsonl);
    expect(result.ok).toBe(true);
    expect(result.examples).toBe(10);
  });

  it("aponta linha sem preferred/non_preferred com número da linha", () => {
    const jsonl = [validDpoLine(1), JSON.stringify({ input: { messages: [{ role: "user", content: "x" }] } })].join("\n");
    const result = validateDpoJsonl(jsonl);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.startsWith("linha 2:"))).toBe(true);
  });
});

describe("estimateTrainingCost", () => {
  it("estima tokens (~4 chars/token) e custo por época para modelo conhecido", () => {
    const jsonl = "a".repeat(4000);
    const result = estimateTrainingCost(jsonl, "gpt-4o-mini", 3);
    expect(result.tokens).toBe(1000);
    expect(result.costUsd).toBeCloseTo((1000 / 1_000_000) * 3.0 * 3, 6);
  });

  it("retorna custo nulo para modelo fora da tabela, sem quebrar", () => {
    const result = estimateTrainingCost("abcd", "modelo-desconhecido", 2);
    expect(result.tokens).toBe(1);
    expect(result.costUsd).toBeNull();
  });
});
