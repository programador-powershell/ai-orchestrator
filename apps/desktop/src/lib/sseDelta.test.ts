import { describe, expect, it } from "vitest";
import { extractDelta, parseSseLine } from "./sseDelta";

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ delta, finish_reason: finish }]
});

describe("extractDelta", () => {
  it("lê o texto visível", () => {
    expect(extractDelta(chunk({ content: "olá" })).content).toBe("olá");
  });

  it("lê o raciocínio de reasoning_content (DeepSeek Reasoner)", () => {
    const parsed = extractDelta(chunk({ reasoning_content: "pensando…" }));
    expect(parsed.reasoning).toBe("pensando…");
    expect(parsed.content).toBe("");
  });

  it("aceita as variações reasoning e thinking", () => {
    expect(extractDelta(chunk({ reasoning: "a" })).reasoning).toBe("a");
    expect(extractDelta(chunk({ thinking: "b" })).reasoning).toBe("b");
  });

  it("separa raciocínio e resposta no mesmo chunk", () => {
    const parsed = extractDelta(chunk({ content: "resposta", reasoning_content: "raciocínio" }));
    expect(parsed).toEqual({ content: "resposta", reasoning: "raciocínio", finishReason: null });
  });

  it("captura o finish_reason (sinal terminal)", () => {
    expect(extractDelta(chunk({}, "stop")).finishReason).toBe("stop");
    expect(extractDelta(chunk({}, "length")).finishReason).toBe("length");
  });

  it("payload sem choices não quebra", () => {
    expect(extractDelta({})).toEqual({ content: "", reasoning: "", finishReason: null });
    expect(extractDelta(null)).toEqual({ content: "", reasoning: "", finishReason: null });
  });
});

describe("parseSseLine", () => {
  it("ignora [DONE] e linha vazia", () => {
    expect(parseSseLine("[DONE]")).toBeNull();
    expect(parseSseLine("")).toBeNull();
  });

  it("ignora JSON malformado sem lançar", () => {
    expect(parseSseLine("{quebrado")).toBeNull();
  });

  it("interpreta uma linha válida", () => {
    expect(parseSseLine(JSON.stringify(chunk({ content: "x" })))?.content).toBe("x");
  });
});
