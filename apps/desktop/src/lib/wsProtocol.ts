/**
 * Protocolo do canal bidirecional do harness — parte PURA.
 *
 * Toda a lógica que decide correção mora aqui, fora do `WebSocket`: cursor de
 * retomada, dedupe do log, recorte do lote e backoff. É o que dá para testar
 * sem socket, e é onde os bugs de sincronização de verdade acontecem.
 *
 * O lado com efeito (abrir, reconectar, reenviar) está em `wsClient.ts` e é
 * fino de propósito.
 */

export interface RunEvent {
  /** Contador POR RUN, atribuído por quem produz. Não é relógio. */
  seq: number;
  kind: string;
  nodeId: string;
  payload: unknown;
  ts?: string;
}

export type ServerFrame =
  | { type: "hello"; userId: string; workspace: string }
  | { type: "events"; runId: string; events: RunEvent[] }
  | { type: "ack"; runId: string; lastSeq: number; accepted: number }
  | { type: "lagged"; runId: string; dropped: number }
  | { type: "decided"; approvalId: string; status: string }
  | { type: "unsubscribed"; runId: string }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

/**
 * Teto de eventos por lote.
 *
 * Espelha `runs::MAX_EVENT_BATCH` do gateway. Recortar aqui transforma uma
 * recusa (descobrir na resposta que o lote era grande) em não-evento.
 */
export const MAX_BATCH = 500;

/** Primeiro atraso de reconexão. */
export const BASE_BACKOFF_MS = 500;
/**
 * Teto do backoff.
 *
 * Sem teto, uma queda longa levaria o intervalo a horas e o app pareceria
 * morto depois que a rede voltasse.
 */
export const MAX_BACKOFF_MS = 30_000;

function normalize(event: unknown): RunEvent | null {
  if (!event || typeof event !== "object") return null;
  const bruto = event as Record<string, unknown>;
  const seq = Number(bruto.seq);
  // `seq` tem de ser inteiro positivo: é a chave do log. Zero ou negativo
  // furaria a ordem e o gateway recusaria o lote inteiro por causa de um item.
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return {
    seq,
    kind: typeof bruto.kind === "string" ? bruto.kind : "",
    nodeId: typeof bruto.nodeId === "string" ? bruto.nodeId : "",
    payload: bruto.payload ?? {},
    ...(typeof bruto.ts === "string" ? { ts: bruto.ts } : {})
  };
}

/**
 * Junta o log atual com os que chegaram, por `seq`, sem repetir.
 *
 * O primeiro a ocupar um `seq` FICA: o log é append-only e imutável, então uma
 * segunda versão do mesmo número é retransmissão, não correção — aceitar a
 * segunda deixaria o replay reescrever história já exibida.
 */
export function mergeEvents(current: readonly RunEvent[], incoming: readonly unknown[]): RunEvent[] {
  const porSeq = new Map<number, RunEvent>();
  for (const event of current) {
    const limpo = normalize(event);
    if (limpo && !porSeq.has(limpo.seq)) porSeq.set(limpo.seq, limpo);
  }
  for (const event of incoming) {
    const limpo = normalize(event);
    if (limpo && !porSeq.has(limpo.seq)) porSeq.set(limpo.seq, limpo);
  }
  return [...porSeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * O que falta subir: acima do cursor confirmado, recortado no teto.
 *
 * Cursor à frente do log (ack de um lote que este cliente não tem) devolve
 * vazio em vez de índice negativo — acontece quando outra máquina empurrou
 * eventos do mesmo run.
 */
export function pendingBatch(log: readonly RunEvent[], syncedSeq: number): RunEvent[] {
  const cursor = Number.isFinite(syncedSeq) ? Math.max(0, syncedSeq) : 0;
  const pendentes = log.filter((event) => event.seq > cursor).sort((a, b) => a.seq - b.seq);
  return pendentes.slice(0, MAX_BATCH);
}

/** Atraso da próxima tentativa. `attempt` 0 é a primeira falha. */
export function nextBackoff(attempt: number): number {
  const passos = Math.max(0, Math.trunc(attempt));
  // `2 ** passos` com passos grande vira Infinity; o min resolve antes disso
  // importar, mas o clamp do expoente evita depender de aritmética de ponto
  // flutuante para a garantia.
  const expoente = Math.min(passos, 20);
  return Math.min(BASE_BACKOFF_MS * 2 ** expoente, MAX_BACKOFF_MS);
}

/**
 * Interpreta um frame do servidor. `null` = ignore.
 *
 * Tipo desconhecido devolve `null` em vez de lançar: o vocabulário do harness
 * vai crescer, e um cliente velho falando com um gateway novo deve ignorar o
 * que não entende, não cair.
 */
export function parseFrame(raw: string): ServerFrame | null {
  let dados: unknown;
  try {
    dados = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!dados || typeof dados !== "object") return null;
  const frame = dados as Record<string, unknown>;
  const tipo = frame.type;

  // `replay` e `events` só diferem no gatilho; quem consome trata igual.
  if (tipo === "events" || tipo === "replay") {
    const lista = Array.isArray(frame.events) ? frame.events : [];
    return {
      type: "events",
      runId: String(frame.runId ?? ""),
      events: mergeEvents([], lista)
    };
  }
  if (tipo === "ack") {
    return {
      type: "ack",
      runId: String(frame.runId ?? ""),
      lastSeq: Number(frame.lastSeq ?? 0),
      accepted: Number(frame.accepted ?? 0)
    };
  }
  if (tipo === "lagged") {
    return { type: "lagged", runId: String(frame.runId ?? ""), dropped: Number(frame.dropped ?? 0) };
  }
  if (tipo === "hello") {
    return { type: "hello", userId: String(frame.userId ?? ""), workspace: String(frame.workspace ?? "") };
  }
  if (tipo === "decided") {
    return {
      type: "decided",
      approvalId: String(frame.approvalId ?? ""),
      status: String(frame.status ?? "")
    };
  }
  if (tipo === "unsubscribed") {
    return { type: "unsubscribed", runId: String(frame.runId ?? "") };
  }
  if (tipo === "pong") return { type: "pong" };
  if (tipo === "error") {
    return { type: "error", code: String(frame.code ?? ""), message: String(frame.message ?? "") };
  }
  return null;
}

/* ------------------------- Frames do cliente -------------------------- */

/**
 * O token vai no CORPO do primeiro frame.
 *
 * `?token=` seria mais simples e é o caminho errado: query string entra em log
 * de acesso, em proxy e no histórico. Aqui o bearer trafega dentro do TLS,
 * como em qualquer outra requisição.
 */
export function authFrame(token: string): string {
  return JSON.stringify({ type: "auth", token });
}

export function subscribeFrame(runId: string, fromSeq: number): string {
  return JSON.stringify({ type: "subscribe", runId, fromSeq: Math.max(0, Math.trunc(fromSeq)) });
}

export function eventsFrame(runId: string, events: readonly RunEvent[]): string {
  return JSON.stringify({ type: "events", runId, events });
}

export function decideFrame(approvalId: string, approved: boolean): string {
  return JSON.stringify({ type: "decide", approvalId, approved });
}

export function cancelFrame(runId: string): string {
  return JSON.stringify({ type: "cancel", runId });
}
