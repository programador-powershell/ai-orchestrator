/**
 * Parse incremental de markdown para streaming.
 *
 * O problema: re-parsear a resposta inteira a cada token é O(n²) — visível já
 * em ~2k tokens. A solução: manter um PREFIXO ESTÁVEL (blocos já fechados) que
 * é parseado UMA vez cada, e re-parsear apenas a CAUDA (o bloco em construção).
 *
 * Detalhe que faz a diferença: a varredura também é incremental. Cada caractere
 * do stream é inspecionado uma única vez na vida — nada de reescanear o texto
 * inteiro em busca de cercas de código ou linhas em branco a cada delta.
 */
import { parseMarkdown, type BlockToken } from "./markdown";

export interface IncrementalMarkdown {
  /** Blocos do texto completo, reusando os blocos já fechados. */
  parse: (source: string) => BlockToken[];
}

/**
 * Cria um parser com memória. Uma instância por mensagem em streaming — o
 * cache só vale enquanto o texto CRESCE sobre o mesmo prefixo; se o texto for
 * substituído (regenerar, trocar de conversa), tudo é recalculado.
 */
export function createIncrementalMarkdown(): IncrementalMarkdown {
  /** Fim do trecho já parseado e congelado em `blocks`. */
  let stableEnd = 0;
  /** Até onde o texto já foi varrido (nunca varremos duas vezes). */
  let scanned = 0;
  /** Estamos dentro de uma cerca ``` aberta? */
  let openFence = false;
  /** Texto da chamada anterior — detecta troca de conteúdo. */
  let previous = "";
  let blocks: BlockToken[] = [];

  function reset() {
    stableEnd = 0;
    scanned = 0;
    openFence = false;
    blocks = [];
  }

  return {
    parse(source: string): BlockToken[] {
      if (!source.startsWith(previous)) reset();
      previous = source;

      // Varre APENAS o que chegou desde a última vez, linha a linha completa.
      // Uma linha em branco fora de cerca fecha um bloco: dali para trás o
      // conteúdo não muda mais, mesmo que cheguem mais tokens.
      let candidate = stableEnd;
      let cursor = scanned;
      for (;;) {
        const newline = source.indexOf("\n", cursor);
        if (newline < 0) break; // linha ainda incompleta: espera mais tokens
        const line = source.slice(cursor, newline);
        if (line.startsWith("```")) openFence = !openFence;
        else if (!openFence && line.trim() === "") candidate = newline + 1;
        cursor = newline + 1;
      }
      scanned = cursor;

      // Congela os blocos recém-fechados: cada trecho é parseado UMA vez.
      if (candidate > stableEnd) {
        const segment = source.slice(stableEnd, candidate);
        if (segment.trim()) blocks = [...blocks, ...parseMarkdown(segment)];
        stableEnd = candidate;
      }

      const tail = source.slice(stableEnd);
      if (!tail.trim()) return blocks;
      return [...blocks, ...parseMarkdown(tail)];
    }
  };
}
