/**
 * O histórico genérico do schema — mesma mecânica do canvas (pilha, teto de
 * 50, push apaga o future), verificada aqui porque este módulo é uma CÓPIA
 * generalizada, não um import: se os dois divergirem um dia, os testes de
 * cada um seguram o seu.
 */
import { describe, expect, it } from "vitest";
import { canRedo, canUndo, createHistory, HISTORY_LIMIT, pushHistory, redo, undo } from "./history";

describe("histórico do schema", () => {
  it("nasce vazio: nada a desfazer nem refazer", () => {
    const history = createHistory<number>();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history, 1)).toBeNull();
    expect(redo(history, 1)).toBeNull();
  });

  it("push → undo devolve o estado anterior e arma o redo", () => {
    let history = createHistory<string>();
    history = pushHistory(history, "v1");

    const passo = undo(history, "v2");
    expect(passo?.doc).toBe("v1");
    expect(canRedo(passo!.history)).toBe(true);

    const volta = redo(passo!.history, "v1");
    expect(volta?.doc).toBe("v2");
  });

  it("um push novo apaga o future — editar depois de desfazer descarta o ramo", () => {
    let history = createHistory<string>();
    history = pushHistory(history, "v1");
    const passo = undo(history, "v2")!;

    const editado = pushHistory(passo.history, passo.doc);
    expect(canRedo(editado)).toBe(false);
  });

  it("o teto de 50 derruba o estado mais ANTIGO, não o mais novo", () => {
    let history = createHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) history = pushHistory(history, i);

    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.past[0]).toBe(10);
    expect(history.past[HISTORY_LIMIT - 1]).toBe(HISTORY_LIMIT + 9);
  });
});
