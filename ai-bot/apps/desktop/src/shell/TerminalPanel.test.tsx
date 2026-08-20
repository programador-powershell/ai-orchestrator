/**
 * O terminal da pessoa — os testes do que pode quebrar CALADO.
 *
 * O que se prova aqui, e por quê:
 *
 *   1. O redutor não ressuscita sessão morta — as threads de leitura e de
 *      espera do Rust são independentes, então evento atrasado DEPOIS do
 *      `pty-exit` é um cenário real, não teórico.
 *   2. `escutarPendente` guarda o que chega antes do id — a corrida que
 *      deixava o terminal em branco até o primeiro Enter.
 *   3. Fora do Tauri o painel é honesto: diz que não há processo para abrir e
 *      NÃO chama comando nenhum (não existe `invoke` no navegador).
 *   4. A fiação inteira no app: inscrição ANTES do spawn, tecla → `pty_write`,
 *      saída → `term.write`, desmontar → `pty_kill`. E depois do exit a tecla
 *      cai no chão — digitar num shell morto não vai a lugar nenhum.
 *   5. A alça do composer cli (`TerminalPanelApi`): escrever no shell vivo é o
 *      mesmo caminho do teclado; com a sessão morta devolve false SEM efeito —
 *      comando de gente não pode executar mais tarde num prompt invisível.
 *      (Os testes do dock em si moram em ComposerCli.test.tsx, que é onde o
 *      dock mora agora.)
 *
 * Aqui não há @testing-library: a montagem é `react-dom/client` cru com o
 * `act` do React 19, como nos outros testes deste app — cada dependência
 * passa por homologação de TI/SI, e uma biblioteca inteira para clicar em
 * botão não se justifica.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/* --------------------------------- mocks ---------------------------------- */

/**
 * `vi.mock` é içado para antes dos imports, então tudo que as fábricas usam
 * precisa nascer em `vi.hoisted`. O Xterm falso guarda o que foi escrito e os
 * handlers registrados — é o suficiente para provar a fiação sem medir fonte
 * em canvas, que o jsdom não tem.
 */
const mocks = vi.hoisted(() => {
  type Registro = { cmd: string; args?: Record<string, unknown> };
  type Handler = (event: { payload: unknown }) => void;

  class XtermFake {
    static instancias: XtermFake[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    escritas: string[] = [];
    teclado: ((data: string) => void) | null = null;
    constructor() {
      XtermFake.instancias.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    onData(fn: (data: string) => void) {
      this.teclado = fn;
      return { dispose: () => undefined };
    }
    onResize(_fn: (medida: { cols: number; rows: number }) => void) {
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
    /** Ordem global de chamadas — é o que prova "listen ANTES de spawn". */
    ordem: [] as string[],
    invocacoes: [] as Registro[],
    ouvintes: new Map<string, Handler[]>(),
    /** O que o `pty_spawn` falso devolve. */
    proximoId: "pty-42"
  };

  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    estado.ordem.push(`invoke:${cmd}`);
    estado.invocacoes.push({ cmd, args });
    if (cmd === "pty_spawn") return estado.proximoId;
    return undefined;
  };

  const listen = async (nome: string, handler: Handler): Promise<() => void> => {
    estado.ordem.push(`listen:${nome}`);
    const lista = estado.ouvintes.get(nome) ?? [];
    lista.push(handler);
    estado.ouvintes.set(nome, lista);
    return () => {
      const atuais = estado.ouvintes.get(nome) ?? [];
      estado.ouvintes.set(
        nome,
        atuais.filter((item) => item !== handler)
      );
    };
  };

  /** Emite como o Rust emitiria: para TODOS os ouvintes da janela. */
  const emitir = (nome: string, payload: unknown): void => {
    for (const handler of estado.ouvintes.get(nome) ?? []) handler({ payload });
  };

  return { estado, invoke, listen, emitir, XtermFake, FitFake };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.XtermFake }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: mocks.FitFake }));

import {
  TerminalPanel,
  escutarPendente,
  reduzirSessao,
  sessaoInicial,
  type TerminalPanelApi
} from "./TerminalPanel";

/* ------------------------------- utilidades ------------------------------- */

