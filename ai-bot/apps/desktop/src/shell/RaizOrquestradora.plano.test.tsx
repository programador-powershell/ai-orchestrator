/**
 * O PLANO do orquestrador na raiz, DESENHADO — e as duas filhas em ordem.
 *
 * A ordem do dono do produto: "precisaria primeiro listar o que precisa e não
 * chamar direto". O gateway agora faz o master LISTAR antes de delegar; do
 * lado da tela, este arquivo tranca as duas metades da experiência:
 *
 *  1. a mensagem-plano do master renderiza LIMPA — a lista numerada em
 *     markdown vira <ol> de verdade (não um parágrafo com "1. 2." colados),
 *     assinada pelo AI-BOT, sem faixa de rota (a raiz não ganha dono);
 *  2. as MÚLTIPLAS filhas nascidas em sequência aparecem aninhadas NA ORDEM
 *     do plano (Código, depois Design), cada uma com o próprio estado — a que
 *     terminou com o ponto de não lida, a que ainda roda com o retrato
 *     trabalhando.
 *
 * Sem @testing-library: react-dom/client cru + act, envelopes reduzidos pelo
 * applyEnvelope real, como nos vizinhos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Delegate, Delta, Envelope, Message } from "@aibot/contracts";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ConversationSurface } from "../specialists/ConversationSurface";
import { Rail } from "./Rail";

/* O avatar da barra carrega o módulo do Lab por URL, e jsdom não tem de onde
   buscá-lo — o dublê devolve um controlador inerte, como nos vizinhos. */
vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: () =>
      Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      })
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* jsdom não implementa element.scrollTo, e a conversa rola ao montar. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let root: Root;
let seq = 0;

const PEDIDO = "crie um site completo em next";

/** A mensagem-plano como o master a emite: lista numerada em markdown. */
const PLANO =
  "Para um site completo em Next, o trabalho se divide assim:\n\n" +
  "1. **Código** — estrutura do projeto Next e as páginas\n" +
  "2. **Design** — tokens, paleta e os estados das telas";

function envelope<P>(
  kind: Envelope["kind"],
  payload: P,
  from: { kind?: "user" | "supervisor" | "specialist"; id?: string; specialist?: string } = {}
): Envelope<P> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-20T12:00:00Z",
    seq,
    session: "s-raiz",
    turn: "t-1",
    kind,
    from: { kind: from.kind ?? "specialist", id: from.id, specialist: from.specialist },
    payload
  };
}

/**
 * O turno do fluxo novo na raiz: o master LISTA (mensagem-plano) e só então
 * delega — Código primeiro (fecha), Design depois (segue rodando).
 */
function turnoComPlano(): Envelope<unknown>[] {
  return [
    envelope<Message>("message", { role: "user", text: PEDIDO }, { kind: "user" }),
    envelope<Message>(
      "message",
      { role: "assistant", text: PLANO },
      { kind: "supervisor", id: "master", specialist: "master" }
    ),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "code", goal: "estrutura do projeto Next", depth: 1, session: "s-raiz-code" },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Delta>("delta", { text: "estrutura no ar." }, { id: "code", specialist: "code" }),
    envelope<Delegate>(
      "delegate",
      {
        from: "master",
        to: "code",
        goal: "estrutura do projeto Next",
        depth: 1,
        session: "s-raiz-code",
        done: true,
        result: "estrutura no ar."
      },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "design", goal: "tokens e telas", depth: 1, session: "s-raiz-design" },
      { kind: "supervisor", id: "master" }
    )
  ];
}

function chegam(envelopes: Envelope<unknown>[]): void {
  act(() => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
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
  useApp.setState({
    ...initialAppData(),
    status: "ready",
    railOpen: true,
    session: "s-raiz",
    sessions: [
      {
        id: "s-raiz",
        title: "",
        createdAt: "2026-08-20T12:00:00Z",
        updatedAt: "2026-08-20T12:00:00Z",
        lastSeq: 0,
        syncedSeq: 0,
        turns: 0
      }
    ]
  });
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
    root.render(
      <>
        <Rail />
        <ConversationSurface />
      </>
    );
  });
}

describe("a mensagem-plano do master na raiz", () => {
  it("renderiza a lista numerada como <ol> de verdade, assinada pelo AI-BOT", () => {
    monta();
    chegam(turnoComPlano());

    // A bolha do plano é do MASTER — e a assinatura diz AI-BOT, não "Conversa".
    const doMaster = container.querySelector('.line[data-specialist="master"]');
    expect(doMaster).not.toBeNull();
    expect(doMaster?.querySelector(".line-who")?.textContent).toBe("AI-BOT");

    // A lista do plano é UMA lista ordenada, com um item por ofício citado —
    // markdown limpo, não "1. 2." colados num parágrafo.
    const lista = doMaster?.querySelector("ol.md-ol");
    expect(lista).not.toBeNull();
    const itens = [...(lista?.querySelectorAll("li") ?? [])].map((item) => item.textContent ?? "");
    expect(itens).toHaveLength(2);
    expect(itens[0]).toContain("Código");
    expect(itens[1]).toContain("Design");

    // Sem faixa de rota: o plano não dá dono à raiz — ela segue orquestradora.
    expect(container.querySelector(".handoff")).toBeNull();
    expect(useApp.getState().activeSpecialist).toBe("");
  });
});

describe("as duas filhas do plano na barra", () => {
  it("aparecem aninhadas NA ORDEM do plano, cada uma com o próprio estado", () => {
    monta();
    chegam(turnoComPlano());

    // Um grupo só: a raiz com as duas filhas dentro dele.
    const grupos = [...container.querySelectorAll(".rail-group")];
    expect(grupos).toHaveLength(1);

    const linhas = [...(grupos[0]?.querySelectorAll(".rail-item-row") ?? [])].map((linha) => ({
      titulo: linha.querySelector(".rail-item-label")?.textContent ?? "",
      filha: linha.getAttribute("data-child") === "true",
      atividade: linha.querySelector(".rail-item")?.getAttribute("data-atividade") ?? "",
      naoLida: linha.querySelector(".rail-item-dot") !== null
    }));

    // Ordem de NASCIMENTO (a ordem do plano): Código primeiro, Design depois.
    // O Código fechou com a pessoa na raiz → ponto de não lida; o Design ainda
    // roda → retrato trabalhando. O título da raiz é o batismo da primeira
    // fala (comMetaDaSessao).
    expect(linhas).toEqual([
      { titulo: PEDIDO, filha: false, atividade: "", naoLida: false },
      { titulo: "Código", filha: true, atividade: "naoLida", naoLida: true },
      { titulo: "Design", filha: true, atividade: "trabalhando", naoLida: false }
    ]);
  });
});
