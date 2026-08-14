/**
 * A barra superior É a barra de título da janela.
 *
 * A janela principal sobe com `decorations: false`, então o sistema não desenha
 * moldura nenhuma: sem os controles daqui a pessoa não fecha, não minimiza e não
 * arrasta o aplicativo — e não existe atalho de teclado que a salve, porque o
 * Alt+F4 fecha a janela sem passar pelo encerramento do Rust.
 *
 * Os três testes cobrem exatamente as três formas de errar isto:
 *   1. não ter os botões;
 *   2. tê-los dentro da faixa de arrasto (aí o clique vira arrasto);
 *   3. mostrá-los no navegador, onde não há janela nativa para eles moverem.
 *
 * Aqui não há @testing-library: a montagem é `react-dom/client` cru com o `act`
 * do React 19. Cada dependência deste projeto passa por homologação de TI/SI, e
 * uma biblioteca inteira de testes para clicar em três botões não se justifica.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Topbar } from "./Topbar";

/* ------------------------------ a janela falsa ---------------------------- */

const minimize = vi.fn(async () => {});
const toggleMaximize = vi.fn(async () => {});
const close = vi.fn(async () => {});

// O módulo nativo não existe fora do Tauri; o componente o carrega por import
// dinâmico, e é este mock que responde no lugar dele.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close })
}));

// A bandeira que o React 19 procura para aceitar `act()` fora de uma suíte
// oficial. `var` é o que declara variável GLOBAL em TypeScript — com `let` ou
// `const` a declaração não vale para `globalThis`.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

/** Liga o que faz `isTauri()` responder que estamos no aplicativo nativo. */
function pretendeSerTauri(nativo: boolean) {
  if (nativo) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    return;
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function monta() {
  act(() => {
    root.render(<Topbar />);
  });
}

function botao(rotulo: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${rotulo}"]`);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  minimize.mockClear();
  toggleMaximize.mockClear();
  close.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  pretendeSerTauri(false);
});

/* --------------------------------- testes -------------------------------- */

describe("controles da janela", () => {
  it("oferece minimizar, maximizar e fechar, e cada um aciona a janela nativa", async () => {
    pretendeSerTauri(true);
    monta();

    const acoes: Array<[string, ReturnType<typeof vi.fn>]> = [
      ["Minimizar", minimize],
      ["Maximizar ou restaurar", toggleMaximize],
      ["Fechar", close]
    ];

    for (const [rotulo, esperado] of acoes) {
      const alvo = botao(rotulo);
      expect(alvo, `faltou o botão "${rotulo}" na barra de título`).not.toBeNull();
      // O clique cai num handler assíncrono (o import dinâmico do módulo da
      // janela); sem o `act` assíncrono, a asserção correria antes dele.
      await act(async () => {
        alvo?.click();
      });
      expect(esperado, `o botão "${rotulo}" não acionou a janela`).toHaveBeenCalledTimes(1);
    }
  });

  it("não desenha os controles fora do Tauri", () => {
    pretendeSerTauri(false);
    monta();

    // Botão de fechar que não fecha é pior que botão nenhum: no navegador do
    // `pnpm dev` não existe janela nativa para eles comandarem.
    expect(botao("Fechar")).toBeNull();
    expect(botao("Minimizar")).toBeNull();
    expect(botao("Maximizar ou restaurar")).toBeNull();
    // O resto da barra continua de pé.
    expect(botao("Configurações")).not.toBeNull();
  });
});

describe("faixa de arrasto", () => {
  it("existe e não engole nenhum controle", () => {
    pretendeSerTauri(true);
    monta();

    const faixas = container.querySelectorAll("[data-tauri-drag-region]");
    expect(faixas.length, "sem faixa de arrasto a janela sem moldura não sai do lugar").toBeGreaterThan(0);

    for (const faixa of faixas) {
      expect(
        faixa.querySelector("button, select, input, a"),
        "controle dentro da faixa de arrasto: o clique vira arrasto e o botão não responde"
      ).toBeNull();
    }

    for (const alvo of container.querySelectorAll("button, select")) {
      expect(
        alvo.closest("[data-tauri-drag-region]"),
        `"${alvo.getAttribute("aria-label") ?? alvo.tagName}" está dentro de uma faixa de arrasto`
      ).toBeNull();
    }
  });
});