declare global {
  // A bandeira que o React 19 procura para aceitar `act()` fora de uma suíte
  // oficial. `var` é o que declara global em TypeScript.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

/** Liga/desliga o que faz `ptyDisponivel()` responder que estamos no app. */
function fingirTauri(nativo: boolean) {
  if (nativo) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    return;
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/**
 * Escoa os `await` da abertura da sessão (3 listen + 1 spawn, todos
 * assíncronos). Microtarefas em série bastam — nenhum mock usa timer.
 */
async function escoar() {
  await act(async () => {
    for (let volta = 0; volta < 8; volta += 1) await Promise.resolve();
  });
}

function ultimoTerm() {
  const term = mocks.XtermFake.instancias[mocks.XtermFake.instancias.length - 1];
  if (!term) throw new Error("nenhum Xterm foi criado");
  return term;
}

function chamadas(cmd: string) {
  return mocks.estado.invocacoes.filter((registro) => registro.cmd === cmd);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.estado.ordem.length = 0;
  mocks.estado.invocacoes.length = 0;
  mocks.estado.ouvintes.clear();
  mocks.XtermFake.instancias.length = 0;
  fingirTauri(false);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  fingirTauri(false);
});

/* --------------------------------- redutor -------------------------------- */

describe("reduzirSessao", () => {
  it("status terminal não volta atrás: evento atrasado não ressuscita a sessão", () => {
    let sessao = sessaoInicial();
    sessao = reduzirSessao(sessao, { type: "saiu", exitCode: 0, motivo: "exited" });
    expect(sessao.status).toBe("saiu");

    // Um `aberto` atrasado (as threads do Rust são independentes) não pode
    // dizer à tela que há shell vivo onde não há.
    const depois = reduzirSessao(sessao, { type: "aberto", id: "pty-9" });
    expect(depois.status).toBe("saiu");
    expect(depois.id).toBe("");
  });

  it("erro de leitura registra a mensagem mas não encerra: quem decide o fim é o pty-exit", () => {
    let sessao = reduzirSessao(sessaoInicial(), { type: "aberto", id: "pty-1" });
    sessao = reduzirSessao(sessao, { type: "erro", mensagem: "READ_ERROR: cabo rompeu" });
    expect(sessao.status).toBe("vivo");
    expect(sessao.erro).toContain("READ_ERROR");
  });

  it("abrir zera tudo: a sessão nova não herda o cadáver da anterior", () => {
    let sessao = reduzirSessao(sessaoInicial(), { type: "saiu", exitCode: 1, motivo: "error" });
    sessao = reduzirSessao(sessao, { type: "abrir" });
    expect(sessao).toEqual(sessaoInicial());
  });
});

/* ---------------------------- inscrição pendente --------------------------- */

describe("escutarPendente", () => {
  it("guarda o que chega antes do id e entrega só o que é da sessão, em ordem", async () => {
    const recebidos: string[] = [];
    const inscricao = await escutarPendente({
      onData: (evento) => recebidos.push(evento.data)
    });

    // A corrida real: a thread de leitura emite antes de o spawn retornar.
    mocks.emitir("pty-data", { id: "pty-9", data: "banner " });
    mocks.emitir("pty-data", { id: "outro-terminal", data: "intruso" });
    mocks.emitir("pty-data", { id: "pty-9", data: "prompt>" });
    expect(recebidos).toEqual([]);

    inscricao.amarrar("pty-9");
    expect(recebidos).toEqual(["banner ", "prompt>"]);

    // Depois de amarrado, entrega direto — e continua filtrando.
    mocks.emitir("pty-data", { id: "pty-9", data: "ls" });
    mocks.emitir("pty-data", { id: "outro-terminal", data: "intruso" });
    expect(recebidos).toEqual(["banner ", "prompt>", "ls"]);

    inscricao.parar();
    mocks.emitir("pty-data", { id: "pty-9", data: "depois de parar" });
    expect(recebidos).toHaveLength(3);
  });
});

/* ------------------------------ fora do Tauri ------------------------------ */

describe("TerminalPanel fora do aplicativo", () => {
  it("é honesto: diz que o terminal é do desktop e não chama comando nenhum", async () => {
    fingirTauri(false);
    await act(async () => {
      root.render(<TerminalPanel />);
    });
    expect(container.textContent).toContain("só no aplicativo desktop");
    // Sem casca nativa não existe `invoke` — chamar quebraria; nem emulador
    // faz sentido montar.
    expect(mocks.estado.invocacoes).toHaveLength(0);
    expect(mocks.XtermFake.instancias).toHaveLength(0);
  });
});

/* ------------------------------ dentro do Tauri ---------------------------- */

describe("TerminalPanel no aplicativo", () => {
  it("assina os eventos ANTES do spawn e liga teclado, saída e kill", async () => {
    fingirTauri(true);
    await act(async () => {
      root.render(<TerminalPanel />);
    });
    await escoar();

    // A ordem é a alma do teste: evento do Tauri sem ouvinte é descartado, e
    // um spawn antes do listen perderia o banner e o primeiro prompt.
    const indiceSpawn = mocks.estado.ordem.indexOf("invoke:pty_spawn");
    expect(indiceSpawn).toBeGreaterThan(-1);
    for (const nome of ["pty-data", "pty-exit", "pty-error"]) {
      const indiceListen = mocks.estado.ordem.indexOf(`listen:${nome}`);
      expect(indiceListen).toBeGreaterThan(-1);
      expect(indiceListen).toBeLessThan(indiceSpawn);
    }

    // O renderer manda o TIPO do shell, nunca um caminho (enum fechado no Rust).
    const spawn = chamadas("pty_spawn")[0];
    expect(spawn?.args?.shell).toBe("default");

    // Saída do processo → tela (filtrando por id: janela é barramento comum).
    const term = ultimoTerm();
    act(() => {
      mocks.emitir("pty-data", { id: "pty-42", data: "PS C:\\projeto>" });
      mocks.emitir("pty-data", { id: "pty-77", data: "de outro terminal" });
    });
    expect(term.escritas).toContain("PS C:\\projeto>");
    expect(term.escritas.join("")).not.toContain("de outro terminal");

    // Tecla da PESSOA → pty_write. (E só da pessoa: este comando nunca pode
    // virar ferramenta do agente — ver o cabeçalho do componente.)
    act(() => {
      term.teclado?.("ls\r");
    });
    expect(chamadas("pty_write")[0]?.args).toMatchObject({ id: "pty-42", data: "ls\r" });

    // Desmontar mata o shell: sem isso fica um processo órfão com os direitos
    // da pessoa e uma entrada presa no mapa do Rust.
    act(() => {
      root.unmount();
    });
    expect(chamadas("pty_kill")[0]?.args).toMatchObject({ id: "pty-42" });
  });

  it("depois do pty-exit a tecla cai no chão e a tela conta como terminou", async () => {
    fingirTauri(true);
    await act(async () => {
      root.render(<TerminalPanel />);
    });
    await escoar();

    const term = ultimoTerm();
    act(() => {
      mocks.emitir("pty-exit", { id: "pty-42", exitCode: 0, reason: "exited" });
    });

    // O fim aparece na tela, como em terminal de verdade.
    expect(term.escritas.join("")).toContain("processo encerrado");

    // Digitar num shell morto não deve ir a lugar nenhum: o id já foi zerado.
    act(() => {
      term.teclado?.("echo fantasma\r");
    });
    expect(chamadas("pty_write")).toHaveLength(0);
  });
});

/* ------------------------- alça do composer cli ---------------------------- */

describe("TerminalPanelApi", () => {
  it("escrever entrega no shell vivo e devolve false (sem efeito) no morto", async () => {
    fingirTauri(true);
    const apiRef: { current: TerminalPanelApi | null } = { current: null };
    await act(async () => {
      root.render(<TerminalPanel apiRef={apiRef} />);
    });
    await escoar();

    // Shell vivo: a alça é o MESMO caminho do teclado da pessoa.
    expect(apiRef.current?.escrever("pnpm test\r")).toBe(true);
    expect(chamadas("pty_write")[0]?.args).toMatchObject({ id: "pty-42", data: "pnpm test\r" });

    // Shell morto: false SEM pty_write — comando de gente não pode ficar
    // guardado para executar depois num prompt que ninguém está vendo.
    act(() => {
      mocks.emitir("pty-exit", { id: "pty-42", exitCode: 0, reason: "exited" });
    });
    expect(apiRef.current?.escrever("echo fantasma\r")).toBe(false);
    expect(chamadas("pty_write")).toHaveLength(1);
  });

  it("aoVivo dispara quando a sessão abre — é o gancho que drena a fila do cli", async () => {
    fingirTauri(true);
    const vivos: string[] = [];
    await act(async () => {
      root.render(<TerminalPanel aoVivo={() => vivos.push("vivo")} />);
    });
    await escoar();
    expect(vivos).toEqual(["vivo"]);
  });
});
