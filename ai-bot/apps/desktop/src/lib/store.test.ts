/**
 * Testes da redução de envelope.
 *
 * `applyEnvelope` é pura, então aqui não há WebSocket, React nem relógio: o
 * teste monta o envelope como o gateway o manda e confere o estado seguinte.
 *
 * O último teste é o que importa mais: duas rotas no mesmo histórico têm de
 * deixar CADA linha com o seu especialista. A regressão contrária — a conversa
 * inteira assumir o especialista da última rota — apaga de quem era cada
 * resposta anterior, e é justamente o que este produto vende.
 */

import { describe, expect, it } from "vitest";
import type {
  Ask,
  Delta,
  Done,
  Envelope,
  EnvelopeKind,
  Message,
  Ready,
  Reply,
  Route,
  Thinking
} from "@aibot/contracts";
import { applyEnvelope, initialAppData, type AppData } from "./store";

let counter = 0;

function envelope<P>(
  kind: EnvelopeKind,
  payload: P,
  options: { turn?: string; specialist?: string } = {}
): Envelope {
  counter += 1;
  return {
    v: 1,
    id: `env-${counter}`,
    ts: "2026-08-14T12:00:00.000Z",
    seq: counter,
    session: "sessao-1",
    turn: options.turn ?? "t-1",
    kind,
    from: { kind: "specialist", specialist: options.specialist },
    payload
  };
}

function route(specialist: string, surface: string, previous?: string): Route {
  return {
    specialist,
    previous,
    reason: previous ? "model" : "heuristic",
    confidence: 0.82,
    surface,
    model: "gpt-oss:20b",
    signals: ["sinal"]
  };
}

/** Aplica uma sequência de envelopes, como a conexão faz. */
function reduce(state: AppData, envelopes: Envelope[]): AppData {
  return envelopes.reduce(applyEnvelope, state);
}

