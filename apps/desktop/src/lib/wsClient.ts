/**
 * Cliente do canal bidirecional — a parte com efeito.
 *
 * A lógica de correção está em `wsProtocol.ts` (pura, testada). Aqui só o que
 * precisa de socket: abrir, autenticar, reinscrever e reenviar.
 *
 * ## A propriedade que este arquivo existe para garantir
 *
 * **Reconectar não abre buraco no log.** Cada run guarda o `seq` do último
 * evento JÁ RECEBIDO; ao reabrir, a inscrição pede `fromSeq` = esse cursor, e o
 * servidor faz replay do que faltou. Sem isso, uma queda de rede de dois
 * segundos no meio de uma onda paralela perderia os eventos daquele intervalo
 * em silêncio — e um log de auditoria com buraco silencioso é pior que não ter
 * log, porque parece completo.
 *
 * O socket é injetável (`socketFactory`) para o caminho de reconexão poder ser
 * testado sem rede.
 */
import {
  authFrame,
  cancelFrame,
  decideFrame,
  eventsFrame,
  mergeEvents,
  nextBackoff,
  parseFrame,
  subscribeFrame,
  type RunEvent,
  type ServerFrame
} from "./wsProtocol";

/** Subconjunto do `WebSocket` que usamos — o que o fake precisa implementar. */
export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  onopen: ((this: unknown, event: unknown) => void) | null;
  onmessage: ((this: unknown, event: { data: unknown }) => void) | null;
  onclose: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface ChannelHandlers {
  /** Eventos novos de um run, já deduplicados e em ordem. */
  onEvents?: (runId: string, events: RunEvent[]) => void;
  /** O gateway confirmou até `lastSeq` — hora de avançar o cursor local. */
  onAck?: (runId: string, lastSeq: number, accepted: number) => void;
  onDecided?: (approvalId: string, status: string) => void;
  onStatus?: (state: ChannelState) => void;
  onError?: (code: string, message: string) => void;
}

export type ChannelState = "idle" | "connecting" | "open" | "closed";

interface Subscription {
  /** Último `seq` recebido. É o cursor de retomada. */
  cursor: number;
}

export interface RunChannel {
  subscribe: (runId: string, fromSeq?: number) => void;
  unsubscribe: (runId: string) => void;
  push: (runId: string, events: readonly RunEvent[]) => void;
  decide: (approvalId: string, approved: boolean) => void;
  cancel: (runId: string) => void;
  state: () => ChannelState;
  /** Cursor conhecido de um run — o que a próxima inscrição pediria. */
  cursor: (runId: string) => number;
  close: () => void;
}

export interface ChannelOptions {
  url: string;
  /** Devolvido a cada (re)conexão: token pode ter sido renovado no meio. */
  token: () => string;
  handlers?: ChannelHandlers;
  socketFactory?: SocketFactory;
  /** Injetável para o teste não depender de tempo real. */
  schedule?: (callback: () => void, delayMs: number) => void;
}

function defaultFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function createRunChannel(options: ChannelOptions): RunChannel {
  const factory = options.socketFactory ?? defaultFactory;
  const schedule =
    options.schedule ?? ((callback: () => void, delay: number) => void setTimeout(callback, delay));
  const handlers = options.handlers ?? {};

  const subscriptions = new Map<string, Subscription>();
  /**
   * Eventos produzidos localmente enquanto o socket estava fora.
   *
   * Descartar seria perder o log do que rodou offline — que é exatamente o
   * cenário do local-first. Eles sobem no `push` da reconexão.
   */
  const outbox = new Map<string, RunEvent[]>();

  let socket: SocketLike | null = null;
  let state: ChannelState = "idle";
  let authed = false;
  let attempt = 0;
  let fechado = false;

  function setState(next: ChannelState) {
    if (state === next) return;
    state = next;
    handlers.onStatus?.(next);
  }

  function sendRaw(frame: string): boolean {
    if (!socket || !authed) return false;
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  function flush(runId: string) {
    const fila = outbox.get(runId);
    if (!fila?.length) return;
    if (sendRaw(eventsFrame(runId, fila))) {
      // Só limpa depois do envio: falhar aqui e limpar mesmo assim perderia o
      // log offline de vez.
      outbox.delete(runId);
    }
  }

  function onFrame(frame: ServerFrame) {
    switch (frame.type) {
      case "hello": {
        authed = true;
        attempt = 0;
        setState("open");
        // Reinscreve TUDO a partir do cursor — é o passo que fecha o buraco.
        for (const [runId, sub] of subscriptions) {
          sendRaw(subscribeFrame(runId, sub.cursor));
          flush(runId);
        }
        break;
      }
      case "events": {
        const sub = subscriptions.get(frame.runId);
        if (!frame.events.length) break;
        const ordenados = mergeEvents([], frame.events);
        const maior = ordenados.at(-1)?.seq ?? 0;
        // `Math.max`: um replay atrasado não pode andar para trás com o cursor.
        if (sub) sub.cursor = Math.max(sub.cursor, maior);
        handlers.onEvents?.(frame.runId, ordenados);
        break;
      }
      case "ack": {
        handlers.onAck?.(frame.runId, frame.lastSeq, frame.accepted);
        break;
      }
      case "lagged": {
        // O canal em memória estourou e o servidor avisou quantos caíram. A
        // recuperação é reinscrever do cursor: o Postgres tem tudo.
        const sub = subscriptions.get(frame.runId);
        if (sub) sendRaw(subscribeFrame(frame.runId, sub.cursor));
        break;
      }
      case "decided": {
        handlers.onDecided?.(frame.approvalId, frame.status);
        break;
      }
      case "error": {
        handlers.onError?.(frame.code, frame.message);
        break;
      }
      default:
        break;
    }
  }

  function connect() {
    if (fechado || socket) return;
    setState("connecting");
    authed = false;
    const atual = factory(options.url);
    socket = atual;
    atual.onopen = () => {
      // Autenticação é o PRIMEIRO frame — o token não vai na URL (ver ws.rs).
      try {
        atual.send(authFrame(options.token()));
      } catch {
        /* o onclose cuida da reconexão */
      }
    };
    atual.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const frame = parseFrame(event.data);
      if (frame) onFrame(frame);
    };
    atual.onclose = () => {
      if (socket !== atual) return;
      socket = null;
      authed = false;
      setState("closed");
      if (fechado) return;
      const espera = nextBackoff(attempt);
      attempt += 1;
      schedule(connect, espera);
    };
    atual.onerror = () => {
      // `onerror` não implica fechado em todo runtime; fechar à mão garante que
      // o caminho de reconexão rode uma vez só, pelo `onclose`.
      try {
        atual.close();
      } catch {
        /* ignora */
      }
    };
  }

  connect();

  return {
    subscribe(runId, fromSeq = 0) {
      const atual = subscriptions.get(runId);
      const cursor = Math.max(atual?.cursor ?? 0, Math.max(0, Math.trunc(fromSeq)));
      subscriptions.set(runId, { cursor });
      sendRaw(subscribeFrame(runId, cursor));
    },
    unsubscribe(runId) {
      subscriptions.delete(runId);
      outbox.delete(runId);
      sendRaw(JSON.stringify({ type: "unsubscribe", runId }));
    },
    push(runId, events) {
      const lote = mergeEvents([], events);
      if (!lote.length) return;
      if (!sendRaw(eventsFrame(runId, lote))) {
        // Offline: acumula para subir na reconexão.
        outbox.set(runId, mergeEvents(outbox.get(runId) ?? [], lote));
      }
    },
    decide(approvalId, approved) {
      sendRaw(decideFrame(approvalId, approved));
    },
    cancel(runId) {
      sendRaw(cancelFrame(runId));
    },
    state: () => state,
    cursor: (runId) => subscriptions.get(runId)?.cursor ?? 0,
    close() {
      fechado = true;
      const atual = socket;
      socket = null;
      setState("idle");
      try {
        atual?.close();
      } catch {
        /* ignora */
      }
    }
  };
}
