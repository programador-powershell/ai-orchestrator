import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/wsFrames.json";
import {
  MAX_BACKOFF_MS,
  authFrame,
  mergeEvents,
  nextBackoff,
  parseFrame,
  pendingBatch,
  subscribeFrame
} from "./wsProtocol";
import type { RunEvent } from "./wsProtocol";

const ev = (seq: number, kind = "log"): RunEvent => ({ seq, kind, nodeId: "", payload: {} });

describe("mergeEvents", () => {
  it("ordena por seq e descarta repetido", () => {
    // O replay e o vivo se sobrepõem de propósito (inscrição antes do replay):
    // sem dedupe, o evento da virada apareceria duas vezes no log.
    const saida = mergeEvents([ev(1), ev(3)], [ev(3), ev(2), ev(4)]);
    expect(saida.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it("mantém o PRIMEIRO de um seq repetido — o log é imutável", () => {
    const saida = mergeEvents([ev(1, "node:start")], [ev(1, "adulterado")]);
    expect(saida).toEqual([{ seq: 1, kind: "node:start", nodeId: "", payload: {} }]);
  });

  it("não muta as entradas", () => {
    const atual = [ev(2)];
    const novos = [ev(1)];
    mergeEvents(atual, novos);
    expect(atual.map((i) => i.seq)).toEqual([2]);
    expect(novos.map((i) => i.seq)).toEqual([1]);
  });

  it("descarta seq inválido em vez de furar a ordem", () => {
    const saida = mergeEvents([], [ev(1), { ...ev(0), seq: 0 }, { ...ev(2), seq: -5 }]);
    expect(saida.map((item) => item.seq)).toEqual([1]);
  });
});

describe("pendingBatch", () => {
  it("manda só o que está acima do cursor confirmado", () => {
    const lote = pendingBatch([ev(1), ev(2), ev(3)], 1);
    expect(lote.map((item) => item.seq)).toEqual([2, 3]);
  });

  it("cursor no topo não manda nada", () => {
    expect(pendingBatch([ev(1), ev(2)], 2)).toEqual([]);
  });

  it("recorta o lote no teto do gateway", () => {
    // O gateway recusa lote acima de MAX_EVENT_BATCH; recortar aqui evita a
    // recusa em vez de descobri-la na resposta.
    const muitos = Array.from({ length: 900 }, (_, index) => ev(index + 1));
    const lote = pendingBatch(muitos, 0);
    expect(lote).toHaveLength(500);
    expect(lote.at(-1)?.seq).toBe(500);
  });

  it("cursor à frente do log não devolve nada (ack adiantado não quebra)", () => {
    expect(pendingBatch([ev(1)], 99)).toEqual([]);
  });
});

describe("nextBackoff", () => {
  it("cresce exponencialmente a partir da primeira falha", () => {
    expect(nextBackoff(0)).toBe(500);
    expect(nextBackoff(1)).toBe(1_000);
    expect(nextBackoff(2)).toBe(2_000);
    expect(nextBackoff(3)).toBe(4_000);
  });

  it("satura no teto — reconectar de 30s em 30s, não de 4h em 4h", () => {
    expect(nextBackoff(20)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(999)).toBe(MAX_BACKOFF_MS);
  });
});

describe("parseFrame", () => {
  it("lê um frame de eventos", () => {
    const frame = parseFrame(
      JSON.stringify({ type: "events", runId: "r1", events: [{ seq: 2, kind: "log" }] })
    );
    expect(frame).toEqual({
      type: "events",
      runId: "r1",
      events: [{ seq: 2, kind: "log", nodeId: "", payload: {} }]
    });
  });

  it("trata replay como events — a diferença é só o gatilho", () => {
    const frame = parseFrame(JSON.stringify({ type: "replay", runId: "r1", events: [] }));
    expect(frame).toEqual({ type: "events", runId: "r1", events: [] });
  });

  it("lê ack, lagged e error", () => {
    expect(parseFrame(JSON.stringify({ type: "ack", runId: "r", lastSeq: 7, accepted: 2 }))).toEqual({
      type: "ack",
      runId: "r",
      lastSeq: 7,
      accepted: 2
    });
    expect(parseFrame(JSON.stringify({ type: "lagged", runId: "r", dropped: 4 }))).toEqual({
      type: "lagged",
      runId: "r",
      dropped: 4
    });
    expect(parseFrame(JSON.stringify({ type: "error", code: "X", message: "m" }))).toEqual({
      type: "error",
      code: "X",
      message: "m"
    });
  });

  it("JSON inválido devolve null em vez de lançar", () => {
    // Frame corrompido não pode derrubar o socket inteiro.
    expect(parseFrame("{nao é json")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("tipo desconhecido devolve null — protocolo novo não quebra cliente velho", () => {
    expect(parseFrame(JSON.stringify({ type: "inventado_amanha" }))).toBeNull();
  });

  it("frame de eventos sem lista não vira crash", () => {
    expect(parseFrame(JSON.stringify({ type: "events", runId: "r" }))).toEqual({
      type: "events",
      runId: "r",
      events: []
    });
  });
});

describe("builders", () => {
  it("auth manda o token no CORPO, nunca na URL", () => {
    const frame = JSON.parse(authFrame("abc"));
    expect(frame).toEqual({ type: "auth", token: "abc" });
  });

  it("subscribe carrega o cursor de retomada", () => {
    expect(JSON.parse(subscribeFrame("r1", 12))).toEqual({
      type: "subscribe",
      runId: "r1",
      fromSeq: 12
    });
  });
});

describe("contrato com o servidor (fixture compartilhada)", () => {
  /*
   * O arquivo e ESCRITO pelo teste do gateway (`ws::contrato` em ws.rs) e
   * LIDO aqui. Os dois lados olhando o mesmo arquivo e o que faltava: a
   * divergencia que quebrou cinco dos sete comandos — o servidor esperando
   * `run_id` enquanto o cliente mandava `runId` — passava nos testes dos
   * dois lados, porque cada um so falava consigo mesmo.
   *
   * Quem mudar um frame no servidor reescreve a fixture, e este teste falha
   * na hora.
   */
  const frames = fixtures as Record<string, { type?: string }>;

  it("todo frame de saida do servidor e reconhecido pelo parseFrame", () => {
    for (const [nome, frame] of Object.entries(frames)) {
      const lido = parseFrame(JSON.stringify(frame));
      expect(lido, `frame "${nome}" foi descartado pelo cliente`).not.toBeNull();
    }
  });

  it("o lote do fanout ao vivo chega como 'events' — nao descartado", () => {
    /*
     * Este e o D2. O fanout publicava `{runId, events}` SEM `type`, o hub
     * repassava verbatim e o `parseFrame` devolvia null: o tempo real ficava
     * morto sem erro, sem log e sem socket fechado. Parecia "nao ha eventos".
     */
    const lido = parseFrame(JSON.stringify(frames.fanout));
    expect(lido?.type).toBe("events");
    if (lido?.type === "events") {
      expect(lido.events).toHaveLength(1);
      expect(lido.events[0].seq).toBe(1);
      expect(lido.events[0].nodeId).toBe("a");
    }
  });

  it("'replay' e normalizado para 'events' — a origem nao muda o tratamento", () => {
    const lido = parseFrame(JSON.stringify(frames.replay));
    expect(lido?.type).toBe("events");
  });

  it("os campos de cada frame batem um a um", () => {
    const ack = parseFrame(JSON.stringify(frames.ack));
    expect(ack).toMatchObject({ type: "ack", accepted: 1, lastSeq: 1 });

    const decided = parseFrame(JSON.stringify(frames.decided));
    expect(decided).toMatchObject({ type: "decided", status: "approved" });

    const lagged = parseFrame(JSON.stringify(frames.lagged));
    expect(lagged).toMatchObject({ type: "lagged", dropped: 3 });

    const erro = parseFrame(JSON.stringify(frames.error));
    expect(erro).toMatchObject({ type: "error", code: "BAD_FRAME" });

    expect(parseFrame(JSON.stringify(frames.pong))?.type).toBe("pong");
    expect(parseFrame(JSON.stringify(frames.hello))?.type).toBe("hello");
    expect(parseFrame(JSON.stringify(frames.unsubscribed))?.type).toBe("unsubscribed");
  });

  it("a fixture cobre TODOS os frames de saida — nenhum ficou sem teste", () => {
    // Se o servidor ganhar um frame novo e ninguem puser aqui, este teste
    // acusa: a lista e o contrato.
    expect(Object.keys(frames).sort()).toEqual([
      "ack",
      "decided",
      "error",
      "fanout",
      "hello",
      "lagged",
      "pong",
      "replay",
      "unsubscribed"
    ]);
  });
});
