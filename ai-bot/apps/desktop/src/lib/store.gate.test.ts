/**
 * O portão da equipe: o pedido ABRE o cartão, a decisão o FECHA.
 *
 * O defeito que este teste fecha era invisível enquanto a conversa estava
 * aberta. A tela fecha o portão na hora, sem esperar resposta do gateway
 * (`decideGate`), então tudo parecia certo. Só que o `gate` gravado no log não
 * tinha decisão nenhuma — e o log é reencenado ao reabrir a conversa. O cartão
 * voltava, com `role="alertdialog"`, chamando a pessoa para decidir uma onda que
 * tinha terminado fazia tempo.
 *
 * O que separa um do outro é o campo `decision`: vazio no pedido, preenchido no
 * eco. Uma segunda janela na mesma sessão depende do mesmo eco para saber que
 * alguém já decidiu.
 */

import { describe, expect, it } from "vitest";
import type { Envelope, Gate } from "@aibot/contracts";
import { applyEnvelope, initialAppData } from "./store";

const GATE_ID = "g-1";

function gateEnvelope(payload: Gate, seq: number): Envelope<Gate> {
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-17T12:00:00Z",
    seq,
    session: "s-1",
    turn: "crew-1",
    kind: "gate",
    from: { kind: "supervisor", id: "agent", specialist: "agent" },
    payload
  };
}

// O pedido como o gateway o emite: sem decisão. O tipo do contrato exige o
// campo, e o Go o serializa como string vazia — é essa forma que chega à tela.
const PEDIDO = gateEnvelope(
  { gateId: GATE_ID, decision: "" as Gate["decision"], reason: "1 tarefa da onda 1 falhou" },
  10
);

describe("applyEnvelope — portão da equipe", () => {
  it("o pedido sem decisão abre o cartão", () => {
    const state = applyEnvelope(initialAppData(), PEDIDO);
    expect(state.crew.gate?.gateId).toBe(GATE_ID);
  });

  it("o eco com decisão fecha o cartão", () => {
    const aberto = applyEnvelope(initialAppData(), PEDIDO);
    const fechado = applyEnvelope(
      aberto,
      gateEnvelope({ gateId: GATE_ID, decision: "proceed", reason: "decidido" }, 11)
    );
    expect(fechado.crew.gate).toBeNull();
  });

  it("reabrir a conversa não reencena um portão já decidido", () => {
    // O replay entrega os dois envelopes na ordem do log, do zero — é o caminho
    // exato de quem fecha o app e volta na conversa depois.
    const replay = [
      PEDIDO,
      gateEnvelope({ gateId: GATE_ID, decision: "abort", reason: "decidido" }, 11)
    ].reduce(applyEnvelope, initialAppData());
    expect(replay.crew.gate).toBeNull();
  });

  it("o eco de OUTRO portão não fecha o cartão que está aberto", () => {
    const aberto = applyEnvelope(initialAppData(), PEDIDO);
    const outro = applyEnvelope(
      aberto,
      gateEnvelope({ gateId: "g-2", decision: "proceed", reason: "decidido" }, 12)
    );
    expect(outro.crew.gate?.gateId).toBe(GATE_ID);
  });
});
