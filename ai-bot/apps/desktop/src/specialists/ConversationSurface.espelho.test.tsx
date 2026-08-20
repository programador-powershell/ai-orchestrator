/**
 * O ESPELHO CLICÁVEL da delegação e o rótulo da rota "clarified".
 *
 * Na conversa do dono (a raiz orquestradora), a delegação deixa de ser só um
 * popup que some: a faixa "Deleguei ao especialista X" ancora na bolha do
 * delegado e é um BOTÃO de verdade — clicar (ou Enter, que é o que um botão
 * dá de graça) abre a conversa da filha, cujo id já viaja no envelope de
 * delegação. E a rota `clarified` (a opção escolhida no cartão de
 * clarificação) ganha o rótulo próprio em vez de cair no genérico.
 *
 * Sem @testing-library: react-dom/client cru + act, envelopes reduzidos pelo
 * applyEnvelope real, como no RaizOrquestradora.test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Delegate, Delta, Done, Envelope, Message } from "@aibot/contracts";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ConversationSurface } from "./ConversationSurface";

/* O avatar carrega o módulo do Lab por URL; o dublê devolve um controlador
   inerte, como nos testes vizinhos. */
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

const PEDIDO = "construa um html simples hello world";
const RESULTADO = "<!doctype html> pronto — Hello World no ar.";

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

/** O turno delegado como o gateway o emite na raiz (ver RaizOrquestradora). */
function turnoDelegado(sessaoDaFilha?: string): Envelope<unknown>[] {
  const filha = sessaoDaFilha === undefined ? {} : { session: sessaoDaFilha };
  return [
    envelope<Message>("message", { role: "user", text: PEDIDO }, { kind: "user" }),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "code", goal: PEDIDO, depth: 1, ...filha },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Delta>("delta", { text: RESULTADO }, { id: "code", specialist: "code" }),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "code", goal: PEDIDO, depth: 1, done: true, result: RESULTADO, ...filha },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Done>("done", { turn: "t-1" }, { kind: "supervisor" })
  ];
}

function chegam(envelopes: Envelope<unknown>[]): void {
  act(() => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
    }
  });
}

function monta(): void {
  act(() => {
    root.render(<ConversationSurface />);
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
  useApp.setState({ ...initialAppData(), status: "ready", session: "s-raiz" });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("o espelho clicável da delegação", () => {
  it("é um BOTÃO ancorado na bolha do delegado, com o gesto óbvio no title", () => {
    monta();
    chegam(turnoDelegado("s-raiz-code"));

    const espelho = container.querySelector<HTMLButtonElement>(".delegation-mirror");
    expect(espelho).not.toBeNull();
    // Botão de verdade, não div com onClick: Tab alcança, Enter navega.
    expect(espelho?.tagName).toBe("BUTTON");
    expect(espelho?.textContent).toContain("deleguei ao especialista");
    expect(espelho?.textContent).toContain("Código");
    expect(espelho?.title).toContain("abrir a conversa do Código");
    expect(espelho?.title).toContain(PEDIDO);

    // Ancorado ANTES da bolha do delegado, no mesmo grupo de linha.
    const grupo = espelho?.closest(".line-group");
    expect(grupo?.querySelector('.line[data-specialist="code"]')).not.toBeNull();
  });

  it("clicar navega para a conversa da filha — openSession com o id do envelope", () => {
    monta();
    chegam(turnoDelegado("s-raiz-code"));

    act(() => {
      container.querySelector<HTMLButtonElement>(".delegation-mirror")?.click();
    });

    // O openSession real rodou: a sessão ativa virou a filha e as linhas
    // zeraram (elas voltam pelo replay do gateway, não de cache local).
    expect(useApp.getState().session).toBe("s-raiz-code");
    expect(useApp.getState().lines).toHaveLength(0);
  });

  it("delegação SEM session não desenha espelho — faixa que não navega é promessa falsa", () => {
    monta();
    chegam(turnoDelegado(undefined));

    expect(container.querySelector(".delegation-mirror")).toBeNull();
    // A resposta do delegado continua espelhada na raiz, como sempre.
    expect(container.textContent).toContain("Hello World no ar");
  });
});

describe("o rótulo da rota clarified", () => {
  it("a faixa de troca diz 'você escolheu no cartão' em vez do genérico", () => {
    useApp.setState({
      lines: [
        {
          id: "l1",
          seq: 1,
          ts: "2026-08-20T12:00:00Z",
          role: "assistant",
          specialist: "code",
          text: "vamos ao código",
          route: {
            specialist: "code",
            reason: "clarified",
            confidence: 1,
            surface: "editor",
            model: ""
          }
        }
      ]
    });
    monta();

    const faixa = container.querySelector<HTMLElement>(".handoff");
    expect(faixa).not.toBeNull();
    expect(faixa?.title).toContain("você escolheu no cartão");
    expect(faixa?.title).not.toContain("o master decidiu");
  });
});
