import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { createIncrementalMarkdown } from "./markdownStream";

/**
 * Garantia de fluidez: o custo de renderizar uma resposta em streaming precisa
 * crescer LINEARMENTE com o tamanho dela. Re-parsear tudo a cada delta é O(n²)
 * e é o que faz a conversa travar em respostas longas.
 *
 * Estes testes comparam os dois caminhos com o MESMO texto e falham se a
 * regressão voltar.
 */

/** Resposta realista: parágrafos, listas e blocos de código. */
function longAnswer(blocks: number): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i += 1) {
    parts.push(
      `## Seção ${i}\n\nParágrafo com **negrito** e \`código\` explicando o item ${i}.\n\n` +
        `- primeiro ponto\n- segundo ponto\n\n` +
        "```ts\n" +
        `const valor${i} = ${i};\n` +
        "```"
    );
  }
  return parts.join("\n\n");
}

/** Simula o stream: o texto cresce em pedaços e re-renderiza a cada pedaço. */
function streamCost(text: string, chunkSize: number, render: (partial: string) => void): number {
  const start = performance.now();
  for (let end = chunkSize; end < text.length; end += chunkSize) {
    render(text.slice(0, end));
  }
  render(text);
  return performance.now() - start;
}

describe("custo do streaming de markdown", () => {
  it("incremental é dramaticamente mais barato que re-parsear tudo", () => {
    const text = longAnswer(40);
    const chunk = 64;

    const naive = streamCost(text, chunk, (partial) => void parseMarkdown(partial));

    const incremental = createIncrementalMarkdown();
    const smart = streamCost(text, chunk, (partial) => void incremental.parse(partial));

    // Margem folgada para não ficar instável em CI/máquina carregada: exigimos
    // apenas que o incremental seja pelo menos 3× mais barato.
    expect(smart).toBeLessThan(naive / 3);
  });

  it("escala ~linear: dobrar o texto não quadruplica o custo", () => {
    const chunk = 64;

    const small = createIncrementalMarkdown();
    const costSmall = streamCost(longAnswer(20), chunk, (p) => void small.parse(p));

    const big = createIncrementalMarkdown();
    const costBig = streamCost(longAnswer(40), chunk, (p) => void big.parse(p));

    // Comportamento quadrático daria ~4×; linear dá ~2×. Teto de 3× separa os dois
    // regimes com folga para ruído de medição.
    expect(costBig).toBeLessThan(Math.max(costSmall, 1) * 3);
  });
});
