/**
 * As ações por conversa na barra: exportar (.md/.json) e apagar em DOIS
 * cliques. O apagar destrutivo com um clique só era o defeito a evitar — o
 * primeiro clique ARMA a lixeira (visível e reversível), o segundo confirma.
 *
 * As ações do store entram como dublês: o DELETE e a exportação de verdade são
 * provados nos testes do gateway e de sessionExport — aqui se prova o gesto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { Rail } from "./Rail";

// O avatar carrega o módulo do Lab por URL, e jsdom não tem de onde buscá-lo —
// o mesmo dublê dos outros testes do Rail.
vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: () =>
      Promise.resolve({ setSpecialist: () => {}, setState: () => {}, destroy: () => {} })
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

const apagadas: string[] = [];
const exportadas: Array<{ id: string; format: string }> = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  apagadas.length = 0;
  exportadas.length = 0;
  useApp.setState({
    ...initialAppData(),
    railOpen: true,
    session: "s1",
    sessions: [
      {
        id: "s1",
        title: "página de vendas",
        createdAt: "2026-08-19T12:00:00Z",
        updatedAt: "2026-08-19T12:00:00Z",
        lastSeq: 4,
        syncedSeq: 4,
        turns: 2
      }
    ],
    deleteSession: (id: string) => apagadas.push(id),
    exportSession: (id: string, format: "md" | "json") => exportadas.push({ id, format })
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
    root.render(<Rail />);
  });
}

function botao(rotulo: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${rotulo}"]`);
  if (!found) throw new Error(`botão "${rotulo}" não está na tela`);
  return found;
}

describe("as ações da linha de conversa", () => {
  it("exporta .md e .json pela linha, cada botão no formato dele", () => {
    monta();

    act(() => {
      botao("Exportar a conversa página de vendas como Markdown").click();
      botao("Exportar a conversa página de vendas como JSON").click();
    });

    expect(exportadas).toEqual([
      { id: "s1", format: "md" },
      { id: "s1", format: "json" }
    ]);
  });

  it("apagar exige DOIS cliques: o primeiro arma, o segundo confirma", () => {
    monta();

    const lixeira = botao("Apagar a conversa página de vendas");
    act(() => {
      lixeira.click();
    });

    // Armada, ainda não apagou — e a tela diz que o próximo clique é o de vez.
    expect(apagadas).toEqual([]);
    const armada = botao("Confirmar a exclusão da conversa página de vendas");
    expect(armada.getAttribute("data-armed")).toBe("true");

    act(() => {
      armada.click();
    });
    expect(apagadas).toEqual(["s1"]);
  });

  it("a lixeira desarma sozinha — clique esquecido não vira mina na lista", () => {
    vi.useFakeTimers();
    try {
      monta();
      act(() => {
        botao("Apagar a conversa página de vendas").click();
      });
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // Desarmada: o rótulo voltou ao de apagar, e nada foi apagado.
      expect(botao("Apagar a conversa página de vendas")).not.toBeNull();
      expect(apagadas).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
