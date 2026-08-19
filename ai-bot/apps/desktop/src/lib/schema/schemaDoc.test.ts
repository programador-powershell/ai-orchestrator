/**
 * As operações imutáveis do modelo editável — com atenção especial ao que
 * justifica o modelo existir: renomear PROPAGANDO a relações e índices, e
 * toda no-op devolvendo o MESMO objeto (é disso que o histórico e o
 * subscribe de publicação dependem).
 */
import { describe, expect, it } from "vitest";
import {
  adicionarIndice,
  adicionarRelacao,
  alterarCampo,
  criarCampo,
  criarTabela,
  definirReferencia,
  deSnapshot,
  docVazio,
  nomeDoIndice,
  paraSnapshot,
  removerCampo,
  removerIndice,
  removerTabela,
  renomearCampo,
  renomearTabela,
  type EsquemaEditavel
} from "./schemaDoc";
import { SCHEMA_VAZIO } from "../schemaFoco";

/** users(id PK, email) ← orders(id PK, user_id FK) com índice em orders.user_id. */
function docBase(): EsquemaEditavel {
  let doc = docVazio("postgres");
  doc = {
    ...doc,
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
        columns: [
          { name: "id", type: "uuid", pk: true, fk: false, required: true },
          { name: "user_id", type: "uuid", pk: false, fk: false, required: true }
        ]
      }
    ]
  };
  doc = adicionarRelacao(doc, { from: "orders", fromColumn: "user_id", to: "users", toColumn: "id", fromCard: "n", toCard: "1" });
  doc = adicionarIndice(doc, "orders", ["user_id"], false);
  return doc;
}

describe("renomear tabela", () => {
  it("propaga aos DOIS lados das relações e aos índices", () => {
    const doc = renomearTabela(docBase(), "users", "clientes");

    expect(doc.tables.map((t) => t.name)).toEqual(["clientes", "orders"]);
    expect(doc.relations[0]).toMatchObject({ from: "orders", to: "clientes" });

    const doc2 = renomearTabela(docBase(), "orders", "pedidos");
    expect(doc2.relations[0]).toMatchObject({ from: "pedidos", to: "users" });
    expect(doc2.indexes[0]).toMatchObject({ table: "pedidos", fields: ["user_id"] });
  });

  it("recusa nome vazio, tabela inexistente e colisão (sem caixa) — devolvendo o MESMO doc", () => {
    const base = docBase();
    expect(renomearTabela(base, "users", "  ")).toBe(base);
    expect(renomearTabela(base, "fantasma", "x")).toBe(base);
    expect(renomearTabela(base, "users", "ORDERS")).toBe(base);
  });
});

describe("renomear campo", () => {
  it("propaga às pontas das relações e aos campos dos índices", () => {
    const doc = renomearCampo(docBase(), "orders", "user_id", "cliente_id");

    expect(doc.tables[1]?.columns.map((c) => c.name)).toContain("cliente_id");
    expect(doc.relations[0]).toMatchObject({ fromColumn: "cliente_id" });
    expect(doc.indexes[0]?.fields).toEqual(["cliente_id"]);
    // O nome do índice é DERIVADO — segue o campo sozinho.
    expect(nomeDoIndice(doc.indexes[0]!)).toBe("idx_orders_cliente_id");
  });

  it("propaga quando o campo renomeado é o ALVO da relação", () => {
    const doc = renomearCampo(docBase(), "users", "id", "uid");
    expect(doc.relations[0]).toMatchObject({ toColumn: "uid" });
  });

  it("recusa colisão dentro da tabela", () => {
    const base = docBase();
    expect(renomearCampo(base, "users", "email", "ID")).toBe(base);
  });
});

describe("remover tabela e campo", () => {
  it("remover tabela leva relações e índices dela — e limpa o fk do campo de origem", () => {
    const doc = removerTabela(docBase(), "users");

    expect(doc.tables.map((t) => t.name)).toEqual(["orders"]);
    expect(doc.relations).toEqual([]);
    // orders.user_id apontava para users: sem a relação, o flag fk cai.
    expect(doc.tables[0]?.columns.find((c) => c.name === "user_id")?.fk).toBe(false);
    // O índice era de orders — fica.
    expect(doc.indexes).toHaveLength(1);
  });

  it("remover campo derruba a relação que o usava e encolhe o índice (vazio sai)", () => {
    const doc = removerCampo(docBase(), "orders", "user_id");

    expect(doc.relations).toEqual([]);
    expect(doc.indexes).toEqual([]);
  });

  it("remover o campo ALVO da relação também a derruba", () => {
    const doc = removerCampo(docBase(), "users", "id");
    expect(doc.relations).toEqual([]);
  });
});

