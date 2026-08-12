/**
 * Diff de uma edição feita pelo agente — o cartão da conversa mostra
 * "Editado arquivo.ts +12 −3" e, ao expandir, as linhas alteradas.
 */
import { computeDiff, diffStats, toHunks } from "./diff";
import type { ToolEdit } from "./toolcard";

/** Formata as linhas alteradas em patch unificado (com contexto e elisão). */
export function formatPatch(before: string, after: string, context = 2): string {
  const lines = computeDiff(before, after);
  return toHunks(lines, context)
    .map((part) => {
      if ("type" in part && part.type === "skip") return `… ${part.count} linha(s) sem alteração`;
      const line = part as { type: string; text: string };
      const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      return `${sign}${line.text}`;
    })
    .join("\n");
}

/** Monta o resumo da edição para o cartão (estatísticas + patch). */
export function buildToolEdit(path: string, before: string | null, after: string): ToolEdit {
  const created = before === null || before === "";
  const previous = before ?? "";
  const stats = diffStats(computeDiff(previous, after));
  // Arquivo novo: o "" anterior vira uma linha vazia no diff e seria contado
  // como remoção — criação nunca remove nada.
  const removed = created ? 0 : stats.removed;
  return {
    path,
    added: stats.added,
    removed,
    patch: formatPatch(previous, after),
    created
  };
}

/** Rótulo curto do cartão: "Criado x.ts +44 −0" / "Editado x.ts +3 −1". */
export function editLabel(edit: ToolEdit): string {
  const verb = edit.created ? "Criado" : "Editado";
  return `${verb} ${edit.path} +${edit.added} −${edit.removed}`;
}
