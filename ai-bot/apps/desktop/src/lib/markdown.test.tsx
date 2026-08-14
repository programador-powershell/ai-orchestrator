/**
 * O contrato do parse incremental: `createMarkdownStream` tem de produzir a
 * MESMA árvore que `renderMarkdown` sobre o texto inteiro, em qualquer ponto do
 * caminho.
 *
 * Por que "a mesma árvore" e não "o mesmo texto renderizado": o streaming troca
 * a árvore a cada token, e diferença de CHAVE (não só de conteúdo) faz o React
 * remontar o bloco — o bloco de código perde o estado do botão "copiado", a
 * seleção do usuário some, o scroll pula. Comparar a árvore inteira, chave
 * inclusive, é o único jeito de isso não passar batido.
 *
 * A comparação usa uma projeção própria (`shape`) em vez de `toEqual` direto nos
 * elementos: elemento React carrega campos de depuração (pilha, owner) que
 * dependem de ONDE foi criado, e comparar isso reprovaria árvores idênticas.
 */

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { createMarkdownStream, lastFencedBlock, renderMarkdown } from "./markdown";

/* ------------------------------- a projeção ------------------------------- */

interface Shape {
  type: string;
  key: string | null;
  props: Record<string, unknown>;
  children: unknown;
}

/** Elemento React → objeto simples, com tipo, chave, props e filhos. */
function shape(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (!isValidElement(node)) {
    // Texto, número, null, undefined: entram como estão.
    return node ?? null;
  }
  const props = { ...(node.props as Record<string, unknown>) };
  const children = "children" in props ? props.children : undefined;
  delete props.children;
  const type = node.type;
  return {
    // Componente vira o nome; host vira a tag. Fragmento não tem nome útil.
    type: typeof type === "string" ? type : typeof type === "function" ? type.name : "fragment",
    key: node.key,
    props,
    children: children === undefined ? null : shape(children as ReactNode)
  } satisfies Shape;
}

/** Entrega o texto em fatias de `size` e devolve a árvore final do stream. */
function streamed(text: string, size: number): unknown {
  const stream = createMarkdownStream();
  let last: ReactNode = null;
  for (let at = 0; at < text.length; at += size) last = stream.push(text.slice(at, at + size));
  if (text.length === 0) last = stream.push("");
  return shape(last);
}

/**
 * O teste de verdade: em TODO prefixo do texto, o stream tem de bater com o
 * parse de uma vez só daquele prefixo. Um bug de selo costuma aparecer no meio,
 * não no fim — e no meio é justamente onde a pessoa está olhando.
 */
function expectSameAtEveryStep(text: string, size: number): void {
  const stream = createMarkdownStream();
  for (let at = 0; at < text.length; at += size) {
    const chunk = text.slice(at, at + size);
    const tree = stream.push(chunk);
    const upTo = text.slice(0, at + chunk.length);
    expect(shape(tree), `divergiu em ${at + chunk.length} de ${text.length} caracteres`).toEqual(
      shape(renderMarkdown(upTo))
    );
  }
}

/* --------------------------------- os casos ------------------------------- */

const PLAIN = "Uma resposta curta, sem nada de especial.\n\nSegundo parágrafo.";

const CLOSED_FENCE = `Segue o trecho:

\`\`\`ts
const x = 1;

const y = 2;
\`\`\`

Pronto.`;

const OPEN_FENCE = `Segue o trecho:

\`\`\`ts
const x = 1;

const y = 2;`;

const LIST = `Os passos:

- primeiro item
- segundo item com \`código\`
- terceiro

1. um
2. dois`;

const HEADING = `# Título

## Subtítulo

Texto embaixo.`;

const BOLD = "Isto é **muito importante** e isto é *ênfase* comum.";

