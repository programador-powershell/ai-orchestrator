import { describe, expect, it } from "vitest";

import { aplicarRetornos, cor256, parseAnsi, stripAnsi } from "./ansi";

const ESC = "\u001b";
const BEL = "\u0007";
/** Atalho para montar sequência sem encher o teste de escapes. */
const csi = (corpo: string) => `${ESC}[${corpo}`;

describe("parseAnsi — texto puro", () => {
  it("texto sem escape sai inteiro, num trecho só", () => {
    const { spans, pendente } = parseAnsi("build concluído");
    expect(spans).toEqual([{ text: "build concluído", style: {} }]);
    expect(pendente).toBe("");
  });

  it("texto vazio não gera trecho", () => {
    expect(parseAnsi("").spans).toEqual([]);
  });
});

describe("parseAnsi — cor", () => {
  it("as 8 cores básicas viram token da paleta do terminal", () => {
    const { spans } = parseAnsi(`${csi("31m")}erro${csi("0m")}`);
    expect(spans).toEqual([{ text: "erro", style: { fg: "var(--ansi-1)" } }]);
  });

  it("as brilhantes ocupam 8-15", () => {
    expect(parseAnsi(`${csi("92m")}ok`).spans[0].style.fg).toBe("var(--ansi-10)");
    expect(parseAnsi(`${csi("104m")}x`).spans[0].style.bg).toBe("var(--ansi-12)");
  });

  it("fundo e frente convivem", () => {
    const { spans } = parseAnsi(`${csi("31;42m")}alerta`);
    expect(spans[0].style).toEqual({ fg: "var(--ansi-1)", bg: "var(--ansi-2)" });
  });

  it("39 e 49 apagam só a cor, mantendo o atributo", () => {
    const { spans } = parseAnsi(`${csi("1;31m")}a${csi("39m")}b`);
    expect(spans[0].style).toEqual({ bold: true, fg: "var(--ansi-1)" });
    expect(spans[1].style).toEqual({ bold: true });
  });

  it("`ESC[m` sem número zera igual a `ESC[0m`", () => {
    const { spans } = parseAnsi(`${csi("31m")}a${csi("m")}b`);
    expect(spans[1].style).toEqual({});
  });
});

describe("parseAnsi — 256 cores e cor verdadeira", () => {
  it("consome os parâmetros do 38;5;n em vez de pintar com eles", () => {
    // Sem consumir, o `5` e o `196` virariam comandos soltos e o texto sairia
    // com a cor errada — o defeito clássico deste parser.
    const { spans } = parseAnsi(`${csi("38;5;196m")}vermelho`);
    expect(spans[0].style.fg).toBe("#ff0000");
  });

  it("38;2;r;g;b vira hex", () => {
    const { spans } = parseAnsi(`${csi("38;2;18;52;86m")}x`);
    expect(spans[0].style.fg).toBe("#123456");
  });

  it("48;5;n pinta o FUNDO", () => {
    expect(parseAnsi(`${csi("48;5;21m")}x`).spans[0].style.bg).toBe("#0000ff");
  });

  it("o cubo usa os degraus do xterm, não uma rampa linear", () => {
    expect(cor256(16)).toBe("#000000");
    expect(cor256(231)).toBe("#ffffff");
    expect(cor256(17)).toBe("#00005f"); // 95 = segundo degrau
  });

  it("0-15 caem na paleta e os cinzas no fim viram hex", () => {
    expect(cor256(3)).toBe("var(--ansi-3)");
    expect(cor256(232)).toBe("#080808");
    expect(cor256(255)).toBe("#eeeeee");
  });

  it("índice fora da faixa não quebra", () => {
    expect(cor256(-1)).toBe("var(--ansi-7)");
    expect(cor256(999)).toBe("var(--ansi-7)");
    expect(cor256(Number.NaN)).toBe("var(--ansi-7)");
  });
});

describe("parseAnsi — atributos", () => {
  it("negrito, itálico, sublinhado, reverso e riscado", () => {
    const { spans } = parseAnsi(`${csi("1;3;4;7;9m")}tudo`);
    expect(spans[0].style).toEqual({
      bold: true,
      italic: true,
      underline: true,
      inverse: true,
      strike: true
    });
  });

  it("22 desliga negrito E fraco de uma vez", () => {
    const { spans } = parseAnsi(`${csi("1;2m")}a${csi("22m")}b`);
    expect(spans[1].style).toEqual({});
  });
});

