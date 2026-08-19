/**
 * O contrato do fio.
 *
 * Duas invariantes, e as duas são de PERDA DE DADO — não de estética:
 *
 * 1. O marco do replay (`lastSeq`) só anda depois que o envelope foi
 *    REALMENTE aplicado. Se ele andasse antes, um envelope que a redução
 *    recusasse ficaria para trás com o marco à frente, e o `resumeFrom` da
 *    reconexão pediria a partir de um ponto DEPOIS do buraco: a linha some da
 *    conversa e nunca mais volta.
 *
 * 2. A recusa do gateway chega à tela com a FRASE dele, não com o número. O
 *    409 de ambiente indisponível carrega o que a pessoa precisa fazer
 *    ("instale o Docker Desktop e o sbx…"); "409" não carrega nada.
 *
 * O WebSocket é falso de propósito: o que se testa aqui é a ordem das coisas,
 * e subir um servidor para isso só acrescentaria relógio e porta ao teste.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Envelope, Hello } from "@aibot/contracts";
import { createTransport, failureMessage, gatewayReason } from "./transport";

const URL_GATEWAY = "ws://127.0.0.1:8799/v1/stream";

/* ------------------------------ o fio de mentira -------------------------- */

type Handler = ((event?: unknown) => void) | null;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  /** O que o gateway mandou pelo fio. */
  deliver(envelope: Envelope): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  /** A queda: é ela que agenda a reconexão. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({});
  }
}

let sockets: FakeSocket[] = [];

/** O `resumeFrom` que o `hello` desta conexão pediu. */
function resumeAsked(socket: FakeSocket): number {
  const first = socket.sent[0];
  if (first === undefined) throw new Error("esta conexão não mandou hello");
  const envelope = JSON.parse(first) as Envelope;
  return (envelope.payload as Hello).resumeFrom ?? -1;
}

function line(seq: number, text: string): Envelope {
  return {
    v: 1,
    id: `env-${seq}`,
    ts: "2026-08-14T12:00:00.000Z",
    seq,
    session: "sessao-1",
    turn: "t-1",
    kind: "delta",
    from: { kind: "specialist", specialist: "chat" },
    payload: { text }
  };
}

/** Abre a próxima conexão pendente e devolve o socket dela. */
function connect(index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`nenhuma conexão de índice ${index}`);
  socket.onopen?.({});
  return socket;
}

/* --------------------------------- o marco -------------------------------- */

describe("marco do replay", () => {
  let logged: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("não avança quando a aplicação do envelope falha, e o replay pede o mesmo de volta", () => {
    const applied: number[] = [];
    let breakOnce = true;

    const transport = createTransport({
      url: URL_GATEWAY,
      token: "segredo",
      onEnvelope: (envelope) => {
        if (breakOnce) {
          breakOnce = false;
          // O que acontece de verdade: a redução do store tropeça num payload
          // que ela não esperava. A exceção sobe por `receive` e por
          // `onmessage`, onde ninguém a pega.
          throw new Error("a redução recusou este envelope");
        }
        applied.push(envelope.seq);
      },
      onStatus: () => {}
    });

    transport.start();
    const first = connect(0);
    expect(resumeAsked(first)).toBe(0);

    first.deliver(line(7, "metade da resposta"));
    // Nada foi aplicado: o envelope se perdeu no caminho.
    expect(applied).toEqual([]);
    expect(logged).toHaveBeenCalled();

    // A conexão cai e volta. É AQUI que o defeito aparecia: o marco tinha ido
    // para 7 sem o 7 ter sido aplicado, e o gateway repetia só do 8 em diante.
    first.drop();
    vi.advanceTimersByTime(20_000);
    const second = connect(1);
    expect(resumeAsked(second)).toBe(0);

    // O replay traz o mesmo envelope; desta vez a redução aceita.
    second.deliver(line(7, "metade da resposta"));
    expect(applied).toEqual([7]);

    // Agora sim o marco andou: a próxima reconexão continua de onde parou.
    second.drop();
    vi.advanceTimersByTime(20_000);
    expect(resumeAsked(connect(2))).toBe(7);
  });

  it("avança com o maior `seq` aplicado e ignora envelope atrasado", () => {
    const transport = createTransport({
      url: URL_GATEWAY,
      token: "segredo",
      onEnvelope: () => {},
      onStatus: () => {}
    });

    transport.start();
    const first = connect(0);
    first.deliver(line(4, "a"));
    first.deliver(line(9, "b"));
    // Fora de ordem (replay que se cruzou com o vivo): o marco não retrocede.
    first.deliver(line(6, "c"));

    first.drop();
    vi.advanceTimersByTime(20_000);
    expect(resumeAsked(connect(1))).toBe(9);
  });
});

