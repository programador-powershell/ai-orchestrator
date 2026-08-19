/**
 * O rodapé com a equipe: enquanto houver orquestração em curso — tarefa
 * despachada sem desfecho, portão aberto ou delegação em andamento — o rodapé
 * fixa o objetivo e diz "orquestrando…", em QUALQUER superfície. É o único
 * pedaço da tela que sobrevive à troca de especialista, e é por isso que a
 * informação mora aqui e não na CrewSurface.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Delegate, Gate, TaskDispatch, WorkerDone } from "@aibot/contracts";
import { emptyCrew, initialAppData, useApp, type CrewState } from "../lib/store";
import { StatusBar, orchestrationOf } from "./StatusBar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/* -------------------------------- fixtures -------------------------------- */

function despacho(taskID: string, goal: string, wave = 1, workerID = ""): TaskDispatch {
  return {
    task: { id: taskID, title: `tarefa ${taskID}`, specialist: "code", goal },
    workerId: workerID === "" ? `w-${wave}-${taskID}` : workerID,
    wave
  };
}

function desfecho(taskID: string, workerID: string, ok = true): WorkerDone {
  return { taskId: taskID, workerId: workerID, ok };
}

function crewCom(parte: Partial<CrewState>): CrewState {
  return { ...emptyCrew(), ...parte };
}

function monta() {
  act(() => {
    root.render(<StatusBar />);
  });
}

/* --------------------------------- a pura --------------------------------- */

describe("orchestrationOf", () => {
  it("sem equipe e sem delegação não há nada a fixar", () => {
    expect(orchestrationOf(emptyCrew(), [])).toBeNull();
  });

  it("tarefa despachada sem desfecho é orquestração em curso, com o objetivo dela", () => {
    const crew = crewCom({ dispatches: [despacho("t1", "ler o banco")] });
    const current = orchestrationOf(crew, []);
    expect(current?.goal).toBe("ler o banco");
    expect(current?.detail).toContain("onda 1");
    expect(current?.detail).toContain("1 de 1");
  });

  it("todas com desfecho: o plano acabou e o rodapé solta o objetivo", () => {
    const crew = crewCom({
      dispatches: [despacho("t1", "ler o banco")],
      done: { t1: desfecho("t1", "w-1-t1") }
    });
    expect(orchestrationOf(crew, [])).toBeNull();
  });

  it("o refazer casa por workerId, não por taskId — a reexecução volta a contar como em curso", () => {
    // `crew.done` é mapa por tarefa: o desfecho da 1ª tentativa fica lá para
    // sempre. Casar por taskId faria a 2ª tentativa nascer "concluída".
    const crew = crewCom({
      dispatches: [despacho("t1", "ler o banco"), despacho("t1", "ler o banco", 1, "w-1-t1-r2")],
      done: { t1: desfecho("t1", "w-1-t1", false) }
    });
    const current = orchestrationOf(crew, []);
    expect(current).not.toBeNull();
    expect(current?.goal).toBe("ler o banco");
  });

  it("onda fechada com portão aberto ainda é plano em curso — parado esperando decisão", () => {
    const crew = crewCom({
      dispatches: [despacho("t1", "ler o banco")],
      done: { t1: desfecho("t1", "w-1-t1", false) },
      // O pedido como o gateway o emite: sem decisão. O tipo do contrato exige
      // o campo, daí o molde.
      gate: { gateId: "g1", decision: "" as Gate["decision"], reason: "1 tarefa da onda 1 falhou" }
    });
    const current = orchestrationOf(crew, []);
    expect(current?.detail).toContain("portão aberto");
    expect(current?.goal).toContain("falhou");
  });

  it("delegação em aberto fixa o objetivo dela; fechada, solta", () => {
    const aberta: Delegate = { from: "chat", to: "data", goal: "descrever o esquema", depth: 1 };
    const current = orchestrationOf(emptyCrew(), [aberta]);
    expect(current?.goal).toBe("descrever o esquema");
    expect(current?.detail).toBe("com data");

    expect(orchestrationOf(emptyCrew(), [{ ...aberta, done: true, result: "feito" }])).toBeNull();
  });
});

/* --------------------------------- a tela --------------------------------- */

describe("o rodapé durante a orquestração", () => {
  it("fixa o objetivo e o estado enquanto a tarefa roda, e some quando o plano fecha", () => {
    monta();
    expect(container.querySelector(".statusbar-crew")).toBeNull();

    act(() => {
      useApp.setState({ crew: crewCom({ dispatches: [despacho("t1", "gerar a API de cobrança")] }) });
    });
    const badge = container.querySelector(".statusbar-crew");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("orquestrando…");
    expect(badge?.textContent).toContain("gerar a API de cobrança");

    act(() => {
      useApp.setState({
        crew: crewCom({
          dispatches: [despacho("t1", "gerar a API de cobrança")],
          done: { t1: desfecho("t1", "w-1-t1") }
        })
      });
    });
    expect(container.querySelector(".statusbar-crew")).toBeNull();
  });

  it("delegação em aberto também aparece — a equipe não é a única orquestração", () => {
    monta();
    act(() => {
      useApp.setState({
        delegations: [{ from: "chat", to: "office", goal: "revisar o contrato", depth: 1 }]
      });
    });
    const badge = container.querySelector(".statusbar-crew");
    expect(badge?.textContent).toContain("orquestrando…");
    expect(badge?.textContent).toContain("revisar o contrato");
    expect(badge?.textContent).toContain("com office");
  });
});
