/**
 * A conversa do bot delegado entra na barra NA HORA da delegação.
 *
 * O defeito era conhecido: "solicitar um HTML — ele foi pro chat e chamou o
 * code, retornou no mesmo chat, não ficou o bot subagente no histórico no menu
 * lateral esquerdo abaixo do chat". O gateway já abre a conversa do delegado
 * quando ele entra; se a lista só soubesse dela no `ready` seguinte, a pessoa
 * veria o Código trabalhar e não teria onde clicar para continuar com ele.
 */

import { describe, expect, it } from "vitest";
import type { Delegate, Envelope } from "@aibot/contracts";
import { applyEnvelope, initialAppData } from "./store";

function delegacao(payload: Delegate, seq = 1): Envelope<Delegate> {
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-19T12:00:00Z",
    seq,
    session: "s-1",
    turn: "t-1",
    kind: "delegate",
    from: { kind: "specialist", id: "chat", specialist: "chat" },
    payload
  };
}

const ABERTA: Delegate = {
  from: "chat",
  to: "code",
  goal: "faça um HTML de página de vendas",
  depth: 1,
  session: "s-1-code"
};

describe("a conversa do bot na barra lateral", () => {
  it("nasce junto com a delegação, pendurada na conversa que a criou", () => {
    const estado = applyEnvelope(initialAppData(), delegacao(ABERTA));

    const filha = estado.sessions.find((item) => item.id === "s-1-code");
    expect(filha).toBeDefined();
    expect(filha?.parentId).toBe("s-1");
    expect(filha?.botId).toBe("code");
    // O título é o NOME do bot, não o objetivo: a linha responde "com quem eu
    // falo aqui", e o objetivo já está escrito dentro da conversa.
    expect(filha?.title).toBe("Código");
    // `specialist` nasce igual ao dono para o retrato da linha ser o dele — e
    // para quem abrir e escrever continuar falando com ELE.
    expect(filha?.specialist).toBe("code");
  });

  it("tem conteúdo desde o primeiro instante, senão o filtro da barra a esconde", () => {
    // O gateway grava o pedido na conversa do bot ANTES de publicar este
    // envelope. Nascer com seq zero faria a linha ser filtrada como "conversa
    // que ninguém começou" justamente na hora em que ela precisa aparecer.
    const estado = applyEnvelope(initialAppData(), delegacao(ABERTA));

    expect(estado.sessions.find((item) => item.id === "s-1-code")?.lastSeq).toBeGreaterThan(0);
  });

  it("o mesmo bot chamado de novo não vira uma segunda linha", () => {
    // Um bot chamado dez vezes na mesma conversa tem UMA conversa com dez
    // trechos. O `done` da própria delegação cai aqui de novo e já bastaria
    // para duplicar.
    let estado = applyEnvelope(initialAppData(), delegacao(ABERTA));
    estado = applyEnvelope(estado, delegacao({ ...ABERTA, done: true, result: "pronto" }, 2));
    estado = applyEnvelope(estado, delegacao({ ...ABERTA, goal: "agora o CSS" }, 3));

    expect(estado.sessions.filter((item) => item.id === "s-1-code")).toHaveLength(1);
  });

  it("bots diferentes ganham conversas diferentes", () => {
    let estado = applyEnvelope(initialAppData(), delegacao(ABERTA));
    estado = applyEnvelope(
      estado,
      delegacao({ from: "chat", to: "design", goal: "a paleta", depth: 1, session: "s-1-design" }, 2)
    );

    expect(estado.sessions.map((item) => item.id).sort()).toEqual(["s-1-code", "s-1-design"]);
  });

  it("gateway sem o campo não quebra nada — a delegação vale, só não há linha", () => {
    // Compatibilidade real: o campo é novo, e um gateway antigo (ou um espelho
    // que falhou no disco) manda a delegação sem ele. Perder a linha lateral é
    // aceitável; perder a delegação não seria.
    const estado = applyEnvelope(
      initialAppData(),
      delegacao({ from: "chat", to: "code", goal: "faça o HTML", depth: 1 })
    );

    expect(estado.sessions).toEqual([]);
    expect(estado.delegations).toHaveLength(1);
  });

  it("a delegação continua sendo registrada como sempre foi", () => {
    // O espelho é acessório. Se ele passasse a decidir o que entra em
    // `delegations`, o popup do bot dependeria de a conversa filha ter dado
    // certo — e ele é o que anuncia quem entrou.
    let estado = applyEnvelope(initialAppData(), delegacao(ABERTA));
    expect(estado.delegations).toHaveLength(1);
    expect(estado.delegations[0]?.done).toBeUndefined();

    estado = applyEnvelope(estado, delegacao({ ...ABERTA, done: true, result: "pronto" }, 2));
    expect(estado.delegations).toHaveLength(1);
    expect(estado.delegations[0]?.done).toBe(true);
    expect(estado.delegations[0]?.result).toBe("pronto");
  });
});
