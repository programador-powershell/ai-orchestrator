/**
 * Parse incremental de markdown para streaming.
 *
 * O problema: re-parsear a resposta inteira a cada token é O(n²) — visível já
 * em ~2k tokens. A solução (mesma ideia do streamdown): o texto que chegou é
 * dividido num PREFIXO ESTÁVEL (blocos já fechados, que não mudam mais) e numa
 * CAUDA (o bloco que ainda está sendo escrito). Só a cauda é re-parseada; os
 * blocos do prefixo ficam em cache e são reaproveitados a cada delta.
 */
import { parseMarkdown, type BlockToken } from "./markdown";

/**
 * Último ponto do texto a partir do qual tudo é "bloco fechado".
 *
 * Um bloco fecha numa linha em branco (\n\n). A cauda depois do último \n\n
 * ainda pode mudar de forma com o próximo token (ex.: `- --` vira lista, uma
 * cerca ``` ainda pode abrir/fechar), então nunca entra no prefixo estável.
 *
 * Cercas de código são a exceção: enquanto houver um número ÍMPAR de ``` no
 * texto, o bloco de código está aberto e engole linhas em branco — o prefixo
 * estável precisa parar antes da cerca aberta.
 */
export function stableBoundary(source: string): number {
  const fenceCount = (source.match(/^```/gm) ?? []).length;
  const searchLimit =
    fenceCount % 2 === 1 ? source.lastIndexOf("\n```") + 1 || source.indexOf("```") : source.length;
  const slice = source.slice(0, Math.max(0, searchLimit));
  const lastBreak = slice.lastIndexOf("\n\n");
  return lastBreak < 0 ? 0 : lastBreak + 2;
}

export interface IncrementalMarkdown {
  /** Blocos do texto completo, reusando o prefixo já parseado. */
  parse: (source: string) => BlockToken[];
}

/**
 * Cria um parser com memória de prefixo. Uma instância por mensagem em
 * streaming (o cache só é válido enquanto o texto CRESCE no mesmo prefixo).
 */
export function createIncrementalMarkdown(): IncrementalMarkdown {
  let cachedPrefix = "";
  let cachedBlocks: BlockToken[] = [];

  return {
    parse(source: string): BlockToken[] {
      // Texto encolheu ou trocou (nova mensagem/regenerar): invalida o cache.
      if (!source.startsWith(cachedPrefix)) {
        cachedPrefix = "";
        cachedBlocks = [];
      }
      const boundary = stableBoundary(source);
      if (boundary > cachedPrefix.length) {
        cachedPrefix = source.slice(0, boundary);
        cachedBlocks = parseMarkdown(cachedPrefix);
      }
      const tail = source.slice(cachedPrefix.length);
      if (!tail.trim()) return cachedBlocks;
      return [...cachedBlocks, ...parseMarkdown(tail)];
    }
  };
}
