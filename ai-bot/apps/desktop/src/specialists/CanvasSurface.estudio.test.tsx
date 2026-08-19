/**
 * O estúdio de Design DESENHADO: criar por arrasto, mover, desfazer, atalhos,
 * Inspect, tokens aplicáveis e as abas de estúdio.
 *
 * A lógica pura (canvasDoc/history/devices/stencils/htmlTokens) já é coberta
 * pelos testes de módulo em lib/canvas. Este arquivo monta o componente porque
 * o que a Onda 2 entrega é de TELA — o gesto do ponteiro virando nó, a tecla
 * virando ferramenta, o clique no swatch virando fill — e a lógica certa com a
 * fiação errada seria o mesmo defeito de antes (prévia estática).
 *
 * Aqui não há @testing-library: a montagem é `react-dom/client` cru com o `act`
 * do React 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { canUndo, createDoc, createHistory, exportSvg } from "../lib/canvas";
import { CanvasSurface, DOC_STORAGE_KEY, useCanvasStudio } from "./CanvasSurface";

/*
 * O avatar (da conversa compacta à direita) carrega o módulo do Lab por URL, e
 * jsdom não tem de onde buscá-lo. O dublê devolve um controlador inerte — a
 * animação em si é assunto de `grokSpecialistAvatar.test.ts`.
 */
vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: () =>
      Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      })
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/*
 * O jsdom não implementa `element.scrollTo`, e a conversa compacta (coluna
 * direita da superfície) rola até o fim ao montar. O stub é vazio de
 * propósito: PARA ONDE ela rola é assunto dos testes da conversa, não deste
 * arquivo — aqui basta a montagem não explodir.
 */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
  // O store é de MÓDULO (sobrevive entre testes de propósito, como no app);
  // aqui cada teste parte do doc inicial para um não contaminar o outro.
  useCanvasStudio.setState({ doc: createDoc(), history: createHistory(), selectedId: null });
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
    root.render(<CanvasSurface />);
  });
}

/**
 * Um evento de ponteiro para o editor. É MouseEvent com o NOME de pointer
 * event de propósito: o React registra por nome, e o jsdom entrega clientX/
 * clientY/button — que é tudo que os handlers leem (pointerId só alimenta o
 * setPointerCapture, que está guardado por try/catch justamente para cá).
 */
function ponteiro(alvo: Element, tipo: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) {
  act(() => {
    alvo.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  });
}

/** Tecla no corpo do documento — é onde o keydown de verdade nasce no app. */
function tecla(key: string, extra: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  });
}

/** Digita num input controlado sem biblioteca: o setter NATIVO de `value`
 *  seguido do evento `input` — setar `input.value` direto o React ignora. */
function digita(campo: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = campo instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(campo, valor);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function editor(): Element {
  const el = container.querySelector(".cnv-editor");
  expect(el).not.toBeNull();
  return el as Element;
}

function botaoPorTexto(texto: string): HTMLButtonElement {
  const botao = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    (item.textContent ?? "").includes(texto)
  );
  expect(botao, `botão "${texto}"`).toBeDefined();
  return botao as HTMLButtonElement;
}

