/**
 * ANSI → trechos com estilo. O que transforma um log num TERMINAL.
 *
 * O PTY entrega bytes com sequências de escape: `git status` pinta o nome do
 * arquivo, `npm` pinta o aviso, `cargo` pinta o erro. Sem interpretar isso, a
 * tela mostra `ESC[31merro` — ou, pior, mostra tudo na mesma cor, e o programa
 * que caprichou na saída fica indistinguível do que não caprichou.
 *
 * ## O que este módulo faz e o que não faz
 *
 * FAZ: `SGR` (cor e atributo de texto), as três paletas — 16 cores, cubo de
 * 256 e cor verdadeira —, `\r` sobrescrevendo a linha e `\b` apagando para
 * trás. Também DESCARTA em silêncio o que não sabe desenhar (mover cursor,
 * limpar tela, título da janela), em vez de deixar o lixo aparecer na tela.
 *
 * NÃO FAZ: emulação de tela. `vim` e `htop` desenham posicionando o cursor
 * numa grade, e isso é outro programa — um emulador de verdade. O que sai
 * daqui cobre o comando de linha, que é o uso do dia.
 *
 * ## Por que o estilo ATRAVESSA a chamada
 *
 * O PTY corta a saída em blocos de tamanho arbitrário, e a sequência que abre
 * a cor pode cair num bloco e o texto colorido no seguinte. Por isso
 * `parseAnsi` recebe e devolve o estilo corrente, e devolve também o pedaço
 * de sequência que ficou pela metade: sem os dois, a cor se perdia justamente
 * nas saídas longas, que são as que mais precisam dela.
 */

/** O byte que abre toda sequência (0x1B). Nomeado para não virar invisível. */
const ESC = "\u001b";
/** O byte que encerra a sequência OSC nos terminais mais antigos (0x07). */
const BEL = "\u0007";

