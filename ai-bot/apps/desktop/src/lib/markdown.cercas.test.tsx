/**
 * As CERCAS DE PROTOCOLO nunca chegam à tela como texto cru.
 *
 * O gateway tira `aibot:tool`/`aibot:delegate` das mensagens DURÁVEIS
 * (stripBlocks em delegate.go), mas os DELTAS streamam o texto do modelo
 * cru — cerca inclusa. Dois buracos reais que estes testes fecham:
 *
 *  - o modelo só chamou ferramenta (`visible == ""`): nenhuma mensagem final
 *    vem substituir o acumulado, e a bolha ficava para sempre com o JSON do
 *    protocolo desenhado como bloco de código;
 *  - a janela da FILHA durante o sub-turno delegado vê os mesmos deltas crus.
 *
 * O filtro é do RENDERER (parseBlocks pula a cerca) porque é o único ponto
 * por onde toda bolha passa — raiz e filha, vivo e replay. `aibot:plan` fica
 * VISÍVEL de propósito: é o que a pessoa lê para aprovar o plano, espelhando
 * exatamente o stripBlocks do gateway.
 */

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import {
  createMarkdownStream,
  ehCercaDeProtocolo,
  lastFencedBlock,
  renderMarkdown,
  semCercasDeProtocolo
} from "./markdown";

/* A mesma projeção do markdown.test: elemento → objeto simples comparável. */
function shape(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (!isValidElement(node)) return node ?? null;
  const props = { ...(node.props as Record<string, unknown>) };
  const children = "children" in props ? props.children : undefined;
  delete props.children;
  const type = node.type;
  return {
    type: typeof type === "string" ? type : typeof type === "function" ? type.name : "fragment",
    key: node.key,
    props,
    children: children === undefined ? null : shape(children as ReactNode)
  };
}

function texto(node: ReactNode): string {
  return JSON.stringify(shape(node));
}

const CERCA_DE_FERRAMENTA =
  '```aibot:tool\n{"tool":"fs.write","args":{"path":"index.html","content":"<!doctype html>"}}\n```';

const RESPOSTA_COM_FERRAMENTA = `Vou gravar a estrutura agora.\n\n${CERCA_DE_FERRAMENTA}\n\nJá aviso quando terminar.`;

const RESPOSTA_COM_DELEGACAO =
  'Chamando o design.\n\n```aibot:delegate\n{"specialist":"design","goal":"tokens do index.html"}\n```';

const RESPOSTA_COM_PLANO = "O plano:\n\n```aibot:plan\n1. criar index.html\n2. extrair tokens\n```";

describe("renderMarkdown esconde as cercas de protocolo", () => {
  it("aibot:tool fechada não vira bloco de código — o texto em volta fica", () => {
    const arvore = texto(renderMarkdown(RESPOSTA_COM_FERRAMENTA));
    expect(arvore).not.toContain("aibot:tool");
    expect(arvore).not.toContain("fs.write");
    expect(arvore).toContain("Vou gravar a estrutura agora.");
    expect(arvore).toContain("Já aviso quando terminar.");
  });

  it("aibot:delegate fechada também é máquina, não fala", () => {
    const arvore = texto(renderMarkdown(RESPOSTA_COM_DELEGACAO));
    expect(arvore).not.toContain("aibot:delegate");
    expect(arvore).not.toContain("specialist");
    expect(arvore).toContain("Chamando o design.");
  });

  it("cerca ABERTA no fim (streaming no meio do JSON) já fica escondida", () => {
    // O caso da bolha ao vivo: o delta parou no meio da cerca — mostrar meio
    // JSON de protocolo é tão cru quanto mostrar o JSON inteiro.
    const parcial = 'Gravando.\n\n```aibot:tool\n{"tool":"fs.write","args":{"path":"index';
    const arvore = texto(renderMarkdown(parcial));
    expect(arvore).not.toContain("aibot:tool");
    expect(arvore).not.toContain("fs.write");
    expect(arvore).toContain("Gravando.");
  });

  it("aibot:plan continua VISÍVEL — é o que a pessoa lê para aprovar", () => {
    const arvore = texto(renderMarkdown(RESPOSTA_COM_PLANO));
    expect(arvore).toContain("criar index.html");
  });

  it("cerca comum de código continua renderizando como sempre", () => {
    const arvore = texto(renderMarkdown("Trecho:\n\n```ts\nconst x = 1;\n```"));
    expect(arvore).toContain("const x = 1;");
    expect(arvore).toContain("CodeBlock");
  });
});

describe("o parse incremental mantém o filtro e a invariante das chaves", () => {
  it("streaming da cerca em fatias produz a MESMA árvore do parse de uma vez", () => {
    // A invariante do selo (nó empurrado e chave andam juntos) vale com o
    // pulo da cerca: divergência de chave remontaria blocos a cada token.
    const stream = createMarkdownStream();
    for (let at = 0; at < RESPOSTA_COM_FERRAMENTA.length; at += 5) {
      const tree = stream.push(RESPOSTA_COM_FERRAMENTA.slice(at, at + 5));
      const upTo = RESPOSTA_COM_FERRAMENTA.slice(0, at + 5);
      expect(shape(tree), `divergiu com ${at + 5} caracteres`).toEqual(
        shape(renderMarkdown(upTo))
      );
    }
    expect(texto(stream.push(""))).not.toContain("aibot:tool");
  });
});

describe("semCercasDeProtocolo (o espelho textual do composer cli)", () => {
  it("tira as cercas de protocolo, fechadas e aberta no fim", () => {
    expect(semCercasDeProtocolo(RESPOSTA_COM_FERRAMENTA)).toBe(
      "Vou gravar a estrutura agora.\n\n\nJá aviso quando terminar."
    );
    expect(semCercasDeProtocolo('Oi.\n\n```aibot:tool\n{"tool":"proc.run"')).toBe("Oi.\n");
  });

  it("preserva cerca comum e o aibot:plan", () => {
    const comum = "A:\n\n```js\n1\n```\n\nB";
    expect(semCercasDeProtocolo(comum)).toBe(comum);
    expect(semCercasDeProtocolo(RESPOSTA_COM_PLANO)).toBe(RESPOSTA_COM_PLANO);
  });
});

describe("lastFencedBlock ignora protocolo", () => {
  it("a última cerca REAL vence; a de máquina não vira sugestão aplicável", () => {
    const resposta = `Sugestão:\n\n\`\`\`html\n<main></main>\n\`\`\`\n\n${CERCA_DE_FERRAMENTA}\n`;
    expect(lastFencedBlock(resposta)).toBe("<main></main>\n");
    // Só protocolo → não há sugestão nenhuma a aplicar.
    expect(lastFencedBlock(`${CERCA_DE_FERRAMENTA}\n`)).toBe("");
  });
});

describe("ehCercaDeProtocolo", () => {
  it("reconhece só tool e delegate — e na caixa exata do gateway", () => {
    expect(ehCercaDeProtocolo("aibot:tool")).toBe(true);
    expect(ehCercaDeProtocolo(" aibot:delegate ")).toBe(true);
    // Grafada errado o gateway nem executa nem limpa: esconder aqui mascararia
    // o erro do modelo que a pessoa precisa ver.
    expect(ehCercaDeProtocolo("AIBOT:TOOL")).toBe(false);
    expect(ehCercaDeProtocolo("aibot:plan")).toBe(false);
    expect(ehCercaDeProtocolo("ts")).toBe(false);
    expect(ehCercaDeProtocolo("")).toBe(false);
  });
});
