import { describe, expect, it, vi } from "vitest";
import type { MemoryItem, MemorySearchHit } from "@orchestrator/contracts";

// memory.ts referencia `window` e importa @tauri-apps/api no topo do módulo.
// Para testar as funções puras em ambiente node, mockamos o invoke e stubamos
// um `window` mínimo ANTES do import dinâmico.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.stubGlobal("window", {});

const {
  scoreMemory,
  rankMemories,
  memoryPreamble,
  parseClaudeMemoryMarkdown,
  parseOpenAiMemoryExport,
  extractMemoryCandidates
} = await import("./memory");

const DAY = 86_400_000;

const makeItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "m-1",
  kind: "fact",
  title: "Título",
  content: "Conteúdo",
  tags: [],
  importance: 3,
  uses: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: "manual",
  ...overrides
});

describe("scoreMemory", () => {
  it("pesa relevância acima de recência", () => {
    const now = Date.now();
    const relevantOld = makeItem({
      title: "Configuração do gateway",
      content: "token de acesso do gateway corporativo",
      updatedAt: new Date(now - 365 * DAY).toISOString()
    });
    const irrelevantFresh = makeItem({
      title: "Preferência de tema",
      content: "usuário prefere modo escuro",
      updatedAt: new Date(now).toISOString()
    });
    const queryTokens = ["gateway", "token"];
    expect(scoreMemory(relevantOld, queryTokens, now)).toBeGreaterThan(
      scoreMemory(irrelevantFresh, queryTokens, now)
    );
  });

  it("relevância é proporcional aos tokens encontrados", () => {
    const now = Date.now();
    const item = makeItem({ title: "gateway", content: "sem mais nada", updatedAt: new Date(now).toISOString() });
    const full = scoreMemory(item, ["gateway"], now);
    const half = scoreMemory(item, ["gateway", "inexistente"], now);
    expect(full).toBeGreaterThan(half);
  });
});

