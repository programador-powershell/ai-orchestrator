/**
 * Política herdada do servidor — o lado do CLIENTE.
 *
 * Aqui é a camada 3 do enforcement (conveniência): a UI deriva o que exibe de
 * allowedModes e trava os controles que a política governa. A segurança real
 * está nas camadas 1 e 2 — o 404 por módulo no gateway e os comandos
 * compilados fora na edição managed. A verificação da assinatura acontece no
 * Rust (src-tauri/src/policy.rs), nunca aqui.
 */

import { UI_MODES, type BootstrapPolicy, type UiMode } from "@ai-orchestrator/contracts";
import type { ApprovalPolicy } from "./approval";
import type { ChatMessage } from "./gateway";

/**
 * Abas efetivas: allowedModes ∩ preferência local, na ordem canônica.
 * Sem política (gateway não conectado / gating não configurado) vale só a
 * preferência — o comportamento de hoje. Política com lista vazia devolve
 * vazio MESMO: o chamador decide o que mostrar, não inventamos uma aba.
 */
export function effectiveModes(
  allowed: readonly string[] | null | undefined,
  visible: readonly UiMode[]
): UiMode[] {
  const base = UI_MODES.filter((mode) => visible.includes(mode));
  if (!allowed) return base;
  return base.filter((mode) => allowed.includes(mode));
}

/** O modo renderizável AGORA — nunca uma aba fora da política. */
export function safeMode(current: UiMode, modes: readonly UiMode[]): UiMode | null {
  if (modes.includes(current)) return current;
  return modes[0] ?? null;
}

/** Teto de esforço da política: o slider pode pedir 4, o grupo pode limitar. */
export function clampEffort(effort: number, policy: BootstrapPolicy | null): number {
  if (!policy) return effort;
  return Math.min(effort, policy.effortMax);
}

/** Com política presente, a aprovação é a do servidor — sempre. */
export function effectiveApproval(
  policy: BootstrapPolicy | null,
  local: ApprovalPolicy | undefined
): ApprovalPolicy {
  if (policy) return policy.approvalPolicy;
  return local ?? "ask";
}

export function effectiveAgentTools(policy: BootstrapPolicy | null, local: boolean): boolean {
  if (policy) return policy.agentTools;
  return local;
}

/**
 * Mensagens de sistema do prompt master, na ordem do ADR: o do SERVIDOR
 * primeiro; o local só se o servidor permitir append, cortado no teto — e
 * dizendo explicitamente que o do servidor manda em conflito.
 */
export function promptMasterMessages(
  policy: BootstrapPolicy | null,
  localPrompt: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const master = policy?.promptMaster;
  if (master?.content.trim()) {
    messages.push({ role: "system", content: master.content.trim() });
  }
  const local = localPrompt.trim();
  if (!local) return messages;
  if (master && !master.allowLocalAppend) return messages;
  const limit = master?.localMaxChars ?? 4000;
  const clipped = local.length > limit ? `${local.slice(0, limit)}\n[... prompt local truncado ...]` : local;
  messages.push({
    role: "system",
    content: master
      ? `Instruções locais da sessão (complementares; em conflito, as instruções da organização acima prevalecem):\n${clipped}`
      : clipped
  });
  return messages;
}

export type { BootstrapPolicy };
