import { describe, expect, it } from "vitest";
import { applyResult, runningCount, toolDetail, toolLabel, type ToolCard } from "./toolcard";

describe("toolDetail", () => {
  it("resume o argumento principal por prioridade", () => {
    expect(toolDetail({ tool: "fs_read", args: { path: "src/app.ts" } })).toBe("src/app.ts");
    expect(toolDetail({ tool: "terminal", args: { command: "pnpm test" } })).toBe("pnpm test");
    expect(toolDetail({ tool: "web_search", args: { query: "melhor filme 2026" } })).toBe("melhor filme 2026");
  });

  it("trunca detalhe longo", () => {
    expect(toolDetail({ tool: "fs_read", args: { path: "a".repeat(200) } })).toHaveLength(118);
  });
});

describe("toolLabel", () => {
  it('usa o verbo do estilo Studio e aspas na busca', () => {
    expect(toolLabel({ tool: "fs_read", detail: "src/app.ts", status: "ok" })).toBe("Read src/app.ts");
    expect(toolLabel({ tool: "web_search", detail: "filme 2026", status: "ok" })).toBe('Searched the web "filme 2026"');
    expect(toolLabel({ tool: "terminal", detail: "pnpm test", status: "ok" })).toBe("Ran pnpm test");
  });
});

describe("applyResult", () => {
  const base: ToolCard[] = [
    { tool: "fs_read", detail: "a", status: "ok" },
    { tool: "terminal", detail: "pnpm test", status: "running" }
  ];

  it("atualiza o último cartão em execução da ferramenta", () => {
    const next = applyResult(base, "terminal", { status: "ok", output: "passou" });
    expect(next[1]).toEqual({ tool: "terminal", detail: "pnpm test", status: "ok", output: "passou" });
    expect(next).not.toBe(base);
    expect(base[1].status).toBe("running");
  });

  it("não altera nada quando não há cartão rodando da ferramenta", () => {
    expect(applyResult(base, "fs_write", { status: "ok" })).toBe(base);
  });

  it("anexa sources no resultado (busca web)", () => {
    const cards: ToolCard[] = [{ tool: "web_search", detail: "x", status: "running" }];
    const next = applyResult(cards, "web_search", {
      status: "ok",
      sources: [{ title: "Wikipedia", url: "https://en.wikipedia.org" }]
    });
    expect(next[0].sources).toHaveLength(1);
  });
});

describe("runningCount", () => {
  it("conta os cartões em execução", () => {
    expect(runningCount([{ tool: "a", detail: "", status: "running" }, { tool: "b", detail: "", status: "ok" }])).toBe(1);
  });
});
