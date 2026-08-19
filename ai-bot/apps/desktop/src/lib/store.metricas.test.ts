/**
 * Métricas por mensagem e raciocínio recolhível — as duas coisas que o `done`
 * e o `thinking` passaram a carregar.
 *
 * Como em store.test.ts: `applyEnvelope` é pura, então aqui não há WebSocket,
 * React nem relógio — a duração vem dos TIMESTAMPS dos envelopes, e é isso que
 * o teste fixa: replay de amanhã mostra os mesmos números de hoje.
 */

import { describe, expect, it } from "vitest";
import type { Delta, Done, Envelope, EnvelopeKind, Message, Route, Thinking } from "@aibot/contracts";
import { applyEnvelope, initialAppData, ultimoTurnoDoUsuario, type AppData } from "./store";

let counter = 0;

function envelope<P>(
  kind: EnvelopeKind,
  payload: P,
  options: { turn?: string; specialist?: string; ts?: string; from?: string } = {}
): Envelope {
  counter += 1;
  return {
    v: 1,
    id: `env-${counter}`,
    ts: options.ts ?? "2026-08-19T12:00:00.000Z",
    seq: counter,
    session: "sessao-1",
    turn: options.turn ?? "t-1",
    kind,
    from: { kind: "specialist", id: options.from, specialist: options.specialist },
    payload
  };
}

function reduce(state: AppData, envelopes: Envelope[]): AppData {
  return envelopes.reduce(applyEnvelope, state);
}

const ROTA: Route = {
  specialist: "code",
  reason: "heuristic",
  confidence: 0.9,
  surface: "editor",
  model: "gpt-oss:20b"
};

describe("métricas do turno no done", () => {
  it("carimba duração (pelos timestamps) e tokens na última linha do assistente", () => {
    const state = reduce(initialAppData(), [
      envelope<Message>("message", { role: "user", text: "faça algo" }, { ts: "2026-08-19T12:00:00.000Z" }),
      envelope<Route>("route", ROTA, { specialist: "master", ts: "2026-08-19T12:00:01.000Z" }),
      envelope<Delta>("delta", { text: "feito" }, { specialist: "code", from: "code", ts: "2026-08-19T12:00:02.000Z" }),
      envelope<Done>("done", { turn: "t-1", outputTokens: 128 }, { ts: "2026-08-19T12:00:12.500Z" })
    ]);

    const resposta = state.lines[state.lines.length - 1];
    expect(resposta?.role).toBe("assistant");
    expect(resposta?.streaming).toBe(false);
    // 12.5 s entre a pergunta (primeiro envelope do turno) e o done.
    expect(resposta?.durationMs).toBe(12_500);
    expect(resposta?.outputTokens).toBe(128);
  });

  it("sem tokens no payload, a duração ainda vale — e tokens ficam de fora", () => {
    const state = reduce(initialAppData(), [
      envelope<Message>("message", { role: "user", text: "oi" }, { ts: "2026-08-19T12:00:00.000Z" }),
      envelope<Delta>("delta", { text: "olá" }, { specialist: "chat", from: "chat", ts: "2026-08-19T12:00:01.000Z" }),
      envelope<Done>("done", { turn: "t-1" }, { ts: "2026-08-19T12:00:03.000Z" })
    ]);

    const resposta = state.lines[state.lines.length - 1];
    expect(resposta?.durationMs).toBe(3000);
    expect(resposta?.outputTokens).toBeUndefined();
  });
});

describe("raciocínio no thinking", () => {
  it("acumula os pedaços marcados na linha do falante, e o orbe ganha rótulo fixo", () => {
    const state = reduce(initialAppData(), [
      envelope<Thinking>("thinking", { label: "preciso ler ", reasoning: true }, { from: "code", specialist: "code" }),
      envelope<Thinking>("thinking", { label: "o arquivo", reasoning: true }, { from: "code", specialist: "code" })
    ]);

    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]?.reasoning).toBe("preciso ler o arquivo");
    expect(state.lines[0]?.streaming).toBe(true);
    // O texto do raciocínio NÃO pisca no orbe — o rótulo é fixo.
    expect(state.thinking).toBe("raciocinando");
  });

  it("os deltas seguintes caem na MESMA linha que o raciocínio abriu", () => {
    const state = reduce(initialAppData(), [
      envelope<Thinking>("thinking", { label: "pensando...", reasoning: true }, { from: "code", specialist: "code" }),
      envelope<Delta>("delta", { text: "a resposta" }, { from: "code", specialist: "code" })
    ]);

    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]?.text).toBe("a resposta");
    expect(state.lines[0]?.reasoning).toBe("pensando...");
  });

  it("thinking SEM a marca continua sendo rótulo de orbe, como sempre foi", () => {
    const state = reduce(initialAppData(), [
      envelope<Thinking>("thinking", { label: "lendo o código" }, { from: "code" })
    ]);
    expect(state.thinking).toBe("lendo o código");
    expect(state.lines).toHaveLength(0);

    const closed = applyEnvelope(state, envelope<Thinking>("thinking", { label: "", done: true }, { from: "code" }));
    expect(closed.thinking).toBe("");
  });
});

describe("ultimoTurnoDoUsuario", () => {
  it("acha a última pergunta com seq real — a âncora do regenerar/editar", () => {
    const state = reduce(initialAppData(), [
      envelope<Message>("message", { role: "user", text: "primeira" }, { turn: "t-1" }),
      envelope<Done>("done", { turn: "t-1" }, { turn: "t-1" }),
      envelope<Message>("message", { role: "user", text: "segunda" }, { turn: "t-2" })
    ]);

    const alvo = ultimoTurnoDoUsuario(state.lines);
    expect(alvo?.text).toBe("segunda");
    expect(alvo?.turn).toBe("t-2");
    expect(alvo?.seq).toBeGreaterThan(0);
  });

  it("devolve null sem pergunta no log — não há o que cortar", () => {
    expect(ultimoTurnoDoUsuario([])).toBeNull();
  });
});
