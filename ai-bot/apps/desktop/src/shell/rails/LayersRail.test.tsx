/**
 * O rail de camadas DESENHADO: lista do topo para a base, seleção, ordem,
 * exclusão e stencils.
 *
 * O placeholder do Rail.tsx prometia "as camadas aparecem aqui" para sempre;
 * este arquivo fixa o contrato do substituto — o rail lê o MESMO store da
 * CanvasSurface (useCanvasStudio) e aciona as mesmas ações, então o que se
 * afirma aqui é a fiação rail→store, com o efeito visível na marcação.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { canUndo, createHistory, type CanvasDoc } from "../../lib/canvas";
import { useCanvasStudio } from "../../specialists/CanvasSurface";
import { LayersRail } from "./LayersRail";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

/** Doc de três nós com tipos diferentes — ordem no array: frame, rect, text
 *  (o text é o MAIS AO TOPO, contrato do canvasDoc). */
const docTeste = (): CanvasDoc => ({
  name: "Teste",
  nodes: [
    { id: "frame-1", type: "frame", x: 0, y: 0, w: 480, h: 320, fill: "#ffffff", radius: 0, text: "Frame 1" },
    { id: "rect-1", type: "rect", x: 10, y: 10, w: 100, h: 80, fill: "#d9d9d9", radius: 0 },
    { id: "text-1", type: "text", x: 20, y: 20, w: 160, h: 24, fill: "#111827", text: "Olá", fontSize: 16 }
  ]
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useCanvasStudio.setState({ doc: docTeste(), history: createHistory(), selectedId: null });
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
    root.render(<LayersRail />);
  });
}

/** As camadas na ordem da tela: rótulo e tipo (meta). */
function camadas() {
  return [...container.querySelectorAll(".rail-layer")].map((linha) => ({
    rotulo: linha.querySelector(".rail-item-label")?.textContent ?? "",
    tipo: linha.querySelector(".rail-item-meta")?.textContent ?? "",
    ativa: linha.querySelector(".rail-item")?.getAttribute("data-active") === "true"
  }));
}

function botaoDaCamada(rotulo: string, acao: "Subir" | "Descer" | "Excluir"): HTMLButtonElement {
  const botao = container.querySelector<HTMLButtonElement>(`button[aria-label="${acao} ${rotulo}"]`);
  expect(botao, `${acao} ${rotulo}`).not.toBeNull();
  return botao as HTMLButtonElement;
}

describe("as camadas no rail", () => {
  it("listam do topo para a base, com nome e tipo — a ordem em que o olho procura", () => {
    monta();
    expect(camadas()).toEqual([
      { rotulo: "Olá", tipo: "text", ativa: false },
      { rotulo: "rect-1", tipo: "rect", ativa: false },
      { rotulo: "Frame 1", tipo: "frame", ativa: false }
    ]);
  });

  it("clicar numa camada seleciona o nó no store — é a seleção que o canvas desenha", () => {
    monta();
    const linha = [...container.querySelectorAll<HTMLButtonElement>(".rail-layer .rail-item")].find(
      (item) => item.querySelector(".rail-item-label")?.textContent === "rect-1"
    );
    act(() => {
      linha?.click();
    });
    expect(useCanvasStudio.getState().selectedId).toBe("rect-1");
    expect(camadas().find((camada) => camada.rotulo === "rect-1")?.ativa).toBe(true);
  });

  it("descer move a camada para baixo no documento (índice menor = mais ao fundo)", () => {
    monta();
    act(() => {
      botaoDaCamada("rect-1", "Descer").click();
    });
    expect(useCanvasStudio.getState().doc.nodes.map((node) => node.id)).toEqual([
      "rect-1",
      "frame-1",
      "text-1"
    ]);
    // E a tela reflete a ordem nova na hora.
    expect(camadas().map((camada) => camada.rotulo)).toEqual(["Olá", "Frame 1", "rect-1"]);
  });

  it("a camada do topo não sobe e a da base não desce — botão que não faria nada fica desabilitado", () => {
    monta();
    expect(botaoDaCamada("Olá", "Subir").disabled).toBe(true);
    expect(botaoDaCamada("Olá", "Descer").disabled).toBe(false);
    expect(botaoDaCamada("Frame 1", "Descer").disabled).toBe(true);
    expect(botaoDaCamada("Frame 1", "Subir").disabled).toBe(false);
  });

  it("excluir remove a camada e o gesto é desfazível — apagar sem volta seria perda de trabalho", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("rect-1");
    });
    act(() => {
      botaoDaCamada("rect-1", "Excluir").click();
    });
    const { doc, selectedId, history } = useCanvasStudio.getState();
    expect(doc.nodes.map((node) => node.id)).toEqual(["frame-1", "text-1"]);
    // A seleção do nó apagado não pode sobrar apontando para o nada.
    expect(selectedId).toBeNull();
    expect(canUndo(history)).toBe(true);
  });

  it("vazio honesto quando não há nós — e diz como criar o primeiro", () => {
    useCanvasStudio.setState({ doc: { name: "Vazio", nodes: [] } });
    monta();
    expect(container.querySelector(".rail-layer")).toBeNull();
    expect(container.querySelector(".rail-empty-hint")?.textContent).toContain("ferramenta");
  });
});

describe("os stencils do rail", () => {
  it("os três grupos da paleta aparecem na ordem do módulo", () => {
    monta();
    const grupos = [...container.querySelectorAll(".rail-stencil-group > small")].map(
      (grupo) => grupo.textContent
    );
    expect(grupos).toEqual(["Formulário", "Layout", "Fluxograma"]);
  });

  it("inserir um stencil cria as peças prontas e seleciona a primeira", () => {
    monta();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[title^="Inserir Botão"]')?.click();
    });
    const { doc, selectedId } = useCanvasStudio.getState();
    // Botão = fundo + rótulo, por cima dos três nós que já existiam.
    expect(doc.nodes).toHaveLength(5);
    expect(selectedId).toBe(doc.nodes[3]?.id);
    expect(doc.nodes[4]?.type).toBe("text");
  });

  it("duas inserções seguidas não colidem: ids únicos e posições em cascata", () => {
    // Dois cliques podem cair no MESMO milissegundo — semear só com Date.now()
    // (como o orquestrador fazia) duplicaria ids, e updateNode/removeNode
    // casam por id: mover um botão moveria o outro junto.
    monta();
    const inserir = container.querySelector<HTMLButtonElement>('button[title^="Inserir Botão"]');
    act(() => {
      inserir?.click();
    });
    act(() => {
      inserir?.click();
    });
    const { doc } = useCanvasStudio.getState();
    expect(doc.nodes).toHaveLength(7);
    expect(new Set(doc.nodes.map((node) => node.id)).size).toBe(7);
    // A cascata desloca a segunda peça: duas inserções produzem duas peças
    // VISÍVEIS, não uma pilha exata que parece inserção falhada.
    const fundos = doc.nodes.filter((node) => node.id.endsWith("-bg"));
    expect(fundos).toHaveLength(2);
    expect(fundos[0]?.x).not.toBe(fundos[1]?.x);
  });
});