describe("renderMarkdown", () => {
  it("não deixa markup do modelo virar HTML", () => {
    // Nenhum nó com `dangerouslySetInnerHTML`: o escape é do React, e é regra.
    const tree = JSON.stringify(shape(renderMarkdown("<script>alert(1)</script> **ok**")));
    expect(tree).not.toContain("dangerouslySetInnerHTML");
    expect(tree).toContain("<script>alert(1)</script> ");
  });

  it("acha o último bloco cercado", () => {
    expect(lastFencedBlock(CLOSED_FENCE)).toBe("const x = 1;\n\nconst y = 2;\n");
  });
});

describe("createMarkdownStream produz a mesma árvore do parse de uma vez", () => {
  const cases: [string, string][] = [
    ["texto simples", PLAIN],
    ["bloco de código fechado", CLOSED_FENCE],
    ["bloco de código ainda aberto", OPEN_FENCE],
    ["lista", LIST],
    ["título", HEADING],
    ["negrito e ênfase", BOLD]
  ];

  for (const [name, text] of cases) {
    it(`${name} — em fatias de 7`, () => {
      expect(streamed(text, 7)).toEqual(shape(renderMarkdown(text)));
    });

    it(`${name} — igual em todo prefixo, fatia de 3`, () => {
      expectSameAtEveryStep(text, 3);
    });
  }

  it("resposta completa, com os blocos se encostando", () => {
    // Os casos acima isolam construções; este cobre a EMENDA entre elas — título
    // logo depois de cerca, lista colada no parágrafo, cerca aberta no fim.
    const answer = `# Resposta

Primeiro **parágrafo** com \`código\` inline.
Segunda linha do mesmo parágrafo.

## Passos
- um
- dois

\`\`\`ts
const a = 1;

const b = 2;
\`\`\`
### Depois da cerca
1. um
2. dois

Último parágrafo, e uma cerca que ficou aberta:

\`\`\`sh
echo oi`;
    expectSameAtEveryStep(answer, 4);
  });

  it("fatia caindo no meio de um **negrito**", () => {
    // Fatia de 1 caractere: passa OBRIGATORIAMENTE por "Isto é *", "Isto é **",
    // "…**muito", que é o estado em que o negrito ainda não fechou.
    expectSameAtEveryStep(BOLD, 1);
  });

  it("fatia caindo no meio de uma cerca", () => {
    // Idem para a cerca: o caminho passa por "`", "``", "```", e por uma cerca
    // aberta contendo linha em branco — o ponto onde selar cedo partiria o bloco.
    expectSameAtEveryStep(CLOSED_FENCE, 1);
  });

  it("uma cerca aberta engole a linha em branco em vez de fechar o bloco", () => {
    const stream = createMarkdownStream();
    stream.push(OPEN_FENCE);
    const tree = JSON.stringify(shape(stream.push("")));
    // Um único CodeBlock, com as duas linhas e o vazio do meio dentro dele.
    expect(tree.split("CodeBlock").length - 1).toBe(1);
    expect(tree).toContain("const x = 1;\\n\\nconst y = 2;");
  });

  it("guarda o texto cru já entregue", () => {
    const stream = createMarkdownStream();
    stream.push("a\r\n");
    stream.push("b");
    expect(stream.text).toBe("a\r\nb");
    // CRLF partido entre dois deltas não pode virar duas quebras.
    const split = createMarkdownStream();
    split.push("a\r");
    const tree = split.push("\nb");
    expect(shape(tree)).toEqual(shape(renderMarkdown("a\r\nb")));
  });

  it("mantém a referência dos blocos já fechados", () => {
    // É disto que o React tira o ganho: elemento idêntico, subárvore pulada.
    const stream = createMarkdownStream();
    const first = stream.push("# Título\n\nparágrafo");
    const second = stream.push(" que continua");
    const firstChildren = (first as { props: { children: ReactNode[] } }).props.children;
    const secondChildren = (second as { props: { children: ReactNode[] } }).props.children;
    expect(secondChildren[0]).toBe(firstChildren[0]);
  });
});