describe("o canvas editável", () => {
  it("cria um retângulo por arrasto e volta à ferramenta de seleção", () => {
    monta();
    // Arma a ferramenta pelo botão — o mesmo caminho do clique de verdade.
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Retângulo (R)"]')?.click();
    });

    // O rect do mundo é 0,0 no jsdom, então coordenadas de cliente SÃO
    // coordenadas de documento com zoom 1 — o arrasto abaixo desenha 120×80.
    ponteiro(editor(), "pointerdown", 100, 90);
    ponteiro(editor(), "pointermove", 220, 170);
    ponteiro(editor(), "pointerup", 220, 170);

    const { doc, selectedId } = useCanvasStudio.getState();
    const rect = doc.nodes.find((node) => node.type === "rect");
    expect(rect).toMatchObject({ x: 100, y: 90, w: 120, h: 80 });
    // O nó recém-criado fica selecionado (o Inspect abre nele)…
    expect(selectedId).toBe(rect?.id);
    // …e a ferramenta volta à seleção: quem desenhou quer ajustar.
    expect(
      container.querySelector('button[aria-label="Selecionar (V)"]')?.getAttribute("data-active")
    ).toBe("true");
  });

  it("clique sem arrasto cria a forma no tamanho padrão do tipo, não num pontinho", () => {
    monta();
    tecla("o");
    ponteiro(editor(), "pointerdown", 50, 50);
    ponteiro(editor(), "pointerup", 50, 50);

    const elipse = useCanvasStudio.getState().doc.nodes.find((node) => node.type === "ellipse");
    expect(elipse).toMatchObject({ w: 96, h: 96 });
  });

  it("move um nó com a ferramenta de seleção", () => {
    monta();
    // frame-1 do doc inicial: (0,0) 480×320.
    const no = container.querySelector('[data-node-id="frame-1"]');
    expect(no).not.toBeNull();

    ponteiro(no as Element, "pointerdown", 50, 50);
    ponteiro(editor(), "pointermove", 80, 90);
    ponteiro(editor(), "pointerup", 80, 90);

    const frame = useCanvasStudio.getState().doc.nodes.find((node) => node.id === "frame-1");
    expect(frame).toMatchObject({ x: 30, y: 40 });
    expect(useCanvasStudio.getState().selectedId).toBe("frame-1");
  });

  it("redimensiona pela alça sudeste respeitando o delta do ponteiro", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    const alca = container.querySelector('[data-handle="se"]');
    expect(alca).not.toBeNull();

    ponteiro(alca as Element, "pointerdown", 480, 320);
    ponteiro(editor(), "pointermove", 520, 340);
    ponteiro(editor(), "pointerup", 520, 340);

    const frame = useCanvasStudio.getState().doc.nodes.find((node) => node.id === "frame-1");
    expect(frame).toMatchObject({ w: 520, h: 340 });
  });

  it("Ctrl+Z desfaz a criação — e o arrasto inteiro é UM passo, não um por movimento", () => {
    monta();
    tecla("r");
    ponteiro(editor(), "pointerdown", 100, 90);
    ponteiro(editor(), "pointermove", 220, 170);
    ponteiro(editor(), "pointerup", 220, 170);
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(2);

    tecla("z", { ctrlKey: true });

    const { doc, history } = useCanvasStudio.getState();
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]?.id).toBe("frame-1");
    // Um único Ctrl+Z bastou: o histórico registrou no pointerdown e nunca por
    // movimento — não há mais nada para desfazer.
    expect(canUndo(history)).toBe(false);
  });

  it("atalhos: R arma o retângulo, Esc volta à seleção e limpa, Delete apaga o selecionado", () => {
    monta();
    tecla("r");
    expect(
      container.querySelector('button[aria-label="Retângulo (R)"]')?.getAttribute("data-active")
    ).toBe("true");

    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    tecla("Escape");
    expect(
      container.querySelector('button[aria-label="Selecionar (V)"]')?.getAttribute("data-active")
    ).toBe("true");
    expect(useCanvasStudio.getState().selectedId).toBeNull();

    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    tecla("Delete");
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(0);
  });

  it("atalho digitado num campo NÃO troca a ferramenta — quem digita está escrevendo", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    const campo = container.querySelector<HTMLInputElement>('input[aria-label="Nome do frame"]');
    expect(campo).not.toBeNull();
    act(() => {
      campo?.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    });
    expect(
      container.querySelector('button[aria-label="Selecionar (V)"]')?.getAttribute("data-active")
    ).toBe("true");
  });

  it("a seleção vinda de fora (LayersRail) desenha o anel e as alças no nó", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    const no = container.querySelector('[data-node-id="frame-1"]');
    expect(no?.classList.contains("cnv-sel")).toBe(true);
    expect(no?.querySelectorAll("[data-handle]")).toHaveLength(4);
  });

  it("o Inspect edita a posição do nó selecionado", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    const campoX = container.querySelector<HTMLInputElement>('input[aria-label="X"]');
    expect(campoX).not.toBeNull();
    digita(campoX as HTMLInputElement, "200");

    const frame = useCanvasStudio.getState().doc.nodes.find((node) => node.id === "frame-1");
    expect(frame?.x).toBe(200);
    // O fill tem o input color NATIVO (o doc inicial é hex de 6 dígitos).
    expect(container.querySelector('input[type="color"][aria-label="Cor do preenchimento"]')).not.toBeNull();
  });

  it("o preset de dispositivo redimensiona o frame e vira o ativo do grupo", () => {
    monta();
    act(() => {
      botaoPorTexto("Mobile").click();
    });
    const frame = useCanvasStudio.getState().doc.nodes.find((node) => node.type === "frame");
    expect(frame).toMatchObject({ w: 375, h: 812 });
    expect(botaoPorTexto("Mobile").getAttribute("data-active")).toBe("true");
  });

  it("o documento editado persiste no localStorage e volta pelo parseDoc", () => {
    monta();
    tecla("r");
    ponteiro(editor(), "pointerdown", 10, 10);
    ponteiro(editor(), "pointermove", 60, 60);
    ponteiro(editor(), "pointerup", 60, 60);

    const salvo = window.localStorage.getItem(DOC_STORAGE_KEY);
    expect(salvo).not.toBeNull();
    expect(JSON.parse(salvo ?? "{}")).toEqual(useCanvasStudio.getState().doc);
  });

  it("o export SVG do documento não é vazio — e os botões acompanham o doc", () => {
    monta();
    tecla("r");
    ponteiro(editor(), "pointerdown", 10, 10);
    ponteiro(editor(), "pointermove", 130, 90);
    ponteiro(editor(), "pointerup", 130, 90);

    // O botão baixa um Blob (URL.createObjectURL não existe no jsdom); o que
    // se afirma aqui é o CONTEÚDO que ele baixaria — o mesmo exportSvg.
    const svg = exportSvg(useCanvasStudio.getState().doc);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<rect");
    expect(svg.length).toBeGreaterThan(100);
    expect(botaoPorTexto("SVG").disabled).toBe(false);
    expect(botaoPorTexto("PNG").disabled).toBe(false);
  });

  it("«Analisar layout com o agente» preenche o composer com o JSON dos nós", () => {
    monta();
    act(() => {
      botaoPorTexto("Analisar layout com o agente").click();
    });
    const input = useApp.getState().input;
    expect(input).toContain("Analise este layout");
    expect(input).toContain('"id":"frame-1"');
  });
});

