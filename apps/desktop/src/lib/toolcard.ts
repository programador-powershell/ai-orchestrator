/**
 * Modelo de apresentação das ferramentas na conversa — estilo Studio: um grupo
 * recolhível "N tool calls" com linhas "Used tool: X", status e, na busca,
 * chips de fonte. Puro e testável; a UI (ChatView) só renderiza este shape.
 */
import type { ToolCall } from "./agent";

export type ToolStatus = "running" | "ok" | "error";

export interface ToolSource {
  title: string;
  url: string;
  kind?: string;
}

export interface ToolCard {
  tool: string;
  /** Resumo do argumento principal (caminho, comando, consulta). */
  detail: string;
  status: ToolStatus;
  output?: string;
  sources?: ToolSource[];
  /** URLs/data-URLs de imagens geradas — exibidas no cartão. */
  images?: string[];
  /** Diff da edição (fs_write): linhas somadas/removidas + o patch. */
  edit?: ToolEdit;
}

export interface ToolEdit {
  path: string;
  added: number;
  removed: number;
  /** Trecho unificado já formatado (com contexto), pronto para exibir. */
  patch: string;
  /** true quando o arquivo não existia antes (criação). */
  created: boolean;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Argumento principal da chamada, resumido para a linha do cartão. */
export function toolDetail(call: ToolCall): string {
  const raw =
    asString(call.args.path) ||
    asString(call.args.command) ||
    asString(call.args.query) ||
    asString(call.args.prompt) ||
    asString(call.args.sub);
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
}

const VERBS: Record<string, string> = {
  fs_read: "Read",
  fs_write: "Edited",
  fs_list: "Listed",
  search: "Searched",
  web_search: "Searched the web",
  generate_image: "Generated image",
  terminal: "Ran"
};

/** Rótulo "Used tool: …" no estilo Studio (verbo + alvo). */
export function toolLabel(card: ToolCard): string {
  const verb = VERBS[card.tool] ?? card.tool;
  if (!card.detail) return verb;
  const quoted = card.tool === "search" || card.tool === "web_search" ? `"${card.detail}"` : card.detail;
  return `${verb} ${quoted}`;
}

/**
 * Reduz um resultado sobre o cartão em execução correspondente (o último
 * "running" da mesma ferramenta). Retorna um NOVO array (imutável).
 */
export function applyResult(
  cards: ToolCard[],
  tool: string,
  patch: { status: ToolStatus; output?: string; sources?: ToolSource[]; images?: string[]; edit?: ToolEdit }
): ToolCard[] {
  const index = [...cards].reverse().findIndex((card) => card.tool === tool && card.status === "running");
  if (index < 0) return cards;
  const realIndex = cards.length - 1 - index;
  return cards.map((card, i) => (i === realIndex ? { ...card, ...patch } : card));
}

/** Quantos ainda estão rodando — controla o spinner do cabeçalho do grupo. */
export function runningCount(cards: ToolCard[]): number {
  return cards.filter((card) => card.status === "running").length;
}
