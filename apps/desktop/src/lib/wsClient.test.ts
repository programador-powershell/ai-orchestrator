import { describe, expect, it } from "vitest";
import { createRunChannel, type SocketLike } from "./wsClient";
import type { RunEvent } from "./wsProtocol";

/** Socket falso: registra o que foi enviado e deixa o teste empurrar frames. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((this: unknown, event: unknown) => void) | null = null;
  onmessage: ((this: unknown, event: { data: unknown }) => void) | null = null;
  onclose: ((this: unknown, event: unknown) => void) | null = null;
  onerror: ((this: unknown, event: unknown) => void) | null = null;

  send(data: string) {
    if (this.closed) throw new Error("socket fechado");
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.call(null, {});
  }
  /* -------- gatilhos do teste -------- */
  open() {
    this.onopen?.call(null, {});
  }
  deliver(frame: unknown) {
    this.onmessage?.call(null, { data: JSON.stringify(frame) });
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((frame) => frame.type === type);
  }
}

/** Ambiente de teste: fábrica que devolve sockets em sequência + relógio manual. */
function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const channel = createRunChannel({
    url: "wss://gw.test/v1/workspaces/w1/ws",
    token: () => "tok-123",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
    },
    handlers: {
      onEvents: (runId, events) => received.push([runId, events]),
      onAck: (runId, lastSeq) => acks.push([runId, lastSeq])
    }
  });
  const received: Array<[string, RunEvent[]]> = [];
  const acks: Array<[string, number]> = [];
  /** Roda o próximo timer agendado (a reconexão). */
  const tick = () => {
    const next = timers.shift();
    next?.callback();
    return next?.delayMs ?? 0;
  };
  return { channel, sockets, timers, tick, received, acks };
}

const ev = (seq: number, kind = "log"): RunEvent => ({ seq, kind, nodeId: "", payload: {} });

/** Abre e autentica o socket `index`. */
function handshake(h: ReturnType<typeof harness>, index = 0) {
  const socket = h.sockets[index];
  socket.open();
  socket.deliver({ type: "hello", userId: "u1", workspace: "w1" });
  return socket;
}

describe("createRunChannel", () => {
  it("autentica com o token no CORPO do primeiro frame", () => {
    const h = harness();
    const socket = h.sockets[0];
    socket.open();
    expect(socket.frames()[0]).toEqual({ type: "auth", token: "tok-123" });
    // O token não pode aparecer na URL em nenhuma hipótese.
    expect(h.channel.state()).not.toBe("open");
  });

  it("só considera aberto depois do hello", () => {
    const h = harness();
    h.sockets[0].open();
    expect(h.channel.state()).toBe("connecting");
    h.sockets[0].deliver({ type: "hello", userId: "u", workspace: "w" });
    expect(h.channel.state()).toBe("open");
  });

  it("avança o cursor com os eventos recebidos", () => {
    const h = harness();
    const socket = handshake(h);
    h.channel.subscribe("r1", 0);
    socket.deliver({ type: "events", runId: "r1", events: [ev(1), ev(2), ev(3)] });
    expect(h.channel.cursor("r1")).toBe(3);
    expect(h.received[0][1].map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("replay atrasado não anda para trás com o cursor", () => {
    const h = harness();
    const socket = handshake(h);
    h.channel.subscribe("r1", 0);
    socket.deliver({ type: "events", runId: "r1", events: [ev(5)] });
    socket.deliver({ type: "events", runId: "r1", events: [ev(2)] });
    expect(h.channel.cursor("r1")).toBe(5);
  });

  it("RECONECTAR REINSCREVE DO CURSOR — é a propriedade central", () => {
    const h = harness();
    const primeiro = handshake(h);
    h.channel.subscribe("r1", 0);
    primeiro.deliver({ type: "events", runId: "r1", events: [ev(1), ev(2), ev(3)] });

    // Cai a rede.
    primeiro.close();
    expect(h.channel.state()).toBe("closed");

    // Reconecta (o backoff foi agendado, não dormido).
    const espera = h.tick();
    expect(espera).toBe(500);
    const segundo = handshake(h, 1);

    // A reinscrição pede de 3 em diante: sem isto os eventos 4 e 5 que
    // aconteceram durante a queda sumiriam sem ninguém notar.
    expect(segundo.ofType("subscribe")).toEqual([{ type: "subscribe", runId: "r1", fromSeq: 3 }]);
  });

  it("backoff cresce entre tentativas falhas", () => {
    const h = harness();
    h.sockets[0].open();
    h.sockets[0].close();
    expect(h.tick()).toBe(500);
    h.sockets[1].open();
    h.sockets[1].close();
    expect(h.tick()).toBe(1_000);
    h.sockets[2].open();
    h.sockets[2].close();
    expect(h.tick()).toBe(2_000);
  });

  it("hello zera o backoff — queda depois de sessão boa recomeça rápido", () => {
    const h = harness();
    h.sockets[0].open();
    h.sockets[0].close();
    expect(h.tick()).toBe(500);
    // Segunda tentativa vai até o hello: a contagem reinicia.
    handshake(h, 1);
    h.sockets[1].close();
    expect(h.tick()).toBe(500);
  });

  it("lagged reinscreve do cursor em vez de aceitar buraco", () => {
    const h = harness();
    const socket = handshake(h);
    h.channel.subscribe("r1", 0);
    socket.deliver({ type: "events", runId: "r1", events: [ev(1), ev(2)] });
    const antes = socket.ofType("subscribe").length;
    socket.deliver({ type: "lagged", runId: "r1", dropped: 40 });
    const depois = socket.ofType("subscribe");
    expect(depois).toHaveLength(antes + 1);
    expect(depois.at(-1)).toEqual({ type: "subscribe", runId: "r1", fromSeq: 2 });
  });

  it("push offline acumula e sobe na reconexão", () => {
    const h = harness();
    // Nunca autenticou: o push não tem para onde ir.
    h.channel.subscribe("r1", 0);
    h.channel.push("r1", [ev(1), ev(2)]);
    expect(h.sockets[0].ofType("events")).toEqual([]);

    // Autentica: o que ficou na fila sobe junto com a reinscrição.
    const socket = handshake(h);
    const enviados = socket.ofType("events");
    expect(enviados).toHaveLength(1);
    expect((enviados[0].events as RunEvent[]).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("push offline não duplica evento já enfileirado", () => {
    const h = harness();
    h.channel.subscribe("r1", 0);
    h.channel.push("r1", [ev(1)]);
    h.channel.push("r1", [ev(1), ev(2)]);
    const socket = handshake(h);
    const enviados = socket.ofType("events");
    expect((enviados[0].events as RunEvent[]).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("ack chega para quem avança o cursor local", () => {
    const h = harness();
    const socket = handshake(h);
    h.channel.subscribe("r1", 0);
    socket.deliver({ type: "ack", runId: "r1", lastSeq: 9, accepted: 4 });
    expect(h.acks).toEqual([["r1", 9]]);
  });

  it("close não reconecta", () => {
    const h = harness();
    handshake(h);
    h.channel.close();
    expect(h.timers).toHaveLength(0);
    expect(h.channel.state()).toBe("idle");
  });

  it("frame corrompido não derruba o canal", () => {
    const h = harness();
    const socket = handshake(h);
    socket.onmessage?.call(null, { data: "{lixo" });
    socket.onmessage?.call(null, { data: JSON.stringify({ type: "tipo_do_futuro" }) });
    expect(h.channel.state()).toBe("open");
  });
});
