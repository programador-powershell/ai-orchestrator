/**
 * Extração pura de design tokens de HTML/CSS colado (sem rede, sem DOM).
 * Funciona com qualquer fonte real: view-source, DevTools, arquivo .css.
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
  for (const match of source.matchAll(HEX_PATTERN)) {
    tally(counts, match[0].toLowerCase());
  }
  for (const match of source.matchAll(FUNC_COLOR_PATTERN)) {
    tally(counts, match[0].toLowerCase().replace(/\s+/g, ""));
  }
  return byFrequency(counts);
}

function extractFonts(source: string): string[] {
  const fonts: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(FONT_PATTERN)) {
    for (const part of match[1].split(",")) {
      const family = part.trim().replace(/^["']+|["']+$/g, "").trim();
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
    if (Number(match[1]) === 0) continue;
    tally(counts, `${match[1]}${match[2]}`);
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
