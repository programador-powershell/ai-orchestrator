/**
 * O parser de DDL com SQL de verdade — o subset declarado do orquestrador:
 * CREATE TABLE, ALTER TABLE ADD FOREIGN KEY, CREATE [UNIQUE] INDEX, nomes
 * qualificados e comentários. O que não é reconhecido é ignorado, nunca
 * derruba o import.
 */
import { describe, expect, it } from "vitest";
import { importarDdl } from "./ddl";

const DUMP_POSTGRES = `
-- schema de exemplo, como sai de um pg_dump enxuto
/* cabeçalho de bloco
   em várias linhas */
CREATE TABLE public.users (
  id uuid NOT NULL,
  email text UNIQUE,
  criado_em timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE TABLE "orders" (
  id serial,
  user_id uuid NOT NULL REFERENCES public.users (id),
  total numeric(18,2) NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_orders_total ON orders (total);
`;

describe("importarDdl — CREATE TABLE", () => {
  it("lê tabelas, colunas, tipos, PK, NOT NULL e DEFAULT de um dump real", () => {
    const doc = importarDdl(DUMP_POSTGRES);

    expect(doc.tables.map((t) => t.name)).toEqual(["users", "orders"]);
    expect(doc.dialect).toBe("postgres");

    const users = doc.tables[0]!;
    expect(users.columns.find((c) => c.name === "id")).toMatchObject({ type: "uuid", pk: true, required: true });
    expect(users.columns.find((c) => c.name === "criado_em")).toMatchObject({ defaultValue: "now()" });
    // Sem NOT NULL declarado, a coluna NÃO é obrigatória.
    expect(users.columns.find((c) => c.name === "email")?.required).toBe(false);
    // numeric(18,2) atravessa com o parêntese — vírgula de nível interno não
    // separa coluna.
    expect(doc.tables[1]?.columns.find((c) => c.name === "total")?.type).toBe("numeric(18,2)");
  });

  it("REFERENCES inline vira relação n-1 e marca o campo como FK", () => {
    const doc = importarDdl(DUMP_POSTGRES);

    expect(doc.relations).toHaveLength(1);
    expect(doc.relations[0]).toMatchObject({
      from: "orders",
      fromColumn: "user_id",
      to: "users",
      toColumn: "id",
      fromCard: "n",
      toCard: "1"
    });
    expect(doc.tables[1]?.columns.find((c) => c.name === "user_id")?.fk).toBe(true);
  });

  it("UNIQUE inline vira índice único — o modelo não tem flag unique e a informação não pode sumir", () => {
    const doc = importarDdl(DUMP_POSTGRES);

    expect(doc.indexes).toContainEqual({ table: "users", fields: ["email"], unique: true });
    expect(doc.indexes).toContainEqual({ table: "orders", fields: ["total"], unique: false });
  });
});

describe("importarDdl — ALTER TABLE e FK de bloco", () => {
  it("ALTER TABLE ADD FOREIGN KEY com nomes qualificados nos dois lados", () => {
    const doc = importarDdl(`
      CREATE TABLE a (id uuid, PRIMARY KEY (id));
      CREATE TABLE b (id uuid, a_id uuid, PRIMARY KEY (id));
      ALTER TABLE public.b ADD CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES public.a (id);
    `);

    expect(doc.relations).toHaveLength(1);
    expect(doc.relations[0]).toMatchObject({ from: "b", fromColumn: "a_id", to: "a", toColumn: "id" });
    expect(doc.tables[1]?.columns.find((c) => c.name === "a_id")?.fk).toBe(true);
  });

  it("FOREIGN KEY declarada no corpo do CREATE também vira relação", () => {
    const doc = importarDdl(`
      CREATE TABLE a (id uuid, PRIMARY KEY (id));
      CREATE TABLE b (
        id uuid,
        a_id uuid NOT NULL,
        CONSTRAINT fk_qualquer FOREIGN KEY (a_id) REFERENCES a (id)
      );
    `);

    expect(doc.relations[0]).toMatchObject({ from: "b", fromColumn: "a_id", to: "a", toColumn: "id" });
  });
});

describe("importarDdl — dialeto e resiliência", () => {
  it("crase e ENGINE=InnoDB detectam MySQL", () => {
    const doc = importarDdl("CREATE TABLE `users` (`id` INT AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB;");
    expect(doc.dialect).toBe("mysql");
    expect(doc.tables[0]?.columns[0]).toMatchObject({ name: "id", pk: true });
  });

  it("sem marca de dialeto, cai no ANSI neutro", () => {
    const doc = importarDdl('CREATE TABLE "t" (id CHAR(36), PRIMARY KEY (id));');
    expect(doc.dialect).toBe("ansi");
  });

  it("texto sem nenhum CREATE TABLE devolve doc sem tabelas — o sinal do erro amigável", () => {
    const doc = importarDdl("SELECT * FROM users;");
    expect(doc.tables).toEqual([]);
  });

  it("CREATE UNIQUE INDEX entra como índice único", () => {
    const doc = importarDdl(`
      CREATE TABLE users (id uuid, email text, PRIMARY KEY (id));
      CREATE UNIQUE INDEX ux_users_email ON users (email);
    `);
    expect(doc.indexes).toContainEqual({ table: "users", fields: ["email"], unique: true });
  });
});
