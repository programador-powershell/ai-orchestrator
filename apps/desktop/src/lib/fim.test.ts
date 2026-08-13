import { describe, expect, it } from "vitest";

import {
  buildFimContext,
  buildFimRequest,
  completionKey,
  overlapLength,
  sanitizeCompletion,
  shouldComplete,
  stripFence
} from "./fim";
import type { CodeSymbol } from "./symbols";

const ctx = (prefix: string, suffix = "") => buildFimContext(prefix + suffix, prefix.length);

describe("buildFimContext", () => {
  it("separa prefixo e sufixo no cursor", () => {
    const context = buildFimContext("abc|def".replace("|", ""), 3);
    expect(context.prefix).toBe("abc");
    expect(context.suffix).toBe("def");
  });

  it("guarda o começo da linha atual", () => {
    const context = ctx("function a() {\n  const x = ");
    expect(context.lineHead).toBe("  const x = ");
  });

  it("corta o prefixo numa quebra de linha, não no meio de um token", () => {
    const texto = "linha1\nlinha2\nlinha3";
    const context = buildFimContext(texto, texto.length, { prefix: 10 });
    // A propriedade que importa: o prefixo começa logo depois de uma quebra.
    // Sem o corte, a janela de 10 abriria no meio de "linha2" ("a2\nlinha3").
    const inicio = texto.length - context.prefix.length;
    expect(texto.slice(inicio)).toBe(context.prefix);
    expect(inicio === 0 || texto[inicio - 1] === "\n").toBe(true);
  });

  it("corta o sufixo numa quebra de linha", () => {
    const texto = "a\nlinha2\nlinha3\nlinha4";
    const context = buildFimContext(texto, 1, { suffix: 12 });
    expect(context.suffix.endsWith("\n")).toBe(false);
    expect(context.suffix.split("\n").pop()).not.toBe("linh");
  });

  it("cursor fora do texto é preso nos limites", () => {
    expect(buildFimContext("abc", 99).prefix).toBe("abc");
    expect(buildFimContext("abc", -5).prefix).toBe("");
  });

  it("texto menor que a janela não é cortado", () => {
    const context = buildFimContext("abc\ndef", 3);
    expect(context.prefix).toBe("abc");
    expect(context.suffix).toBe("\ndef");
  });
});

describe("shouldComplete", () => {
  it("aceita no fim de uma linha de código", () => {
    expect(shouldComplete("const x = ", 10)).toBe(true);
  });

  it("recusa no meio de um identificador", () => {
    // Cursor entre "nom" e "e": sugerir aqui briga com o que se digita.
    expect(shouldComplete("const nome = 1", 9)).toBe(false);
  });

  it("aceita quando o próximo caractere não é de identificador", () => {
    expect(shouldComplete("const x = 1;\n", 12)).toBe(true);
  });

  it("recusa dentro de comentário — a resposta viria em prosa", () => {
    expect(shouldComplete("// explicando ", 14)).toBe(false);
    expect(shouldComplete("# explicando ", 13)).toBe(false);
    expect(shouldComplete("-- explicando ", 14)).toBe(false);
    expect(shouldComplete(" * explicando ", 14)).toBe(false);
  });

  it("recusa buffer vazio", () => {
    expect(shouldComplete("   \n  ", 3)).toBe(false);
  });

  it("recusa cursor inválido", () => {
    expect(shouldComplete("const x", Number.NaN)).toBe(false);
    expect(shouldComplete("const x", -1)).toBe(false);
  });
});

describe("completionKey", () => {
  it("muda quando o texto perto do cursor muda", () => {
    expect(completionKey(ctx("const a = "))).not.toBe(completionKey(ctx("const b = ")));
  });

  it("não muda quando só o topo distante do arquivo muda", () => {
    const cauda = "\n".repeat(3) + "function alvo() {\n  const x = ";
    const a = ctx("// cabeçalho A" + " ".repeat(400) + cauda);
    const b = ctx("// cabeçalho B" + " ".repeat(400) + cauda);
    expect(completionKey(a)).toBe(completionKey(b));
  });
});

