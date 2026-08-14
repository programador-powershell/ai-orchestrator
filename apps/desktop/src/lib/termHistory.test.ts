import { describe, expect, it } from "vitest";
import { MAX_HISTORY, emptyHistory, recallNext, recallPrev, remember } from "./termHistory";

describe("remember", () => {
  it("guarda o comando e deixa o cursor no fim (editando o novo)", () => {
    const history = remember(emptyHistory, "pnpm test");
    expect(history.entries).toEqual(["pnpm test"]);
    expect(history.cursor).toBe(1);
  });

  it("ignora vazio e só-espaço", () => {
    expect(remember(emptyHistory, "").entries).toEqual([]);
    expect(remember(emptyHistory, "   ").entries).toEqual([]);
  });

  it("não repete o comando imediatamente anterior", () => {
    // Rodar `pnpm test` cinco vezes seguidas enchia o histórico com a mesma
    // linha, e o ↑ precisava de cinco toques para chegar no comando anterior.
    const history = remember(remember(remember(emptyHistory, "ls"), "ls"), "ls");
    expect(history.entries).toEqual(["ls"]);
  });

  it("repete se houve outro comando no meio", () => {
    const history = remember(remember(remember(emptyHistory, "ls"), "pwd"), "ls");
    expect(history.entries).toEqual(["ls", "pwd", "ls"]);
  });

  it("descarta o mais antigo ao passar do teto", () => {
    let history = emptyHistory;
    for (let index = 0; index < MAX_HISTORY + 10; index += 1) {
      history = remember(history, `cmd ${index}`);
    }
    expect(history.entries).toHaveLength(MAX_HISTORY);
    expect(history.entries[0]).toBe("cmd 10");
    expect(history.entries.at(-1)).toBe(`cmd ${MAX_HISTORY + 9}`);
  });

  it("recoloca o cursor no fim depois de navegar", () => {
    const navegado = recallPrev(remember(remember(emptyHistory, "ls"), "pwd")).history;
    expect(navegado.cursor).toBe(1);
    const depois = remember(navegado, "git status");
    expect(depois.cursor).toBe(depois.entries.length);
  });
});

describe("recallPrev", () => {
  it("do fim, ↑ traz o último comando", () => {
    const history = remember(remember(emptyHistory, "ls"), "pwd");
    const { value, history: proximo } = recallPrev(history);
    expect(value).toBe("pwd");
    expect(proximo.cursor).toBe(1);
  });

  it("↑ repetido caminha para trás", () => {
    let history = remember(remember(remember(emptyHistory, "a"), "b"), "c");
    let value = "";
    ({ history, value } = recallPrev(history));
    expect(value).toBe("c");
    ({ history, value } = recallPrev(history));
    expect(value).toBe("b");
    ({ history, value } = recallPrev(history));
    expect(value).toBe("a");
  });

  it("no mais antigo, ↑ fica parado — não volta a dar a volta", () => {
    let history = remember(remember(emptyHistory, "a"), "b");
    ({ history } = recallPrev(history));
    ({ history } = recallPrev(history));
    const { value, history: proximo } = recallPrev(history);
    expect(value).toBe("a");
    expect(proximo.cursor).toBe(0);
  });

  it("histórico vazio devolve null — o ↑ não deve mexer no que está digitado", () => {
    expect(recallPrev(emptyHistory).value).toBeNull();
  });
});

describe("recallNext", () => {
  it("↓ volta para frente e, passando do último, esvazia a linha", () => {
    let history = remember(remember(emptyHistory, "a"), "b");
    ({ history } = recallPrev(history));
    ({ history } = recallPrev(history));
    let value: string | null = "";
    ({ history, value } = recallNext(history));
    expect(value).toBe("b");
    ({ history, value } = recallNext(history));
    expect(value).toBe("");
    expect(history.cursor).toBe(history.entries.length);
  });

  it("já no fim, ↓ devolve null — nada a restaurar", () => {
    const history = remember(emptyHistory, "a");
    expect(recallNext(history).value).toBeNull();
  });
});
