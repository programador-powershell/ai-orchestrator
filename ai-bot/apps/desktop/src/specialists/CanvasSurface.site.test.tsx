/**
 * A ABA SITE do estúdio de Design — o projeto ENTREGUE aparece renderizado.
 *
 * O que este arquivo tranca (o gesto do dono: construiu → vê no Design →
 * edita em canvas):
 *
 * - a aba Site está VIVA e renderiza o index.html entregue SANEADO numa
 *   moldura sandbox="" — script não sobrevive (conferido por reparse);
 * - o CSS local referenciado (<link rel="stylesheet">) entra inline, lido
 *   pela MESMA rota de ferramenta (fs.read em /v1/tools/call);
 * - sem arquivo, o vazio é DIGNO: diz o que vai aparecer ali e o motivo real;
 * - a moldura recarrega na ENTREGA (a linha do done no store), nunca no meio
 *   do turno — e turno INTERROMPIDO não recarrega (o staging foi descartado);
 * - «Editar no canvas» importa o site como nós editáveis e volta ao Canvas.
 *
 * Sem @testing-library: react-dom/client cru + act, envelopes de VERDADE
 * reduzidos pelo applyEnvelope real — o mesmo fio da produção.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Done, Envelope, ToolCall, ToolResult } from "@aibot/contracts";
import type { Transport } from "../lib/transport";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { createDoc, createHistory } from "../lib/canvas";
import { CanvasSurface, useCanvasStudio } from "./CanvasSurface";

let transporteFalso: Transport | null = null;

vi.mock("../lib/store", async (original) => {
  const real = await original<typeof import("../lib/store")>();
  return { ...real, activeTransport: (): Transport | null => transporteFalso };
});

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

interface CorpoDaChamada {
  session: string;
  tool: string;
  args?: Record<string, unknown>;
}

let chamadas: CorpoDaChamada[] = [];

/** O "projeto entregue" do teste — mutável para simular uma entrega nova. */
let DISCO: Record<string, string> = {};

function projetoEntregue(): Record<string, string> {
  return {
    "index.html": `<!doctype html><html><head><title>Meu App</title>
<link rel="stylesheet" href="style.css"><script src="app.js"></script></head>
<body onload="alert(1)"><h1 style="color:#123abc">Olá do site</h1>
<a href="javascript:alert(2)">entrar</a><script>alert(3)</script></body></html>`,
    "style.css": "body { background: #445566; font-family: Inter; }"
  };
}

function respostasPadrao(corpo: CorpoDaChamada): unknown {
  if (corpo.tool === "fs.read") {
    const path = String(corpo.args?.path ?? "");
    const conteudo = DISCO[path];
    if (conteudo !== undefined) return { ok: true, output: conteudo };
    return { ok: false, error: `arquivo inesperado: ${path}` };
  }
  return { ok: false, error: `ferramenta inesperada: ${corpo.tool}` };
}

let container: HTMLDivElement;
let slotTopbar: HTMLDivElement;
let root: Root;

function monta(): void {
  act(() => {
    root.render(<CanvasSurface />);
  });
}

async function assentar(): Promise<void> {
  await act(async () => {
    for (let passo = 0; passo < 12; passo += 1) await Promise.resolve();
  });
}

/* Envelopes de VERDADE, reduzidos pelo applyEnvelope real — o fio de produção. */
let seqDeEnvelope = 100;

function envelopeDe<P>(kind: Envelope["kind"], payload: P, turn = "t-1"): Envelope<P> {
  seqDeEnvelope += 1;
  return {
    v: 1,
    id: `e-${seqDeEnvelope}`,
    ts: "2026-08-20T12:00:00Z",
    seq: seqDeEnvelope,
    session: "s-site",
    turn,
    kind,
    from: { kind: "specialist", id: "code", specialist: "code" },
    payload
  };
}

function reduzir(envelopes: Envelope<unknown>[]): void {
  act(() => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
    }
  });
}

/** O que o send da produção faz: liga o busy e zera o erro — turno VIVO. */
function turnoComecou(): void {
  act(() => {
    useApp.setState({ busy: true, error: "" });
  });
}

function gravouNoTurno(callId: string, turn: string): Envelope<unknown>[] {
  return [
    envelopeDe<ToolCall>("tool.call", { callId, tool: "fs.write", args: { path: "index.html" } }, turn),
    envelopeDe<ToolResult>("tool.result", { callId, tool: "fs.write", ok: true, output: "gravado" }, turn)
  ];
}

function abaSite(): HTMLButtonElement {
  const aba = [...container.querySelectorAll<HTMLButtonElement>(".studio-tab")].find((botao) =>
    (botao.textContent ?? "").includes("Site")
  );
  expect(aba, "aba Site").toBeDefined();
  return aba as HTMLButtonElement;
}

function botaoPorTexto(texto: string): HTMLButtonElement {
  const botao = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    (item.textContent ?? "").includes(texto)
  );
  expect(botao, `botão "${texto}"`).toBeDefined();
  return botao as HTMLButtonElement;
}