export interface AnsiStyle {
  /** Cor do texto, já resolvida em `var(--ansi-N)` ou `#rrggbb`. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Vídeo reverso — trocar frente e fundo é do CSS, não daqui. */
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

export interface AnsiResult {
  spans: AnsiSpan[];
  /** Estilo aberto no fim — passe de volta no próximo bloco do stream. */
  final: AnsiStyle;
  /** Sequência cortada no fim do bloco — prefixe no próximo. */
  pendente: string;
}

const VAZIO: AnsiStyle = {};

/**
 * As 16 cores viram token, não valor.
 *
 * O terminal precisa de paleta PRÓPRIA (a cor 1 é "vermelho do terminal", não
 * a cor de erro do app) e, ao mesmo tempo, precisa acompanhar claro⇄escuro.
 * Devolver `var(--ansi-1)` resolve os dois: quem escolhe o vermelho é a folha
 * de estilo, e trocar de tema não passa por aqui.
 */
const BASE = (indice: number) => `var(--ansi-${indice})`;

/** Componente do cubo 6×6×6 do xterm — os passos não são lineares. */
const NIVEIS = [0, 95, 135, 175, 215, 255];

function rgb(r: number, g: number, b: number): string {
  const hex = (valor: number) => Math.max(0, Math.min(255, Math.round(valor))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Cor do cubo de 256: 0-15 base, 16-231 cubo, 232-255 cinzas. */
export function cor256(indice: number): string {
  if (!Number.isFinite(indice) || indice < 0 || indice > 255) return BASE(7);
  if (indice < 16) return BASE(indice);
  if (indice >= 232) {
    const cinza = 8 + (indice - 232) * 10;
    return rgb(cinza, cinza, cinza);
  }
  const n = indice - 16;
  return rgb(NIVEIS[Math.floor(n / 36) % 6], NIVEIS[Math.floor(n / 6) % 6], NIVEIS[n % 6]);
}

/**
 * Aplica um comando SGR sobre o estilo corrente.
 *
 * Devolve o índice do último parâmetro consumido: `38;5;n` e `38;2;r;g;b`
 * comem os seguintes, e tratá-los como comandos soltos pintava a saída com as
 * cores dos próprios números.
 */
function aplicarSgr(style: AnsiStyle, params: number[], i: number): number {
  const codigo = params[i];
  switch (codigo) {
    case 0:
      for (const chave of Object.keys(style)) delete style[chave as keyof AnsiStyle];
      return i;
    case 1: style.bold = true; return i;
    case 2: style.dim = true; return i;
    case 3: style.italic = true; return i;
    case 4: style.underline = true; return i;
    case 7: style.inverse = true; return i;
    case 9: style.strike = true; return i;
    // 21 é "sublinhado duplo" em alguns terminais e "sem negrito" em outros;
    // na prática o uso comum é desligar o negrito.
    // Desligar APAGA a chave em vez de gravar `false`: o estilo é copiado em
    // cada trecho, e chave morta é peso a mais em toda linha do scrollback.
    case 21:
    case 22: delete style.bold; delete style.dim; return i;
    case 23: delete style.italic; return i;
    case 24: delete style.underline; return i;
    case 27: delete style.inverse; return i;
    case 29: delete style.strike; return i;
    case 39: delete style.fg; return i;
    case 49: delete style.bg; return i;
    default:
      break;
  }
  if (codigo >= 30 && codigo <= 37) {
    style.fg = BASE(codigo - 30);
    return i;
  }
  if (codigo >= 40 && codigo <= 47) {
    style.bg = BASE(codigo - 40);
    return i;
  }
  // 90-97 e 100-107 são as versões "brilhantes", que ocupam 8-15 da paleta.
  if (codigo >= 90 && codigo <= 97) {
    style.fg = BASE(codigo - 90 + 8);
    return i;
  }
  if (codigo >= 100 && codigo <= 107) {
    style.bg = BASE(codigo - 100 + 8);
    return i;
  }
  if (codigo === 38 || codigo === 48) {
    const alvo = codigo === 38 ? "fg" : "bg";
    if (params[i + 1] === 5) {
      style[alvo] = cor256(params[i + 2] ?? 7);
      return i + 2;
    }
    if (params[i + 1] === 2) {
      style[alvo] = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
      return i + 4;
    }
  }
  return i;
}

/** Cópia rasa — o estilo é gravado em cada trecho e não pode ser o mesmo objeto. */
function clonar(style: AnsiStyle): AnsiStyle {
  return { ...style };
}

/** Dois estilos pintam igual? Serve para não quebrar o texto à toa. */
export function mesmoEstilo(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse &&
    !!a.strike === !!b.strike
  );
}

/**
 * Quebra o texto em trechos com estilo, descartando o que não sabe desenhar.
 *
 * `inicial` é o estilo que sobrou do bloco anterior (ver o topo do arquivo).
 */
export function parseAnsi(text: string, inicial: AnsiStyle = VAZIO): AnsiResult {
  const spans: AnsiSpan[] = [];
  const style = clonar(inicial);
  let buffer = "";

  const fechar = () => {
    if (!buffer) return;
    const ultimo = spans[spans.length - 1];
    // Junta com o anterior quando o estilo não mudou: um `<span>` por
    // caractere seria a forma mais cara possível de escrever a mesma coisa.
    if (ultimo && mesmoEstilo(ultimo.style, style)) ultimo.text += buffer;
    else spans.push({ text: buffer, style: clonar(style) });
    buffer = "";
  };

  const cortado = (indice: number): AnsiResult => {
    fechar();
    return { spans, final: style, pendente: text.slice(indice) };
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch !== ESC) {
      buffer += ch;
      continue;
    }

    const proximo = text[i + 1];

    /*
     * Sequência cortada no fim do bloco vira PENDENTE, não lixo.
     * Sem isso, `ESC[3` no fim de um bloco e `1m` no começo do seguinte
     * apareciam na tela como o texto "1m".
     */
    if (proximo === undefined) return cortado(i);

    // CSI — `ESC [ params letra`. Só o SGR (`m`) desenha; o resto é descarte.
    if (proximo === "[") {
      let j = i + 2;
      while (j < text.length && /[0-9;:?]/.test(text[j])) j += 1;
      if (j >= text.length) return cortado(i);
      if (text[j] === "m") {
        fechar();
        const bruto = text.slice(i + 2, j);
        // `ESC[m` sem número é o mesmo que `ESC[0m`.
        const params = bruto === "" ? [0] : bruto.split(/[;:]/).map((parte) => Number(parte) || 0);
        for (let k = 0; k < params.length; k += 1) k = aplicarSgr(style, params, k);
      }
      i = j;
      continue;
    }

    // OSC — `ESC ] ... BEL` ou `ESC ] ... ESC \`. É título de janela e afins.
    if (proximo === "]") {
      let j = i + 2;
      while (j < text.length && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === "\\")) j += 1;
      if (j >= text.length) return cortado(i);
      i = text[j] === ESC ? j + 1 : j;
      continue;
    }

    /*
     * Escape curto. `ESC ( B` (designação de conjunto de caracteres) tem
     * TRÊS bytes, e os `( ) * +` são os únicos assim; `ESC =` e companhia têm
     * dois. Tratando todos como dois, o `B` do `ESC(B` — que todo shell
     * emite ao iniciar — aparecia escrito na tela.
     */
    i += "()*+".includes(proximo) ? 2 : 1;
  }

  fechar();
  return { spans, final: style, pendente: "" };
}

/**
 * Resolve `\r` e `\b` dentro de uma linha.
 *
 * Barra de progresso reescreve a MESMA linha com `\r`: sem isto, um download
 * vira sessenta linhas de lixo no scrollback. Roda antes do `parseAnsi`
 * porque mexe em posição de caractere, não em estilo.
 */
export function aplicarRetornos(linha: string): string {
  /*
   * As células são um ARRAY de code points, não uma string indexada.
   *
   * A versão anterior iterava por code point (`for…of`) e escrevia com
   * `saida.slice(0, coluna) + ch + saida.slice(coluna + 1)`, que indexa por
   * unidade UTF-16. Um emoji ocupa duas unidades e uma coluna: os dois
   * contadores saíam de sincronia no primeiro caractere fora do BMP, e a
   * escrita seguinte cortava o par substituto ao meio — o resto da linha
   * virava lixo, com um substituto solto no meio. É saída comum: `git` com
   * emoji no commit, `npm` com ✨, qualquer script que decore o progresso.
   */
  const celulas: string[] = [];
  let coluna = 0;
  for (const ch of linha) {
    if (ch === "\r") {
      coluna = 0;
      continue;
    }
    if (ch === "\b") {
      coluna = Math.max(0, coluna - 1);
      continue;
    }
    // Sobrescreve a coluna, ou preenche o buraco se o cursor pulou à frente.
    while (celulas.length < coluna) celulas.push(" ");
    celulas[coluna] = ch;
    coluna += 1;
  }
  return celulas.join("");
}

/** Texto limpo, sem nenhum escape — para copiar, buscar e gravar em log. */
export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .spans.map((span) => span.text)
    .join("");
}
