import { describe, expect, it } from "vitest";
import { renderErdSvg } from "./erdSvg";
import { applyOps, emptyDoc, type SchemaDocExt } from "./schema";

/** Doc mínimo com duas tabelas e uma FK (relação criada por references). */
function demoDoc(): SchemaDocExt {
  return applyOps(emptyDoc("Demo"), [
    {
      op: "add_table",
      name: "users",
      fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "email", type: "text" }
      ]
    },
    {
      op: "add_table",
      name: "posts",
      fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "user_id", type: "uuid", references: { table: "users", field: "id" } }
      ]
    }
  ]);
}

describe("renderErdSvg", () => {
  it("produz um SVG com um <rect> por tabela e o nome de cada tabela em <text>", () => {
    const svg = renderErdSvg(demoDoc());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
    expect(svg).toContain(">users</text>");
    expect(svg).toContain(">posts</text>");
  });

  it("desenha uma linha entre tabelas para cada relação/FK", () => {
    const svg = renderErdSvg(demoDoc());
    expect(svg).toContain("<line");
  });

  it("lista os campos de cada tabela", () => {
    const svg = renderErdSvg(demoDoc());
    expect(svg).toContain(">email</text>");
    expect(svg).toContain(">user_id</text>");
  });

  it("documento vazio ainda produz um <svg> válido sem tabelas nem linhas", () => {
    const svg = renderErdSvg(emptyDoc("Vazio"));
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect((svg.match(/<rect/g) ?? []).length).toBe(0);
    expect(svg).not.toContain("<line");
  });

  it("escapa caracteres XML no nome da tabela", () => {
    const doc: SchemaDocExt = {
      name: "X",
      dialect: "postgres",
      tables: [{ id: "t", name: "a&b", x: 0, y: 0, tone: "cyan", fields: [{ name: "id", type: "uuid" }] }],
      relations: []
    };
    const svg = renderErdSvg(doc);
    expect(svg).toContain("a&amp;b");
    expect(svg).not.toContain("a&b");
  });
});

describe("layout do usuário", () => {
  /** Posições REAIS: o export tem de sair igual ao que foi desenhado. */
  function movedDoc(): SchemaDocExt {
    const doc = demoDoc();
    return {
      ...doc,
      tables: doc.tables.map((table, index) =>
        index === 0 ? { ...table, x: 500, y: 300 } : { ...table, x: 900, y: 700 }
      )
    };
  }

  it("usa table.x/table.y em vez da grade própria", () => {
    const svg = renderErdSvg(movedDoc());
    // primeira tabela em (500,300) vira (24,24) após normalizar pela origem
    expect(svg).toContain('<rect x="24" y="24"');
    // a segunda mantém a distância relativa: 900-500=400, 700-300=400
    expect(svg).toContain('<rect x="424" y="424"');
  });

  it("normaliza coordenadas negativas para dentro do viewBox", () => {
    const doc = movedDoc();
    const negativo = { ...doc, tables: doc.tables.map((t) => ({ ...t, x: t.x - 2000, y: t.y - 2000 })) };
    const svg = renderErdSvg(negativo);
    expect(svg).not.toMatch(/<rect x="-/);
    expect(svg).toContain('<rect x="24" y="24"');
  });

  it("o viewBox cobre a extensão real do desenho", () => {
    const svg = renderErdSvg(movedDoc());
    const match = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(match).toBeTruthy();
    // a tabela mais à direita começa em 424 e tem a largura do card
    expect(Number(match![1])).toBeGreaterThan(424);
    expect(Number(match![2])).toBeGreaterThan(424);
  });

  it("documento nunca desenhado (tudo em 0,0) cai na grade determinística", () => {
    const svg = renderErdSvg(demoDoc());
    // a grade põe a primeira em MARGIN e a segunda na coluna seguinte
    expect(svg).toContain('<rect x="24" y="24"');
    expect(svg).toMatch(/<rect x="\d+" y="24"/);
  });

  it("a largura do card acompanha a geometria do canvas", () => {
    const svg = renderErdSvg(movedDoc());
    expect(svg).toContain('width="190"');
  });
});
