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
  Delegate,
  Delta,
  Done,
  Envelope,
  EnvelopeKind,
  Escalate,
  Message,
  Ready,
  Reply,
  Route,
  State,
  TaskDispatch,
  Thinking,
  WorkerDone
} from "@aibot/contracts";
import { outcomeOf } from "./crew";
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
    // A rota continua flipando a TELA onde quer que chegue: conversa nascida
    // no bot, conversa filha, `/mode` explícito e replay de log antigo. O que
    // mudou mora no GATEWAY: o primeiro input de trabalho numa raiz não emite
    // mais rota — vira delegação (ver store.raizOrquestradora.test.ts).
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

  /**
   * O ambiente é do GATEWAY, não da tela.
   *
   * Quem executa é ele, então é ele quem diz onde o próximo comando cai e quais
   * ambientes existem nesta máquina. Se o `ready` não preenchesse isto, o rodapé
   * mostraria para sempre a reserva local — e um rodapé que diz "Local" enquanto
   * o gateway executa em contêiner é pior que rodapé nenhum.
   */
  it("ready preenche o ambiente em vigor e o catálogo medido na máquina", () => {
    const state = applyEnvelope(
      initialAppData(),
      envelope<Ready>("ready", {
        session: "sessao-1",
        seq: 3,
        specialists: ["chat"],
        models: [],
        environment: "docker",
        environments: [
          { id: "local", label: "Local", hint: "na sua estação", available: true },
          { id: "docker", label: "Docker", hint: "contêiner descartável", available: true },
          {
            id: "vps",
            label: "VPS",
            hint: "servidor remoto",
            available: false,
            detail: "nenhum servidor cadastrado"
          }
        ]
      })
    );

    expect(state.environment).toBe("docker");
    expect(state.environments.map((item) => item.id)).toEqual(["local", "docker", "vps"]);
    // O motivo da indisponibilidade atravessa — é ele que vai para o `title` do
    // item desabilitado, e sem ele o menu apaga a opção sem explicar nada.
    expect(state.environments[2]?.available).toBe(false);
    expect(state.environments[2]?.detail).toBe("nenhum servidor cadastrado");

    // Gateway antigo (sem os campos) não pode APAGAR o que já está na tela.
    const again = applyEnvelope(
      state,
      envelope<Ready>("ready", { session: "sessao-1", seq: 4, specialists: ["chat"], models: [] })
    );
    expect(again.environment).toBe("docker");
    expect(again.environments).toHaveLength(3);
  });

  /**
   * A delegação não tem id — o par de bots mais o objetivo é a identidade.
   *
   * O modo de falha que este teste tranca: o `done` entrar como entrada NOVA. A
   * lista passaria a ter duas delegações, o popup leria a última (aberta, porque
   * a de cima nunca fechou) e ficaria de pé para sempre sobre a conversa.
   */
  it("delegate abre a entrada e o done conclui a mesma em vez de duplicar", () => {
    const call: Delegate = {
      from: "code",
      to: "data",
      goal: "modelar o esquema de cobrança",
      reason: "o pedido virou modelagem de dados",
      depth: 1
    };

    const opened = applyEnvelope(initialAppData(), envelope<Delegate>("delegate", call, { specialist: "code" }));
    expect(opened.delegations).toHaveLength(1);
    expect(opened.delegations[0]?.to).toBe("data");
    expect(opened.delegations[0]?.done).toBeUndefined();

    const closed = applyEnvelope(
      opened,
      envelope<Delegate>(
        "delegate",
        { ...call, done: true, result: "esquema com 4 tabelas" },
        { specialist: "data" }
      )
    );

    expect(closed.delegations).toHaveLength(1);
    expect(closed.delegations[0]?.done).toBe(true);
    expect(closed.delegations[0]?.result).toBe("esquema com 4 tabelas");
    // O motivo da abertura sobrevive à conclusão: é ele que explica a troca.
    expect(closed.delegations[0]?.reason).toBe("o pedido virou modelagem de dados");

    // Outro par não fecha esta: a identidade é o trio inteiro.
    const other = applyEnvelope(
      opened,
      envelope<Delegate>("delegate", { ...call, to: "design", done: true }, { specialist: "design" })
    );
    expect(other.delegations).toHaveLength(2);
    expect(other.delegations[0]?.done).toBeUndefined();
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
    // O cenário hoje nasce de `/mode` (ou do replay de uma conversa antiga):
    // a raiz não recebe mais rota de trabalho no roteamento do master. A regra
    // que o teste tranca é a mesma de sempre — a segunda rota NÃO pode apagar
    // de quem era a resposta anterior.
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

  /**
   * O `escalated` tem de ATRAVESSAR o envelope com este nome exato.
   *
   * O campo nasce no Go (`json:"escalated,omitempty"`) e é copiado à mão para o
   * contrato TS — não existe gerador nem teste que compare as duas pontas. Se os
   * nomes divergirem, NADA quebra: o payload chega, o campo vira `undefined`, o
   * desfecho volta a ser "failed" e a tela chama de falha quem só fez uma
   * pergunta. É o modo de falha que o cabeçalho do contrato descreve — silêncio.
   */
  it("worker.done atravessa com o escalated e o desfecho sai dele", () => {
    const state = reduce(initialAppData(), [
      envelope<TaskDispatch>("task.dispatch", {
        task: { id: "t1", title: "Migrar tabelas", specialist: "data", goal: "mover o schema" },
        workerId: "w-1-t1",
        wave: 1
      }),
      envelope<Escalate>("escalate", { taskId: "t1", workerId: "w-1-t1", question: "qual banco?" }),
      envelope<WorkerDone>("worker.done", {
        taskId: "t1",
        workerId: "w-1-t1",
        ok: false,
        escalated: true,
        error: "escalado: qual banco?"
      })
    ]);

    const done = state.crew.done["t1"];
    expect(done?.escalated).toBe(true);
    expect(done ? outcomeOf(done) : null).toBe("escalated");
    expect(state.crew.escalations).toHaveLength(1);
  });

  /**
   * A mesma tarefa reexecutada — o caso que decidiu o desenho.
   *
   * `crew.escalations` só cresce enquanto a conversa vive e `crew.done` é
   * sobrescrito por `taskId`. Quem deduzisse escalação cruzando as duas listas
   * ainda veria a escalação do primeiro plano aqui e chamaria de "escalado" uma
   * falha real — apagando-a do contador enquanto o gateway conta 1 e abre o
   * portão. O desfecho vem do `done` NOVO, e só dele.
   */
  it("o done novo da mesma tarefa vence a escalacao antiga", () => {
    const state = reduce(initialAppData(), [
      envelope<Escalate>("escalate", { taskId: "t1", workerId: "w-1-t1", question: "qual banco?" }),
      envelope<WorkerDone>("worker.done", {
        taskId: "t1",
        workerId: "w-1-t1",
        ok: false,
        escalated: true,
        error: "escalado: qual banco?"
      }),
      // Plano novo, mesmo id — um modelo reusa t1/t2/t3 —, e agora falha de verdade.
      envelope<WorkerDone>("worker.done", {
        taskId: "t1",
        workerId: "w-1-t1",
        ok: false,
        error: "o trabalhador não concluiu em 6 rodadas"
      })
    ]);

    const done = state.crew.done["t1"];
    expect(done?.escalated).toBeUndefined();
    expect(done ? outcomeOf(done) : null).toBe("failed");
    // A escalação velha CONTINUA na lista: é isso que torna o cruzamento errado.
    expect(state.crew.escalations).toHaveLength(1);
  });

  /**
   * O aviso de atualização não pode piscar.
   *
   * O gateway só anuncia PENDÊNCIA (`update.Service.announce` sai fora quando
   * não há nenhuma), e `state` chega de várias origens — a troca de ambiente é
   * uma delas. Se o campo ausente zerasse o aviso, ele sumiria no primeiro
   * clique do rodapé e voltaria na próxima verificação, sem nada explicando.
   */
  it("guarda a atualizacao pendente e nao a perde no state seguinte", () => {
    const comAviso = reduce(initialAppData(), [
      envelope<State>("state", {
        busy: false,
        updateAvailable: true,
        updateVersion: "0.2.0",
        updateTracks: ["ui", "gateway"]
      })
    ]);
    expect(comAviso.updateAvailable).toBe(true);
    expect(comAviso.updateVersion).toBe("0.2.0");
    expect(comAviso.updateTracks).toEqual(["ui", "gateway"]);

    // `state` de outra origem: só ambiente e `busy`, sem os campos de
    // atualização (é assim que o gateway os omite).
    const depois = applyEnvelope(comAviso, envelope<State>("state", { busy: true, environment: "docker" }));
    expect(depois.busy).toBe(true);
    expect(depois.environment).toBe("docker");
    expect(depois.updateAvailable, "o aviso não pode sumir num state alheio").toBe(true);
    expect(depois.updateTracks).toEqual(["ui", "gateway"]);
  });
});
