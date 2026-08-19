/**
 * A tela de Tuning saindo do empty-state perpétuo — montagem real: o bloco
 * ```json de finetune.status virando lista de execuções (estado/passo/perda),
 * os botões da barra superior aparecendo pelo portal, e o vazio digno quando o
 * resultado é só texto (gateway antigo).
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { TrainSurface } from "./TrainSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let topbarHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // O host do portal da barra superior: no app ele vive na Topbar; sem ele os
  // botões do Tuning não teriam onde aparecer.
  topbarHost = document.createElement("div");
  topbarHost.id = "topbar-actions";
  document.body.appendChild(topbarHost);
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
  topbarHost.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/** Um tool.result de finetune.status como o gateway emite: texto + bloco. */
function linhaComTreinos(): ConversationLine {
  const bloco = {
    provider: "openai",
    runs: [
      // step/loss não vêm do dialeto da OpenAI, mas o contrato da tela já os
      // lê — este run prova o cartão completo, o de baixo prova o mínimo.
      { id: "ftjob-1", state: "running", model: "base-a", step: 120, totalSteps: 400, loss: 1.2345 },
      { id: "ftjob-2", state: "succeeded", model: "base-b", fineTunedModel: "ft:base-b:acme" },
      { id: "ftjob-3", state: "validating_files", model: "base-c" }
    ]
  };
  return {
    id: "l1",
    seq: 1,
    ts: "2026-08-19T00:00:00Z",
    role: "assistant",
    text: "",
    toolResults: [
      {
        callId: "c1",
        tool: "finetune.status",
        ok: true,
        output: `3 treino(s) em openai:\n- ftjob-1 …\n\n\`\`\`json\n${JSON.stringify(bloco, null, 2)}\n\`\`\``
      }
    ]
  };
}

function monta(lines: ConversationLine[]) {
  useApp.setState({ lines });
  act(() => {
    root.render(<TrainSurface />);
  });
}

function clica(alvo: Element) {
  act(() => {
    alvo.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function botaoPorTexto(raiz: ParentNode, texto: string): HTMLButtonElement {
  const alvo = [...raiz.querySelectorAll("button")].find((botao) => botao.textContent?.trim() === texto);
  expect(alvo, `botão "${texto}"`).toBeDefined();
  return alvo as HTMLButtonElement;
}

/* ------------------------- bloco JSON → execuções ------------------------- */

describe("a tela de Tuning com o bloco JSON", () => {
  it("lista as execuções com estado, passo e perda", () => {
    monta([linhaComTreinos()]);

    const linhas = container.querySelectorAll(".run-row");
    expect(linhas.length).toBe(3);
    expect(container.textContent).toContain("ftjob-1");
    expect(container.textContent).toContain("perda 1.2345");
    expect(container.textContent).toContain("passo 120/400");
    // O contador do topo sai do mesmo modelo.
    expect(container.textContent).toContain("3 execuções");
    // E o empty-state foi embora.
    expect(container.textContent).not.toContain("Nenhum treino na mesa");
  });

  it("traduz os estados do provedor para o vocabulário da tela", () => {
    monta([linhaComTreinos()]);

    const estados = [...container.querySelectorAll(".run-row")].map((row) => row.getAttribute("data-state"));
    // running → running; succeeded → ok; validating_files é a antessala da
    // fila no dialeto da OpenAI — para quem olha, é fila.
    expect(estados).toEqual(["running", "ok", "queued"]);
  });
});

/* ------------------------- botões da barra superior ------------------------ */

describe("os botões do Tuning na barra superior", () => {
  it("Dataset e Avaliar escrevem o comando no composer — a pessoa completa e envia", () => {
    monta([]);

    clica(botaoPorTexto(topbarHost, "Dataset"));
    expect(useApp.getState().input).toBe("/dataset ");

    clica(botaoPorTexto(topbarHost, "Avaliar"));
    expect(useApp.getState().input).toBe("/avaliar ");
  });

  it("Atualizar treinos existe e respeita o busy — nada roda por fora do funil", () => {
    monta([]);
    expect(botaoPorTexto(topbarHost, "Atualizar treinos").disabled).toBe(false);

    act(() => {
      useApp.setState({ busy: true });
    });
    expect(botaoPorTexto(topbarHost, "Atualizar treinos").disabled).toBe(true);
  });
});

/* ------------------------------ vazio digno ------------------------------- */

describe("a tela de Tuning sem bloco JSON", () => {
  it("resultado só texto (gateway antigo) mantém o estado vazio", () => {
    monta([
      {
        id: "l1",
        seq: 1,
        ts: "2026-08-19T00:00:00Z",
        role: "assistant",
        text: "",
        toolResults: [
          {
            callId: "c1",
            tool: "finetune.status",
            ok: true,
            output: "- ftjob-1 — base base-a — estado running"
          }
        ]
      }
    ]);

    expect(container.textContent).toContain("Nenhum treino na mesa");
    expect(container.querySelectorAll(".run-row").length).toBe(0);
  });
});
