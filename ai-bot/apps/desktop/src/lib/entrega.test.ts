/**
 * O parser da entrega — o `detail` do `workspace.promote` virando lista com
 * contagens.
 *
 * O contrato que se fixa aqui: as duas grafias de linha (símbolo e palavra)
 * produzem o mesmo resultado, e linha que o cliente NÃO entende entra na lista
 * sem tipo em vez de sumir — aprovar uma entrega vendo menos caminhos do que
 * ela toca é o defeito que o cartão existe para impedir.
 */

import { describe, expect, it } from "vitest";
import { ehEntrega, parseEntrega, FERRAMENTA_DE_ENTREGA } from "./entrega";

describe("ehEntrega", () => {
  it("reconhece só a ferramenta de entrega", () => {
    expect(ehEntrega({ tool: FERRAMENTA_DE_ENTREGA })).toBe(true);
    expect(ehEntrega({ tool: "workspace.promote" })).toBe(true);
    // Qualquer outra ferramenta cai no cartão genérico de sempre.
    expect(ehEntrega({ tool: "proc.run" })).toBe(false);
    expect(ehEntrega({ tool: "fs.write" })).toBe(false);
  });
});

describe("parseEntrega", () => {
  it("lê a grafia de símbolo (+/~/-) com contagens", () => {
    const entrega = parseEntrega("+ src/App.tsx\n~ src/lib/store.ts\n- velho.txt\n+ docs/novo.md");

    expect(entrega.criados).toBe(2);
    expect(entrega.alterados).toBe(1);
    expect(entrega.apagados).toBe(1);
    expect(entrega.mudancas).toEqual([
      { tipo: "criado", caminho: "src/App.tsx" },
      { tipo: "alterado", caminho: "src/lib/store.ts" },
      { tipo: "apagado", caminho: "velho.txt" },
      { tipo: "criado", caminho: "docs/novo.md" }
    ]);
  });

  it("lê a grafia de palavra — o vocabulário do espelho do gateway incluso", () => {
    // "novo/alterado/sumido" é como o promoteStaging fala; os sinônimos
    // existem porque a redação de lá pode mudar sem avisar a daqui.
    const entrega = parseEntrega("novo: src/a.ts\nalterado: src/b.ts\nsumido: src/c.ts");

    expect(entrega.mudancas).toEqual([
      { tipo: "criado", caminho: "src/a.ts" },
      { tipo: "alterado", caminho: "src/b.ts" },
      { tipo: "apagado", caminho: "src/c.ts" }
    ]);
  });

  it("aceita palavra sem dois-pontos e com acento", () => {
    const entrega = parseEntrega("criado src/a.ts\nexcluído src/c.ts");

    expect(entrega.mudancas).toEqual([
      { tipo: "criado", caminho: "src/a.ts" },
      { tipo: "apagado", caminho: "src/c.ts" }
    ]);
  });

  it("linha que não entende ENTRA na lista, sem tipo e fora das contagens", () => {
    const entrega = parseEntrega("??? src/misterio.ts\nsrc/solto.ts");

    expect(entrega.criados + entrega.alterados + entrega.apagados).toBe(0);
    // Esconder um caminho porque o prefixo é desconhecido seria mostrar uma
    // entrega menor do que ela é.
    expect(entrega.mudancas).toEqual([
      { caminho: "??? src/misterio.ts" },
      { caminho: "src/solto.ts" }
    ]);
  });

  it("ignora linhas vazias, detail ausente e prefixo sem caminho", () => {
    expect(parseEntrega(undefined).mudancas).toEqual([]);
    expect(parseEntrega("").mudancas).toEqual([]);
    expect(parseEntrega("\n  \n+\n").mudancas).toEqual([]);
  });

  it("um caminho não vira tipo por engano", () => {
    // "src/main.ts" começa com "src", mas o separador seguinte é "/": não há
    // palavra-prefixo aqui, e a linha entra crua.
    const entrega = parseEntrega("src/main.ts");
    expect(entrega.mudancas).toEqual([{ caminho: "src/main.ts" }]);
  });

  it("o contrato real do gateway: lista capada, contagens verdadeiras no summary", () => {
    // askEntrega capa o detail em 20 caminhos e fecha com "… e mais N" — as
    // contagens inteiras viajam na frase do summary. Contar só as linhas
    // listadas diria "2 criados" sobre uma entrega de 400 arquivos.
    const summary =
      "Código quer entregar 400 arquivo(s) ao projeto: 398 criado(s), 1 alterado(s), 1 apagado(s)";
    const entrega = parseEntrega("+ src/a.ts\n+ src/b.ts\n~ src/c.ts\n- src/d.ts\n… e mais 396 arquivo(s)", summary);

    expect(entrega.criados).toBe(398);
    expect(entrega.alterados).toBe(1);
    expect(entrega.apagados).toBe(1);
    // O excedente contado NÃO some da lista: ele é a prova de que há mais do
    // que o cartão mostra.
    expect(entrega.mudancas.at(-1)).toEqual({ caminho: "… e mais 396 arquivo(s)" });
  });

  it("summary sem contagens não estraga as contadas da lista", () => {
    const entrega = parseEntrega("+ src/a.ts\n- src/b.ts", "Código quer entregar 2 arquivo(s) ao projeto");
    expect(entrega.criados).toBe(1);
    expect(entrega.apagados).toBe(1);
  });
});
