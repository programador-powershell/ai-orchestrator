/**
 * fuzzy — pontuação fuzzy para Quick Open (Ctrl+P), pura e determinística.
 * Casamento por subsequência (greedy, case-insensitive) com:
 *   +1 por caractere casado;
 *   +2 de bônus por caractere consecutivo ao anterior (sequências);
 *   +4 de bônus em limite de palavra (início, após / \ . - _ espaço,
 *      ou fronteira camelCase no texto original);
 *   −0.1 por caractere excedente do alvo (favorece caminhos curtos).
 * Sem casamento → -Infinity. Query vazia → 0 (neutro).
 */

const BOUNDARY_CHARS = new Set(["/", "\\", ".", "-", "_", " "]);

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] !== q[qi]) continue;
    let bonus = 1;
    if (i === lastMatch + 1) bonus += 2;
    const prevOriginal = i > 0 ? target[i - 1] : "";
    const isCamelBoundary =
      i > 0 &&
      prevOriginal >= "a" &&
      prevOriginal <= "z" &&
      target[i] >= "A" &&
      target[i] <= "Z";
    if (i === 0 || BOUNDARY_CHARS.has(prevOriginal) || isCamelBoundary) bonus += 4;
    score += bonus;
    lastMatch = i;
    qi += 1;
  }
  if (qi < q.length) return -Infinity;
  return score - (t.length - q.length) * 0.1;
}

export interface FuzzyHit {
  path: string;
  score: number;
}

/**
 * Ordena caminhos pela pontuação fuzzy (desc). Empate: caminho mais curto,
 * depois ordem alfabética. Query vazia preserva a ordem de entrada.
 */
export function fuzzyRank(query: string, paths: readonly string[], limit = 50): FuzzyHit[] {
  if (!query.trim()) {
    return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
  }
  const hits: FuzzyHit[] = [];
  for (const path of paths) {
    const score = fuzzyScore(query.trim(), path);
    if (score !== -Infinity) hits.push({ path, score });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return hits.slice(0, limit);
}
