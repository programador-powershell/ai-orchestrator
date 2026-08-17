import { describe, expect, it } from "vitest";
import type { UiMode } from "@orchestrator/contracts";
import {
  addProject,
  assignProject,
  detachProject,
  exportFileName,
  groupByProject,
  removeProject,
  renameProject,
  searchConversations,
  toJson,
  toMarkdown,
  type ExportConversation,
  type Project
} from "./conversations";

const conv = (
  id: string,
  title: string,
  texts: string[],
  updatedAt = 1_000,
  projectId?: string
): ExportConversation => ({
  id,
  title,
  updatedAt,
  messages: texts.map((content, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content
  })),
  ...(projectId ? { projectId } : {})
});

const project = (id: string, name: string, createdAt = 1): Project => ({ id, name, createdAt });

describe("toMarkdown", () => {
  it("escreve o título e o papel de cada mensagem", () => {
    const markdown = toMarkdown(conv("a", "Plano de deploy", ["Como faço?", "Assim."], Date.UTC(2026, 0, 2)));
    expect(markdown).toContain("# Plano de deploy");
    expect(markdown).toContain("## Você\n\nComo faço?");
    expect(markdown).toContain("## Assistente\n\nAssim.");
  });

  it("preserva blocos de código exatamente como estão", () => {
    const fence = "```ts\nconst a = 1;\n```";
    const markdown = toMarkdown(conv("a", "Código", ["gera", fence]));
    expect(markdown).toContain(fence);
  });

  it("marca o papel de sistema e ignora mensagens vazias", () => {
    const markdown = toMarkdown({
      id: "a",
      title: "Mix",
      updatedAt: 0,
      messages: [
        { role: "system", content: "Regras." },
        { role: "assistant", content: "   " }
      ]
    });
    expect(markdown).toContain("## Sistema\n\nRegras.");
    expect(markdown).not.toContain("## Assistente");
  });

  it("usa título de reserva quando a conversa não tem título", () => {
    expect(toMarkdown(conv("a", "  ", ["oi"]))).toContain("# Conversa sem título");
  });

  it("termina com quebra de linha única", () => {
    const markdown = toMarkdown(conv("a", "T", ["oi"]));
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("toJson", () => {
  it("serializa a conversa inteira e volta idêntica no parse", () => {
    const conversation = conv("a", "Título", ["um", "dois"], 42, "p1");
    expect(JSON.parse(toJson(conversation))).toEqual(conversation);
  });

  it("indenta para leitura humana", () => {
    expect(toJson(conv("a", "T", ["oi"]))).toContain("\n  ");
  });
});

describe("exportFileName", () => {
  it("gera slug sem acento nem símbolo", () => {
    expect(exportFileName(conv("a", "Revisão de Código: parte 2!", []), "md")).toBe("revisao-de-codigo-parte-2.md");
  });

  it("usa nome de reserva quando o título não vira slug", () => {
    expect(exportFileName(conv("a", "***", []), "json")).toBe("conversa.json");
  });

  it("limita o comprimento do slug", () => {
    const long = exportFileName(conv("a", "palavra ".repeat(40), []), "md");
    expect(long.length).toBeLessThanOrEqual(53);
    expect(long.endsWith(".md")).toBe(true);
  });
});

describe("searchConversations", () => {
  const all: Partial<Record<UiMode, ExportConversation[]>> = {
    chat: [conv("c1", "Deploy", ["Como fazer deploy?", "Deploy é assim, deploy pronto."], 10)],
    code: [conv("c2", "Refatorar", ["Preciso de deploy contínuo", "ok"], 20)],
    data: [conv("c3", "Relatório", ["nada aqui", "nem aqui"], 30)]
  };

  it("devolve vazio para query vazia ou só espaços", () => {
    expect(searchConversations(all, "")).toEqual([]);
    expect(searchConversations(all, "   ")).toEqual([]);
  });

  it("devolve vazio quando nada casa", () => {
    expect(searchConversations(all, "kubernetes")).toEqual([]);
  });

  it("ignora caixa e acentos", () => {
    const results = searchConversations({ chat: [conv("c1", "Sessão", ["Configuração básica"], 1)] }, "CONFIGURACAO");
    expect(results).toHaveLength(1);
    expect(results[0].conversationId).toBe("c1");
  });

  it("informa a aba de origem de cada resultado", () => {
    const results = searchConversations(all, "deploy");
    expect(results.map((item) => item.mode)).toEqual(["chat", "code"]);
  });

  it("ordena por número de ocorrências (mais relevante primeiro)", () => {
    const results = searchConversations(all, "deploy");
    expect(results[0].conversationId).toBe("c1");
    expect(results[0].matchCount).toBe(4);
    expect(results[1].matchCount).toBe(1);
  });

  it("desempata pela conversa mais recente", () => {
    const results = searchConversations(
      {
        chat: [conv("velha", "x", ["alfa"], 1)],
        code: [conv("nova", "y", ["alfa"], 99)]
      },
      "alfa"
    );
    expect(results.map((item) => item.conversationId)).toEqual(["nova", "velha"]);
  });

  it("traz um trecho ao redor do match", () => {
    const results = searchConversations(
      { chat: [conv("c1", "T", ["prefixo bem longo antes do alvo aqui e depois muito texto adicional"], 1)] },
      "alvo"
    );
    expect(results[0].snippet).toContain("alvo");
    expect(results[0].snippet.length).toBeLessThan(120);
  });

  it("cai para o título quando o match só existe no título", () => {
    const results = searchConversations({ chat: [conv("c1", "Auditoria", ["texto solto"], 1)] }, "auditoria");
    expect(results[0].snippet).toBe("Auditoria");
    expect(results[0].matchCount).toBe(1);
  });

  it("tolera abas ausentes no mapa", () => {
    expect(searchConversations({}, "x")).toEqual([]);
  });

  it("conta ocorrências espalhadas por mensagens diferentes", () => {
    /*
     * O corpo passou a ser contado como UMA string por conversa (memorizada
     * pela identidade do array). Este é o contrato: unir as mensagens não
     * pode perder nem inventar ocorrência.
     */
    const results = searchConversations(
      { chat: [conv("c1", "T", ["alfa no começo", "meio sem nada", "alfa e alfa no fim"], 1)] },
      "alfa"
    );
    expect(results[0].matchCount).toBe(3);
  });

  it("não casa termo que só existiria colando o fim de uma mensagem no início da seguinte", () => {
    const results = searchConversations(
      { chat: [conv("c1", "T", ["termina em depl", "oy começa aqui"], 1)] },
      "deploy"
    );
    expect(results).toEqual([]);
  });

  it("reflete mensagem nova na mesma conversa (a memória é por array, não por id)", () => {
    const antes = conv("c1", "T", ["alfa"], 1);
    expect(searchConversations({ chat: [antes] }, "alfa")[0].matchCount).toBe(1);
    // O store troca o array ao acrescentar — a memória tem de morrer junto.
    const depois = { ...antes, messages: [...antes.messages, { role: "user" as const, content: "alfa de novo" }] };
    expect(searchConversations({ chat: [depois] }, "alfa")[0].matchCount).toBe(2);
  });

  it("`limite` corta os resultados já ordenados por relevância", () => {
    const results = searchConversations(all, "deploy", undefined, 1);
    expect(results).toHaveLength(1);
    expect(results[0].conversationId).toBe("c1");
    expect(results[0].snippet).not.toBe("");
  });

  it("`limite` zero devolve vazio e `limite` maior que o total não sobra", () => {
    expect(searchConversations(all, "deploy", undefined, 0)).toEqual([]);
    expect(searchConversations(all, "deploy", undefined, 99)).toHaveLength(2);
  });
});

describe("groupByProject", () => {
  const projects = [project("p1", "Cliente A"), project("p2", "Cliente B")];

  it("agrupa na ordem dos projetos com as sem-projeto no fim", () => {
    const list = [conv("a", "A", [], 1, "p2"), conv("b", "B", [], 1), conv("c", "C", [], 1, "p1")];
    const groups = groupByProject(list, projects);
    expect(groups.map((group) => group.project?.id ?? null)).toEqual(["p1", "p2", null]);
    expect(groups[0].conversations.map((item) => item.id)).toEqual(["c"]);
    expect(groups[2].conversations.map((item) => item.id)).toEqual(["b"]);
  });

  it("mantém projeto vazio visível", () => {
    const groups = groupByProject([], projects);
    expect(groups.map((group) => group.project?.id)).toEqual(["p1", "p2"]);
  });

  it("trata projectId órfão como sem-projeto", () => {
    const groups = groupByProject([conv("a", "A", [], 1, "sumiu")], projects);
    expect(groups.at(-1)?.project).toBeNull();
    expect(groups.at(-1)?.conversations.map((item) => item.id)).toEqual(["a"]);
  });

  it("devolve um único grupo sem-projeto quando não há projetos", () => {
    const groups = groupByProject([conv("a", "A", [], 1)], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBeNull();
  });

  it("não cria grupo sem-projeto vazio", () => {
    const groups = groupByProject([conv("a", "A", [], 1, "p1")], projects);
    expect(groups.some((group) => group.project === null)).toBe(false);
  });
});

describe("mutações de projeto", () => {
  it("addProject acrescenta com nome aparado", () => {
    const next = addProject([], "  Cliente A  ", "p1", 7);
    expect(next).toEqual([{ id: "p1", name: "Cliente A", createdAt: 7 }]);
  });

  it("addProject ignora nome vazio", () => {
    const current = [project("p1", "A")];
    expect(addProject(current, "   ", "p2", 1)).toBe(current);
  });

  it("renameProject troca só o alvo e ignora nome vazio", () => {
    const current = [project("p1", "A"), project("p2", "B")];
    expect(renameProject(current, "p2", " Novo ")).toEqual([project("p1", "A"), project("p2", "Novo")]);
    expect(renameProject(current, "p2", "  ")).toBe(current);
  });

  it("removeProject retira apenas o alvo", () => {
    const current = [project("p1", "A"), project("p2", "B")];
    expect(removeProject(current, "p1").map((item) => item.id)).toEqual(["p2"]);
  });

  it("assignProject move a conversa e aceita null para tirar do projeto", () => {
    const list = [conv("a", "A", [], 1, "p1"), conv("b", "B", [], 1)];
    expect(assignProject(list, "b", "p1")[1].projectId).toBe("p1");
    const detached = assignProject(list, "a", null)[0];
    expect("projectId" in detached).toBe(false);
  });

  it("assignProject não altera a lista quando o id não existe", () => {
    const list = [conv("a", "A", [], 1)];
    expect(assignProject(list, "zzz", "p1")).toBe(list);
  });

  it("detachProject limpa o vínculo de todas as conversas do projeto", () => {
    const list = [conv("a", "A", [], 1, "p1"), conv("b", "B", [], 1, "p2")];
    const next = detachProject(list, "p1");
    expect("projectId" in next[0]).toBe(false);
    expect(next[1].projectId).toBe("p2");
  });
});
