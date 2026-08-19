/**
 * O markdown que faltava: link, tabela GFM, citação e régua — e a regra de
 * segurança que os acompanha.
 *
 * Duas famílias de teste, de propósito:
 *  - ESTRUTURA E SANITIZAÇÃO por HTML estático (`renderToStaticMarkup`): o
 *    contrato visível — link com target/_blank + rel, esquema perigoso que NÃO
 *    vira link, tabela com thead/tbody, alinhamento;
 *  - EQUIVALÊNCIA DO STREAMING por árvore, como em markdown.test.tsx: uma
 *    tabela chega linha a linha, e cada prefixo tem de renderizar IGUAL ao
 *    parse de uma vez daquele prefixo — é a invariante do parse incremental.
 */

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMarkdownStream, renderMarkdown } from "./markdown";

function html(text: string): string {
  return renderToStaticMarkup(<>{renderMarkdown(text)}</>);
}

/* ------------------------- projeção de árvore (streaming) ----------------- */

/** A mesma projeção de markdown.test.tsx: tipo, chave, props e filhos. */
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

/* --------------------------------- links ---------------------------------- */

describe("links", () => {
  it("viram <a> com target _blank e rel — a WebView não pode navegar a própria janela", () => {
    const out = html("Veja a [documentação](https://exemplo.dev/docs) antes.");
    expect(out).toContain('href="https://exemplo.dev/docs"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("documentação");
  });

  it("aceita mailto e mantém a ênfase dentro do rótulo", () => {
    const out = html("[**suporte**](mailto:ti@empresa.com)");
    expect(out).toContain('href="mailto:ti@empresa.com"');
    expect(out).toContain("<strong>suporte</strong>");
  });

  it("NÃO transforma esquema perigoso em link — fica como texto inerte", () => {
    for (const perigoso of ["[x](javascript:alert(1))", "[x](data:text/html;base64,AAAA)"]) {
      const out = html(perigoso);
      // O texto continua VISÍVEL (escapado pelo React), mas nenhum <a> nasce:
      // sem href, o esquema é só uma string na tela.
      expect(out).not.toContain("<a");
      expect(out).not.toContain("href=");
    }
  });
});

/* --------------------------------- tabela --------------------------------- */

const TABELA = ["| Nome | Valor |", "| :--- | ---: |", "| um | 1 |", "| dois | 2 |"].join("\n");

describe("tabela GFM", () => {
  it("monta thead e tbody com as células parseadas inline", () => {
    const out = html(TABELA);
    expect(out).toContain("<table");
    expect(out).toContain("<thead>");
    expect(out).toContain("<th");
    expect(out).toContain("Nome");
    expect(out).toContain("<tbody>");
    expect(out).toContain("<td");
    expect(out).toContain("dois");
  });

  it("aplica o alinhamento pedido no separador", () => {
    const out = html(TABELA);
    expect(out).toContain("text-align:right");
  });

  it("normaliza linha torta à largura do cabeçalho", () => {
    const out = html("| a | b |\n|---|---|\n| só-uma |");
    // A célula que falta vira vazia; a linha não desalinha a tabela.
    expect((out.match(/<td/g) ?? []).length).toBe(2);
  });

  it("linha com pipe SEM separador na seguinte continua parágrafo", () => {
    const out = html("| isso não é tabela |");
    expect(out).not.toContain("<table");
    expect(out).toContain("| isso não é tabela |");
  });
});

/* ---------------------------- citação e régua ----------------------------- */

describe("citação e régua", () => {
  it("blockquote agrupa as linhas contíguas e parseia o miolo", () => {
    const out = html("> primeira **forte**\n> segunda");
    expect(out).toContain("<blockquote");
    expect(out).toContain("<strong>forte</strong>");
  });

  it("citação aninhada vira blockquote dentro de blockquote", () => {
    const out = html("> fora\n> > dentro");
    expect((out.match(/<blockquote/g) ?? []).length).toBe(2);
  });

  it("--- vira <hr>, e lista com hífen continua lista", () => {
    expect(html("---")).toContain("<hr");
    expect(html("- item")).toContain("<ul");
    expect(html("- item")).not.toContain("<hr");
  });
});

/* ------------------------- invariante do streaming ------------------------ */

const RESPOSTA_COMPLETA = [
  "Comparando as opções:",
  "",
  "| Opção | Custo |",
  "| --- | ---: |",
  "| A | 10 |",
  "| B | 20 |",
  "",
  "> A opção **A** ganha por custo.",
  "",
  "---",
  "",
  "Mais detalhes em [docs](https://exemplo.dev)."
].join("\n");

describe("streaming dos blocos novos", () => {
  it("todo prefixo bate com o parse de uma vez — em fatias de 1, 3 e 7", () => {
    for (const size of [1, 3, 7]) {
      expectSameAtEveryStep(RESPOSTA_COMPLETA, size);
    }
  });
});
