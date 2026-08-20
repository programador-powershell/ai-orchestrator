/**
 * A linha da barra acompanha a PRÓPRIA conversa.
 *
 * O resumo que vem no `ready` é uma fotografia: título vazio, zero turnos, sem
 * dono. Sem os retoques do redutor, a conversa ativa ficava "Conversa sem
 * título · 0" com o orbe genérico — mesmo com a pessoa três pedidos adentro e
 * o bot de Dados já respondendo. O gateway segue sendo a fonte: o próximo
 * `ready` reescreve tudo com o valor canônico.
 */

import { describe, expect, it } from "vitest";
import type { Envelope, Message, Route } from "@aibot/contracts";
import { applyEnvelope, initialAppData, type AppData } from "./store";

let seq = 0;

function envelope<P>(kind: Envelope["kind"], payload: P, session = "s-1"): Envelope<P> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-19T12:00:00Z",
    seq,
    session,
    turn: "t-1",
    kind,
    from: { kind: "user" },
    payload
  };
}

function comSessaoVazia(): AppData {
  return {
    ...initialAppData(),
    session: "s-1",
    sessions: [
      {
        id: "s-1",
        title: "",
        createdAt: "2026-08-19T12:00:00Z",
        updatedAt: "2026-08-19T12:00:00Z",
        lastSeq: 0,
        syncedSeq: 0,
        turns: 0
      }
    ]
  };
}

describe("a linha da conversa ativa", () => {
  it("a primeira fala batiza o título", () => {
    const estado = applyEnvelope(
      comSessaoVazia(),
      envelope<Message>("message", { role: "user", text: "crie tabela de cliente com pedido" })
    );

    expect(estado.sessions[0]?.title).toBe("crie tabela de cliente com pedido");
  });

  it("o título espelha o corte do gateway: 60 caracteres, espaços colapsados", () => {
    const longo = "  crie   uma tabela ".repeat(8);
    const estado = applyEnvelope(
      comSessaoVazia(),
      envelope<Message>("message", { role: "user", text: longo })
    );

    const titulo = estado.sessions[0]?.title ?? "";
    expect(titulo.endsWith("…")).toBe(true);
    expect([...titulo].length).toBeLessThanOrEqual(61);
    expect(titulo.includes("  ")).toBe(false);
  });

  it("título existente NÃO é rebatizado pela fala seguinte", () => {
    let estado = applyEnvelope(
      comSessaoVazia(),
      envelope<Message>("message", { role: "user", text: "primeiro pedido" })
    );
    estado = applyEnvelope(
      estado,
      envelope<Message>("message", { role: "user", text: "segundo pedido" })
    );

    expect(estado.sessions[0]?.title).toBe("primeiro pedido");
  });

  it("só o /mode assina o dono da linha — rota de passagem não troca o retrato", () => {
    // A raiz é orquestradora: pedido de trabalho vira DELEGAÇÃO (o retrato do
    // bot mora na filha) e a resposta do chat na raiz não muda o dono dela.
    // Antes, qualquer rota assinava — e a raiz vestia o retrato de quem só
    // respondeu de passagem, em vez de manter o do master.
    const dePassagem = applyEnvelope(
      comSessaoVazia(),
      envelope<Route>("route", {
        specialist: "chat",
        model: "m1",
        surface: "conversation",
        reason: "heuristic",
        confidence: 1
      })
    );

    expect(dePassagem.sessions[0]?.specialist).toBeUndefined();

    // Quem pede /mode está ESCOLHENDO o dono: a conversa vira o bot, retrato
    // incluído — na hora, sem esperar a próxima reconexão.
    const escolhido = applyEnvelope(
      comSessaoVazia(),
      envelope<Route>("route", {
        specialist: "data",
        model: "m1",
        surface: "schema",
        reason: "explicit",
        confidence: 1
      })
    );

    expect(escolhido.sessions[0]?.specialist).toBe("data");
  });

  it("o done conta o turno na linha", () => {
    const estado = applyEnvelope(comSessaoVazia(), envelope("done", { specialist: "data" }));

    expect(estado.sessions[0]?.turns).toBe(1);
  });

  it("envelope de OUTRA sessão não toca a linha desta", () => {
    const estado = applyEnvelope(
      comSessaoVazia(),
      envelope<Message>("message", { role: "user", text: "fala de outra conversa" }, "s-9")
    );

    expect(estado.sessions[0]?.title).toBe("");
  });
});
