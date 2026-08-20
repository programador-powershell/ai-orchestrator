/**
 * O composer cli do Código — os três gestos da linha `$` e o dock único.
 *
 * O que se prova aqui, e por quê:
 *
 *   1. O DOCK continua com o contrato do antigo TerminalDock (os testes
 *      moraram em TerminalPanel.test.tsx até o dock virar o composer cli):
 *      Ctrl+` e botão abrem, fechar ESCONDE em vez de desmontar — desmontar
 *      mataria o dev server que a pessoa deixou rodando.
 *   2. COMANDO vai ao PTY pelo caminho do teclado da pessoa: o primeiro
 *      comando abre o shell e espera na fila até o `pty_spawn` devolver o id
 *      (comando digitado antes do shell existir não pode cair no chão); o
 *      seguinte escreve direto. Fora do Tauri o pane é honesto: diz que é
 *      modo demonstração e NÃO chama comando nenhum.
 *   3. `ai <pergunta>` vai pelo composer normal (useApp.send) e a resposta é
 *      ESPELHADA quando o turno fecha — sem cerca de protocolo, com a guarda
 *      de turno em andamento e com a falha de envio dita em vez de engolida.
 *   4. ARQUIVO auto-detect: caminho que EXISTE no índice abre no editor
 *      (ideStore); caminho com cara de arquivo que NÃO existe volta a valer
 *      como comando — o índice decide, nunca a cara do texto.
 *
 * Sem @testing-library: react-dom/client cru + act, como nos vizinhos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";

/* ------------------------------- mocks (PTY) ------------------------------- */

const mocks = vi.hoisted(() => {
  type Registro = { cmd: string; args?: Record<string, unknown> };
  type Handler = (event: { payload: unknown }) => void;

  class XtermFake {
    static instancias: XtermFake[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    escritas: string[] = [];
    constructor() {
      XtermFake.instancias.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    onData() {
      return { dispose: () => undefined };
    }
    onResize() {
      return { dispose: () => undefined };
    }
    write(data: string): void {
      this.escritas.push(data);
    }
    clear(): void {}
    focus(): void {}
    dispose(): void {}
  }

  class FitFake {
    fit(): void {}
  }

  const estado = {
    invocacoes: [] as Registro[],
    ouvintes: new Map<string, Handler[]>(),
    proximoId: "pty-cli"
  };

  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    estado.invocacoes.push({ cmd, args });
    if (cmd === "pty_spawn") return estado.proximoId;
    return undefined;
  };

  const listen = async (nome: string, handler: Handler): Promise<() => void> => {
    const lista = estado.ouvintes.get(nome) ?? [];
    lista.push(handler);
    estado.ouvintes.set(nome, lista);
    return () => {
      estado.ouvintes.set(
        nome,
        (estado.ouvintes.get(nome) ?? []).filter((item) => item !== handler)
      );
    };
  };

  /* O índice do projeto que o gesto de arquivo consulta — via fs.list real do
     ideStore, com o gateway dublado. */
  const chamarFerramenta = async (tool: string, args?: unknown): Promise<unknown> => {
    if (tool === "fs.list") {
      const path = (args as { path?: string } | undefined)?.path ?? "";
      if (path === "") return { ok: true, output: "src/\nindex.html (12 bytes)" };
      if (path === "src") return { ok: true, output: "app.ts (5 bytes)" };
      return { ok: true, output: "(pasta vazia)" };
    }
    if (tool === "fs.read") return { ok: true, output: "conteúdo do arquivo" };
    return { ok: false, error: `ferramenta inesperada no teste: ${tool}` };
  };

  return { estado, invoke, listen, chamarFerramenta, XtermFake, FitFake };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.XtermFake }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: mocks.FitFake }));
vi.mock("../lib/ide/ferramentas", () => ({
  chamarFerramenta: mocks.chamarFerramenta,
  SEM_CONEXAO: "sem conexão com o gateway — conecte para trabalhar no projeto real"
}));

import { initialAppData, useApp } from "../lib/store";
import { useIde, zerarIde } from "../lib/ide/ideStore";
import {
  ComposerCliDock,
  arquivoDoIndice,
  candidatoAArquivo,
  perguntaDoGesto
} from "./ComposerCli";

/* ------------------------------- utilidades ------------------------------- */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* jsdom não implementa element.scrollTo, e o histórico rola ao crescer. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let root: Root;

