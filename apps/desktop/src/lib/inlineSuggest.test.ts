import { describe, expect, it } from "vitest";
import { suggestIdentifier } from "./inlineSuggest";

describe("suggestIdentifier", () => {
  it("completa identificador já usado no buffer", () => {
    const text = "const contadorTotal = 1;\ncont";
    expect(suggestIdentifier(text, text.length)).toBe("adorTotal");
  });

  it("prefixo curto demais não sugere", () => {
    const text = "const contador = 1;\nc";
    expect(suggestIdentifier(text, text.length)).toBeNull();
  });

  it("sem candidato devolve null", () => {
    const text = "const alfa = 1;\nzzz";
    expect(suggestIdentifier(text, text.length)).toBeNull();
  });

  it("não sugere quando a única ocorrência é o próprio prefixo", () => {
    const text = "abc";
    expect(suggestIdentifier(text, text.length)).toBeNull();
  });

  it("prefere o candidato mais frequente", () => {
    const text = "usuarioAtivo\nusuarioAtivo\nusuarioBanido\nusu";
    expect(suggestIdentifier(text, text.length)).toBe("arioAtivo");
  });

  it("empate na frequência escolhe o mais curto", () => {
    const text = "valorX\nvalorLongoDemais\nval";
    expect(suggestIdentifier(text, text.length)).toBe("orX");
  });

  it("não sugere no meio de uma palavra", () => {
    const text = "contador = 1; cont" + "ainer";
    expect(suggestIdentifier(text, 17)).toBeNull();
  });

  it("cursor fora de identificador devolve null", () => {
    expect(suggestIdentifier("const contador = ", 17)).toBeNull();
    expect(suggestIdentifier("contador", 0)).toBeNull();
  });

  it("respeita caixa e aceita _ e $", () => {
    const text = "$minhaVar = 1;\n_interno = 2;\n_int";
    expect(suggestIdentifier(text, text.length)).toBe("erno");
    const outro = "MinhaClasse\nminhaCoisa\nMin";
    expect(suggestIdentifier(outro, outro.length)).toBe("haClasse");
  });

  it("cursor fora do intervalo é tratado sem quebrar", () => {
    const text = "contador = 1;\ncont";
    expect(suggestIdentifier(text, 999)).toBe("ador");
    expect(suggestIdentifier(text, -5)).toBeNull();
  });

  it("ignora dígitos iniciais e não sugere sobre número", () => {
    expect(suggestIdentifier("total123 = 1;\n123", 17)).toBeNull();
  });
});
