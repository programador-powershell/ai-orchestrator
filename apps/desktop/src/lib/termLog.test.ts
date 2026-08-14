import { describe, expect, it } from "vitest";
import { MAX_TERM_LINES, exitLine, line, pushLines, splitOutput } from "./termLog";

describe("splitOutput", () => {
  it("quebra a saída em uma linha por entrada", () => {
    expect(splitOutput("um\ndois\ntrês", "output")).toEqual([
      { kind: "output", text: "um" },
      { kind: "output", text: "dois" },
      { kind: "output", text: "três" }
    ]);
  });

  it("descarta o \\n final sem inventar linha vazia no fim", () => {
    // Todo comando de shell termina a saída com \n; um split ingênuo devolvia
    // uma linha vazia extra por comando e o scrollback ia abrindo buraco.
    expect(splitOutput("pronto\n", "output")).toEqual([{ kind: "output", text: "pronto" }]);
  });

  it("preserva linha vazia NO MEIO — é separador de parágrafo da ferramenta", () => {
    expect(splitOutput("um\n\ndois", "output")).toEqual([
      { kind: "output", text: "um" },
      { kind: "output", text: "" },
      { kind: "output", text: "dois" }
    ]);
  });

  it("normaliza CRLF — a plataforma-alvo é Windows", () => {
    expect(splitOutput("um\r\ndois\r\n", "output")).toEqual([
      { kind: "output", text: "um" },
      { kind: "output", text: "dois" }
    ]);
  });

  it("saída vazia não produz linha nenhuma", () => {
    expect(splitOutput("", "output")).toEqual([]);
    expect(splitOutput("\n", "output")).toEqual([]);
  });
});

describe("exitLine", () => {
  it("exit 0 é sucesso", () => {
    expect(exitLine(0, 120)).toEqual({ kind: "success", text: "[exit 0 · 120 ms]" });
  });

  it("exit diferente de 0 é ERRO — falha não pode ter a cor de sucesso", () => {
    // Era a mesma cor de `exit 0`: quem rodava um build quebrado via um
    // rodapé cinza idêntico ao do build que passou.
    expect(exitLine(1, 120)).toEqual({ kind: "error", text: "[exit 1 · 120 ms]" });
    expect(exitLine(127, 8)).toEqual({ kind: "error", text: "[exit 127 · 8 ms]" });
  });

  it("sem código de saída fica neutro — não sabemos se falhou", () => {
    expect(exitLine(undefined, 40)).toEqual({ kind: "meta", text: "[exit n/a · 40 ms]" });
  });
});

describe("pushLines", () => {
  it("acrescenta ao fim preservando a ordem", () => {
    const atual = [line("note", "a")];
    expect(pushLines(atual, [line("output", "b"), line("output", "c")])).toEqual([
      { kind: "note", text: "a" },
      { kind: "output", text: "b" },
      { kind: "output", text: "c" }
    ]);
  });

  it("não muta o array recebido", () => {
    const atual = [line("note", "a")];
    pushLines(atual, [line("output", "b")]);
    expect(atual).toEqual([{ kind: "note", text: "a" }]);
  });

  it("corta o começo ao passar do teto, mantendo as ÚLTIMAS linhas", () => {
    // Sem teto, um `cat` de arquivo grande (ou um build verboso) crescia o
    // array para sempre e o React reconciliava o scrollback inteiro por linha
    // nova — a aba travava progressivamente até fechar.
    const atual = Array.from({ length: MAX_TERM_LINES }, (_, index) => line("output", `linha ${index}`));
    const saida = pushLines(atual, [line("output", "nova")]);
    expect(saida).toHaveLength(MAX_TERM_LINES);
    expect(saida.at(-1)).toEqual({ kind: "output", text: "nova" });
    expect(saida[0]).toEqual({ kind: "output", text: "linha 1" });
  });

  it("lote maior que o teto guarda só a cauda dele", () => {
    const enorme = Array.from({ length: MAX_TERM_LINES + 50 }, (_, index) => line("output", `l${index}`));
    const saida = pushLines([line("note", "banner")], enorme);
    expect(saida).toHaveLength(MAX_TERM_LINES);
    expect(saida.at(-1)).toEqual({ kind: "output", text: `l${MAX_TERM_LINES + 49}` });
    // O banner e as primeiras linhas do lote saíram junto.
    expect(saida.some((item) => item.text === "banner")).toBe(false);
  });
});