function srcdocAtual(): string {
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

function leiturasDoIndex(): number {
  return chamadas.filter((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "index.html").length;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  chamadas = [];
  DISCO = projetoEntregue();
  transporteFalso = {
    post: async (_path: string, body: unknown) => {
      const corpo = body as CorpoDaChamada;
      chamadas.push(corpo);
      return respostasPadrao(corpo);
    }
  } as unknown as Transport;
  container = document.createElement("div");
  document.body.appendChild(container);
  slotTopbar = document.createElement("div");
  slotTopbar.id = "topbar-actions";
  document.body.appendChild(slotTopbar);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData(), status: "ready", session: "s-site" });
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

describe("a aba Site do estúdio de Design", () => {
  it("renderiza o index.html entregue SANEADO na moldura sandbox — script não sobrevive", async () => {
    monta();
    act(() => {
      abaSite().click();
    });
    await assentar();

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // O sandbox VAZIO — a segunda camada da defesa, como na prévia replicada.
    expect(iframe?.getAttribute("sandbox")).toBe("");

    const srcdoc = srcdocAtual();
    // O conteúdo entregue está lá, e o style.css referenciado entrou INLINE
    // (lido pela mesma rota de ferramenta — fs.read do projeto entregue).
    expect(srcdoc).toContain("Olá do site");
    expect(srcdoc).toContain("background: #445566");
    expect(chamadas.some((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "style.css")).toBe(true);

    // A afirmação forte é por REPARSE — o que o iframe faria com o texto.
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(doc.querySelector("script, iframe, object, embed, base, link")).toBeNull();
    const comHandler = [...doc.querySelectorAll("*")].some((elemento) =>
      [...elemento.attributes].some((atributo) => atributo.name.toLowerCase().startsWith("on"))
    );
    expect(comHandler).toBe(false);
    expect(srcdoc.toLowerCase()).not.toContain("javascript:");
  });

  it("sem index.html o vazio é DIGNO: diz o que vai aparecer ali, com o motivo real", async () => {
    delete DISCO["index.html"];
    monta();
    act(() => {
      abaSite().click();
    });
    await assentar();

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Nenhum site entregue ainda");
    // O motivo do gateway aparece como diagnóstico — nunca uma tela inventada.
    expect(container.textContent).toContain("arquivo inesperado: index.html");
    // E não há o que importar.
    expect(botaoPorTexto("Editar no canvas").disabled).toBe(true);
  });

  it("recarrega na ENTREGA (a linha do done), nunca no meio do turno; interrupção não recarrega", async () => {
    monta();
    act(() => {
      abaSite().click();
    });
    await assentar();
    expect(srcdocAtual()).toContain("Olá do site");
    expect(leiturasDoIndex()).toBe(1);

    // O bot grava NO MEIO do turno — na cópia (staging). Nada recarrega: o
    // fs.read de agora mostraria o projeto de ANTES da entrega.
    DISCO["index.html"] = "<html><head></head><body><h1>Nova entrega</h1></body></html>";
    turnoComecou();
    reduzir(gravouNoTurno("c-1", "t-1"));
    await assentar();
    expect(leiturasDoIndex()).toBe(1);
    expect(srcdocAtual()).toContain("Olá do site");

    // O done ENTREGA: a promoção pôs os arquivos no projeto e a moldura relê.
    reduzir([envelopeDe<Done>("done", { turn: "t-1" }, "t-1")]);
    await assentar();
    expect(leiturasDoIndex()).toBe(2);
    expect(srcdocAtual()).toContain("Nova entrega");

    // Turno INTERROMPIDO: o stop derruba busy localmente com error vazio, e a
    // verdade chega depois na linha do done com interrupted — o staging foi
    // descartado, nada mudou, nada relê.
    turnoComecou();
    reduzir(gravouNoTurno("c-2", "t-2"));
    act(() => {
      useApp.setState({ busy: false });
    });
    reduzir([envelopeDe<Done>("done", { turn: "t-2", interrupted: true }, "t-2")]);
    await assentar();
    expect(leiturasDoIndex()).toBe(2);
  });

  it("«Editar no canvas» importa o site entregue como nós editáveis e volta ao Canvas", async () => {
    monta();
    act(() => {
      abaSite().click();
    });
    await assentar();

    act(() => {
      botaoPorTexto("Editar no canvas").click();
    });

    // A aba voltou ao Canvas — é lá que os nós recém-importados estão.
    expect(container.querySelector(".cnv-editor")).not.toBeNull();
    expect(container.querySelector(".site-studio")).toBeNull();

    const { doc, selectedId } = useCanvasStudio.getState();
    // O caminho é o MESMO do "Importar como nós" da réplica: frame com o
    // título, paleta (do html + css entregues) e amostras de tipografia.
    expect(doc.nodes.some((node) => node.type === "text" && (node.text ?? "").includes("Meu App"))).toBe(true);
    expect(doc.nodes.some((node) => node.type === "rect" && node.fill === "#445566")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "rect" && node.fill === "#123abc")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "text" && (node.text ?? "").includes("Inter"))).toBe(true);
    // O frame importado fica selecionado — quem importou quer mexer nele.
    expect(doc.nodes.find((node) => node.id === selectedId)?.type).toBe("frame");
  });
});
