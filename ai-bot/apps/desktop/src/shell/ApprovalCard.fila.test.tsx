/**
 * DUAS ENTREGAS EM SEQUÊNCIA — um cartão por ofício, sem atropelo.
 *
 * No plano orquestrado ("crie um site completo em next"), cada filha fecha o
 * próprio turno com um `workspace.promote`, e o cartão de entrega é espelhado
 * na raiz. Dois riscos que este arquivo tranca, com envelopes reduzidos pelo
 * applyEnvelope REAL:
 *
 *  - atropelo: o segundo pedido NÃO sobrescreve o primeiro — ele espera na
 *    fila ("+1 na fila") e só sobe quando o primeiro é decidido;
 *  - deduplicação errada: a identidade do pedido é o callId, nunca o conteúdo
 *    — duas entregas de filhas diferentes com o MESMO texto continuam sendo
 *    dois cartões, e a REENTREGA do mesmo callId (espelho, replay) continua
 *    sendo um só.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequest, Envelope } from "@aibot/contracts";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ApprovalCard } from "./ApprovalCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;
let seq = 0;

function envelope(payload: ApprovalRequest): Envelope<ApprovalRequest> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-20T12:00:00Z",
    seq,
    session: "s-raiz",
    turn: "t-1",
    kind: "approval.request",
    from: { kind: "supervisor" },
    payload
  };
}

/** A entrega da filha do Código e a da filha do Design — callIds DISTINTOS. */
const ENTREGA_DO_CODE: ApprovalRequest = {
  callId: "call-promote-code",
  tool: "workspace.promote",
  risk: "write",
  summary: "o Código quer entregar 2 arquivo(s) ao projeto",
  detail: "+ app/page.tsx\n+ app/layout.tsx"
};

const ENTREGA_DO_DESIGN: ApprovalRequest = {
  callId: "call-promote-design",
  tool: "workspace.promote",
  risk: "write",
  summary: "o Design quer entregar 1 arquivo(s) ao projeto",
  detail: "+ styles/tokens.css"
};

function chegam(pedidos: ApprovalRequest[]): void {
  act(() => {
    for (const pedido of pedidos) {
      useApp.setState((estado) => applyEnvelope(estado, envelope(pedido)));
    }
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  seq = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState(initialAppData());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta() {
  act(() => {
    root.render(<ApprovalCard />);
  });
}

function clica(rotulo: string) {
  const botao = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === rotulo
  );
  expect(botao, `botão "${rotulo}" não está no cartão`).toBeTruthy();
  act(() => {
    botao?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function caminhosNoCartao(): string[] {
  return [...container.querySelectorAll(".approval-entrega-lista code")].map(
    (item) => item.textContent ?? ""
  );
}

describe("duas entregas de filhas diferentes na fila", () => {
  it("apresenta uma por vez: a primeira na frente, a segunda anunciada na fila", () => {
    monta();
    chegam([ENTREGA_DO_CODE, ENTREGA_DO_DESIGN]);

    // A CABEÇA da fila é a entrega do Código, inteira — nada da do Design
    // vazou para dentro dela.
    expect(container.querySelector("#approval-tool")?.textContent).toBe("entregar ao projeto");
    expect(caminhosNoCartao()).toEqual(["app/page.tsx", "app/layout.tsx"]);
    expect(container.textContent).not.toContain("styles/tokens.css");

    // E a segunda está ANUNCIADA — decidir um cartão e ver outro aparecer sem
    // aviso parece defeito.
    expect(container.querySelector(".approval-queue")?.textContent).toBe("+1 na fila");
  });

  it("decidir a primeira sobe a segunda, com o corpo DELA — sem atropelo", () => {
    monta();
    chegam([ENTREGA_DO_CODE, ENTREGA_DO_DESIGN]);

    clica("Permitir entrega");

    // O cartão agora é o do Design, e a fila esvaziou.
    expect(caminhosNoCartao()).toEqual(["styles/tokens.css"]);
    expect(container.querySelector(".approval-queue")).toBeNull();
    expect(useApp.getState().pendingApprovals.map((item) => item.callId)).toEqual([
      "call-promote-design"
    ]);
  });

  it("a identidade é o callId: mesmo TEXTO não deduplica, mesmo callId sim", () => {
    monta();
    // A entrega do Design com o MESMO resumo e a MESMA lista da do Código —
    // só o callId distingue. Cenário real: duas filhas entregando o mesmo
    // arquivo de nomes iguais em worktrees diferentes.
    const gemea: ApprovalRequest = { ...ENTREGA_DO_CODE, callId: "call-promote-design" };
    chegam([ENTREGA_DO_CODE, gemea]);
    expect(useApp.getState().pendingApprovals).toHaveLength(2);

    // Já a REENTREGA do mesmo callId (espelho na raiz, replay de reconexão)
    // não vira terceiro cartão.
    chegam([ENTREGA_DO_CODE]);
    expect(useApp.getState().pendingApprovals).toHaveLength(2);
    expect(container.querySelector(".approval-queue")?.textContent).toBe("+1 na fila");
  });

  it("o eco da decisão de OUTRA janela tira o pedido certo da fila", () => {
    monta();
    chegam([ENTREGA_DO_CODE, ENTREGA_DO_DESIGN]);

    // O gateway ecoa a decisão do Design (decidida em outra janela): sai o
    // dele, e o do Código continua na frente, intacto.
    act(() => {
      useApp.setState((estado) =>
        applyEnvelope(estado, {
          v: 1,
          id: "e-eco",
          ts: "2026-08-20T12:00:01Z",
          seq: 99,
          session: "s-raiz",
          turn: "t-1",
          kind: "approval.decision",
          from: { kind: "supervisor" },
          payload: { callId: "call-promote-design", allow: true }
        })
      );
    });

    expect(useApp.getState().pendingApprovals.map((item) => item.callId)).toEqual([
      "call-promote-code"
    ]);
    expect(caminhosNoCartao()).toEqual(["app/page.tsx", "app/layout.tsx"]);
    expect(container.querySelector(".approval-queue")).toBeNull();
  });
});
