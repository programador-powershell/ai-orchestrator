/**
 * A superfície de Código DESENHADA como IDE: salvar de verdade (fs.write pela
 * rota), Quick Open (Ctrl+P) sobre o índice difuso, busca no projeto
 * (Ctrl+Shift+F) com resultado clicável em arquivo:linha e a honestidade de
 * offline. Os atalhos são disparados como eventos de teclado REAIS na janela —
 * é a fiação que o teste de módulo não cobre.
 *
 * Sem @testing-library: montagem com react-dom/client cru e o act do React 19,
 * como nos outros testes de tela deste projeto. O gateway é dublado por
 * activeTransport (padrão da casa) e o avatar da conversa compacta é um dublê
 * inerte, como no teste do estúdio de Design.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Transport } from "../lib/transport";
import { initialAppData, useApp } from "../lib/store";
import { abrirArquivo, useIde, zerarIde } from "../lib/ide/ideStore";
import { SEM_CONEXAO } from "../lib/ide/ferramentas";
import { EditorSurface } from "./EditorSurface";

let transporteFalso: Transport | null = null;

vi.mock("../lib/store", async (original) => {
  const real = await original<typeof import("../lib/store")>();
  return { ...real, activeTransport: (): Transport | null => transporteFalso };
});

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

/* O jsdom não implementa `element.scrollTo`, e a conversa compacta rola ao
   montar. O stub é vazio: aqui basta a montagem não explodir. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

interface CorpoDaChamada {
  session: string;
  tool: string;
  args?: Record<string, unknown>;
}

let chamadas: CorpoDaChamada[] = [];
let responder: (corpo: CorpoDaChamada) => unknown | Promise<unknown>;

function respostasPadrao(corpo: CorpoDaChamada): unknown {
  if (corpo.tool === "fs.list") {
    const path = String(corpo.args?.path ?? "");
    if (path === "") return { ok: true, output: "src/\nmain.go (12 bytes)" };
    if (path === "src") return { ok: true, output: "app.ts (5 bytes)" };
    return { ok: true, output: "(pasta vazia)" };
  }
  if (corpo.tool === "fs.read") {
    return { ok: true, output: "package main\n\nfunc main() {\n}\n" };
  }
  if (corpo.tool === "fs.write") return { ok: true, output: "gravado" };
  if (corpo.tool === "fs.search") return { ok: true, output: "main.go:3: func main() {" };
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

function teclar(opcoes: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opcoes }));
  });
}

/** React 19 rastreia o value com descritor próprio; escrever pelo setter
 *  NATIVO e disparar "input" é o que faz o onChange enxergar a digitação. */
