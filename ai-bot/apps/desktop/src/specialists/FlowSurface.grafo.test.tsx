/**
 * A tela de Fluxo DESENHANDO — montagem real da superfície, porque o que esta
 * onda entrega é de tela: o bloco ```json do flow.validate virando grafo do
 * @xyflow, o problema atribuído acendendo o nó, o "Exportar JSON" saindo do
 * desabilitado eterno, e o vazio continuando digno quando o resultado é só
 * texto (gateway antigo).
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 *
 * Os shims do topo são o preço de rodar o @xyflow em jsdom: a biblioteca mede
 * o contêiner (ResizeObserver + offsetWidth/Height) e lê o zoom do transform
 * (DOMMatrixReadOnly). São os mocks da documentação oficial de teste do xyflow,
 * não invenção nossa.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { FlowSurface } from "./FlowSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* ------------------------- shims exigidos pelo @xyflow -------------------- */

class ResizeObserverShim {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    // O xyflow lê entry.contentRect.width/height para dimensionar o viewport.
    const contentRect = { width: 640, height: 480, x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 480 };
    this.callback(
      [{ target, contentRect } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyShim {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

globalThis.ResizeObserver = ResizeObserverShim as unknown as typeof ResizeObserver;
(globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyShim;
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 480 },
  offsetWidth: { configurable: true, get: () => 640 }
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

/* --------------------------------- fixture -------------------------------- */

let container: HTMLDivElement;
let topbarHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // O host do portal da barra superior: no app ele vive na Topbar; sem ele
  // "Validar" e "Exportar JSON" não teriam onde aparecer.
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

/** Um tool.result de flow.validate como o gateway emite: relatório + bloco. */
function linhaComFluxo(): ConversationLine {
  const bloco = {
    name: "atendimento",
    ok: false,
    nodes: [
      { id: "start", kind: "input", label: "Receber pedido" },
      { id: "work", kind: "action", label: "Processar", onError: "fail" },
      { id: "fail", kind: "output", label: "Avisar falha" }
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "fail", label: "erro" }
    ],
    problems: [
      {
        level: "error",
        message: 'o nó "work" aponta em "next" para "done", que não existe no fluxo',
        nodeId: "work"
      }
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
        tool: "flow.validate",
        ok: true,
        output: `fluxo "atendimento" — 3 nó(s) — RECUSADO\n\n\`\`\`json\n${JSON.stringify(bloco, null, 2)}\n\`\`\``
      }
    ]
  };
}

function monta(lines: ConversationLine[]) {
  useApp.setState({ lines });
  act(() => {
    root.render(<FlowSurface />);
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

/* ------------------------- bloco JSON → grafo real ------------------------ */

describe("a tela de Fluxo desenhando o flow.validate", () => {
  it("desenha os nós do bloco JSON com o @xyflow e mostra o problema atribuído", () => {
    monta([linhaComFluxo()]);

    // Os três nós viraram nós custom do @xyflow, com kind e rótulo.
    const nos = container.querySelectorAll(".flow-xy-node");
    expect(nos.length).toBe(3);
    expect(container.textContent).toContain("Receber pedido");
    expect(container.textContent).toContain("Processar");

    // O problema do relatório aparece na lista, com o chip do nó ofensor.
    expect(container.textContent).toContain("que não existe no fluxo");

    // O veredito veio do bloco (ok: false).
    expect(container.textContent).toContain("com problema");

    // "work" está sem… não: work TEM onError; "start" e "fail" não têm — os
    // pontos de aviso acendem neles, não nele.
    expect(container.querySelectorAll(".flow-xy-warn").length).toBe(2);
  });

  it("clicar no chip do problema seleciona o nó no painel de propriedades", () => {
    monta([linhaComFluxo()]);

    const chip = [...container.querySelectorAll(".flow-issue button")].find(
      (botao) => botao.textContent?.trim() === "work"
    );
    expect(chip).toBeDefined();
    clica(chip!);

    const painel = container.querySelector(".flow-props");
    expect(painel?.textContent).toContain("Processar");
    // O caminho de erro declarado aparece no painel.
    expect(painel?.textContent).toContain("fail");
  });

  it("habilita o Exportar JSON quando o bloco existe — e o grafo estruturado é o que sai", () => {
    monta([linhaComFluxo()]);

    const exportar = botaoPorTexto(topbarHost, "Exportar JSON");
    expect(exportar.disabled).toBe(false);
  });
});

/* ------------------------------ vazio digno ------------------------------- */

describe("a tela de Fluxo sem bloco JSON", () => {
  it("resultado só texto (gateway antigo) mantém o estado vazio e o exportar desabilitado", () => {
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
            tool: "flow.validate",
            ok: true,
            output: 'fluxo "x" — 2 nó(s) — VÁLIDO\n\nnenhum erro e nenhum aviso\n'
          }
        ]
      }
    ]);

    expect(container.textContent).toContain("Nenhum fluxo na tela");
    expect(container.querySelectorAll(".flow-xy-node").length).toBe(0);
    expect(botaoPorTexto(topbarHost, "Exportar JSON").disabled).toBe(true);
  });

  it("sem resultado nenhum, idem", () => {
    monta([]);
    expect(container.textContent).toContain("Nenhum fluxo na tela");
    expect(botaoPorTexto(topbarHost, "Exportar JSON").disabled).toBe(true);
  });
});
