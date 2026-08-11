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