describe("rankMemories", () => {
  const now = Date.now();
  const relevantOld = makeItem({
    id: "relevante",
    title: "Configuração do gateway",
    content: "token de acesso do gateway corporativo",
    updatedAt: new Date(now - 365 * DAY).toISOString()
  });
  const irrelevantFresh = makeItem({
    id: "irrelevante",
    title: "Preferência de tema",
    content: "usuário prefere modo escuro",
    updatedAt: new Date(now).toISOString()
  });

  it("ordena por relevância antes de recência", () => {
    const hits = rankMemories([irrelevantFresh, relevantOld], "gateway token", 5);
    expect(hits[0].item.id).toBe("relevante");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("encontra a memória mesmo com a palavra em outra forma", () => {
    // O caso que a busca por token exato não resolvia: a pessoa pergunta no
    // plural/substantivo, a memória está no singular/verbo.
    const memoria = makeItem({
      id: "publicar",
      title: "Como publicar o sistema",
      content: "roteiro para subir a versão",
      updatedAt: new Date(now).toISOString()
    });
    const hits = rankMemories([irrelevantFresh, memoria], "publicações do sistema", 5);
    expect(hits[0]?.item.id).toBe("publicar");
  });

  it("usa o vetor quando o gateway calculou, mesmo sem palavra em comum", () => {
    const deploy = makeItem({
      id: "deploy",
      title: "Procedimento de deploy",
      content: "esteira e homologação",
      updatedAt: new Date(now).toISOString()
    });
    const semVetor = rankMemories([irrelevantFresh, deploy], "como coloco no ar", 5);
    const comVetor = rankMemories(
      [irrelevantFresh, deploy],
      "como coloco no ar",
      5,
      new Map([["deploy", 0.92]])
    );
    // Sem vetor a consulta não tem token em comum e a memória não aparece.
    expect(semVetor.map((hit) => hit.item.id)).not.toContain("deploy");
    expect(comVetor[0]?.item.id).toBe("deploy");
  });

  it("memória recente e importante não entra em consulta que não é dela", () => {
    // O corte é na RELEVÂNCIA, não na nota final — senão a recência sozinha
    // colaria essa memória em toda pergunta.
    const querida = makeItem({
      id: "querida",
      title: "Preferência de fonte",
      content: "usa fonte monoespaçada",
      importance: 5,
      uses: 50,
      updatedAt: new Date(now).toISOString()
    });
    expect(rankMemories([querida], "cronograma de faturamento", 5)).toEqual([]);
  });

  it("filtra itens com score abaixo do corte", () => {
    const noise = makeItem({
      id: "ruido",
      title: "Assunto antigo",
      content: "nada relacionado",
      importance: 0,
      updatedAt: new Date(now - 3650 * DAY).toISOString()
    });
    const hits = rankMemories([noise, relevantOld], "gateway token", 5);
    expect(hits.map((hit) => hit.item.id)).not.toContain("ruido");
    expect(hits.map((hit) => hit.item.id)).toContain("relevante");
  });

  it("respeita o limite k", () => {
    const items = [1, 2, 3].map((n) =>
      makeItem({
        id: `m-${n}`,
        title: `gateway ${n}`,
        content: "token do gateway",
        updatedAt: new Date(now).toISOString()
      })
    );
    expect(rankMemories(items, "gateway token", 2)).toHaveLength(2);
  });
});

describe("memoryPreamble", () => {
  it("retorna vazio sem hits", () => {
    expect(memoryPreamble([])).toBe("");
  });

  it("lista cada memória com kind, título e conteúdo", () => {
    const hits: MemorySearchHit[] = [
      { item: makeItem({ kind: "preference", title: "Idioma", content: "Prefere pt-BR" }), score: 2 },
      { item: makeItem({ kind: "project", title: "Stack", content: "Tauri 2 + React 19" }), score: 1 }
    ];
    const preamble = memoryPreamble(hits);
    expect(preamble).toContain("Memórias persistentes do usuário");
    expect(preamble).toContain("- [preference] Idioma: Prefere pt-BR");
    expect(preamble).toContain("- [project] Stack: Tauri 2 + React 19");
  });
});

describe("parseClaudeMemoryMarkdown", () => {
  it("lê frontmatter com name/description/type e usa o corpo como conteúdo", () => {
    const md = "---\nname: Preferências do usuário\ndescription: Resumo\ntype: user\n---\nPrefere respostas em pt-BR.";
    const entries = parseClaudeMemoryMarkdown("prefs.md", md);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "preference",
      title: "Preferências do usuário",
      content: "Prefere respostas em pt-BR.",
      tags: ["claude-import"],
      source: "import-claude"
    });
  });

  it("cai para description quando o corpo é vazio e mapeia type project", () => {
    const md = "---\nname: Orchestrator\ndescription: App desktop Tauri\ntype: project\n---\n";
    const entries = parseClaudeMemoryMarkdown("orchestrator.md", md);
    expect(entries[0].kind).toBe("project");
    expect(entries[0].content).toBe("App desktop Tauri");
  });

  it("extrai linhas de índice de MEMORY.md", () => {
    const md =
      "# Índice\n- [Stack do projeto](stack.md) — Tauri 2 com React 19\n- [Convenções](conv.md) - Commits com gitmoji";
    const entries = parseClaudeMemoryMarkdown("MEMORY.md", md);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("Stack do projeto");
    expect(entries[0].content).toBe("Tauri 2 com React 19");
    expect(entries[1].title).toBe("Convenções");
    expect(entries[1].kind).toBe("fact");
  });

  it("md sem frontmatter vira um único fact com o nome do arquivo", () => {
    const entries = parseClaudeMemoryMarkdown("notas.md", "Apenas texto solto.\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("notas");
    expect(entries[0].kind).toBe("fact");
    expect(entries[0].content).toBe("Apenas texto solto.");
  });

  it("conteúdo vazio retorna lista vazia", () => {
    expect(parseClaudeMemoryMarkdown("vazio.md", "   \n  ")).toEqual([]);
  });
});

describe("parseOpenAiMemoryExport", () => {
  it("aceita array de strings e ignora entradas vazias", () => {
    const entries = parseOpenAiMemoryExport(JSON.stringify(["Usuário prefere português", "", "  "]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "fact",
      content: "Usuário prefere português",
      tags: ["openai-import"],
      source: "import-openai"
    });
  });

  it("trunca títulos longos com reticências", () => {
    const long = "a".repeat(70);
    const entries = parseOpenAiMemoryExport(JSON.stringify([long]));
    expect(entries[0].title).toBe(`${"a".repeat(61)}…`);
    expect(entries[0].content).toBe(long);
  });

  it("aceita objeto {memories: [...]} com campos memory/content/text", () => {
    const payload = JSON.stringify({
      memories: [{ memory: "usa Windows 11" }, { content: "trabalha na Orchestrator" }, { text: "gosta de TDD" }]
    });
    const entries = parseOpenAiMemoryExport(payload);
    expect(entries.map((entry) => entry.content)).toEqual([
      "usa Windows 11",
      "trabalha na Orchestrator",
      "gosta de TDD"
    ]);
  });

  it("payload sem memórias retorna vazio", () => {
    expect(parseOpenAiMemoryExport("{}")).toEqual([]);
    expect(parseOpenAiMemoryExport("[]")).toEqual([]);
  });
});

describe("extractMemoryCandidates", () => {
  it("captura marcadores [memorizar: …] do texto do assistente", () => {
    const text = "Feito. [memorizar: usuário prefere respostas curtas] E também [Memorizar: projeto usa pnpm workspaces]";
    const candidates = extractMemoryCandidates(text);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      kind: "fact",
      content: "usuário prefere respostas curtas",
      tags: ["auto"],
      source: "conversa"
    });
    expect(candidates[1].content).toBe("projeto usa pnpm workspaces");
  });

  it("ignora marcadores curtos demais e texto sem marcador", () => {
    expect(extractMemoryCandidates("[memorizar: curto]")).toEqual([]);
    expect(extractMemoryCandidates("resposta comum")).toEqual([]);
  });

  it("trunca o título em 64 caracteres mantendo o conteúdo completo", () => {
    const long = "b".repeat(100);
    const candidates = extractMemoryCandidates(`[memorizar: ${long}]`);
    expect(candidates[0].title).toBe("b".repeat(64));
    expect(candidates[0].content).toBe(long);
  });
});
