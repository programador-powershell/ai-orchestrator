/**
 * AI Change Log — histórico granular de quem alterou o quê no documento.
 *
 * Cada entrada guarda o snapshot ANTERIOR do trecho afetado, o que permite
 * reverter uma ação específica sem desfazer as posteriores (diferente de um
 * undo em pilha). É o que impede a IA de "destruir" o documento sem recurso.
 */
import type { OfficeCommand } from "./commands";

export type ChangeAuthor = "ai" | "user";

export interface ChangeEntry {
  id: string;
  author: ChangeAuthor;
  /** Descrição legível ("Alterou título do documento"). */
  label: string;
  at: number;
  /** Comando aplicado (ausente em edição manual do usuário). */
  command?: OfficeCommand;
  /** Estado do documento ANTES desta entrada — permite reverter só ela. */
  before: string;
  /** Estado DEPOIS — usado para detectar se a reversão ainda é segura. */
  after: string;
  reverted?: boolean;
}

export interface ChangeLogState {
  entries: ChangeEntry[];
}

export const emptyChangeLog = (): ChangeLogState => ({ entries: [] });

/** Registra uma alteração no log (mais recente primeiro na exibição). */
export function recordChange(
  state: ChangeLogState,
  entry: Omit<ChangeEntry, "id" | "at"> & { id?: string; at?: number }
): ChangeLogState {
  const id = entry.id ?? `chg-${state.entries.length + 1}`;
  const at = entry.at ?? state.entries.length;
  return { entries: [...state.entries, { ...entry, id, at }] };
}

/**
 * Reverte UMA entrada. Só é seguro quando o conteúdo atual ainda é o que a
 * entrada produziu — se algo foi editado depois, a reversão cega corromperia
 * o trabalho posterior, então devolvemos o motivo em vez de aplicar.
 */
export function revertEntry(
  state: ChangeLogState,
  id: string,
  current: string
): { ok: boolean; content?: string; state?: ChangeLogState; reason?: string } {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return { ok: false, reason: "alteração não encontrada" };
  if (entry.reverted) return { ok: false, reason: "esta alteração já foi revertida" };
  if (current !== entry.after) {
    return { ok: false, reason: "o documento mudou depois desta alteração — reverta as posteriores primeiro" };
  }
  return {
    ok: true,
    content: entry.before,
    state: {
      entries: state.entries.map((item) => (item.id === id ? { ...item, reverted: true } : item))
    }
  };
}

/** Desfaz a última alteração não revertida (undo comum). */
export function undoLast(state: ChangeLogState, current: string) {
  const last = [...state.entries].reverse().find((entry) => !entry.reverted);
  if (!last) return { ok: false as const, reason: "nada para desfazer" };
  return revertEntry(state, last.id, current);
}

/** Entradas para exibição, mais recentes primeiro. */
export function timeline(state: ChangeLogState): ChangeEntry[] {
  return [...state.entries].sort((a, b) => b.at - a.at);
}

/** Quantas alterações a IA fez (para o resumo do painel). */
export function aiChangeCount(state: ChangeLogState): number {
  return state.entries.filter((entry) => entry.author === "ai" && !entry.reverted).length;
}
