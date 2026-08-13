import { describe, expect, it } from "vitest";

import {
  buildIdf,
  cosine,
  diceSimilarity,
  memoryText,
  normalize,
  semanticScore,
  stem,
  stems,
  tokens,
  trigrams,
  weightedOverlap
} from "./semantic";

describe("normalize", () => {
  it("tira acento e caixa", () => {
    expect(normalize("Publicação")).toBe("publicacao");
    expect(normalize("ÍNDICE")).toBe("indice");
  });
});

describe("stem", () => {
  it("junta singular e plural", () => {
    expect(stem("servidores")).toBe(stem("servidor"));
    expect(stem("contas")).toBe(stem("conta"));
  });

  it("junta a forma nominal com a verbal em português", () => {
    // É o caso que motivou o módulo: a consulta diz "publicação", a memória
    // diz "publicar".
    expect(stem("publicação")).toBe(stem("publicar"));
    expect(stem("publicação")).toBe("public");
    expect(stem("publicados")).toBe("public");
  });

  it("o piso protege verbo curto de perder a cauda", () => {
    expect(stem("fazer")).toBe("fazer");
    expect(stem("lugar")).toBe("lugar");
  });

  it("junta o gerúndio inglês", () => {
    expect(stem("deploying")).toBe("deploy");
  });

  it("não radicaliza palavra curta — juntaria o que não tem relação", () => {
    // Sem o piso, "casa" e "caso" virariam o mesmo token.
    expect(stem("casa")).toBe("casa");
    expect(stem("caso")).toBe("caso");
    expect(stem("casa")).not.toBe(stem("caso"));
  });

  it("não corta a ponto de deixar radical minúsculo", () => {
    expect(stem("ações").length).toBeGreaterThanOrEqual(4);
  });
});

describe("tokens", () => {
  it("descarta palavra vazia e token curto", () => {
    expect(tokens("como faço para o deploy")).toEqual(["faco", "deploy"]);
  });

  it("quebra em qualquer não-alfanumérico", () => {
    expect(tokens("banco-de-dados/producao")).toEqual(["banco", "dados", "producao"]);
  });

  it("texto sem nada aproveitável devolve vazio", () => {
    expect(tokens("a e o de")).toEqual([]);
  });
});

describe("diceSimilarity", () => {
  it("perdoa erro de digitação", () => {
    expect(diceSimilarity("orquestrador", "orquestardor")).toBeGreaterThan(0.6);
  });

  it("texto igual dá 1", () => {
    expect(diceSimilarity("deploy", "deploy")).toBeCloseTo(1, 5);
  });

  it("textos sem relação ficam perto de zero", () => {
    expect(diceSimilarity("deploy", "xyzw")).toBeLessThan(0.2);
  });

  it("vazio não quebra", () => {
    expect(diceSimilarity("", "deploy")).toBe(0);
  });
});

describe("trigrams", () => {
  it("inclui as bordas, para o começo da palavra contar", () => {
    expect([...trigrams("ab")]).toContain(" ab");
  });
});

describe("buildIdf", () => {
  const docs = [
    "servidor de producao com deploy",
    "servidor de homologacao",
    "servidor de testes",
    "politica de ferias"
  ];

  it("dá peso maior ao termo raro", () => {
    const idf = buildIdf(docs);
    // "deploy" aparece em 1 de 4; "servidor" em 3 de 4.
    expect(idf.get(stem("deploy"))!).toBeGreaterThan(idf.get(stem("servidor"))!);
  });

  it("nunca devolve peso negativo", () => {
    const idf = buildIdf(["a mesma coisa", "a mesma coisa"]);
    for (const peso of idf.values()) expect(peso).toBeGreaterThan(0);
  });

  it("lista vazia não quebra", () => {
    expect(buildIdf([]).size).toBe(0);
  });
});

