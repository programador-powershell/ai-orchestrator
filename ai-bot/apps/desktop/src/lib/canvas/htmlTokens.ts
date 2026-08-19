/**
 * Extração pura de design tokens de HTML/CSS colado (sem rede, sem DOM).
 * Funciona com qualquer fonte real: view-source, DevTools, arquivo .css.
 * Portado do AI-Orchestrator (apps/desktop/src/lib/htmlTokens.ts).
 *
 * É regex sobre TEXTO, não parser de CSS, de propósito: o que o usuário cola
 * raramente é CSS válido inteiro (vem HTML misturado, comentário cortado,
 * style inline) e um parser estrito rejeitaria justamente os casos reais.
 * Coberto por vitest (htmlTokens.test.ts).
 */

export interface TokenFrequency {
  value: string;
  count: number;
}

export interface ExtractedTokens {
  /** Cores hex/rgb(a)/hsl(a) únicas, normalizadas, por frequência desc. */
  colors: TokenFrequency[];
  /** font-family únicas na ordem em que aparecem. */
  fonts: string[];
  /** Valores px/rem (espaçamento/tamanho) por frequência desc. */
  spacing: TokenFrequency[];
}

// A alternância testa o hex MAIS LONGO primeiro: sem isso, #a1b2c3d4 casaria
// como #a1b2c3 e sobraria um "d4" órfão contado errado.
const HEX_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi;
const FUNC_COLOR_PATTERN = /\b(?:rgba?|hsla?)\(\s*[^)]*\)/gi;
const FONT_PATTERN = /font-family\s*:\s*([^;{}<>]+)/gi;
const SPACING_PATTERN = /\b(\d+(?:\.\d+)?)(px|rem)\b/g;

const CSS_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

function tally(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

/** Ordena por frequência desc; empates preservam a ordem de aparição. */
function byFrequency(map: Map<string, number>): TokenFrequency[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

function extractColors(source: string): TokenFrequency[] {
  const counts = new Map<string, number>();
  for (const [bruto] of source.matchAll(HEX_PATTERN)) {
    if (!bruto) continue;
    // minúsculas: #ABCDEF e #abcdef são a MESMA cor e têm que somar juntas.
    tally(counts, bruto.toLowerCase());
  }
  for (const [bruto] of source.matchAll(FUNC_COLOR_PATTERN)) {
    if (!bruto) continue;
    // Espaço interno fora: rgb(1, 2, 3) e rgb(1,2,3) são a mesma entrada.
    tally(counts, bruto.toLowerCase().replace(/\s+/g, ""));
  }
  return byFrequency(counts);
}

function extractFonts(source: string): string[] {
  const fonts: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(FONT_PATTERN)) {
    const declaracao = match[1];
    if (!declaracao) continue;
    for (const part of declaracao.split(",")) {
      const family = part.trim().replace(/^["']+|["']+$/g, "").trim();
      // var() e keywords de herança não são família de fonte — viram lixo na
      // lista se passarem.
      if (!family || family.includes("var(") || CSS_KEYWORDS.has(family.toLowerCase())) continue;
      const key = family.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fonts.push(family);
    }
  }
  return fonts;
}

function extractSpacing(source: string): TokenFrequency[] {
  const counts = new Map<string, number>();
  for (const match of source.matchAll(SPACING_PATTERN)) {
    const [, valor, unidade] = match;
    if (!valor || !unidade) continue;
    // 0px aparece em todo reset e não é decisão de espaçamento de ninguém.
    if (Number(valor) === 0) continue;
    tally(counts, `${valor}${unidade}`);
  }
  return byFrequency(counts);
}

/** Extrai tokens reais (cores, fontes, espaçamentos) de HTML/CSS colado. */
export function extractTokens(source: string): ExtractedTokens {
  return {
    colors: extractColors(source),
    fonts: extractFonts(source),
    spacing: extractSpacing(source)
  };
}
