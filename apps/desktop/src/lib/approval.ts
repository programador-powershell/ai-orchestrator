/**
 * Política de aprovação de ferramentas ("Approve for me" do Studio).
 *
 * Em vez de perguntar a cada chamada, o usuário escolhe UMA política. A opção
 * padrão é a conservadora: leitura roda direto, escrita/execução pedem aval.
 */
import { needsApproval, type ToolCall } from "./agent";

export type ApprovalPolicy = "ask" | "edits" | "all";

export const APPROVAL_POLICIES: Array<{ id: ApprovalPolicy; label: string; hint: string }> = [
  { id: "ask", label: "Perguntar sempre", hint: "Toda ação que altera o projeto pede sua aprovação" },
  { id: "edits", label: "Aprovar edições", hint: "Edições de arquivo passam direto; comandos ainda pedem aval" },
  { id: "all", label: "Aprovar tudo", hint: "Nenhuma confirmação — inclusive comandos de terminal" }
];

/**
 * Decide se a chamada precisa parar e perguntar, dada a política ativa.
 * Ferramentas só-leitura nunca perguntam, em qualquer política.
 */
export function requiresPrompt(call: ToolCall, policy: ApprovalPolicy): boolean {
  if (!needsApproval(call)) return false;
  if (policy === "all") return false;
  if (policy === "edits") return call.tool !== "fs_write";
  return true;
}

/** Rótulo curto para o chip do composer. */
export function policyLabel(policy: ApprovalPolicy): string {
  return APPROVAL_POLICIES.find((item) => item.id === policy)?.label ?? "Perguntar sempre";
}
