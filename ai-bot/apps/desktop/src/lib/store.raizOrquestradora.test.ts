/**
 * A raiz é ORQUESTRADORA: o primeiro pedido de trabalho não vira a tela.
 *
 * O defeito que este arquivo tranca (reclamação recorrente, com screenshot):
 * "construa um html simples hello world" roteava para Código e a CONVERSA
 * INTEIRA virava o Código — a tela virava a IDE e a pessoa ficava presa nela.
 * O contrato novo: a raiz fica com o MASTER (superfície de conversa) e o
 * especialista de trabalho nasce como SUB-BOT — o gateway emite na raiz os
 * MESMOS envelopes da delegação bot-a-bot (thinking de etapa, delegate aberto
 * com a sessão da filha, espelho do pedido/resultado, delegate done, done do
 * turno), e o modo/rota/superfície acontecem NA FILHA.
 *
 * Estes testes reduzem exatamente essa sequência de envelopes e conferem que
 * NENHUM deles flipa a raiz — quem flipa é o `ready` da filha, quando a pessoa
 * a abre pela barra.
 */

import { describe, expect, it } from "vitest";
import type { Delegate, Delta, Done, Envelope, Message, Ready, Route, Thinking } from "@aibot/contracts";
import { applyEnvelope, initialAppData, type AppData } from "./store";

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

/** A raiz recém-nascida, SEM dono: `specialist` vazio é o retrato do master. */
function comRaiz(): AppData {
  return {
    ...initialAppData(),
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
  };
}

const PEDIDO = "construa um html simples hello world";
const RESULTADO = "<!doctype html> pronto — Hello World no ar.";

/**
 * A sequência que o gateway emite na raiz — a MESMA da delegação bot-a-bot:
 * o eco do pedido, o rótulo de etapa, o delegate aberto (do SUPERVISOR, sem
 * `specialist` no ator — a raiz não pode ganhar dono pelo próprio anúncio),
 * o trabalho do bot streamado em deltas, o delegate done e o done do turno.
 * O resultado NÃO vira `message` na raiz: a linha é a dos deltas, fechada
 * pelo done — igual ao que o delegado sempre fez na conversa de quem chamou.
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

describe("o primeiro pedido de trabalho na raiz", () => {
  it("NÃO flipa a raiz: superfície de conversa e retrato do master ficam", () => {
    const estado = turnoDelegado().reduce(applyEnvelope, comRaiz());

    // A tela NÃO virou a IDE — era exatamente o defeito.
    expect(estado.activeSurface).toBe("conversation");
    // "" = o master: nenhum envelope da delegação adota o modo na raiz.
    expect(estado.activeSpecialist).toBe("");
    // E a linha da raiz na barra segue SEM dono — o retrato é o do master.
    expect(estado.sessions.find((item) => item.id === "s-raiz")?.specialist).toBeUndefined();
  });

  it("a raiz mostra o espelho pedido→resultado, assinado por quem trabalhou", () => {
    const estado = turnoDelegado().reduce(applyEnvelope, comRaiz());

    const doUsuario = estado.lines.find((line) => line.role === "user");
    expect(doUsuario?.text).toBe(PEDIDO);

    // O resultado entra como linha do Código — o retrato e o nome dele é que
    // dizem quem fez, já que não há mais faixa de rota na raiz.
    const doBot = estado.lines.find((line) => line.role === "assistant");
    expect(doBot?.specialist).toBe("code");
    expect(doBot?.text).toBe(RESULTADO);
    expect(doBot?.streaming).toBe(false);
  });

  it("a filha nasce na barra com o dono, o vínculo e o objetivo", () => {
    const estado = turnoDelegado().reduce(applyEnvelope, comRaiz());

    const filha = estado.sessions.find((item) => item.id === "s-raiz-code");
    expect(filha?.parentId).toBe("s-raiz");
    expect(filha?.botId).toBe("code");
    expect(filha?.title).toBe("Código");
    expect(filha?.lastGoal).toBe(PEDIDO);

    // E o sinal da linha: fechou com a pessoa na raiz → ponto de não lida.
    expect(estado.atividadeDasConversas["s-raiz-code"]).toBe("naoLida");
  });

  it("é o ready da FILHA que flipa a tela — ao abri-la, não antes", () => {
    const estado = turnoDelegado().reduce(applyEnvelope, comRaiz());

    // A pessoa clicou na filha: o replay dela chega com o dono no meta.
    const aberta = applyEnvelope(
      { ...estado, session: "s-raiz-code" },
      envelope<Ready>(
        "ready",
        { session: "s-raiz-code", seq: 2, specialists: ["chat", "code"], models: [], activeSpecialist: "code" },
        { kind: "supervisor" },
        "s-raiz-code"
      )
    );

    expect(aberta.activeSpecialist).toBe("code");
    expect(aberta.activeSurface).toBe("editor");
  });

  it("o input seguinte para o mesmo bot continua na MESMA filha", () => {
    let estado = turnoDelegado().reduce(applyEnvelope, comRaiz());

    // A raiz roteia de novo a cada input; mesmo bot vence → mesma filha (o
    // gateway manda o MESMO id de sessão), só o objetivo em curso muda.
    estado = applyEnvelope(
      estado,
      envelope<Delegate>(
        "delegate",
        { from: "master", to: "code", goal: "agora o CSS", depth: 1, session: "s-raiz-code" },
        { kind: "supervisor", id: "master" }
      )
    );

    expect(estado.sessions.filter((item) => item.id === "s-raiz-code")).toHaveLength(1);
    expect(estado.sessions.find((item) => item.id === "s-raiz-code")?.lastGoal).toBe("agora o CSS");
    expect(estado.atividadeDasConversas["s-raiz-code"]).toBe("trabalhando");
  });
});

describe("a pergunta simples na raiz", () => {
  it("o chat responde NA RAIZ, sem filha e sem trocar o retrato", () => {
    const estado = [
      envelope<Message>("message", { role: "user", text: "o que é DNS?" }, { kind: "user" }),
      envelope<Route>(
        "route",
        { specialist: "chat", reason: "heuristic", confidence: 0.9, surface: "conversation", model: "m1" },
        { kind: "supervisor", id: "master" }
      ),
      envelope<Message>(
        "message",
        { role: "assistant", text: "É a lista telefônica da internet.", specialist: "chat" },
        { id: "chat", specialist: "chat" }
      ),
      envelope<Done>("done", { turn: "t-1" }, { kind: "supervisor" })
    ].reduce(applyEnvelope, comRaiz());

    // Sem filha: a resposta é da própria raiz.
    expect(estado.sessions.map((item) => item.id)).toEqual(["s-raiz"]);
    expect(estado.activeSurface).toBe("conversation");
    // A rota de passagem não vira dono: o retrato da raiz segue o do master.
    expect(estado.sessions[0]?.specialist).toBeUndefined();
  });
});
