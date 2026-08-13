/**
 * Auditoria das execuções do agente na estação (`computer_exec`).
 *
 * ## Por que uma trilha própria, e não `usage_events`
 *
 * `usage_events` responde "quanto de MODELO foi consumido". Misturar ação de
 * agente ali inflaria `calls` no relatório de custo e diluiria o percentual de
 * chamadas medidas — o número ficaria errado com cara de certo, que é
 * exatamente o que a relatoria foi feita para evitar. São perguntas
 * diferentes: uma é gasto, a outra é "o que a IA rodou na máquina de quem".
 *
 * ## Por que o comando é redigido antes de sair
 *
 * O comando É o registro de auditoria — sem ele a trilha não serve para nada.
 * Só que um comando pode carregar credencial (`curl -H "Authorization: Bearer
 * …"`, `PGPASSWORD=…`), e a política da empresa proíbe persistir segredo. A
 * saída é redigir os padrões conhecidos ANTES de enviar: o que vai para o banco
 * preserva a forma do comando e perde o valor sensível.
 *
 * A redação é feita no CLIENTE, não no servidor: assim o segredo nunca chega
 * a trafegar.
 *
 * Módulo puro na parte que importa (a redação) — coberto por agentAudit.test.ts.
 */
import type { GatewaySession } from "./gateway";

/** Marca visível: quem lê a trilha precisa saber que houve corte. */
export const REDACTED = "«redigido»";

/**
 * Padrões redigidos. Espelham as regras do scanner de segredos da aba
 * Security (lib/scan.ts) — mesma família de achados, aplicada na saída.
 */
const REDACTIONS: Array<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // Authorization: Bearer <token>
  { pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{12,}/gi, replace: (_m, prefix) => `${prefix}${REDACTED}` },
  // chave de API em variável/flag: KEY=valor, --token valor, "secret": "valor"
  {
    pattern:
      /\b((?:password|passwd|pwd|senha|api[_-]?key|apikey|secret|token|pgpassword|access[_-]?key)\s*[:=]\s*)(["']?)([^\s"';|&]{4,})\2/gi,
    replace: (_m, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`
  },
  { pattern: /(--(?:password|token|api-key|secret)[= ])(\S{4,})/gi, replace: (_m, prefix) => `${prefix}${REDACTED}` },
  // chaves com forma própria
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  { pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: () => REDACTED },
  { pattern: /\bsk-[A-Za-z0-9\-_]{16,}\b/g, replace: () => REDACTED },
  // JWT
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replace: () => REDACTED },
  // usuário:senha dentro de URL de conexão
  {
    pattern: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|mssql|https?):\/\/[^\s/:@]+:)[^\s@/]+@/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}@`
  }
];

/** Teto do que é persistido — comando gigante é ruído, não auditoria. */
const MAX_COMMAND = 2_000;

/**
 * Remove segredos conhecidos preservando a forma do comando.
 *
 * Não é garantia: um segredo em formato desconhecido passa. A trilha é para
 * responder "o que foi executado", não para ser um cofre — e isso precisa
 * estar dito na homologação.
 */
export function redactCommand(command: string): string {
  let out = command;
  for (const rule of REDACTIONS) {
    out = out.replace(rule.pattern, rule.replace as never);
  }
  return out.length > MAX_COMMAND ? `${out.slice(0, MAX_COMMAND)}… (truncado)` : out;
}

export interface AgentActionRecord {
  /** Rótulo do agente que pediu — numa árvore, saber quem pediu importa. */
  agent: string;
  /** Objetivo da execução, para dar contexto à linha da trilha. */
  goal: string;
  command: string;
  approved: boolean;
  exitCode: number | null;
  durationMs: number;
  /** O comando rodou dentro do Job Object? */
  jailed: boolean;
}

export interface AuditOutcome {
  recorded: boolean;
  /** Motivo quando não deu — vira aviso na UI, nunca silêncio. */
  reason?: string;
}

/**
 * Envia a linha de auditoria. **Best-effort de propósito**: falhar aqui não
 * pode derrubar a execução do agente, mas também não pode passar em silêncio —
 * quem chama mostra o aviso.
 *
 * Sem sessão com o gateway não há a quem auditar; o chamador decide se isso
 * bloqueia (política) ou só avisa.
 */
export async function recordAgentAction(
  session: GatewaySession | null,
  record: AgentActionRecord
): Promise<AuditOutcome> {
  if (!session?.accessToken || !session.workspaceId) {
    return { recorded: false, reason: "sem sessão com o gateway — execução não auditada" };
  }
  try {
    const response = await fetch(
      `${session.baseUrl.replace(/\/$/, "")}/v1/workspaces/${session.workspaceId}/agent-actions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          agent: record.agent.slice(0, 120),
          goal: record.goal.slice(0, 500),
          // A redação acontece AQUI: o segredo não chega a trafegar.
          command: redactCommand(record.command),
          approved: record.approved,
          exitCode: record.exitCode,
          durationMs: Math.max(0, Math.round(record.durationMs)),
          jailed: record.jailed
        })
      }
    );
    if (!response.ok) {
      return { recorded: false, reason: `gateway respondeu ${response.status} ao auditar` };
    }
    return { recorded: true };
  } catch (cause) {
    return {
      recorded: false,
      reason: cause instanceof Error ? `falha ao auditar: ${cause.message}` : "falha ao auditar"
    };
  }
}