function fingirTauri(nativo: boolean) {
  if (nativo) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    return;
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

async function escoar() {
  await act(async () => {
    for (let volta = 0; volta < 8; volta += 1) await Promise.resolve();
  });
}

function monta(): void {
  act(() => {
    root.render(<ComposerCliDock />);
  });
}

function entrada(): HTMLInputElement {
  const campo = container.querySelector<HTMLInputElement>(".cli-entrada");
  if (!campo) throw new Error("a linha $ do composer cli não está na tela");
  return campo;
}

function historico(): string {
  return container.querySelector(".cli-historico")?.textContent ?? "";
}

/** Digita na linha `$` e aperta Enter — o gesto inteiro da pessoa. */
function gesto(texto: string): void {
  const campo = entrada();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(campo, texto);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function chamadas(cmd: string) {
  return mocks.estado.invocacoes.filter((registro) => registro.cmd === cmd);
}

function linhaDoBot(texto: string): ConversationLine {
  return {
    id: "l-1",
    seq: 2,
    turn: "t-1",
    role: "assistant",
    speakerId: "code",
    specialist: "code",
    text: texto,
    ts: "2026-08-20T12:00:00Z",
    streaming: false
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  mocks.estado.invocacoes.length = 0;
  mocks.estado.ouvintes.clear();
  mocks.XtermFake.instancias.length = 0;
  fingirTauri(false);
  useApp.setState({ ...initialAppData(), status: "ready", session: "s-cli" });
  zerarIde();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  fingirTauri(false);
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/* ------------------------------ gestos (puros) ----------------------------- */

describe("a triagem dos gestos", () => {
  it("perguntaDoGesto: só `ai <algo>` vira pergunta", () => {
    expect(perguntaDoGesto("ai qual a porta do dev server?")).toBe("qual a porta do dev server?");
    expect(perguntaDoGesto("AI maiúsculo também")).toBe("maiúsculo também");
    expect(perguntaDoGesto("ai")).toBeNull();
    expect(perguntaDoGesto("air quality")).toBeNull();
    expect(perguntaDoGesto("pnpm test")).toBeNull();
  });

  it("candidatoAArquivo: extensão ou barra; espaço é comando", () => {
    expect(candidatoAArquivo("index.html")).toBe("index.html");
    expect(candidatoAArquivo('"src\\app.ts"')).toBe("src/app.ts");
    expect(candidatoAArquivo("./src/app.ts")).toBe("src/app.ts");
    expect(candidatoAArquivo("ls")).toBeNull();
    expect(candidatoAArquivo("git status")).toBeNull();
  });

  it("arquivoDoIndice: exato, sufixo e nome — nunca pasta", () => {
    const indice = [
      { name: "src", path: "src", isDir: true, size: 0 },
      { name: "app.ts", path: "src/app.ts", isDir: false, size: 5 },
      { name: "index.html", path: "index.html", isDir: false, size: 12 }
    ];
    expect(arquivoDoIndice(indice, "src/app.ts")?.path).toBe("src/app.ts");
    expect(arquivoDoIndice(indice, "app.ts")?.path).toBe("src/app.ts");
    expect(arquivoDoIndice(indice, "src")).toBeNull();
    expect(arquivoDoIndice(indice, "nada.md")).toBeNull();
  });
});

/* ---------------------------------- dock ----------------------------------- */

describe("o dock único (o contrato do antigo TerminalDock)", () => {
  function corpo(): HTMLElement | null {
    return container.querySelector<HTMLElement>(".term-dock-corpo");
  }

  it("abre por Ctrl+` e por botão; fechar esconde em vez de desmontar", () => {
    monta();

    // Fechado de nascença: montar o painel junto com a superfície abriria um
    // shell que a pessoa talvez nunca use.
    expect(corpo()).toBeNull();

    // A linha $ e o cabeçalho do cli, por outro lado, JÁ estão de pé: o cli é
    // o dock — não um segundo rodapé que só aparece depois.
    expect(entrada()).not.toBeNull();
    expect(container.textContent).toContain("composer cli");
    expect(container.textContent).toContain("comandos executam na raiz do projeto");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true }));
    });
    expect(corpo()).not.toBeNull();
    expect(corpo()?.hidden).toBe(false);

    // Ctrl+` de novo: ESCONDE, não desmonta — desmontar mataria o shell (e o
    // dev server que estivesse rodando nele).
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true }));
    });
    expect(corpo()).not.toBeNull();
    expect(corpo()?.hidden).toBe(true);

    const botao = container.querySelector<HTMLButtonElement>(".term-dock-alternar");
    expect(botao?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      botao?.click();
    });
    expect(botao?.getAttribute("aria-expanded")).toBe("true");
    expect(corpo()?.hidden).toBe(false);
  });

  it("sem Ctrl a crase é só uma tecla: digitar ` num campo não abre o painel", () => {
    monta();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote" }));
    });
    expect(corpo()).toBeNull();
  });
});

/* ------------------------------ gesto (a): comando ------------------------- */