describe("weightedOverlap", () => {
  const idf = buildIdf(["deploy do servidor", "politica de ferias", "reembolso de despesa"]);

  it("acha o documento mesmo com a palavra em outra forma", () => {
    // A consulta diz "publicações"; o documento diz "publicar".
    const nota = weightedOverlap("publicações", "como publicar o sistema", buildIdf(["como publicar o sistema"]));
    expect(nota).toBeGreaterThan(0);
  });

  it("consulta que casa inteira dá 1", () => {
    expect(weightedOverlap("deploy servidor", "deploy do servidor", idf)).toBeCloseTo(1, 5);
  });

  it("consulta sem nada em comum dá 0", () => {
    expect(weightedOverlap("jacaré", "deploy do servidor", idf)).toBe(0);
  });

  it("perdoa erro de digitação no token, não só no texto inteiro", () => {
    // "prodicao" radicaliza para `prod` e "producao" para `produ`: o erro
    // mudou onde o sufixo termina, então o casamento exato falha.
    const pesos = buildIdf(["subir a versao em producao"]);
    expect(weightedOverlap("prodicao", "subir a versao em producao", pesos)).toBeGreaterThan(0.5);
  });

  it("o casamento aproximado vale menos que o exato", () => {
    const pesos = buildIdf(["servidor de producao"]);
    const exato = weightedOverlap("producao", "servidor de producao", pesos);
    const aproximado = weightedOverlap("prodicao", "servidor de producao", pesos);
    expect(aproximado).toBeLessThan(exato);
    expect(aproximado).toBeGreaterThan(0);
  });

  it("palavra diferente não vira casamento aproximado", () => {
    const pesos = buildIdf(["servidor de producao"]);
    expect(weightedOverlap("jacare", "servidor de producao", pesos)).toBe(0);
  });

  it("consulta só com palavra vazia dá 0 em vez de dividir por zero", () => {
    expect(weightedOverlap("para com que", "deploy do servidor", idf)).toBe(0);
  });

  it("termo raro que casa vale mais que termo comum que casa", () => {
    const corpus = ["servidor um", "servidor dois", "servidor tres", "jacare unico"];
    const pesos = buildIdf(corpus);
    const comum = weightedOverlap("servidor", "servidor um", pesos);
    const raro = weightedOverlap("jacare", "jacare unico", pesos);
    // Ambos casam por inteiro (1.0); a diferença aparece quando misturados.
    const misto = weightedOverlap("servidor jacare", "jacare unico", pesos);
    expect(comum).toBeCloseTo(1, 5);
    expect(raro).toBeCloseTo(1, 5);
    expect(misto).toBeGreaterThan(0.5);
  });
});

describe("cosine", () => {
  it("vetores iguais dão 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("vetores opostos dão -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("perpendiculares dão 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("tamanho diferente devolve 0 em vez de resultado sem sentido", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });

  it("vetor nulo não divide por zero", () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("semanticScore", () => {
  const idf = buildIdf(["deploy do servidor de producao", "politica de ferias", "reembolso"]);

  it("sem vetor, usa só a camada morfológica", () => {
    const nota = semanticScore({ query: "deploy", document: "deploy do servidor de producao", idf });
    expect(nota).toBeGreaterThan(0);
    expect(nota).toBeLessThanOrEqual(1);
  });

  it("com vetor alto a nota sobe, mesmo sem palavra em comum", () => {
    // É o caso que a busca léxica não resolvia: sentido próximo, zero token
    // repetido.
    const sem = semanticScore({ query: "como publico o sistema", document: "procedimento de deploy", idf });
    const com = semanticScore({ query: "como publico o sistema", document: "procedimento de deploy", idf, vector: 0.9 });
    expect(com).toBeGreaterThan(sem);
    expect(com).toBeGreaterThan(0.5);
  });

  it("cosseno negativo não vira nota negativa", () => {
    const nota = semanticScore({ query: "a", document: "b", idf, vector: -0.8 });
    expect(nota).toBeGreaterThanOrEqual(0);
  });

  it("a camada literal continua contando com vetor presente", () => {
    // Vetor idêntico nos dois; quem desempata é a correspondência literal —
    // que é onde o vetor erra (nome próprio, identificador de código).
    const casa = semanticScore({ query: "deploy", document: "deploy do servidor", idf, vector: 0.5 });
    const naoCasa = semanticScore({ query: "deploy", document: "politica de ferias", idf, vector: 0.5 });
    expect(casa).toBeGreaterThan(naoCasa);
  });

  it("fica entre 0 e 1", () => {
    const nota = semanticScore({ query: "deploy servidor", document: "deploy do servidor", idf, vector: 1 });
    expect(nota).toBeLessThanOrEqual(1);
    expect(nota).toBeGreaterThanOrEqual(0);
  });
});

describe("memoryText", () => {
  it("repete o título, para ele pesar mais que o corpo", () => {
    const texto = memoryText({ title: "Deploy", content: "passos", tags: ["infra"] });
    expect(texto.match(/Deploy/g)).toHaveLength(2);
    expect(texto).toContain("infra");
  });
});

describe("stems", () => {
  it("radicaliza a frase inteira", () => {
    expect(stems("servidores publicados")).toEqual([stem("servidor"), stem("publicado")]);
  });
});
