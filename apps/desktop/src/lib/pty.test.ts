/**
 * Testes da inscrição PENDENTE do PTY.
 *
 * O que se defende aqui é a ordem: a thread de leitura do Rust emite
 * `pty-data` no instante em que o filho nasce, e o front só conhece o id
 * depois que `pty_spawn` volta. Evento do Tauri sem ouvinte é descartado —
 * então assinar depois perdia o começo da sessão. Estes casos travam o
 * contrato de que nada se perde e de que nada vaza de uma sessão para outra.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Ouvintes registrados pelo módulo, por nome de evento. */
const registrados = new Map<string, Array<(event: { payload: unknown }) => void>>();
const desinscricoes: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (nome: string, handler: (event: { payload: unknown }) => void) => {
    const lista = registrados.get(nome) ?? [];
    lista.push(handler);
    registrados.set(nome, lista);
    return () => {
      desinscricoes.push(nome);
      registrados.set(
        nome,
        (registrados.get(nome) ?? []).filter((item) => item !== handler)
      );
    };
  })
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("./ssh", () => ({
  resolveRoute: vi.fn(),
  routeLabel: vi.fn(),
  toTarget: vi.fn()
}));
vi.mock("./store", () => ({ useApp: { getState: () => ({}) } }));

/*
 * O ambiente do vitest é `node` — sem `window`. O módulo decide
 * `isPtyAvailable` na CARGA (`"__TAURI_INTERNALS__" in window`), então a
 * janela falsa precisa existir antes do import dinâmico, não depois.
 *
 * E precisa sair depois: o global é compartilhado com os outros arquivos de
 * teste do mesmo worker, e uma janela sem `addEventListener` fazia módulos
 * alheios (o `store`) tomarem o caminho de navegador e quebrarem na carga.
 */
const janelaOriginal = (globalThis as unknown as Record<string, unknown>).window;
(globalThis as unknown as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };

const { ptyListenPendente } = await import("./pty");

afterAll(() => {
  if (janelaOriginal === undefined) delete (globalThis as unknown as Record<string, unknown>).window;
  else (globalThis as unknown as Record<string, unknown>).window = janelaOriginal;
});

function emitir(nome: string, payload: unknown) {
  for (const handler of registrados.get(nome) ?? []) handler({ payload });
}

beforeEach(() => {
  registrados.clear();
  desinscricoes.length = 0;
});

describe("ptyListenPendente", () => {
  it("entrega, na ordem, o que chegou ANTES de amarrar", async () => {
    const recebido: string[] = [];
    const inscricao = await ptyListenPendente({ onData: (evento) => recebido.push(evento.data) });

    emitir("pty-data", { id: "s1", data: "Windows PowerShell\r\n" });
    emitir("pty-data", { id: "s1", data: "PS C:\\> " });
    expect(recebido).toEqual([]); // ainda sem id: fica na fila

    inscricao.amarrar("s1");
    expect(recebido).toEqual(["Windows PowerShell\r\n", "PS C:\\> "]);
  });

  it("descarta o que era de OUTRA sessão, antes e depois de amarrar", async () => {
    const recebido: string[] = [];
    const inscricao = await ptyListenPendente({ onData: (evento) => recebido.push(evento.data) });

    // Dois terminais abertos: a fila vê os dois, o filtro escolhe.
    emitir("pty-data", { id: "outra", data: "não é minha" });
    emitir("pty-data", { id: "s1", data: "minha" });
    inscricao.amarrar("s1");
    emitir("pty-data", { id: "outra", data: "também não" });
    emitir("pty-data", { id: "s1", data: "minha 2" });

    expect(recebido).toEqual(["minha", "minha 2"]);
  });

  it("amarrar duas vezes não reentrega a fila", async () => {
    const recebido: string[] = [];
    const inscricao = await ptyListenPendente({ onData: (evento) => recebido.push(evento.data) });
    emitir("pty-data", { id: "s1", data: "a" });
    inscricao.amarrar("s1");
    inscricao.amarrar("s1");
    expect(recebido).toEqual(["a"]);
  });

  it("parar antes de amarrar desinscreve os três e joga a fila fora", async () => {
    const recebido: string[] = [];
    const inscricao = await ptyListenPendente({ onData: (evento) => recebido.push(evento.data) });
    emitir("pty-data", { id: "s1", data: "perdido de propósito" });

    inscricao.parar();
    expect(desinscricoes.sort()).toEqual(["pty-data", "pty-error", "pty-exit"]);

    // Amarrar depois de parar não pode ressuscitar nada.
    inscricao.amarrar("s1");
    expect(recebido).toEqual([]);
  });

  it("erro SEM id é do subsistema e passa nos dois momentos", async () => {
    const erros: string[] = [];
    const inscricao = await ptyListenPendente({ onError: (evento) => erros.push(evento.code) });

    emitir("pty-error", { code: "SPAWN_FAILED", message: "x" }); // sem id, antes
    emitir("pty-error", { id: "outra", code: "NAO_MINHA", message: "x" });
    inscricao.amarrar("s1");
    emitir("pty-error", { code: "PTY_READ", message: "x" }); // sem id, depois
    emitir("pty-error", { id: "s1", code: "MINHA", message: "x" });

    expect(erros).toEqual(["SPAWN_FAILED", "PTY_READ", "MINHA"]);
  });

  it("a fila tem teto — processo tagarela sem amarrar não come a memória", async () => {
    const recebido: string[] = [];
    const inscricao = await ptyListenPendente({ onData: (evento) => recebido.push(evento.data) });
    for (let i = 0; i < 1000; i += 1) emitir("pty-data", { id: "s1", data: String(i) });
    inscricao.amarrar("s1");
    // 512 é o teto declarado no módulo; o que importa é NÃO ser 1000.
    expect(recebido).toHaveLength(512);
    expect(recebido[0]).toBe("0");
  });

  it("exit e data da sessão chegam pelo mesmo filtro", async () => {
    const eventos: string[] = [];
    const inscricao = await ptyListenPendente({
      onData: () => eventos.push("data"),
      onExit: (evento) => eventos.push(`exit:${evento.reason}`)
    });
    emitir("pty-data", { id: "s1", data: "oi" });
    emitir("pty-exit", { id: "s1", exitCode: 0, reason: "exited" });
    inscricao.amarrar("s1");
    expect(eventos).toEqual(["data", "exit:exited"]);
  });
});
