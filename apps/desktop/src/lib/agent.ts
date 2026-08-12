/**
 * Loop agêntico de ferramentas — o modelo EXECUTA ferramentas, não só sugere.
 *
 * Protocolo textual (provider-agnóstico, funciona com qualquer API compatível
 * com OpenAI e preserva o streaming): o modelo emite blocos ```tool``` com um
 * JSON {tool, args}. O app parseia, pede aprovação nas ferramentas que mutam
 * estado, executa, e realimenta o resultado — até o modelo responder sem tools.
 *
 * As primitivas reusam o que já existe no app (fsx, terminal), então nenhuma
 * capacidade nova de sistema é introduzida além do que a aba Code já faz.
 */
import { collectFiles, fsList, fsRead, fsWrite } from "./fsx";
import { terminal } from "./terminal";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** true = altera estado (grava/executa) e exige aprovação humana. */
  mutating: boolean;
  args: string;
}

export const TOOL_SPECS: ToolSpec[] = [
  { name: "fs_read", description: "Lê um arquivo do projeto", mutating: false, args: '{"path":"caminho/relativo"}' },
  { name: "fs_list", description: "Lista uma pasta do projeto", mutating: false, args: '{"sub":"caminho/da/pasta"}' },
  { name: "search", description: "Busca um termo nos arquivos do projeto", mutating: false, args: '{"query":"termo"}' },
  { name: "web_search", description: "Pesquisa na web e retorna fontes citáveis", mutating: false, args: '{"query":"o que buscar"}' },
  { name: "generate_image", description: "Gera uma imagem a partir de um prompt", mutating: false, args: '{"prompt":"descrição da imagem"}' },
  { name: "fs_write", description: "Grava/altera um arquivo do projeto", mutating: true, args: '{"path":"caminho","content":"…"}' },
  { name: "terminal", description: "Executa um comando no terminal do projeto", mutating: true, args: '{"command":"pnpm test"}' }
];

const TOOL_NAMES = new Set(TOOL_SPECS.map((spec) => spec.name));

const TOOL_BLOCK = /```tool\s*([\s\S]*?)```/g;

/** Ferramentas MCP externas chegam namespaced: mcp:<servidor>:<tool>. */
const isMcpTool = (name: string) => /^mcp:[^:]+:.+$/.test(name);

/** Extrai os tool-calls válidos do texto do modelo. Puro, testável. */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(TOOL_BLOCK)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as { tool?: unknown; args?: unknown };
      if (typeof parsed.tool === "string" && (TOOL_NAMES.has(parsed.tool) || isMcpTool(parsed.tool))) {
        calls.push({ tool: parsed.tool, args: (parsed.args as Record<string, unknown>) ?? {} });
      }
    } catch {
      // Bloco malformado é ignorado; o texto do modelo continua visível.
    }
  }
  return calls;
}

