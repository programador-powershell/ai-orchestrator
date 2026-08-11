import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { TOOL_SPECS, agentSystemInstruction, formatToolResult, needsApproval, parseToolCalls, stripToolCalls, runAgentLoop } =
  await import("./agent");

describe("parseToolCalls", () => {
  it("extrai um tool-call de um bloco ```tool```", () => {
    const text = 'Vou ler o arquivo.\n```tool\n{"tool":"fs_read","args":{"path":"src/app.ts"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: "fs_read", args: { path: "src/app.ts" } }]);
  });

  it("extrai vários blocos e ignora JSON malformado", () => {
    const text =
      '```tool\n{"tool":"fs_list","args":{"sub":"src"}}\n```\n' +
      "```tool\n{quebrado}\n```\n" +
      '```tool\n{"tool":"terminal","args":{"command":"pnpm test"}}\n```';
    expect(parseToolCalls(text)).toEqual([
      { tool: "fs_list", args: { sub: "src" } },
      { tool: "terminal", args: { command: "pnpm test" } }
    ]);
  });

  it("ignora call sem nome de tool conhecido", () => {
    const text = '```tool\n{"tool":"inexistente","args":{}}\n```';
    expect(parseToolCalls(text)).toEqual([]);
  });

  it("retorna vazio quando não há blocos", () => {
    expect(parseToolCalls("resposta comum sem ferramentas")).toEqual([]);
  });
});

describe("stripToolCalls", () => {
  it("remove os blocos ```tool``` deixando só o texto do assistente", () => {
    const text = 'Lendo agora.\n```tool\n{"tool":"fs_read","args":{"path":"a"}}\n```\nPronto.';
    expect(stripToolCalls(text)).toBe("Lendo agora.\n\nPronto.");
  });
});

describe("needsApproval", () => {
  it("ferramentas de escrita/execução exigem aprovação", () => {
    expect(needsApproval({ tool: "fs_write", args: {} })).toBe(true);
    expect(needsApproval({ tool: "terminal", args: {} })).toBe(true);
  });

  it("ferramentas somente-leitura não exigem aprovação", () => {
    expect(needsApproval({ tool: "fs_read", args: {} })).toBe(false);
    expect(needsApproval({ tool: "fs_list", args: {} })).toBe(false);
    expect(needsApproval({ tool: "search", args: {} })).toBe(false);
  });

  it("toda ferramenta MCP externa exige aprovação", () => {
    expect(needsApproval({ tool: "mcp:jira:create_issue", args: {} })).toBe(true);
  });
});

describe("tool-calls MCP", () => {
  it("aceita ferramenta namespaced mcp:<servidor>:<tool>", () => {
    const text = '```tool\n{"tool":"mcp:jira:create_issue","args":{"titulo":"x"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: "mcp:jira:create_issue", args: { titulo: "x" } }]);
  });
});

describe("formatToolResult", () => {
  it("formata o resultado para realimentar o modelo, com o nome da ferramenta", () => {
    const out = formatToolResult({ tool: "fs_read", args: { path: "a.ts" } }, "conteúdo");
    expect(out).toContain("fs_read");
    expect(out).toContain("conteúdo");
  });

  it("trunca resultados muito longos", () => {
    const out = formatToolResult({ tool: "terminal", args: { command: "x" } }, "a".repeat(20000));
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain("truncado");
  });
});

describe("catálogo e instrução", () => {
  it("expõe as ferramentas essenciais", () => {
    const names = TOOL_SPECS.map((spec) => spec.name);
    expect(names).toEqual(expect.arrayContaining(["fs_read", "fs_write", "fs_list", "terminal", "search"]));
  });

  it("a instrução de sistema ensina o protocolo de blocos", () => {
    const instruction = agentSystemInstruction();
    expect(instruction).toContain("```tool");
    expect(instruction).toContain("fs_read");
  });
});

describe("runAgentLoop", () => {
  it("executa a ferramenta lida, realimenta e retorna a resposta final", async () => {
    const turns = [
      '```tool\n{"tool":"fs_read","args":{"path":"a.ts"}}\n```',
      "O arquivo exporta uma função."
    ];
    const ran: string[] = [];
    const final = await runAgentLoop([{ role: "user", content: "o que faz a.ts?" }], {
      runTurn: () => Promise.resolve(turns.shift() ?? ""),
      runTool: (call) => {
        ran.push(call.tool);
        return Promise.resolve({ ok: true, output: "export function foo() {}" });
      },
      requestApproval: () => Promise.resolve(true)
    });
    expect(ran).toEqual(["fs_read"]);
    expect(final).toBe("O arquivo exporta uma função.");
  });

  it("não executa ferramenta mutante recusada e informa o modelo", async () => {
    const turns = ['```tool\n{"tool":"fs_write","args":{"path":"a","content":"x"}}\n```', "Ok, não gravei."];
    let toolRan = false;
    const final = await runAgentLoop([{ role: "user", content: "grave a" }], {
      runTurn: () => Promise.resolve(turns.shift() ?? ""),
      runTool: () => {
        toolRan = true;
        return Promise.resolve({ ok: true, output: "gravado" });
      },
      requestApproval: () => Promise.resolve(false)
    });
    expect(toolRan).toBe(false);
    expect(final).toBe("Ok, não gravei.");
  });

  it("respeita o teto de iterações", async () => {
    const final = await runAgentLoop([{ role: "user", content: "loop" }], {
      runTurn: () => Promise.resolve('```tool\n{"tool":"fs_list","args":{"sub":"."}}\n```'),
      runTool: () => Promise.resolve({ ok: true, output: "x" }),
      requestApproval: () => Promise.resolve(true),
      maxIterations: 3
    });
    expect(final).toContain("Limite");
  });
});