describe("as abas de estúdio", () => {
  it("Canvas ativa; Vídeo abre o estúdio de verdade; Site segue com a dica honesta", () => {
    monta();
    const abas = [...container.querySelectorAll<HTMLButtonElement>(".studio-tab")];
    expect(abas.map((aba) => (aba.textContent ?? "").trim().startsWith("Canvas"))).toContain(true);
    expect(abas).toHaveLength(3);

    const [canvas, video, site] = abas;
    expect(canvas?.getAttribute("data-active")).toBe("true");
    // A aba Vídeo deixou de fingir: habilitada, e o clique troca o corpo da
    // superfície pelo VideoStudio — o editor do canvas sai da tela.
    expect(video?.disabled).toBe(false);
    act(() => {
      video?.click();
    });
    expect(video?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector(".video-studio")).not.toBeNull();
    expect(container.querySelector(".cnv-editor")).toBeNull();

    // Voltar ao Canvas restaura o editor — o documento seguiu vivo no store.
    act(() => {
      canvas?.click();
    });
    expect(container.querySelector(".cnv-editor")).not.toBeNull();
    expect(container.querySelector(".video-studio")).toBeNull();

    // Site continua desabilitada, com a dica de QUANDO chega.
    expect(site?.disabled).toBe(true);
    expect(site?.title).toContain("Onda 3");
  });

  it("com o estúdio de Vídeo aberto, Delete NÃO apaga nó do canvas fora da tela", () => {
    monta();
    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    act(() => {
      botaoPorTexto("Vídeo").click();
    });
    // O atalho pertence ao editor VISÍVEL: apagar um nó que ninguém está
    // vendo seria perda de trabalho silenciosa.
    tecla("Delete");
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);
  });
});

describe("tokens de HTML/CSS colado", () => {
  it("extrai localmente e o swatch aplica a cor como fill do nó selecionado", () => {
    monta();
    const fonte = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Fonte HTML/CSS para extrair tokens"]'
    );
    expect(fonte).not.toBeNull();
    digita(fonte as HTMLTextAreaElement, ".a { color: #123abc; margin: 8px; font-family: Inter; }");
    act(() => {
      botaoPorTexto("Extrair tokens").click();
    });

    const swatch = container.querySelector<HTMLButtonElement>(".swatch");
    expect(swatch?.getAttribute("aria-label")).toBe("Aplicar cor #123abc como fill");

    act(() => {
      useCanvasStudio.getState().selecionar("frame-1");
    });
    act(() => {
      swatch?.click();
    });
    const frame = useCanvasStudio.getState().doc.nodes.find((node) => node.id === "frame-1");
    expect(frame?.fill).toBe("#123abc");
  });
});

describe("a prévia do design.replicate", () => {
  const linhaReplicada = (): ConversationLine => ({
    id: "l1",
    seq: 1,
    ts: "2026-08-19T12:00:00Z",
    role: "assistant",
    text: "",
    toolResults: [
      {
        callId: "c1",
        tool: "design.replicate",
        ok: true,
        output: JSON.stringify({
          url: "https://exemplo.com",
          title: "Exemplo",
          tokens: { colors: ["#112233", "#445566"], fonts: ["Inter"] },
          html: "<div>réplica</div>"
        })
      }
    ]
  });

  it("continua funcionando: a moldura isolada abre com sandbox vazio", () => {
    useApp.setState({ lines: [linhaReplicada()] });
    monta();

    act(() => {
      botaoPorTexto("Prévia replicada").click();
    });
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe?.getAttribute("srcdoc")).toContain("réplica");

    // E volta ao canvas sem perder o editor.
    act(() => {
      botaoPorTexto("Voltar ao canvas").click();
    });
    expect(container.querySelector(".cnv-editor")).not.toBeNull();
  });

  it("o snapshot é IMPORTÁVEL como nós editáveis do documento", () => {
    useApp.setState({ lines: [linhaReplicada()] });
    monta();

    act(() => {
      botaoPorTexto("Importar como nós").click();
    });

    const { doc, selectedId, history } = useCanvasStudio.getState();
    // frame-1 inicial + frame da réplica + título + 2 cores + 1 fonte = 6.
    expect(doc.nodes).toHaveLength(6);
    expect(doc.nodes.some((node) => node.type === "rect" && node.fill === "#112233")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "text" && (node.text ?? "").includes("Inter"))).toBe(true);
    // O frame importado fica selecionado, e a importação é desfazível.
    expect(doc.nodes.find((node) => node.id === selectedId)?.type).toBe("frame");
    expect(canUndo(history)).toBe(true);
  });
});