describe("comando na linha $", () => {
  it("fora do Tauri é honesto: modo demonstração, nenhum invoke", async () => {
    monta();
    gesto("pnpm test");
    await escoar();
    expect(historico()).toContain("$ pnpm test");
    expect(historico()).toContain("modo demonstração");
    expect(mocks.estado.invocacoes).toHaveLength(0);
    // E não abriu painel nenhum — não há shell para mostrar.
    expect(container.querySelector(".term-dock-corpo")).toBeNull();
  });

  it("no app: o primeiro comando abre o shell e espera na fila; o segundo escreve direto", async () => {
    fingirTauri(true);
    monta();

    // O primeiro gesto: o painel ainda nem existia — o comando não pode cair
    // no chão enquanto o pty_spawn viaja.
    gesto("pnpm test");
    expect(container.querySelector<HTMLElement>(".term-dock-corpo")?.hidden).toBe(false);
    await escoar();
    expect(chamadas("pty_spawn")).toHaveLength(1);
    expect(chamadas("pty_write")[0]?.args).toMatchObject({ id: "pty-cli", data: "pnpm test\r" });

    // O segundo: shell vivo, escrita imediata — mesma sessão, sem outro spawn.
    gesto("git status");
    await escoar();
    expect(chamadas("pty_spawn")).toHaveLength(1);
    expect(chamadas("pty_write")[1]?.args).toMatchObject({ id: "pty-cli", data: "git status\r" });

    expect(historico()).toContain("$ pnpm test");
    expect(historico()).toContain("$ git status");
  });
});

/* --------------------------- gesto (b): arquivo ---------------------------- */

describe("arquivo auto-detect", () => {
  it("caminho que existe no índice abre no editor, sem tocar no shell", async () => {
    fingirTauri(true);
    monta();
    gesto("index.html");
    await escoar();

    expect(useIde.getState().files.some((arquivo) => arquivo.path === "index.html")).toBe(true);
    expect(useIde.getState().activePath).toBe("index.html");
    expect(historico()).toContain("abrindo index.html no editor");
    expect(chamadas("pty_write")).toHaveLength(0);
  });

  it("o nome acha o arquivo dentro de pasta (src/app.ts por app.ts)", async () => {
    fingirTauri(true);
    monta();
    gesto("app.ts");
    await escoar();
    expect(useIde.getState().files.some((arquivo) => arquivo.path === "src/app.ts")).toBe(true);
  });

  it("cara de arquivo que NÃO existe volta a valer como comando", async () => {
    fingirTauri(true);
    monta();
    gesto("main.py");
    await escoar();
    // Não abriu aba nenhuma…
    expect(useIde.getState().files).toHaveLength(0);
    // …e o texto seguiu para o shell, que é o que ele provavelmente era.
    expect(chamadas("pty_write").at(-1)?.args).toMatchObject({ data: "main.py\r" });
  });
});

/* ------------------------- gesto (c): ai <pergunta> ------------------------ */

describe("ai <pergunta>", () => {
  it("vai pelo composer normal e espelha a resposta quando o turno fecha — sem cerca de protocolo", async () => {
    const prompts: string[] = [];
    useApp.setState({
      send: (texto?: string) => {
        prompts.push(texto ?? "");
        useApp.setState({ busy: true, error: "" });
      }
    });
    monta();

    gesto("ai qual a porta do dev server?");
    expect(prompts).toEqual(["qual a porta do dev server?"]);
    expect(historico()).toContain("→ agente da sessão…");

    // O turno fecha: busy cai com a resposta nas linhas — é o momento do
    // espelho, como o original fazia com threads.code.
    act(() => {
      useApp.setState({
        lines: [linhaDoBot('A porta é 1421.\n\n```aibot:tool\n{"tool":"fs.read"}\n```')],
        busy: false
      });
    });
    expect(historico()).toContain("A porta é 1421.");
    // O espelho passa pelo mesmo filtro do renderer: máquina não vaza no pane.
    expect(historico()).not.toContain("aibot:tool");
  });

  it("com o agente ocupado, o gesto avisa em vez de enfileirar pergunta", () => {
    const prompts: string[] = [];
    useApp.setState({
      busy: true,
      send: (texto?: string) => {
        prompts.push(texto ?? "");
      }
    });
    monta();
    gesto("ai mais uma coisa");
    expect(prompts).toEqual([]);
    expect(historico()).toContain("o agente ainda está respondendo");
  });

  it("envio que falha antes de virar turno é DITO — o send explica em error", () => {
    useApp.setState({
      send: () => {
        // O caminho real do send sem conexão: error preenchido, busy intacto.
        useApp.setState({ error: "sem conexão com o gateway — o pedido não foi enviado" });
      }
    });
    monta();
    gesto("ai alguém aí?");
    expect(historico()).toContain("sem conexão com o gateway");
  });

  it("turno que fecha em erro espelha o motivo, não um vazio", () => {
    useApp.setState({
      send: () => {
        useApp.setState({ busy: true, error: "" });
      }
    });
    monta();
    gesto("ai vai dar certo?");
    act(() => {
      useApp.setState({ busy: false, error: "Falha no gateway." });
    });
    expect(historico()).toContain("Falha no gateway.");
  });
});
