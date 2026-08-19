/**
 * Os botões do Quadro na barra superior — a reclamação literal era "faltam os
 * botões de cima" nas telas de Trabalho e Tuning. Aqui a montagem real do
 * BoardSurface prova que os botões chegam ao slot da Topbar pelo portal, que
 * "Tarefa"/"Automação" só ESCREVEM no composer (quem envia é a pessoa) e que
 * "Andamento" respeita o busy — nenhum botão executa nada por fora do funil.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { BoardSurface } from "./BoardSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// O jsdom não implementa scrollTo de elemento, e a conversa compacta (que o
// Quadro monta ao lado das colunas) rola até o fim no mount.
Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];

let container: HTMLDivElement;
let topbarHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

function monta() {
  act(() => {
    root.render(<BoardSurface />);
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

describe("os botões do Quadro na barra superior", () => {
  it("chegam ao slot da Topbar pelo portal", () => {
    monta();
    botaoPorTexto(topbarHost, "Tarefa");
    botaoPorTexto(topbarHost, "Automação");
    botaoPorTexto(topbarHost, "Andamento");
  });

  it("Tarefa e Automação escrevem o comando no composer — a pessoa completa e envia", () => {
    monta();

    clica(botaoPorTexto(topbarHost, "Tarefa"));
    expect(useApp.getState().input).toBe("/tarefa ");

    clica(botaoPorTexto(topbarHost, "Automação"));
    expect(useApp.getState().input).toBe("/automacao ");
  });

  it("Andamento respeita o busy — sem fila de pedidos por cima de um turno aberto", () => {
    monta();
    expect(botaoPorTexto(topbarHost, "Andamento").disabled).toBe(false);

    act(() => {
      useApp.setState({ busy: true });
    });
    expect(botaoPorTexto(topbarHost, "Andamento").disabled).toBe(true);
  });
});
