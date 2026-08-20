/**
 * O EDITOR AO VIVO: o especialista trabalha NA JANELA DELE.
 *
 * A regra de produto que este arquivo tranca é a do caso flagrado — o bot
 * gravava index.html via fs.write e a tela ficava em "nenhum arquivo aberto":
 * o tool.result CONFIRMADO de fs.write/fs.patch na sessão aberta tem de abrir
 * o arquivo no palco, com o conteúdo lido do disco (fs.read pela rota
 * /v1/tools/call). E as três guardas que não podem regredir:
 *
 * - buffer SUJO da pessoa nunca é sobrescrito (fica o chip discreto);
 * - rajada de gravações abre só o ÚLTIMO arquivo (debounce do ideStore);
 * - replay/histórico não abre NADA (guarda de turno-vivo do FilesRail).
 *
 * Sem @testing-library: react-dom/client cru + act, envelopes de VERDADE
 * reduzidos pelo applyEnvelope real — o mesmo fio da produção.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, Envelope, ToolCall, ToolResult } from "@aibot/contracts";
import type { Transport } from "../lib/transport";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ATRASO_DA_ATUALIZACAO_MS, abrirArquivo, useIde, zerarIde } from "../lib/ide/ideStore";
import { EditorSurface } from "./EditorSurface";

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

/** O "disco" do teste: cada arquivo tem o conteúdo que o fs.read devolve. */
const DISCO: Record<string, string> = {
  "index.html": "<!doctype html>\n<h1>Olá do bot</h1>\n",
  "a.html": "<p>primeiro</p>\n",
  "b.html": "<p>último</p>\n",
  "main.go": "package main\n"
};

function respostasPadrao(corpo: CorpoDaChamada): unknown {
  if (corpo.tool === "fs.read") {
    const path = String(corpo.args?.path ?? "");
    const conteudo = DISCO[path];
    if (conteudo !== undefined) return { ok: true, output: conteudo };
    return { ok: false, error: `arquivo inesperado: ${path}` };
  }
  if (corpo.tool === "fs.write") return { ok: true, output: "gravado" };
  if (corpo.tool === "fs.list") return { ok: true, output: "(pasta vazia)" };
  return { ok: false, error: `ferramenta inesperada: ${corpo.tool}` };
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let slotTopbar: HTMLDivElement;
let root: Root;

function montar(): void {
  act(() => {
    root.render(<EditorSurface />);
  });
}

async function assentar(): Promise<void> {
  await act(async () => {
    for (let passo = 0; passo < 12; passo += 1) await Promise.resolve();
  });
}

/** Espera o debounce da abertura ao vivo vencer e o fs.read assentar. */
async function esperarAbertura(): Promise<void> {
  await act(async () => {
    await new Promise((resolver) => setTimeout(resolver, ATRASO_DA_ATUALIZACAO_MS + 50));
  });
  await assentar();
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
    session: "s-1",
    turn,
    kind,
    from: { kind: "specialist", id: "code", specialist: "code" },
    payload
  };
}

function chamadaDoBot(callId: string, path: string): Envelope<ToolCall> {
  return envelopeDe("tool.call", { callId, tool: "fs.write", args: { path, content: DISCO[path] ?? "" } });
}

function gravacaoDoBot(callId: string, ok = true): Envelope<ToolResult> {
  const payload: ToolResult = ok
    ? { callId, tool: "fs.write", ok: true, output: "gravado" }
    : { callId, tool: "fs.write", ok: false, error: "a pessoa recusou a escrita" };
  return envelopeDe("tool.result", payload);
}

function reduzir(envelopes: Envelope<unknown>[]): void {
  act(() => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
    }
  });
}

/** A MESMA gravação, mas já assentada em linhas — o formato do replay. */
function linhasDoHistorico(callId: string, path: string): ConversationLine[] {
  return [
    {
      id: "l-hist",
      seq: 1,
      turn: "t-0",
      role: "assistant",
      specialist: "code",
      text: "gravei o arquivo",
      toolCalls: [{ callId, tool: "fs.write", args: { path, content: DISCO[path] ?? "" } }],
      toolResults: [{ callId, tool: "fs.write", ok: true, output: "gravado" }],
      ts: "2026-08-20T11:00:00Z"
    }
  ];
}

