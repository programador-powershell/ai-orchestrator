/**
 * A leitura do tool.result da tela de Dados — as partes que ganharam contrato
 * novo: índices tolerantes (o gateway VAI emitir; o de hoje não emite), o
 * prompt do "Pedir ao agente" com o schema real dentro, e o empacote do SVG
 * que sai do DOM para um arquivo que abre sozinho.
 */
import { describe, expect, it } from "vitest";
import type { ToolResult } from "@aibot/contracts";
import { empacotarSvg, promptComSchema, readSchema } from "./SchemaSurface";
import { SCHEMA_VAZIO, type SchemaSnapshot } from "../lib/schemaFoco";

const resultado = (output: unknown, tool = "schema.export", callId = "c1"): ToolResult => ({
  callId,
  tool,
  ok: true,
  output: typeof output === "string" ? output : JSON.stringify(output)
});

/* ------------------------------- índices --------------------------------- */

describe("leitura de índices do tool.result", () => {
  it("campo ausente vira lista vazia — o gateway de hoje não emite índices", () => {
    const schema = readSchema([resultado({ tables: [{ name: "users", columns: ["id"] }] })]);

    expect(schema.tables).toHaveLength(1);
    expect(schema.indexes).toEqual([]);
  });

  it("lê a lista do topo, com campos como texto ou objeto", () => {
    const schema = readSchema([
      resultado({
        tables: [{ name: "users", columns: ["id", "email"] }],
        indexes: [
          { name: "users_email_uq", table: "users", fields: ["email"], unique: true },
          { table: "users", columns: [{ name: "id" }, "email"] }
        ]
      })
    ]);

    expect(schema.indexes).toEqual([
      { name: "users_email_uq", table: "users", fields: ["email"], unique: true },
      // Sem nome declarado, a convenção idx_<tabela>_<campos> do orquestrador.
      { name: "idx_users_id_email", table: "users", fields: ["id", "email"], unique: false }
    ]);
  });

  it("lê índices agrupados dentro de cada tabela, herdando o nome dela", () => {
    const schema = readSchema([
      resultado({
        tables: [{ name: "orders", columns: ["id", "user_id"], indexes: [{ fields: ["user_id"] }] }]
      })
    ]);

    expect(schema.indexes).toEqual([{ name: "idx_orders_user_id", table: "orders", fields: ["user_id"], unique: false }]);
  });

  it("descarta entrada quebrada (sem tabela ou sem campo) sem derrubar as boas", () => {
    const schema = readSchema([
      resultado({
        tables: [{ name: "users", columns: ["id"] }],
        indexes: [{ fields: ["id"] }, { table: "users", fields: [] }, { table: "users", fields: ["id"] }]
      })
    ]);

    expect(schema.indexes).toEqual([{ name: "idx_users_id", table: "users", fields: ["id"], unique: false }]);
  });

  it("saída de texto puro (sql.render de hoje) continua enchendo só o rodapé", () => {
    const schema = readSchema([resultado("CREATE TABLE users (id uuid);", "sql.render")]);

    expect(schema.sql).toBe("CREATE TABLE users (id uuid);");
    expect(schema.tables).toEqual([]);
    expect(schema.indexes).toEqual([]);
  });
});

/* ----------------------------- pedir ao agente ---------------------------- */

describe("prompt com o schema real", () => {
  const snapshot: SchemaSnapshot = {
    ...SCHEMA_VAZIO,
    tables: [
      {
        name: "users",
        note: "",
        columns: [
          { name: "id", type: "uuid", pk: true, fk: false, required: true },
          { name: "email", type: "text", pk: false, fk: false, required: false }
        ]
      },
      {
        name: "orders",
        note: "",
        columns: [{ name: "user_id", type: "uuid", pk: false, fk: true, required: true }]
      }
    ],
    relations: [
      { id: "r1", from: "orders", fromColumn: "user_id", to: "users", toColumn: "id", fromCard: "n", toCard: "1" }
    ],
    indexes: [{ name: "users_email_uq", table: "users", fields: ["email"], unique: true }]
  };

  it("embute tabelas com PK/FK/NOT NULL, relações e índices", () => {
    const prompt = promptComSchema(snapshot, "PostgreSQL");

    expect(prompt).toContain("Schema atual (PostgreSQL): users(id uuid PK NOT NULL, email text); orders(user_id uuid FK NOT NULL)");
    expect(prompt).toContain("Relações: orders.user_id → users.id (n-1)");
    expect(prompt).toContain("Índices: users_email_uq em users(email) UNIQUE");
  });

  it("não inventa seção vazia: sem relações e sem índices, as linhas somem", () => {
    const prompt = promptComSchema({ ...snapshot, relations: [], indexes: [] }, "MySQL");

    expect(prompt).not.toContain("Relações:");
    expect(prompt).not.toContain("Índices:");
  });
});

/* ------------------------------ SVG em arquivo ---------------------------- */

describe("empacote do SVG para download", () => {
  it("injeta prólogo XML e o estilo com as cores resolvidas, preservando o desenho", () => {
    const cru = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect class="erd-table"/></svg>';
    const arquivo = empacotarSvg(cru);

    expect(arquivo.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    // Sem estilo embutido, o arquivo abriria com retângulo preto (fill padrão
    // de SVG) e texto invisível — o CSS da página não viaja junto.
    expect(arquivo).toContain("<style>");
    expect(arquivo).toContain(".erd-table{");
    expect(arquivo).toContain('<rect class="erd-table"/>');
    // O xmlns que já existia não é duplicado.
    expect(arquivo.match(/xmlns=/g)).toHaveLength(1);
  });

  it("acrescenta o xmlns quando a serialização veio sem ele (outerHTML)", () => {
    const arquivo = empacotarSvg('<svg width="10"><g/></svg>');

    expect(arquivo).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("devolve intocado o que não é um SVG — melhor um arquivo estranho que um corrompido", () => {
    expect(empacotarSvg("nada de svg")).toBe("nada de svg");
  });
});
