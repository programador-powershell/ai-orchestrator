/**
 * MCP — Model Context Protocol, dois lados:
 *
 *  - CLIENTE: conecta a servidores MCP externos (HTTP/SSE) por JSON-RPC 2.0,
 *    lista as ferramentas deles e as chama. As ferramentas viram tools do
 *    agente com nome namespaced `mcp:<servidor>:<tool>`, sob o mesmo diálogo
 *    de aprovação.
 *  - INTERNO: expõe as ferramentas do PRÓPRIO app (fs/terminal/search) como
 *    descritores MCP, para consumo uniforme (pelo agente e por clientes MCP).
 *
 * O framing (build/parse JSON-RPC) e a conversão de descritores são puros e
 * testáveis; o transporte HTTP usa fetch.
 */
import { TOOL_SPECS, dispatchTool, type ToolResult } from "./agent";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** Monta um envelope JSON-RPC 2.0. Puro. */
export function buildRpcRequest(method: string, params: Record<string, unknown>, id: number): RpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

export interface RpcParsed {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Interpreta a resposta JSON-RPC do servidor. Puro. */
export function parseRpcResponse(text: string): RpcParsed {
  try {
    const parsed = JSON.parse(text) as { result?: unknown; error?: { message?: string; code?: number } };
    if (parsed.error) return { ok: false, error: parsed.error.message ?? `erro ${parsed.error.code ?? ""}`.trim() };
    return { ok: true, result: parsed.result };
  } catch {
    return { ok: false, error: "resposta JSON-RPC inválida" };
  }
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolSpec {
  name: string;
  description: string;
  /** Ferramentas externas são tratadas como mutantes (exigem aprovação). */
  mutating: boolean;
}

export function namespacedName(server: string, tool: string): string {
  return `mcp:${server}:${tool}`;
}

/** Desmonta `mcp:<servidor>:<tool>`; null se não for um nome MCP. */
export function parseNamespaced(name: string): { server: string; tool: string } | null {
  const match = name.match(/^mcp:([^:]+):(.+)$/);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** Converte descritores de um servidor em specs do agente (namespaced). */
export function mcpToolsToSpecs(server: string, tools: McpToolDescriptor[]): McpToolSpec[] {
  return tools.map((tool) => ({
    name: namespacedName(server, tool.name),
    description: tool.description,
    mutating: true
  }));
}

/** Ferramentas do próprio app expostas como descritores MCP (MCP interno). */
export function internalMcpTools(): McpToolDescriptor[] {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: { type: "object", example: spec.args }
  }));
}

/** Executa uma ferramenta interna via o contrato MCP (delega ao dispatch real). */
export function callInternalTool(name: string, args: Record<string, unknown>, root: string): Promise<ToolResult> {
  return dispatchTool({ tool: name, args }, root);
}

/* ------------------------------ cliente HTTP ------------------------------ */

export interface McpServerConfig {
  name: string;
  url: string;
  token?: string;
}

/** Cliente MCP sobre HTTP (JSON-RPC). SSE de servidores é lido como stream. */
export class McpHttpClient {
  private id = 0;
  constructor(private readonly config: McpServerConfig) {}

  private async rpc(method: string, params: Record<string, unknown>): Promise<RpcParsed> {
    this.id += 1;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRpcRequest(method, params, this.id))
    });
    if (!response.ok) return { ok: false, error: `servidor MCP respondeu ${response.status}` };
    return parseRpcResponse(await response.text());
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const parsed = await this.rpc("tools/list", {});
    if (!parsed.ok) throw new Error(parsed.error);
    return ((parsed.result as { tools?: McpToolDescriptor[] })?.tools ?? []).filter((tool) => tool?.name);
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = await this.rpc("tools/call", { name: tool, arguments: args });
    if (!parsed.ok) return { ok: false, output: parsed.error ?? "falha na ferramenta MCP" };
    const content = (parsed.result as { content?: Array<{ text?: string }> })?.content ?? [];
    return { ok: true, output: content.map((part) => part.text ?? "").join("\n") || "(sem saída)" };
  }
}
