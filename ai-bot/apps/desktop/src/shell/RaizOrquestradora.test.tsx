/**
 * A EXPERIÊNCIA da raiz orquestradora, DESENHADA.
 *
 * O redutor da sequência nova já é provado em store.raizOrquestradora.test.ts;
 * aqui monta-se a tela porque o defeito relatado era de tela — "construa um
 * html simples hello world" virava a IDE e a pessoa ficava presa nela. O que
 * este arquivo tranca é o padrão Grok Bot: o pedido de trabalho na raiz mostra
 * o espelho da delegação (pedido→resultado) na PRÓPRIA conversa, a barra ganha
 * a filha aninhada com o retrato do Código e o objetivo, e é o CLIQUE na filha
 * que leva à superfície do editor.
 *
 * Sem @testing-library, como nos vizinhos: react-dom/client cru + act.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Delegate, Delta, Done, Envelope, Message, Ready, Thinking } from "@aibot/contracts";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ConversationSurface } from "../specialists/ConversationSurface";
import { DelegationPopup } from "./DelegationPopup";
import { Rail } from "./Rail";

/*
 * O avatar da barra carrega o módulo do Lab por URL, e jsdom não tem de onde
 * buscá-lo. O dublê registra QUEM cada linha pediu — é exatamente o que o
 * teste do retrato precisa observar.
 */
const montados: Array<{ specialist: string; size: number }> = [];

vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: (_alvo: unknown, options: { specialist: string; size?: number }) => {
      montados.push({ specialist: options.specialist, size: options.size ?? 0 });
      return Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      });
    }
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;
let seq = 0;

function envelope<P>(
  kind: Envelope["kind"],
  payload: P,
  from: { kind?: "user" | "supervisor" | "specialist"; id?: string; specialist?: string } = {},
  session = "s-raiz"
): Envelope<P> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-20T12:00:00Z",
    seq,
    session,
    turn: "t-1",
    kind,
    from: { kind: from.kind ?? "specialist", id: from.id, specialist: from.specialist },
    payload
  };
}

const PEDIDO = "construa um html simples hello world";
const RESULTADO = "<!doctype html> pronto — Hello World no ar.";

/**
 * O turno inteiro do fluxo novo, como o gateway o emite na raiz: o delegate
 * sai do SUPERVISOR (sem `specialist` no ator — a raiz não ganha dono pelo
 * anúncio) e o resultado é a linha dos DELTAS do bot, fechada pelo done — não
 * há `message` final na raiz, igual à delegação bot-a-bot de sempre.
 */
function turnoDelegado(): Envelope<unknown>[] {
  return [
    envelope<Message>("message", { role: "user", text: PEDIDO }, { kind: "user" }),
    envelope<Thinking>("thinking", { label: "Código no caso" }, { id: "code", specialist: "code" }),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "code", goal: PEDIDO, depth: 1, session: "s-raiz-code" },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Delta>("delta", { text: RESULTADO }, { id: "code", specialist: "code" }),
    envelope<Delegate>(
      "delegate",
      { from: "master", to: "code", goal: PEDIDO, depth: 1, session: "s-raiz-code", done: true, result: RESULTADO },
      { kind: "supervisor", id: "master" }
    ),
    envelope<Done>("done", { turn: "t-1" }, { kind: "supervisor" })
  ];
}

beforeEach(() => {
  montados.length = 0;
  seq = 0;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom não implementa scrollTo de elemento, e o autoscroll da conversa o
  // chama a cada linha nova — sem o dublê, a montagem inteira morre.
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
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
        <DelegationPopup />
      </>
    );
  });
}

async function chegam(envelopes: Envelope<unknown>[]) {
  await act(async () => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
    }
    // Flipar para o Código monta o FilesRail, que dispara o bootstrap da
    // árvore (fs.list sem transporte → vazio honesto, via microtasks). Os
    // ticks deixam esse setState acontecer DENTRO do act, sem aviso.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("o primeiro pedido de código na raiz", () => {
  it("não vira a IDE: a conversa fica, com o espelho pedido→resultado", async () => {
    monta();
    await chegam(turnoDelegado());

    // A tela continua sendo a conversa — o defeito era ela virar o editor.
    expect(useApp.getState().activeSurface).toBe("conversation");
    expect(useApp.getState().activeSpecialist).toBe("");

    // O espelho na própria raiz: a pergunta da pessoa…
    const doUsuario = container.querySelector('.line[data-role="user"]');
    expect(doUsuario?.textContent).toContain(PEDIDO);

    // …e o resultado assinado por quem trabalhou, com nome e retrato do bot.
    const doBot = container.querySelector('.line[data-specialist="code"]');
    expect(doBot).not.toBeNull();
    expect(doBot?.querySelector(".line-who")?.textContent).toBe("Código");
    expect(doBot?.textContent).toContain("Hello World no ar");

    // Sem faixa de rota: quem anuncia a entrada do bot é o popup da delegação
    // (estilo que já existia — nada de UI nova).
    expect(container.querySelector(".handoff")).toBeNull();
    const popup = container.querySelector(".delegation");
    expect(popup?.querySelector(".delegation-line")?.textContent).toContain("AI-BOT");
    expect(popup?.querySelector(".delegation-line")?.textContent).toContain("Código");
    expect(popup?.querySelector(".delegation-goal")?.textContent).toBe(PEDIDO);
  });

  it("a barra ganha a filha aninhada: retrato do Código e o objetivo de subtítulo", async () => {
    monta();
    await chegam(turnoDelegado());

    const filha = container.querySelector('.rail-item-row[data-child="true"]');
    expect(filha).not.toBeNull();
    expect(filha?.querySelector(".rail-item-label")?.textContent).toBe("Código");
    expect(filha?.querySelector(".rail-item-sub")?.textContent).toBe(PEDIDO);
    // O resultado chegou com a pessoa na raiz: ponto de não lida na filha.
    expect(filha?.querySelector(".rail-item-dot")).not.toBeNull();

    // O retrato da filha é o do Código; o da raiz segue o do master — no
    // vocabulário de oito ofícios do wrapper, master (e a raiz sem dono) caem
    // em "agent". O que o teste tranca: a raiz NÃO veste o retrato do code.
    expect(montados.some((avatar) => avatar.size === 18 && avatar.specialist === "code")).toBe(true);
    expect(montados.filter((avatar) => avatar.size === 22).map((avatar) => avatar.specialist)).toEqual([
      "agent"
    ]);
  });

  it("clicar na filha abre a conversa DELA — e o ready dela traz o editor", async () => {
    monta();
    await chegam(turnoDelegado());

    const botaoDaFilha = [...container.querySelectorAll<HTMLButtonElement>(".rail-item")].find(
      (botao) => botao.querySelector(".rail-item-label")?.textContent === "Código"
    );
    expect(botaoDaFilha).toBeDefined();

    act(() => {
      botaoDaFilha?.click();
    });

    // Abriu a conversa do bot; as linhas voltam pelo replay do gateway.
    expect(useApp.getState().session).toBe("s-raiz-code");

    // O replay da filha chega com o dono no meta — é ELE que flipa a tela.
    await chegam([
      envelope<Ready>(
        "ready",
        { session: "s-raiz-code", seq: 2, specialists: ["chat", "code"], models: [], activeSpecialist: "code" },
        { kind: "supervisor" },
        "s-raiz-code"
      )
    ]);

    expect(useApp.getState().activeSpecialist).toBe("code");
    expect(useApp.getState().activeSurface).toBe("editor");
  });
});