function digitar(campo: HTMLTextAreaElement, texto: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(campo, texto);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  chamadas = [];
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
  useApp.setState({ ...initialAppData(), status: "ready", session: "s-1" });
  zerarIde();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  slotTopbar.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("editor ao vivo", () => {
  it("fs.write confirmado do bot abre o arquivo no palco, com o conteúdo do disco", async () => {
    montar();
    await assentar();
    // O ponto de partida do caso flagrado: nenhum arquivo aberto.
    expect(container.textContent).toContain("nenhum arquivo aberto");

    reduzir([chamadaDoBot("c-1", "index.html"), gravacaoDoBot("c-1")]);
    await esperarAbertura();

    // O conteúdo veio do DISCO (fs.read pela rota), não do texto da conversa.
    expect(chamadas.some((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "index.html")).toBe(true);
    expect(useIde.getState().activePath).toBe("index.html");
    const area = container.querySelector<HTMLTextAreaElement>(".editor-area");
    expect(area?.value).toBe(DISCO["index.html"]);
    // E a aba existe — o "nenhum arquivo aberto" morreu.
    expect(container.textContent).not.toContain("nenhum arquivo aberto");
  });

  it("rajada de gravações no mesmo turno abre SÓ o último arquivo", async () => {
    montar();
    await assentar();

    reduzir([
      chamadaDoBot("c-1", "a.html"),
      gravacaoDoBot("c-1"),
      chamadaDoBot("c-2", "b.html"),
      gravacaoDoBot("c-2")
    ]);
    await esperarAbertura();

    // Um fs.read só — o do último; a.html nem virou aba.
    const leituras = chamadas.filter((corpo) => corpo.tool === "fs.read");
    expect(leituras).toHaveLength(1);
    expect(leituras[0]?.args?.path).toBe("b.html");
    expect(useIde.getState().files.map((arquivo) => arquivo.path)).toEqual(["b.html"]);
    expect(useIde.getState().activePath).toBe("b.html");
  });

  it("gravação RECUSADA não abre nada — escrita que não aconteceu não muda o palco", async () => {
    montar();
    await assentar();

    reduzir([chamadaDoBot("c-9", "index.html"), gravacaoDoBot("c-9", false)]);
    await esperarAbertura();

    expect(chamadas.some((corpo) => corpo.tool === "fs.read")).toBe(false);
    expect(useIde.getState().files).toHaveLength(0);
  });

  it("buffer SUJO da pessoa não é sobrescrito — fica o chip 'o bot gravou por cima no disco'", async () => {
    montar();
    await act(async () => {
      await abrirArquivo({ name: "main.go", path: "main.go" });
    });
    const area = container.querySelector<HTMLTextAreaElement>(".editor-area");
    digitar(area as HTMLTextAreaElement, "package main // meu rascunho\n");

    reduzir([chamadaDoBot("c-3", "main.go"), gravacaoDoBot("c-3")]);
    await esperarAbertura();

    // O rascunho local venceu: nenhuma releitura, nenhum byte trocado.
    expect(chamadas.filter((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "main.go")).toHaveLength(1);
    expect(area?.value).toBe("package main // meu rascunho\n");
    expect(useIde.getState().files[0]?.dirty).toBe(true);
    const chip = slotTopbar.querySelector<HTMLElement>(".editor-chip-bot");
    expect(chip?.textContent).toContain("o bot gravou por cima no disco");
    expect(chip?.title).toContain("main.go");

    // Salvar resolve a disputa (a versão da pessoa vence no disco) e o aviso sai.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await assentar();
    expect(slotTopbar.querySelector(".editor-chip-bot")).toBeNull();
  });

  it("flush do replay DEPOIS da montagem não abre nada — a ordem real do fio", async () => {
    // Na produção o `ready` remonta a superfície com as linhas ZERADAS e o
    // histórico chega depois, num flush único que se anuncia andando o
    // contador `replaysAssentados` (store.ts, o lote do connect). O teste
    // reproduz exatamente esse contrato: linhas e contador no MESMO set.
    montar();
    await assentar();
    expect(container.textContent).toContain("nenhum arquivo aberto");

    act(() => {
      useApp.setState((estado) => ({
        lines: linhasDoHistorico("c-hist", "index.html"),
        replaysAssentados: estado.replaysAssentados + 1
      }));
    });
    await esperarAbertura();

    expect(chamadas.some((corpo) => corpo.tool === "fs.read")).toBe(false);
    expect(useIde.getState().files).toHaveLength(0);

    // E a guarda REANCORA no flush: a gravação viva que vem depois abre.
    reduzir([chamadaDoBot("c-2", "index.html"), gravacaoDoBot("c-2")]);
    await esperarAbertura();
    expect(useIde.getState().activePath).toBe("index.html");
  });

  it("replay/histórico NÃO abre nada — a guarda de turno-vivo ancora na montagem", async () => {
    // A conversa reabriu: as linhas do log (com a gravação antiga) já estão no
    // store quando a superfície monta — exatamente como o replay entrega.
    useApp.setState({ lines: linhasDoHistorico("c-hist", "index.html") });
    montar();
    await esperarAbertura();

    expect(chamadas.some((corpo) => corpo.tool === "fs.read")).toBe(false);
    expect(useIde.getState().files).toHaveLength(0);
    expect(container.textContent).toContain("nenhum arquivo aberto");
  });
});