function digitar(campo: HTMLInputElement | HTMLTextAreaElement, texto: string): void {
  act(() => {
    const prototipo =
      campo instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototipo, "value")?.set;
    setter?.call(campo, texto);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function overlayInput(): HTMLInputElement {
  const campo = document.querySelector<HTMLInputElement>(".ide-quick header input");
  if (!campo) throw new Error("o overlay não está aberto");
  return campo;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  chamadas = [];
  responder = respostasPadrao;
  transporteFalso = {
    post: async (_path: string, body: unknown) => {
      const corpo = body as CorpoDaChamada;
      chamadas.push(corpo);
      return responder(corpo);
    }
  } as unknown as Transport;
  container = document.createElement("div");
  document.body.appendChild(container);
  // O host do portal da barra superior — sem ele os chips não teriam onde morar.
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

describe("salvar de verdade", () => {
  it("Ctrl+S grava o arquivo ativo via fs.write e acende o chip 'salvo'", async () => {
    montar();
    await act(async () => {
      await abrirArquivo({ name: "main.go", path: "main.go" });
    });
    const area = container.querySelector<HTMLTextAreaElement>(".editor-area");
    expect(area?.value).toContain("package main");
    digitar(area as HTMLTextAreaElement, "package main // editado\n");

    teclar({ key: "s", ctrlKey: true });
    await assentar();

    const escrita = chamadas.find((corpo) => corpo.tool === "fs.write");
    expect(escrita?.args).toEqual({ path: "main.go", content: "package main // editado\n" });
    expect(slotTopbar.querySelector('.editor-chip[data-tone="ok"]')?.textContent).toContain("salvo");
    expect(useIde.getState().files[0]?.dirty).toBe(false);
  });

  it("recusa (portão, pessoa, prazo) vira chip de erro com o MOTIVO no title", async () => {
    responder = (corpo) =>
      corpo.tool === "fs.write" ? { ok: false, error: "a pessoa recusou a escrita" } : respostasPadrao(corpo);
    montar();
    await act(async () => {
      await abrirArquivo({ name: "main.go", path: "main.go" });
    });

    teclar({ key: "s", ctrlKey: true });
    await assentar();

    const chip = slotTopbar.querySelector<HTMLElement>('.editor-chip[data-tone="erro"]');
    expect(chip?.textContent).toContain("erro ao salvar");
    expect(chip?.title).toBe("a pessoa recusou a escrita");
  });

  it("enquanto o cartão de aprovação pende, a barra diz 'aguardando aprovação'", async () => {
    let soltar!: (valor: unknown) => void;
    responder = (corpo) =>
      corpo.tool === "fs.write"
        ? new Promise((resolver) => (soltar = resolver))
        : respostasPadrao(corpo);
    montar();
    await act(async () => {
      await abrirArquivo({ name: "main.go", path: "main.go" });
    });

    teclar({ key: "s", ctrlKey: true });
    // O cartão chega pelo WebSocket como em produção: um approval.request na fila.
    act(() => {
      useApp.setState({
        pendingApprovals: [
          { callId: "c1", tool: "fs.write", risk: "write", summary: "gravar main.go" }
        ]
      });
    });
    await assentar();
    expect(slotTopbar.textContent).toContain("aguardando aprovação");

    // Decidiu: o POST volta, o chip de espera sai e o de salvo entra.
    act(() => {
      useApp.setState({ pendingApprovals: [] });
      soltar({ ok: true, output: "gravado" });
    });
    await assentar();
    expect(slotTopbar.textContent).not.toContain("aguardando aprovação");
    expect(slotTopbar.querySelector('.editor-chip[data-tone="ok"]')).not.toBeNull();
  });

  it("offline: salvar mostra o erro honesto em vez de fingir gravação", async () => {
    montar();
    await act(async () => {
      await abrirArquivo({ name: "main.go", path: "main.go" });
    });
    transporteFalso = null;

    teclar({ key: "s", ctrlKey: true });
    await assentar();

    const chip = slotTopbar.querySelector<HTMLElement>('.editor-chip[data-tone="erro"]');
    expect(chip?.title).toBe(SEM_CONEXAO);
  });
});

describe("Quick Open (Ctrl+P)", () => {
  it("abre a paleta, filtra difuso sobre o índice e Enter abre o arquivo", async () => {
    montar();
    teclar({ key: "p", ctrlKey: true });
    await assentar();

    // O índice veio de fs.list recursivo (raiz + src).
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list").length).toBeGreaterThanOrEqual(2);
    digitar(overlayInput(), "apts");
    await assentar();
    const itens = [...document.querySelectorAll(".ide-quick-item")].map((item) => item.textContent);
    expect(itens.join("\n")).toContain("src/app.ts");

    act(() => {
      overlayInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await assentar();

    expect(document.querySelector(".ide-quick")).toBeNull();
    expect(useIde.getState().activePath).toBe("src/app.ts");
    expect(chamadas.some((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "src/app.ts")).toBe(true);
  });

  it("offline: a paleta mostra a mensagem honesta, nunca um índice inventado", async () => {
    transporteFalso = null;
    montar();
    teclar({ key: "p", ctrlKey: true });
    await assentar();

    expect(document.querySelector(".ide-quick-note")?.textContent).toBe(SEM_CONEXAO);
    expect(document.querySelectorAll(".ide-quick-item")).toHaveLength(0);
  });
});

describe("busca no projeto (Ctrl+Shift+F)", () => {
  it("Enter busca via fs.search e o resultado clicável abre o arquivo na linha", async () => {
    montar();
    teclar({ key: "F", ctrlKey: true, shiftKey: true });
    await assentar();

    digitar(overlayInput(), "func main");
    act(() => {
      overlayInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await assentar();

    expect(chamadas.find((corpo) => corpo.tool === "fs.search")?.args).toEqual({ query: "func main" });
    const resultado = [...document.querySelectorAll<HTMLButtonElement>(".ide-quick-item")].find((botao) =>
      botao.textContent?.includes("main.go:3")
    );
    expect(resultado).toBeDefined();

    act(() => {
      resultado?.click();
    });
    await assentar();
    // O revelar corre num timeout curto depois que o arquivo termina de abrir.
    await act(async () => {
      await new Promise((resolver) => setTimeout(resolver, 60));
    });

    expect(useIde.getState().activePath).toBe("main.go");
    const area = container.querySelector<HTMLTextAreaElement>(".editor-area");
    // A linha 3 ("func main() {") está selecionada — o salto é visível.
    const inicioDaLinha3 = "package main\n\n".length;
    expect(area?.selectionStart).toBe(inicioDaLinha3);
    expect(area?.selectionEnd).toBe(inicioDaLinha3 + "func main() {".length);
  });

  it("recusa da busca aparece como mensagem no overlay", async () => {
    responder = (corpo) =>
      corpo.tool === "fs.search"
        ? { ok: false, error: "a interface não pode pedir fs.search fora do turno" }
        : respostasPadrao(corpo);
    montar();
    teclar({ key: "F", ctrlKey: true, shiftKey: true });
    await assentar();
    digitar(overlayInput(), "x");
    act(() => {
      overlayInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await assentar();

    expect(document.querySelector(".ide-quick-note")?.textContent).toContain("fora do turno");
  });

  it("Esc fecha os overlays — e tecla SOLTA nunca é roubada de quem digita", async () => {
    montar();
    teclar({ key: "p", ctrlKey: true });
    await assentar();
    expect(document.querySelector(".ide-quick")).not.toBeNull();

    teclar({ key: "Escape" });
    await assentar();
    expect(document.querySelector(".ide-quick")).toBeNull();

    // "s" sem modificador não salva nada: o atalho é só o combo.
    teclar({ key: "s" });
    await assentar();
    expect(chamadas.some((corpo) => corpo.tool === "fs.write")).toBe(false);
  });
});
