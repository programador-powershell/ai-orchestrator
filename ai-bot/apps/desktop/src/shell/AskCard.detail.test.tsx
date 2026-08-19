/**
 * O cartão de pergunta mostra o CORPO da decisão.
 *
 * O defeito: o gateway sempre mandou o plano no campo `detail` do ask, mas o
 * contrato do cliente nem declarava o campo e o cartão não o desenhava. O
 * resultado era um diálogo dizendo "Design propôs um plano antes de executar.
 * Aprovar?" — sem plano nenhum à vista, pedindo um sim no escuro.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { AskCard } from "./AskCard";

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
    root.render(<AskCard />);
  });
}

const PLANO = "1. Definir tokens de design\n2. Criar estrutura base\n3. Compor as telas";

describe("o corpo da pergunta", () => {
  it("o plano aparece no cartão, aberto — é ele que está sendo aprovado", () => {
    useApp.setState({
      pendingAsk: {
        askId: "a1",
        question: "Design propôs um plano antes de executar. Aprovar?",
        options: ["Aprovar plano", "Ajustar"],
        detail: PLANO,
        blocking: true
      }
    });
    monta();

    const corpo = container.querySelector(".ask-detail");
    expect(corpo?.textContent).toBe(PLANO);
    // Aberto de verdade, não atrás de um <details> fechado: um cartão que diz
    // "aprovar o plano?" sem mostrar o plano pede um sim no escuro.
    expect(corpo?.closest("details")).toBeNull();
    // E as opções continuam lá.
    const botoes = [...container.querySelectorAll("button")].map((botao) => botao.textContent);
    expect(botoes).toEqual(["Aprovar plano", "Ajustar"]);
  });

  it("pergunta sem corpo não desenha um bloco vazio", () => {
    useApp.setState({
      pendingAsk: {
        askId: "a2",
        question: "Qual banco de dados o projeto usa?",
        blocking: true
      }
    });
    monta();

    expect(container.querySelector(".ask-detail")).toBeNull();
  });
});
