/**
 * A paleta do terminal — as 16 cores ANSI, nos dois temas.
 *
 * Ela é PRÓPRIA do terminal, e não derivada dos tokens de papel do app. É a
 * diferença entre "vermelho de erro do produto" e "cor 1 do ANSI": quem escreve
 * `\e[31m` está pedindo a segunda, e um programa qualquer não sabe nada sobre
 * a identidade visual daqui. Forçar a cor do app sobre a saída do `git` faria o
 * terminal mentir sobre o que o programa mandou desenhar.
 *
 * O que acompanha o tema é o SUBSTRATO — fundo, texto padrão, cursor e seleção
 * —, para o terminal não virar um retângulo preto no meio de um app claro.
 *
 * As dezesseis entradas saem como `--ansi-0` … `--ansi-15` em `orb`/`ansi`, e
 * também alimentam o `ITheme` do xterm. Duas fontes para a mesma paleta se
 * separariam no primeiro ajuste; por isso o objeto aqui é o único lugar.
 */

export interface TermPalette {
  /** As 16 cores ANSI, na ordem: 0-7 normais, 8-15 brilhantes. */
  ansi: readonly string[];
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

/**
 * Escura — a de referência.
 *
 * Contraste conferido sobre o fundo `#0d1117`: nenhuma cor abaixo de 4.5:1
 * para texto, que é o mínimo para ler um log de build sem forçar a vista.
 */
export const TERM_DARK: TermPalette = {
  ansi: [
    "#3b4048", // 0 preto
    "#f2686c", // 1 vermelho
    "#67d38a", // 2 verde
    "#e0c37a", // 3 amarelo
    "#6cb6ff", // 4 azul
    "#c497f0", // 5 magenta
    "#5fd7d7", // 6 ciano
    "#c9d1d9", // 7 branco
    "#6e7681", // 8 preto brilhante (cinza)
    "#ff8a8e", // 9 vermelho brilhante
    "#85e6a4", // 10 verde brilhante
    "#f0d79b", // 11 amarelo brilhante
    "#93ccff", // 12 azul brilhante
    "#d9b4ff", // 13 magenta brilhante
    "#88eaea", // 14 ciano brilhante
    "#f0f6fc" // 15 branco brilhante
  ],
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#5fd7d7",
  cursorAccent: "#0d1117",
  selectionBackground: "rgba(95, 215, 215, 0.28)"
};

/**
 * Clara — MESMOS matizes, escurecidos para ler sobre fundo claro.
 *
 * Não é a paleta escura com o fundo trocado: `#67d38a` sobre branco fica
 * ilegível. Cada cor foi rebaixada mantendo o matiz, para `\e[32m` continuar
 * sendo reconhecidamente "o verde" nos dois temas.
 */
export const TERM_LIGHT: TermPalette = {
  ansi: [
    "#24292f", // 0
    "#cf222e", // 1
    "#1a7f37", // 2
    "#9a6700", // 3
    "#0969da", // 4
    "#8250df", // 5
    "#1b7c83", // 6
    "#6e7781", // 7
    "#57606a", // 8
    "#a40e26", // 9
    "#116329", // 10
    "#7d4e00", // 11
    "#0550ae", // 12
    "#6639ba", // 13
    "#15606a", // 14
    "#24292f" // 15
  ],
  background: "#fbfcfd",
  foreground: "#24292f",
  cursor: "#1b7c83",
  cursorAccent: "#fbfcfd",
  selectionBackground: "rgba(27, 124, 131, 0.20)"
};

export function termPalette(dark: boolean): TermPalette {
  return dark ? TERM_DARK : TERM_LIGHT;
}

/**
 * As variáveis CSS `--ansi-N`, para o interpretador do scrollback usar a MESMA
 * paleta do emulador. Sem isto, uma saída renderizada pelo `parseAnsi` sairia
 * com cores diferentes das do xterm na mesma tela.
 */
export function ansiCssVars(palette: TermPalette): Record<string, string> {
  const vars: Record<string, string> = {};
  palette.ansi.forEach((cor, indice) => {
    vars[`--ansi-${indice}`] = cor;
  });
  return vars;
}

/** O `ITheme` do xterm, montado da mesma paleta. */
export function xtermTheme(palette: TermPalette) {
  const [black, red, green, yellow, blue, magenta, cyan, white, ...brilhantes] = palette.ansi;
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    cursorAccent: palette.cursorAccent,
    selectionBackground: palette.selectionBackground,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: brilhantes[0],
    brightRed: brilhantes[1],
    brightGreen: brilhantes[2],
    brightYellow: brilhantes[3],
    brightBlue: brilhantes[4],
    brightMagenta: brilhantes[5],
    brightCyan: brilhantes[6],
    brightWhite: brilhantes[7]
  };
}