/** Remove os blocos ```tool``` deixando só o texto conversacional. */
export function stripToolCalls(text: string): string {
  return text.replace(TOOL_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
}

const MUTATING = new Set(TOOL_SPECS.filter((spec) => spec.mutating).map((spec) => spec.name));

/** Ferramentas que gravam/executam — e toda MCP externa — exigem aprovação. */
export function needsApproval(call: ToolCall): boolean {
  return MUTATING.has(call.tool) || isMcpTool(call.tool);
}

const MAX_RESULT = 8000;

/** Formata o resultado de uma ferramenta para realimentar o modelo. */
export function formatToolResult(call: ToolCall, output: string): string {
  const trimmed = output.length > MAX_RESULT ? `${output.slice(0, MAX_RESULT)}\n… (truncado)` : output;
  return `Resultado da ferramenta \`${call.tool}\`:\n\n${trimmed}`;
}

/** Instrução de sistema que ensina o modelo a usar as ferramentas. */
export function agentSystemInstruction(): string {
  const list = TOOL_SPECS.map((spec) => `- ${spec.name}: ${spec.description}. args: ${spec.args}`).join("\n");
  return (
    "Você pode EXECUTAR ferramentas para investigar e alterar o projeto. Para chamar uma, emita um bloco " +
    "```tool``` contendo um JSON {\"tool\":\"nome\",\"args\":{…}}. Uma ferramenta por bloco; pode emitir várias. " +
    "Após a chamada, PARE e aguarde o resultado — ele voltará como mensagem e você continua a partir dele. " +
    "Quando terminar, responda em texto normal SEM blocos de ferramenta. Ferramentas disponíveis:\n" +
    list +
    "\n\nfs_write e terminal exigem aprovação do usuário; prefira ler e explicar antes de alterar."
  );
}

/* ------------------------------- dispatch ------------------------------- */

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Fontes citadas (busca web) — viram chips no cartão da conversa. */
  sources?: Array<{ title: string; url: string; kind?: string }>;
  /** Imagens geradas — renderizadas dentro do cartão da ferramenta. */
  images?: string[];
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Executa uma ferramenta contra as primitivas reais do app. */
export async function dispatchTool(call: ToolCall, root: string): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "fs_read":
        return { ok: true, output: await fsRead(root, asString(call.args.path)) };
      case "fs_list": {
        const entries = await fsList(root, asString(call.args.sub));
        return { ok: true, output: entries.map((entry) => `${entry.isDir ? "d" : "-"} ${entry.path}`).join("\n") || "(vazio)" };
      }
      case "search": {
        const query = asString(call.args.query).toLowerCase();
        if (!query) return { ok: false, output: "search exige args.query" };
        const files = await collectFiles(root);
        const hits: string[] = [];
        for (const file of files) {
          if (hits.length >= 40) break;
          const content = await fsRead(root, file.path).catch(() => "");
          if (content.toLowerCase().includes(query)) hits.push(file.path);
        }
        return { ok: true, output: hits.length ? hits.join("\n") : `nenhum arquivo contém "${query}"` };
      }
      case "fs_write":
        await fsWrite(root, asString(call.args.path), asString(call.args.content));
        return { ok: true, output: `gravado: ${asString(call.args.path)}` };
      case "terminal": {
        const result = await terminal.execute(asString(call.args.command), root || undefined);
        const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { ok: result.exitCode === 0, output: `${body || "(sem saída)"}\n[exit ${result.exitCode ?? "n/a"}]` };
      }
      default:
        return { ok: false, output: `ferramenta desconhecida: ${call.tool}` };
    }
  } catch (cause) {
    return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
  }
}

/* --------------------------------- loop --------------------------------- */

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentLoopHooks {
  /** Um turno do modelo (deve fazer streaming via os eventos do chamador). */
  runTurn: (messages: AgentMessage[]) => Promise<string>;
  /** Executa a ferramenta (dispatchTool real; injetável para teste). */
  runTool: (call: ToolCall) => Promise<ToolResult>;
  /** Pede aprovação para ferramentas que mutam estado; true = pode executar. */
  requestApproval: (call: ToolCall) => Promise<boolean>;
  /** Notifica a UI que uma ferramenta vai rodar (cartão na conversa). */
  onToolStart?: (call: ToolCall) => void;
  /** Notifica a UI do resultado da ferramenta. */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /** Limite de idas ao modelo (backstop anti-loop). Padrão 8. */
  maxIterations?: number;
  /** Botão Parar: interrompe o loop entre passos, sem nova ida ao modelo. */
  signal?: AbortSignal;
}

/**
 * Conduz o ciclo ler→propor→executar→realimentar até o modelo responder sem
 * ferramentas (ou atingir o teto). Retorna o texto final (sem blocos tool).
 */
export async function runAgentLoop(initial: AgentMessage[], hooks: AgentLoopHooks): Promise<string> {
  const messages = [...initial];
  const maxIterations = hooks.maxIterations ?? 8;
  const stopped = () => hooks.signal?.aborted === true;
  let lastText = "";
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (stopped()) return lastText;
    const raw = await hooks.runTurn(messages);
    lastText = stripToolCalls(raw);
    const calls = parseToolCalls(raw);
    if (!calls.length || stopped()) return lastText;
    messages.push({ role: "assistant", content: raw });

    for (const call of calls) {
      if (stopped()) return lastText;
      hooks.onToolStart?.(call);
      if (needsApproval(call) && !(await hooks.requestApproval(call))) {
        const denied: ToolResult = { ok: false, output: "usuário recusou a execução desta ferramenta." };
        hooks.onToolResult?.(call, denied);
        messages.push({ role: "user", content: formatToolResult(call, denied.output) });
        continue;
      }
      const result = await hooks.runTool(call);
      hooks.onToolResult?.(call, result);
      messages.push({ role: "user", content: formatToolResult(call, result.output) });
    }
  }
  return lastText || "Limite de passos do agente atingido.";
}
