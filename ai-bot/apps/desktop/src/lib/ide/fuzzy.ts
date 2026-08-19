/**
 * fuzzy — pontuação difusa para o Quick Open (Ctrl+P), pura e determinística.
 * Portada da referência do orquestrador (apps/desktop/src/lib/fuzzy.ts), com a
 * mesma régua, porque a régua É o produto: quem usa os dois apps espera que
 * "cvw" encontre CodeView nos dois.
 *
 * Casamento por subsequência (greedy, sem diferenciar maiúsculas) com:
 *   +1 por caractere casado;
 *   +2 de bônus por caractere consecutivo ao anterior (sequências);
 *   +4 de bônus em limite de palavra (início, após / \ . - _ espaço,
 *      ou fronteira camelCase no texto original);
 *   −0.1 por caractere excedente do alvo (favorece caminhos curtos).
 * Sem casamento → -Infinity. Busca vazia → 0 (neutra).
 */

const LIMITES_DE_PALAVRA = new Set(["/", "\\", ".", "-", "_", " "]);

export function fuzzyScore(busca: string, alvo: string): number {
  if (!busca) return 0;
  const b = busca.toLowerCase();
  const a = alvo.toLowerCase();
  let indiceBusca = 0;
  let pontos = 0;
  let ultimoCasado = -2;
  for (let i = 0; i < a.length && indiceBusca < b.length; i += 1) {
    if (a[i] !== b[indiceBusca]) continue;
    let bonus = 1;
    if (i === ultimoCasado + 1) bonus += 2;
    const anterior = i > 0 ? alvo[i - 1] ?? "" : "";
    const atual = alvo[i] ?? "";
    const fronteiraCamel = i > 0 && anterior >= "a" && anterior <= "z" && atual >= "A" && atual <= "Z";
    if (i === 0 || LIMITES_DE_PALAVRA.has(anterior) || fronteiraCamel) bonus += 4;
    pontos += bonus;
    ultimoCasado = i;
    indiceBusca += 1;
  }
  if (indiceBusca < b.length) return -Infinity;
  return pontos - (a.length - b.length) * 0.1;
}

export interface FuzzyHit {
  path: string;
  score: number;
}

/**
 * Ordena caminhos pela pontuação (desc). Empate: caminho mais curto, depois
 * ordem alfabética. Busca vazia preserva a ordem de entrada — a lista recém-
 * aberta mostra o índice como ele é, sem rebaralhar.
 */
export function fuzzyRank(busca: string, caminhos: readonly string[], limite = 50): FuzzyHit[] {
  if (!busca.trim()) {
    return caminhos.slice(0, limite).map((path) => ({ path, score: 0 }));
  }
  const acertos: FuzzyHit[] = [];
  for (const path of caminhos) {
    const score = fuzzyScore(busca.trim(), path);
    if (score !== -Infinity) acertos.push({ path, score });
  }
  acertos.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return acertos.slice(0, limite);
}