describe("relações e referências", () => {
  it("adicionar relação marca o campo de origem como FK e dedupa pelas pontas", () => {
    const base = docBase();
    expect(base.tables[1]?.columns.find((c) => c.name === "user_id")?.fk).toBe(true);
    // A mesma relação de novo é no-op — MESMO objeto.
    expect(
      adicionarRelacao(base, { from: "orders", fromColumn: "user_id", to: "users", toColumn: "id", fromCard: "n", toCard: "1" })
    ).toBe(base);
  });

  it("definirReferencia troca o alvo removendo a relação antiga do campo", () => {
    let doc = docBase();
    doc = definirReferencia(doc, "orders", "user_id", "users.email");

    expect(doc.relations).toHaveLength(1);
    expect(doc.relations[0]).toMatchObject({ to: "users", toColumn: "email" });
  });

  it("definirReferencia com \"\" desliga a FK e limpa o flag", () => {
    const doc = definirReferencia(docBase(), "orders", "user_id", "");

    expect(doc.relations).toEqual([]);
    expect(doc.tables[1]?.columns.find((c) => c.name === "user_id")?.fk).toBe(false);
  });
});

describe("índices", () => {
  it("valida tabela e campos antes de aceitar", () => {
    const base = docBase();
    expect(adicionarIndice(base, "fantasma", ["x"], false)).toBe(base);
    expect(adicionarIndice(base, "users", ["nao_existe"], false)).toBe(base);
    expect(adicionarIndice(base, "users", [], false)).toBe(base);
  });

  it("dedupa por tabela+campos e remove pelo par exato", () => {
    const base = docBase();
    expect(adicionarIndice(base, "orders", ["user_id"], true)).toBe(base);

    const doc = removerIndice(base, "orders", ["user_id"]);
    expect(doc.indexes).toEqual([]);
    expect(removerIndice(doc, "orders", ["user_id"])).toBe(doc);
  });
});

describe("criar e alterar", () => {
  it("criarTabela nomeia tabela_N sem colidir e devolve o nome", () => {
    const { doc, nome } = criarTabela(docBase());
    expect(nome).toBe("tabela_3");
    expect(doc.tables.map((t) => t.name)).toContain("tabela_3");
    // A PK padrão vem junto — tabela sem PK nasce quebrada.
    expect(doc.tables[2]?.columns[0]).toMatchObject({ name: "id", pk: true });
  });

  it("criarCampo nomeia campo_N; alterarCampo troca tipo e flags", () => {
    let doc = criarCampo(docBase(), "users");
    expect(doc.tables[0]?.columns.map((c) => c.name)).toContain("campo_3");

    doc = alterarCampo(doc, "users", "email", { type: "varchar", required: true });
    expect(doc.tables[0]?.columns.find((c) => c.name === "email")).toMatchObject({ type: "varchar", required: true });
  });
});

describe("conversões com o snapshot", () => {
  it("deSnapshot → paraSnapshot preserva tabelas, relações e índices (nome vira convenção)", () => {
    const snapshot = {
      ...SCHEMA_VAZIO,
      tables: [{ name: "users", note: "", columns: [{ name: "id", type: "uuid", pk: true, fk: false, required: true }] }],
      relations: [],
      indexes: [{ name: "qualquer_nome", table: "users", fields: ["id"], unique: true }],
      dialect: "mysql"
    };
    const doc = deSnapshot(snapshot, "postgres");
    expect(doc.dialect).toBe("mysql");

    const volta = paraSnapshot(doc, "SQL AQUI", "mysql");
    expect(volta.tables).toEqual(snapshot.tables);
    // O nome livre do gateway vira a convenção derivada — é o preço de o
    // rename propagar sozinho.
    expect(volta.indexes[0]).toMatchObject({ name: "idx_users_id", unique: true });
    expect(volta.sql).toBe("SQL AQUI");
  });

  it("dialeto desconhecido no snapshot cai no fallback", () => {
    const doc = deSnapshot({ ...SCHEMA_VAZIO, dialect: "oracle" }, "postgres");
    expect(doc.dialect).toBe("postgres");
  });
});