describe("buildFimRequest", () => {
  const symbol = (name: string): CodeSymbol => ({
    name,
    kind: "function",
    file: "a.ts",
    line: 1,
    indent: 0,
    exported: true
  });

  it("marca o ponto do cursor entre prefixo e sufixo", () => {
    const request = buildFimRequest(ctx("const x = ", ";\n"));
    expect(request.user).toContain("const x = <CURSOR>;");
  });

  it("inclui a linguagem quando informada", () => {
    expect(buildFimRequest(ctx("a"), { language: "TypeScript" }).user).toContain("TypeScript");
  });

  it("passa os símbolos do projeto, sem repetir nome", () => {
    const request = buildFimRequest(ctx("a"), { symbols: [symbol("alfa"), symbol("alfa"), symbol("beta")] });
    expect(request.user).toContain("alfa, beta");
  });

  it("limita a lista de símbolos para o pedido não inchar", () => {
    const muitos = Array.from({ length: 90 }, (_, index) => symbol(`s${index}`));
    const request = buildFimRequest(ctx("a"), { symbols: muitos });
    expect(request.user).not.toContain("s50");
  });

  it("manda o modelo não repetir nem explicar", () => {
    const request = buildFimRequest(ctx("a"));
    expect(request.system).toContain("Não repita");
    expect(request.system).toContain("sem explicação");
  });
});

describe("stripFence", () => {
  it("remove a cerca com linguagem", () => {
    expect(stripFence("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("remove a cerca sem linguagem", () => {
    expect(stripFence("```\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("deixa em paz o texto sem cerca", () => {
    expect(stripFence("const a = 1;")).toBe("const a = 1;");
  });

  it("cerca aberta e nunca fechada não devolve lixo", () => {
    expect(stripFence("```ts")).toBe("");
  });
});

describe("overlapLength", () => {
  it("acha o fim de a que é começo de b", () => {
    expect(overlapLength("const x = ", "const x = 1")).toBe(10);
  });

  it("devolve zero quando não há sobreposição", () => {
    expect(overlapLength("abc", "xyz")).toBe(0);
  });

  it("respeita o teto", () => {
    expect(overlapLength("aaaa", "aaaa", 2)).toBe(2);
  });
});

describe("sanitizeCompletion", () => {
  it("devolve o miolo limpo", () => {
    const context = ctx("const soma = ", ";\n");
    expect(sanitizeCompletion("a + b", context)).toBe("a + b");
  });

  it("tira a cerca de markdown", () => {
    const context = ctx("const soma = ", ";\n");
    expect(sanitizeCompletion("```ts\na + b\n```", context)).toBe("a + b");
  });

  it("tira o eco do prefixo", () => {
    const context = ctx("function somar(a, b) {\n  return ");
    // O modelo recomeçou a linha inteira.
    expect(sanitizeCompletion("  return a + b;", context)).toBe("a + b;");
  });

  it("corta o avanço sobre o sufixo — é o fechamento duplicado de chave", () => {
    const context = ctx("function somar(a, b) {\n  ", "\n}\n");
    const limpo = sanitizeCompletion("return a + b;\n}", context);
    expect(limpo).toBe("return a + b;");
  });

  it("não deixa parêntese duplicado quando o sufixo já fecha", () => {
    const context = ctx("chamar(", ")");
    expect(sanitizeCompletion("1, 2)", context)).toBe("1, 2");
  });

  it("remove o marcador quando o modelo o devolve", () => {
    const context = ctx("const a = ");
    expect(sanitizeCompletion("<CURSOR>1;", context)).toBe("1;");
  });

  it("limita o número de linhas", () => {
    const context = ctx("const a = ");
    const longo = Array.from({ length: 20 }, (_, index) => `linha${index}`).join("\n");
    expect(sanitizeCompletion(longo, context, 3)?.split("\n")).toHaveLength(3);
  });

  it("resposta vazia vira null, não sugestão em branco", () => {
    const context = ctx("const a = ");
    expect(sanitizeCompletion("", context)).toBeNull();
    expect(sanitizeCompletion("   \n  ", context)).toBeNull();
    expect(sanitizeCompletion("```\n\n```", context)).toBeNull();
  });

  it("sugestão que vira vazia depois da limpeza também é null", () => {
    // O modelo devolveu exatamente o que já existe depois do cursor.
    const context = ctx("const a = ", "1;");
    expect(sanitizeCompletion("1;", context)).toBeNull();
  });
});