/* ------------------------------ a recusa do REST -------------------------- */

describe("post", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function transportWithFetch(response: Partial<Response> & { text?: () => Promise<string> }) {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn(async () => response as Response));
    return createTransport({
      url: URL_GATEWAY,
      token: "segredo",
      onEnvelope: () => {},
      onStatus: () => {}
    });
  }

  it("lança a frase acionável do gateway, com o status junto", async () => {
    const detail =
      "o Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx";
    const transport = transportWithFetch({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({ error: { code: "ambiente_indisponivel", message: detail } })
    });

    await expect(
      transport.post("/v1/sessions/s-1/environment", { environment: "docker" })
    ).rejects.toThrow(detail);

    // O status continua no texto: é ele que faz a ponte com o log do gateway.
    await expect(
      transport.post("/v1/sessions/s-1/environment", { environment: "docker" })
    ).rejects.toThrow("409");
  });

  it("cai no status quando o corpo não traz motivo", async () => {
    const transport = transportWithFetch({ ok: false, status: 500, text: async () => "" });

    await expect(transport.post("/v1/sessions/s-1/environment", {})).rejects.toThrow(
      "o gateway recusou /v1/sessions/s-1/environment com 500"
    );
  });

  it("não deixa o corpo ilegível virar exceção nova", async () => {
    const transport = transportWithFetch({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("conexão cortada no meio do corpo");
      }
    });

    await expect(transport.post("/v1/x", {})).rejects.toThrow("o gateway recusou /v1/x com 502");
  });

  it("resolve quando o gateway aceita", async () => {
    const transport = transportWithFetch({ ok: true, status: 204, text: async () => "" });
    await expect(transport.post("/v1/x", {})).resolves.toBeUndefined();
  });

  it("envia PATCH autenticado com o corpo da alteração", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, status: 200, text: async () => "{}" }) as Response
    );
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", fetch);
    const transport = createTransport({
      url: URL_GATEWAY,
      token: "segredo",
      onEnvelope: () => {},
      onStatus: () => {}
    });

    await transport.patch("/v1/catalog/providers/xai", { enabled: true, apiKey: "xai-key" });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8799/v1/catalog/providers/xai",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: true, apiKey: "xai-key" })
      })
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer segredo");
  });
});

describe("gatewayReason", () => {
  it("lê o `error.message` do contrato e ignora o resto", () => {
    expect(gatewayReason('{"error":{"code":"x","message":"  falta o sbx  "}}')).toBe("falta o sbx");
    expect(gatewayReason("")).toBe("");
    expect(gatewayReason("<html>502 Bad Gateway</html>")).toBe("");
    expect(gatewayReason('{"error":"texto solto"}')).toBe("");
    expect(gatewayReason('{"mensagem":"outro formato"}')).toBe("");
    expect(gatewayReason("null")).toBe("");
  });

  it("`failureMessage` mantém o caminho quando não há motivo", () => {
    expect(failureMessage("/v1/x", 404, "")).toBe("o gateway recusou /v1/x com 404");
    expect(failureMessage("/v1/x", 409, '{"error":{"message":"instale o sbx"}}')).toBe(
      "instale o sbx (409)"
    );
  });
});
