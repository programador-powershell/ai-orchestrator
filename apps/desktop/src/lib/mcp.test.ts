import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { buildRpcRequest, parseRpcResponse, mcpToolsToSpecs, internalMcpTools, namespacedName, parseNamespaced } =
  await import("./mcp");

describe("buildRpcRequest", () => {
  it("monta um envelope JSON-RPC 2.0 com id e params", () => {
    expect(buildRpcRequest("tools/list", {}, 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {}
    });
  });
});

describe("parseRpcResponse", () => {
  it("retorna o result em caso de sucesso", () => {
    const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(parseRpcResponse(text)).toEqual({ ok: true, result: { tools: [] } });
  });

  it("retorna erro quando o servidor responde error", () => {
    const text = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "método ausente" } });
    const parsed = parseRpcResponse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("método ausente");
  });

  it("trata JSON inválido como erro", () => {
    expect(parseRpcResponse("{quebrado").ok).toBe(false);
  });
});

describe("mcpToolsToSpecs", () => {
  it("converte descritores MCP para specs do agente", () => {
    const specs = mcpToolsToSpecs("jira", [
      { name: "create_issue", description: "Cria um card" },
      { name: "search", description: "Busca" }
    ]);
    expect(specs).toHaveLength(2);
    expect(specs[0].name).toBe("mcp:jira:create_issue");
    expect(specs[0].mutating).toBe(true);
  });
});

describe("namespacedName / parseNamespaced", () => {
  it("cria e desmonta o nome namespaced", () => {
    expect(namespacedName("jira", "create_issue")).toBe("mcp:jira:create_issue");
    expect(parseNamespaced("mcp:jira:create_issue")).toEqual({ server: "jira", tool: "create_issue" });
  });

  it("retorna null para nome que não é MCP", () => {
    expect(parseNamespaced("fs_read")).toBeNull();
  });
});

describe("internalMcpTools", () => {
  it("expõe as ferramentas do app como descritores MCP", () => {
    const tools = internalMcpTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["fs_read", "fs_write", "terminal"]));
    expect(tools.every((tool) => typeof tool.description === "string")).toBe(true);
  });
});
