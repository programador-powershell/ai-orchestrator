/**
 * O overlay do Ctrl+K, montado de verdade: atalho abre, Escape fecha, a busca
 * (injetada — a de produção fala com o gateway) pinta os resultados, e Enter e
 * clique abrem a conversa do resultado.
 *
 * Aqui não há @testing-library: a montagem é `react-dom/client` cru com o `act`
 * do React 19, como nos outros testes de tela deste projeto. O `buscar` é
 * injetado porque o contrato da ROTA já é provado no Go — o que este arquivo
 * prova é o comportamento do overlay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { SearchOverlay, type SearchHit } from "./SearchOverlay";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

const HITS: SearchHit[] = [
  {
    session: "s-deploy",
    title: "deploy do portal",
    seq: 4,
    turn: "t1",
    role: "user",
    snippet: "…como faço o deploy…",
    updatedAt: "2026-08-19T12:00:00Z"
  },
  {
    session: "s-outra",
    title: "outra conversa",
    seq: 9,
    turn: "t3",
    role: "assistant",
    snippet: "…o deploy sai por pipeline…",
    updatedAt: "2026-08-19T11:00:00Z"
  }
];

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta(buscar: (query: string) => Promise<SearchHit[]>) {
  act(() => {
    root.render(<SearchOverlay buscar={buscar} />);
  });
}

function atalho() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  });
}

/** Digita no input controlado — setter nativo + evento, como nos vizinhos. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom sem setter de value");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function campo(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Termo da busca"]');
  if (!input) throw new Error("o campo da busca não está na tela");
  return input;
}

/** Espera o debounce e a promise da busca dentro do act. */
async function aguardaBusca() {
  await act(async () => {
    vi.advanceTimersByTime(250);
    await Promise.resolve();
  });
}

function tecla(key: string) {
  act(() => {
    campo().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("SearchOverlay", () => {
  it("abre com Ctrl+K, fecha com Escape, e fechado não deixa nada na tela", () => {
    monta(() => Promise.resolve([]));
    expect(container.querySelector(".search-overlay")).toBeNull();

    atalho();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    tecla("Escape");
    expect(container.querySelector(".search-overlay")).toBeNull();
  });

  it("busca com debounce e pinta sessão + trecho de cada resultado", async () => {
    const buscar = vi.fn(() => Promise.resolve(HITS));
    monta(buscar);
    atalho();

    type(campo(), "deploy");
    // Antes do debounce, nenhuma ida à rede: digitação não é dez buscas.
    expect(buscar).not.toHaveBeenCalled();

    await aguardaBusca();
    expect(buscar).toHaveBeenCalledWith("deploy");

    const resultados = [...container.querySelectorAll(".search-hit")];
    expect(resultados).toHaveLength(2);
    expect(resultados[0]?.textContent).toContain("deploy do portal");
    expect(resultados[0]?.textContent).toContain("como faço o deploy");
  });

  it("Enter abre a conversa selecionada; as setas movem a seleção", async () => {
    const abertas: string[] = [];
    useApp.setState({ openSession: (id: string) => abertas.push(id) });

    monta(() => Promise.resolve(HITS));
    atalho();
    type(campo(), "deploy");
    await aguardaBusca();

    tecla("ArrowDown");
    tecla("Enter");

    expect(abertas).toEqual(["s-outra"]);
    // Abrir fecha o overlay: a pessoa foi para a conversa.
    expect(container.querySelector(".search-overlay")).toBeNull();
  });

  it("clique num resultado abre a conversa dele", async () => {
    const abertas: string[] = [];
    useApp.setState({ openSession: (id: string) => abertas.push(id) });

    monta(() => Promise.resolve(HITS));
    atalho();
    type(campo(), "deploy");
    await aguardaBusca();

    const primeiro = container.querySelector<HTMLButtonElement>(".search-hit");
    act(() => {
      primeiro?.click();
    });
    expect(abertas).toEqual(["s-deploy"]);
  });

  it("mostra a falha da busca em vez de engoli-la", async () => {
    monta(() => Promise.reject(new Error("sem conexão com o gateway")));
    atalho();
    type(campo(), "deploy");
    await aguardaBusca();

    expect(container.querySelector(".search-failure")?.textContent).toContain("sem conexão");
  });
});
