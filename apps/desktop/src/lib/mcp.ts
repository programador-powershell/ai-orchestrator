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
import { invoke } from "@tauri-apps/api/core";

import { TOOL_SPECS, dispatchTool, type ToolResult } from "./agent";
import { blockedMessage, blockedUrl } from "./blocklist";
import { useApp } from "./store";

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
  /**
   * O conector TEM token — que fica no cofre do SO, nunca aqui.
   *
   * O campo antes era o próprio Bearer, e o `settings` inteiro é persistido
   * pelo zustand no `localStorage` do webview: um token de conector
   * corporativo ficava em texto puro, em disco e em qualquer backup do
   * perfil. Só a EXISTÊNCIA é estado de interface; o valor é segredo.
   */
  hasToken?: boolean;
}

/** Conta do conector no cofre — precisa casar com o `account_for` do Rust. */
export const mcpAccount = (name: string) => `mcp.${name.trim()}`;

/** Teto por chamada. O do Rust é o mesmo (30 s). */
const RPC_TIMEOUT_MS = 30_000;

/**
 * Nome obrigatório e único (case-insensitive) + URL http(s) válida.
 *
 * Mora aqui, e não na tela de Configurações, porque a janela "Conectar Apps"
 * cadastra o mesmo tipo de registro: enquanto a validação era privada de uma
 * tela, dava para salvar `intranet/mcp` (sem esquema) pela outra e ficar com
 * um conector marcado como conectado que nunca conseguiria funcionar.
 */
export function validateMcpDraft(
  name: string,
  url: string,
  existing: Array<{ name: string }>
): string | null {
  if (!name) return "Informe um nome para o conector.";
  if (existing.some((server) => server.name.toLowerCase() === name.toLowerCase())) {
    return `Já existe um conector chamado "${name}".`;
  }
  if (!url) return "Informe a URL do servidor MCP.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL inválida — informe o endereço completo, ex.: https://host/mcp.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "A URL deve usar http:// ou https://.";
  }
  return null;
}

const isTauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Cliente MCP sobre HTTP (JSON-RPC). SSE de servidores é lido como stream. */
export class McpHttpClient {
  private id = 0;
  constructor(private readonly config: McpServerConfig) {}

  private async rpc(method: string, params: Record<string, unknown>): Promise<RpcParsed> {
    this.id += 1;
    const body = JSON.stringify(buildRpcRequest(method, params, this.id));
    if (isTauriHost) {
      // Desktop: quem sai é o Rust. Ele lê o token do cofre, resolve o DNS
      // antes de conectar (rebinding) e aplica a blocklist assinada — as três
      // coisas que o renderer não consegue garantir.
      try {
        const outcome = await invoke<{ status: number; ok: boolean; body: string }>("mcp_rpc", {
          name: this.config.name,
          url: this.config.url,
          body
        });
        if (!outcome.ok) return { ok: false, error: `servidor MCP respondeu ${outcome.status}` };
        return parseRpcResponse(outcome.body);
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    // Navegador (preview de desenvolvimento): sem cofre e sem Rust. A
    // blocklist aqui é camada de renderer — quem abrir o devtools contorna —,
    // e conector com token simplesmente não funciona neste caminho.
    const bloqueio = blockedUrl(useApp.getState().policy?.blockedDomains ?? [], this.config.url);
    if (bloqueio) return { ok: false, error: blockedMessage(bloqueio) };
    // Timeout obrigatório: um servidor que aceita a conexão e nunca responde
    // pendurava o envio inteiro (o Composer chama listTools em série para
    // CADA conector antes do turno) até o socket do navegador desistir, e o
    // botão Parar não alcançava este fetch.
    const relogio = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: relogio
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
