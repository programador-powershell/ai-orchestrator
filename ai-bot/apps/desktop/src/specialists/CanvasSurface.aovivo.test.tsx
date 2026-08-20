/**
 * O CANVAS AO VIVO: o resultado estruturado de design.* que chega na sessão
 * aberta vira NÓS EDITÁVEIS no documento — o mesmo caminho do botão "Importar
 * como nós" —, em vez de ficar só como texto no chat lateral (a casca que a
 * regra de produto proíbe).
 *
 * O que este arquivo tranca:
 * - resultado AO VIVO importa sozinho, e o palco fica no canvas editável;
 * - o bloco JSON DEMARCADO (```json no fim do texto — padrão anti-casca do
 *   lib/toolJson) também importa, não só JSON puro;
 * - o doc é o da SESSÃO (chaveDoDoc) e o Ctrl+Z desfaz a importação;
 * - replay/histórico NÃO importa nada (guarda de turno-vivo do FilesRail).
 *
 * Sem @testing-library: react-dom/client cru + act, como nos vizinhos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { canUndo, createDoc, createHistory } from "../lib/canvas";
import { CanvasSurface, chaveDoDoc, useCanvasStudio } from "./CanvasSurface";

/* O avatar da conversa compacta carrega o módulo do Lab por URL; o dublê
   devolve um controlador inerte, como nos testes vizinhos. */
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

/* jsdom não implementa element.scrollTo, e a conversa compacta rola ao montar. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let slotTopbar: HTMLDivElement;
let root: Root;

const SESSAO = "s-design";

/** O payload estruturado que o design.replicate devolve. */
const PAYLOAD = {
  url: "https://exemplo.com",
  title: "Exemplo",
  tokens: { colors: ["#112233", "#445566"], fonts: ["Inter"] },
  html: "<div>réplica</div>"
};

function linhaDeDesign(id: string, output: string): ConversationLine {
  return {
    id,
    seq: 1,
    ts: "2026-08-20T12:00:00Z",
    role: "assistant",
    specialist: "design",
    text: "",
    toolResults: [{ callId: `c-${id}`, tool: "design.replicate", ok: true, output }]
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  // O host do portal da barra superior (Replicar URL / Exportar tokens).
  slotTopbar = document.createElement("div");
  slotTopbar.id = "topbar-actions";
  document.body.appendChild(slotTopbar);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData(), status: "ready", session: SESSAO });
  useCanvasStudio.setState({ doc: createDoc(), history: createHistory(), selectedId: null });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  slotTopbar.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta(): void {
  act(() => {
    root.render(<CanvasSurface />);
  });
}

describe("canvas ao vivo", () => {
  it("resultado de design.* AO VIVO importa como nós editáveis — e o palco fica no canvas, não na prévia", () => {
    monta();
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);

    act(() => {
      useApp.setState({ lines: [linhaDeDesign("l1", JSON.stringify(PAYLOAD))] });
    });

    const { doc, history } = useCanvasStudio.getState();
    // frame-1 inicial + frame da réplica + título + 2 cores + 1 fonte = 6.
    expect(doc.nodes).toHaveLength(6);
    expect(doc.nodes.some((node) => node.type === "rect" && node.fill === "#112233")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "text" && (node.text ?? "").includes("Inter"))).toBe(true);
    // O palco é o canvas EDITÁVEL com os nós — não a moldura da prévia.
    expect(container.querySelector(".cnv-editor")).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();

    // O doc importado é o da SESSÃO: persistiu na chave dela.
    const salvo = window.localStorage.getItem(chaveDoDoc(SESSAO));
    expect(salvo).not.toBeNull();
    expect((JSON.parse(salvo ?? "{}") as { nodes: unknown[] }).nodes).toHaveLength(6);

    // E o undo funciona DEPOIS da importação: um Ctrl+Z devolve o doc anterior.
    expect(canUndo(history)).toBe(true);
    act(() => {
      useCanvasStudio.getState().desfazer();
    });
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);
  });

  it("o bloco JSON DEMARCADO (```json no fim do relatório) também importa — padrão anti-casca", () => {
    monta();
    const relatorio =
      "Peguei o index.html do Código e extraí a linguagem visual.\n\n" +
      "```json\n" +
      JSON.stringify(PAYLOAD) +
      "\n```";

    act(() => {
      useApp.setState({ lines: [linhaDeDesign("l2", relatorio)] });
    });

    const { doc } = useCanvasStudio.getState();
    expect(doc.nodes).toHaveLength(6);
    expect(doc.nodes.some((node) => node.type === "rect" && node.fill === "#445566")).toBe(true);
  });

  it("flush do replay DEPOIS da montagem não importa — a ordem real do fio", () => {
    // Na produção o `ready` remonta a superfície com as linhas ZERADAS e o
    // histórico chega depois, num flush único que anda o contador
    // `replaysAssentados` (store.ts, o lote do connect). Sem a guarda ler o
    // contador, cada reabertura da conversa despejava os nós da réplica de
    // novo num doc que a pessoa já editou.
    monta();
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);

    act(() => {
      useApp.setState((estado) => ({
        lines: [linhaDeDesign("l5", JSON.stringify(PAYLOAD))],
        replaysAssentados: estado.replaysAssentados + 1
      }));
    });
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);

    // E a guarda REANCORA no flush: o resultado vivo que vem depois importa.
    act(() => {
      useApp.setState((estado) => ({
        lines: [...estado.lines, linhaDeDesign("l6", JSON.stringify(PAYLOAD))]
      }));
    });
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(6);
  });

  it("replay/histórico NÃO importa nada — a guarda ancora na montagem; só resultado NOVO importa", () => {
    // A conversa reabriu com uma réplica antiga no log: nada de despejar nós
    // num desenho que a pessoa já editou.
    useApp.setState({ lines: [linhaDeDesign("l3", JSON.stringify(PAYLOAD))] });
    monta();
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(1);

    // Um resultado NOVO chegando depois da âncora é turno vivo: importa.
    act(() => {
      useApp.setState((estado) => ({
        lines: [...estado.lines, linhaDeDesign("l4", JSON.stringify(PAYLOAD))]
      }));
    });
    expect(useCanvasStudio.getState().doc.nodes).toHaveLength(6);
  });
});