describe("parseAnsi — o que NÃO se desenha é descartado", () => {
  it("mover cursor e limpar tela somem sem deixar lixo", () => {
    const { spans } = parseAnsi(`${csi("2J")}${csi("H")}pronto${csi("K")}`);
    expect(spans.map((s) => s.text).join("")).toBe("pronto");
  });

  it("título de janela (OSC) some, com BEL ou com ESC \\", () => {
    expect(stripAnsi(`${ESC}]0;meu titulo${BEL}texto`)).toBe("texto");
    expect(stripAnsi(`${ESC}]0;outro${ESC}\\texto`)).toBe("texto");
  });

  it("escape de dois caracteres some", () => {
    expect(stripAnsi(`${ESC}(Btexto`)).toBe("texto");
  });
});

describe("parseAnsi — stream cortado ao meio", () => {
  it("sequência partida vira PENDENTE, não texto na tela", () => {
    // O PTY corta em blocos de tamanho arbitrário: sem isto, o "1m" aparecia
    // escrito no terminal.
    const bloco1 = parseAnsi(`ok ${ESC}[3`);
    expect(bloco1.spans.map((s) => s.text).join("")).toBe("ok ");
    expect(bloco1.pendente).toBe(`${ESC}[3`);

    const bloco2 = parseAnsi(`${bloco1.pendente}1merro`, bloco1.final);
    expect(bloco2.spans).toEqual([{ text: "erro", style: { fg: "var(--ansi-1)" } }]);
  });

  it("ESC sozinho no fim também fica pendente", () => {
    const r = parseAnsi(`ok${ESC}`);
    expect(r.pendente).toBe(ESC);
    expect(r.spans[0].text).toBe("ok");
  });

  it("OSC sem terminador fica pendente em vez de comer o resto", () => {
    const r = parseAnsi(`${ESC}]0;sem fim`);
    expect(r.pendente).toBe(`${ESC}]0;sem fim`);
    expect(r.spans).toEqual([]);
  });

  it("o ESTILO atravessa os blocos", () => {
    const a = parseAnsi(`${csi("1;31m")}começo`);
    const b = parseAnsi("continua", a.final);
    expect(b.spans[0].style).toEqual({ bold: true, fg: "var(--ansi-1)" });
  });
});

describe("parseAnsi — junção de trechos", () => {
  it("estilo igual não quebra o texto em dois", () => {
    const { spans } = parseAnsi(`${csi("31m")}a${csi("31m")}b`);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("ab");
  });

  it("cada trecho carrega uma CÓPIA do estilo", () => {
    const { spans } = parseAnsi(`${csi("31m")}a${csi("32m")}b`);
    expect(spans[0].style.fg).toBe("var(--ansi-1)");
    expect(spans[1].style.fg).toBe("var(--ansi-2)");
    expect(spans[0].style).not.toBe(spans[1].style);
  });
});

describe("aplicarRetornos", () => {
  it("`\\r` reescreve a linha — a barra de progresso não vira scrollback", () => {
    expect(aplicarRetornos("baixando 10%\rbaixando 90%")).toBe("baixando 90%");
  });

  it("o rabo da linha antiga sobrevive quando a nova é mais curta", () => {
    // É o comportamento do terminal de verdade: `\r` só move o cursor.
    expect(aplicarRetornos("carregando...\rok")).toBe("okrregando...");
  });

  it("`\\b` apaga um caractere para trás", () => {
    expect(aplicarRetornos("abcX\by")).toBe("abcy");
  });

  it("`\\b` no começo não estoura", () => {
    expect(aplicarRetornos("\b\bab")).toBe("ab");
  });

  it("linha sem controle passa intacta", () => {
    expect(aplicarRetornos("linha normal")).toBe("linha normal");
  });
});

describe("stripAnsi", () => {
  it("devolve o texto que o usuário copiaria", () => {
    const bruto = `${csi("32m")}✓${csi("0m")} 12 testes ${csi("2m")}(1.3s)${csi("0m")}`;
    expect(stripAnsi(bruto)).toBe("✓ 12 testes (1.3s)");
  });
});