describe("applyEnvelope", () => {
  it("acumula os deltas e deixa a mensagem final substituir o acumulado", () => {
    const state = reduce(initialAppData(), [
      envelope<Route>("route", route("code", "editor"), { specialist: "master" }),
      envelope<Delta>("delta", { text: "Vou abrir " }, { specialist: "code" }),
      envelope<Delta>("delta", { text: "o arquivo." }, { specialist: "code" })
    ]);

    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]?.text).toBe("Vou abrir o arquivo.");
    expect(state.lines[0]?.streaming).toBe(true);

    const closed = applyEnvelope(
      state,
      envelope<Message>(
        "message",
        { role: "assistant", text: "Abri o arquivo e apliquei o diff.", specialist: "code" },
        { specialist: "code" }
      )
    );

    // Uma linha só: a mensagem FECHA a que estava aberta, não abre outra.
    expect(closed.lines).toHaveLength(1);
    expect(closed.lines[0]?.text).toBe("Abri o arquivo e apliquei o diff.");
    expect(closed.lines[0]?.streaming).toBe(false);
  });

  it("abre linha com a rota preenchida e troca a superfície", () => {
    const decision = route("data", "schema");
    const state = applyEnvelope(initialAppData(), envelope<Route>("route", decision, { specialist: "master" }));

    expect(state.activeSpecialist).toBe("data");
    expect(state.activeSurface).toBe("schema");
    expect(state.activeModel).toBe("gpt-oss:20b");

    const line = state.lines[0];
    expect(line?.role).toBe("assistant");
    expect(line?.specialist).toBe("data");
    // É a `route` na linha que desenha a faixa de troca, com o motivo no title.
    expect(line?.route?.reason).toBe("heuristic");
    expect(line?.route?.specialist).toBe("data");
  });

  it("zera busy e thinking no done", () => {
    const working = applyEnvelope(
      { ...initialAppData(), busy: true },
      envelope<Thinking>("thinking", { label: "Lendo o repositório" })
    );
    expect(working.thinking).toBe("Lendo o repositório");
    expect(working.busy).toBe(true);

    const finished = applyEnvelope(working, envelope<Done>("done", { turn: "t-1" }));
    expect(finished.busy).toBe(false);
    expect(finished.thinking).toBe("");
  });

  it("popula a lista de conversas com as sessões que vieram no ready", () => {
    const state = applyEnvelope(
      initialAppData(),
      envelope<Ready>("ready", {
        session: "sessao-1",
        seq: 12,
        specialists: ["chat", "code"],
        models: [],
        sessions: [
          {
            id: "sessao-1",
            title: "corrigir o parser",
            specialist: "code",
            model: "gpt-oss:20b",
            updatedAt: "2026-08-14T11:00:00.000Z",
            turns: 4
          },
          {
            id: "sessao-2",
            title: "desenhar a tela",
            updatedAt: "2026-08-13T09:30:00.000Z",
            turns: 1
          }
        ]
      })
    );

    // Sem isto a barra lateral e o título da barra superior ficavam vazios para
    // sempre: `sessions` era lido pelos dois e nunca escrito por ninguém.
    expect(state.sessions.map((item) => item.id)).toEqual(["sessao-1", "sessao-2"]);
    expect(state.sessions[0]?.title).toBe("corrigir o parser");
    expect(state.sessions[0]?.specialist).toBe("code");
    expect(state.sessions[0]?.turns).toBe(4);

    // O resumo não carrega estes campos: valor neutro, nunca número inventado.
    expect(state.sessions[0]?.lastSeq).toBe(0);
    expect(state.sessions[0]?.syncedSeq).toBe(0);
    expect(state.sessions[0]?.createdAt).toBe("2026-08-14T11:00:00.000Z");

    // Gateway sem o campo não pode APAGAR a lista que já está na tela.
    const again = applyEnvelope(
      state,
      envelope<Ready>("ready", { session: "sessao-1", seq: 13, specialists: [], models: [] })
    );
    expect(again.sessions).toHaveLength(2);
  });

  it("guarda a pergunta do supervisor no ask e a limpa no reply", () => {
    const question: Ask = {
      askId: "ask-1",
      question: "Posso apagar a branch antiga?",
      options: ["sim", "não"],
      blocking: true
    };

    const asking = applyEnvelope(initialAppData(), envelope<Ask>("ask", question, { specialist: "agent" }));
    // Antes, `ask` caía no `default`: a pergunta sumia e o turno ficava preso.
    expect(asking.pendingAsk?.askId).toBe("ask-1");
    expect(asking.pendingAsk?.question).toBe("Posso apagar a branch antiga?");

    // Resposta de outra pergunta não pode fechar esta.
    const other = applyEnvelope(asking, envelope<Reply>("reply", { askId: "ask-9", answer: "sim" }));
    expect(other.pendingAsk?.askId).toBe("ask-1");

    const answered = applyEnvelope(asking, envelope<Reply>("reply", { askId: "ask-1", answer: "sim" }));
    expect(answered.pendingAsk).toBeNull();
  });

  it("deixa cada linha com o seu próprio especialista quando o histórico tem duas rotas", () => {
    const state = reduce(initialAppData(), [
      envelope<Message>("message", { role: "user", text: "corrige o parser" }, { turn: "t-1" }),
      envelope<Route>("route", route("code", "editor"), { turn: "t-1", specialist: "master" }),
      envelope<Delta>("delta", { text: "Parser corrigido." }, { turn: "t-1", specialist: "code" }),
      envelope<Message>(
        "message",
        { role: "assistant", text: "Parser corrigido.", specialist: "code" },
        { turn: "t-1", specialist: "code" }
      ),
      envelope<Done>("done", { turn: "t-1" }, { turn: "t-1" }),

      envelope<Message>("message", { role: "user", text: "agora desenha a tela" }, { turn: "t-2" }),
      envelope<Route>("route", route("design", "canvas", "code"), { turn: "t-2", specialist: "master" }),
      envelope<Delta>("delta", { text: "Tela desenhada." }, { turn: "t-2", specialist: "design" }),
      envelope<Message>(
        "message",
        { role: "assistant", text: "Tela desenhada.", specialist: "design" },
        { turn: "t-2", specialist: "design" }
      ),
      envelope<Done>("done", { turn: "t-2" }, { turn: "t-2" })
    ]);

    const assistantLines = state.lines.filter((line) => line.role === "assistant");
    expect(assistantLines).toHaveLength(2);
    expect(assistantLines.map((line) => line.specialist)).toEqual(["code", "design"]);
    expect(assistantLines.map((line) => line.text)).toEqual(["Parser corrigido.", "Tela desenhada."]);

    // A segunda rota não pode reescrever a primeira linha nem seu texto.
    expect(assistantLines[0]?.route?.specialist).toBe("code");
    expect(assistantLines[1]?.route?.specialist).toBe("design");

    // A linha do usuário nunca carrega especialista (ela não foi atendida por um).
    const userLines = state.lines.filter((line) => line.role === "user");
    expect(userLines).toHaveLength(2);
    expect(userLines.every((line) => line.specialist === undefined)).toBe(true);

    // O estado da tela segue a ÚLTIMA rota; o histórico, não.
    expect(state.activeSpecialist).toBe("design");
    expect(state.activeSurface).toBe("canvas");
  });
});
