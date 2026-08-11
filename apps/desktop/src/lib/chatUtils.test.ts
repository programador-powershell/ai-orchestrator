import { describe, expect, it } from "vitest";
import {
  buildEditPayload,
  buildRegeneratePayload,
  charCount,
  filterConversations,
  formatDuration,
  normalizeSearchText,
  searchSnippet,
  wordCount,
  type ChatLikeMessage
} from "./chatUtils";

const msg = (role: ChatLikeMessage["role"], content: string): ChatLikeMessage => ({ role, content });

describe("wordCount", () => {
  it("conta zero em texto vazio ou só espaços", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n\t ")).toBe(0);
  });

  it("conta palavras separadas por qualquer espaço em branco", () => {
    expect(wordCount("olá mundo")).toBe(2);
    expect(wordCount("  uma\nfrase\tcom   cinco palavras ")).toBe(5);
  });
});

describe("charCount", () => {
  it("conta zero em texto vazio", () => {
    expect(charCount("")).toBe(0);
  });

  it("conta por code point (emoji conta 1)", () => {
    expect(charCount("abc")).toBe(3);
    expect(charCount("a👍b")).toBe(3);
  });
});

describe("formatDuration", () => {
  it("formata sub-minuto com uma casa decimal e vírgula", () => {
    expect(formatDuration(0)).toBe("0,0 s");
    expect(formatDuration(900)).toBe("0,9 s");
    expect(formatDuration(12_340)).toBe("12,3 s");
  });

  it("formata minutos e segundos acima de 60 s", () => {
    expect(formatDuration(61_000)).toBe("1 min 1 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("faz rollover quando os segundos arredondam para 60", () => {
    expect(formatDuration(119_600)).toBe("2 min 0 s");
  });

  it("nunca formata valor negativo", () => {
    expect(formatDuration(-500)).toBe("0,0 s");
  });
});

describe("normalizeSearchText", () => {
  it("remove acentos e baixa a caixa", () => {
    expect(normalizeSearchText("Ação Coração ÀÉÎÕÜ")).toBe("acao coracao aeiou");
  });
});

describe("filterConversations", () => {
  const list = [
    {
      id: "a",
      title: "Orquestração de modelos",
      messages: [msg("user", "Como funciona a fusão de motores?"), msg("assistant", "A fusão combina executores…")]
    },
    {
      id: "b",
      title: "Receita de bolo",
      messages: [msg("user", "bolo de cenoura com cobertura"), msg("assistant", "Misture farinha e ovos.")]
    }
  ];

  it("devolve a lista intacta com query vazia", () => {
    expect(filterConversations(list, "")).toEqual(list);
    expect(filterConversations(list, "   ")).toEqual(list);
  });

  it("filtra por conteúdo real das mensagens, sem acentos e sem caixa", () => {
    expect(filterConversations(list, "FUSAO").map((c) => c.id)).toEqual(["a"]);
    expect(filterConversations(list, "cenoura").map((c) => c.id)).toEqual(["b"]);
  });

  it("filtra também pelo título", () => {
    expect(filterConversations(list, "orquestracao").map((c) => c.id)).toEqual(["a"]);
  });

  it("devolve vazio quando nada bate", () => {
    expect(filterConversations(list, "kubernetes")).toEqual([]);
  });
});

describe("searchSnippet", () => {
  it("devolve trecho original (com acentos) ao redor da ocorrência", () => {
    const messages = [msg("assistant", "A orquestração de múltiplos modelos exige um plano de fusão claro.")];
    const snippet = searchSnippet(messages, "fusao");
    expect(snippet).toContain("fusão");
  });

  it("adiciona reticências quando corta o texto", () => {
    const long = `${"x".repeat(120)} alvo central ${"y".repeat(120)}`;
    const snippet = searchSnippet([msg("user", long)], "alvo");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("alvo central");
  });

  it("devolve vazio sem ocorrência ou com query vazia", () => {
    expect(searchSnippet([msg("user", "nada aqui")], "kubernetes")).toBe("");
    expect(searchSnippet([msg("user", "nada aqui")], "  ")).toBe("");
  });
});

describe("buildRegeneratePayload", () => {
  it("devolve null sem par pergunta→resposta", () => {
    expect(buildRegeneratePayload([])).toBeNull();
    expect(buildRegeneratePayload([msg("user", "oi")])).toBeNull();
    expect(buildRegeneratePayload([msg("assistant", "olá")])).toBeNull();
  });

  it("remove o par pergunta/resposta e devolve o texto da pergunta (o composer a ecoa de volta)", () => {
    const messages = [msg("user", "primeira"), msg("assistant", "resposta 1"), msg("user", "segunda"), msg("assistant", "resposta 2")];
    const payload = buildRegeneratePayload(messages);
    expect(payload).not.toBeNull();
    expect(payload?.lastUserText).toBe("segunda");
    expect(payload?.trimmedMessages).toEqual([msg("user", "primeira"), msg("assistant", "resposta 1")]);
  });

  it("ignora mensagens de sistema ao procurar o usuário", () => {
    const messages = [msg("system", "regras"), msg("user", "pergunta"), msg("system", "contexto"), msg("assistant", "resposta")];
    const payload = buildRegeneratePayload(messages);
    expect(payload?.lastUserText).toBe("pergunta");
    expect(payload?.trimmedMessages).toEqual([msg("system", "regras")]);
  });

  it("não altera o array original", () => {
    const messages = [msg("user", "a"), msg("assistant", "b")];
    buildRegeneratePayload(messages);
    expect(messages).toHaveLength(2);
  });
});

describe("buildEditPayload", () => {
  it("devolve null sem mensagem de usuário", () => {
    expect(buildEditPayload([])).toBeNull();
    expect(buildEditPayload([msg("assistant", "olá")])).toBeNull();
  });

  it("remove o par pergunta/resposta e devolve o texto da pergunta", () => {
    const messages = [msg("user", "primeira"), msg("assistant", "resposta 1"), msg("user", "segunda"), msg("assistant", "resposta 2")];
    const payload = buildEditPayload(messages);
    expect(payload?.lastUserText).toBe("segunda");
    expect(payload?.trimmedMessages).toEqual([msg("user", "primeira"), msg("assistant", "resposta 1")]);
  });

  it("funciona quando a pergunta ainda não tem resposta", () => {
    const payload = buildEditPayload([msg("user", "só pergunta")]);
    expect(payload?.lastUserText).toBe("só pergunta");
    expect(payload?.trimmedMessages).toEqual([]);
  });
});
