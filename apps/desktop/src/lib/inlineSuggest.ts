/**
 * inlineSuggest — sugestão inline sem modelo: completa o identificador que está
 * sendo digitado usando os identificadores que já existem no próprio buffer.
 */

const PREFIX_AT_CURSOR = /[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

const MIN_PREFIX = 2;

/**
 * Devolve só o trecho que falta para completar o identificador (nunca o token
 * inteiro), ou null quando não há candidato confiável.
 */
export function suggestIdentifier(text: string, cursor: number): string | null {
  if (!Number.isFinite(cursor) || cursor < 0) return null;
  const at = Math.min(Math.trunc(cursor), text.length);

  // Digitando no meio de uma palavra a sugestão atrapalharia mais do que ajuda.
  if (at < text.length && IDENTIFIER_CHAR.test(text[at])) return null;

  const prefix = PREFIX_AT_CURSOR.exec(text.slice(0, at))?.[0] ?? "";
  if (prefix.length < MIN_PREFIX) return null;

  const frequency = new Map<string, number>();
  IDENTIFIER.lastIndex = 0;
  for (let match = IDENTIFIER.exec(text); match; match = IDENTIFIER.exec(text)) {
    const token = match[0];
    if (token.length <= prefix.length || !token.startsWith(prefix)) continue;
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  if (frequency.size === 0) return null;

  let best = "";
  let bestCount = 0;
  for (const [token, count] of frequency) {
    if (!best) {
      best = token;
      bestCount = count;
      continue;
    }
    // Mais usado vence; empate escolhe o mais curto e, ainda empatado, a ordem alfabética.
    const better =
      count > bestCount ||
      (count === bestCount && token.length < best.length) ||
      (count === bestCount && token.length === best.length && token < best);
    if (better) {
      best = token;
      bestCount = count;
    }
  }
  return best.slice(prefix.length);
}
