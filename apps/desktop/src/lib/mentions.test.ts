import { describe, expect, it } from "vitest";
import { applyMention, detectMention, extractMentionedPaths, mentionContext, rankMentions } from "./mentions";

describe("detectMention", () => {
  it("detecta menção em digitação no início e após espaço", () => {
    expect(detectMention("@src/app", 8)).toEqual({ term: "src/app", start: 0 });
    expect(detectMention("veja @lib/eng", 13)).toEqual({ term: "lib/eng", start: 5 });
  });

  it("ignora @ colado em palavra (e-mail, decorator)", () => {
    expect(detectMention("daniel@empresa.com", 18)).toBeNull();
  });

  it("espaço encerra a menção", () => {
    expect(detectMention("@arquivo.ts e depois", 20)).toBeNull();
  });

  it("sem @ retorna null", () => {
    expect(detectMention("texto normal", 12)).toBeNull();
  });

  it("@ sozinho abre a lista (termo vazio)", () => {
    expect(detectMention("@", 1)).toEqual({ term: "", start: 0 });
  });
});

describe("applyMention", () => {
  it("substitui o termo pelo caminho e deixa espaço", () => {
    const result = applyMention("veja @lib/eng", { term: "lib/eng", start: 5 }, "src/lib/engine.ts");
    expect(result.text).toBe("veja @src/lib/engine.ts ");
    expect(result.cursor).toBe(result.text.length);
  });

  it("preserva o texto após a menção", () => {
    const result = applyMention("@ap e o resto", { term: "ap", start: 0 }, "src/App.tsx");
    expect(result.text).toBe("@src/App.tsx e o resto");
  });
});

describe("rankMentions", () => {
  const paths = ["src/App.tsx", "src/lib/engine.ts", "src/lib/engineHelpers.ts", "docs/engine.md"];

  it("prioriza correspondência no NOME do arquivo sobre a pasta", () => {
    const ranked = rankMentions(paths, "engine");
    // engine.ts e engine.md casam pelo nome; engineHelpers casa só parcialmente.
    expect(ranked.slice(0, 2)).toEqual(expect.arrayContaining(["src/lib/engine.ts", "docs/engine.md"]));
    expect(ranked.indexOf("src/lib/engineHelpers.ts")).toBeGreaterThan(1);
  });

  it("nome exato vence prefixo", () => {
    const ranked = rankMentions(["src/lib/engineHelpers.ts", "src/lib/engine.ts"], "engine.ts");
    expect(ranked[0]).toBe("src/lib/engine.ts");
  });

  it("termo vazio devolve os primeiros", () => {
    expect(rankMentions(paths, "", 2)).toEqual(["src/App.tsx", "src/lib/engine.ts"]);
  });

  it("sem correspondência devolve vazio", () => {
    expect(rankMentions(paths, "zzzz")).toEqual([]);
  });

  it("respeita o limite", () => {
    expect(rankMentions(paths, "e", 2)).toHaveLength(2);
  });
});

describe("extractMentionedPaths", () => {
  it("extrai caminhos de arquivo mencionados", () => {
    const paths = extractMentionedPaths("compare @src/App.tsx com @src/lib/engine.ts por favor");
    expect(paths).toEqual(["src/App.tsx", "src/lib/engine.ts"]);
  });

  it("ignora menção que não parece arquivo", () => {
    expect(extractMentionedPaths("obrigado @equipe")).toEqual([]);
  });

  it("não duplica o mesmo arquivo", () => {
    expect(extractMentionedPaths("@a.ts e de novo @a.ts")).toEqual(["a.ts"]);
  });
});

describe("mentionContext", () => {
  it("monta o contexto com caminho e conteúdo", () => {
    const context = mentionContext([{ path: "a.ts", content: "export const x = 1;" }]);
    expect(context).toContain("a.ts");
    expect(context).toContain("export const x = 1;");
  });

  it("trunca arquivo gigante avisando", () => {
    const context = mentionContext([{ path: "big.ts", content: "x".repeat(30_000) }]);
    expect(context).toContain("truncado");
    expect(context.length).toBeLessThan(21_000);
  });
});
