/**
 * O diff de migração por snapshot: up e down coerentes (o down é o diff no
 * sentido oposto), por dialeto, na ordem estável do orquestrador.
 */
import { describe, expect, it } from "vitest";
import { importarDdl } from "./ddl";
import { diffEsquemas, diffEsquemasDown } from "./migration";
import { adicionarIndice, alterarCampo, criarCampo, definirReferencia, removerTabela, renomearCampo } from "./schemaDoc";

/** Base via parser — o mesmo caminho que um schema importado percorre. */
function base() {
  return importarDdl(`
    CREATE TABLE users (id uuid NOT NULL, email text, PRIMARY KEY (id));
    CREATE TABLE orders (id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (id));
    ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users (id);
  `);
}

describe("diffEsquemas — up e down coerentes", () => {
  it("campo novo: up ADD COLUMN, down DROP COLUMN", () => {
    const prev = base();
    const next = criarCampo(prev, "users");

    const up = diffEsquemas(prev, next, "postgres");
    expect(up).toEqual(['ALTER TABLE "users" ADD COLUMN "campo_3" text;']);

    const down = diffEsquemasDown(prev, next, "postgres");
    expect(down).toEqual(['ALTER TABLE "users" DROP COLUMN "campo_3";']);
  });

  it("tabela nova: up CREATE TABLE completo, down DROP TABLE", () => {
    const prev = base();
    const next = importarDdl(`
      CREATE TABLE users (id uuid NOT NULL, email text, PRIMARY KEY (id));
      CREATE TABLE orders (id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (id));
      CREATE TABLE items (id uuid NOT NULL, criado_em timestamptz DEFAULT now(), PRIMARY KEY (id));
      ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users (id);
    `);

    const up = diffEsquemas(prev, next, "postgres");
    expect(up).toHaveLength(1);
    expect(up[0]).toContain('CREATE TABLE "items"');
    expect(up[0]).toContain('"criado_em" timestamptz DEFAULT now()');
    expect(up[0]).toContain('PRIMARY KEY ("id")');

    expect(diffEsquemasDown(prev, next, "postgres")).toEqual(['DROP TABLE "items";']);
  });

  it("tabela removida leva as FKs junto no DROP TABLE — sem DROP CONSTRAINT redundante", () => {
    const prev = base();
    const next = removerTabela(prev, "orders");

    const up = diffEsquemas(prev, next, "postgres");
    expect(up).toEqual(['DROP TABLE "orders";']);
  });

  it("FK nova: ADD CONSTRAINT no up, DROP CONSTRAINT no down (DROP FOREIGN KEY em MySQL)", () => {
    const prev = base();
    const next = definirReferencia(criarCampo(prev, "orders"), "orders", "campo_3", "users.email");

    const up = diffEsquemas(prev, next, "postgres");
    expect(up).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_campo_3" FOREIGN KEY ("campo_3") REFERENCES "users" ("email");'
    );

    const down = diffEsquemasDown(prev, next, "postgres");
    expect(down).toContain('ALTER TABLE "orders" DROP CONSTRAINT "fk_orders_campo_3";');
    expect(diffEsquemasDown(prev, next, "mysql")).toContain(
      "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_campo_3`;"
    );
  });

  it("índice novo: CREATE INDEX com o nome derivado; down DROP INDEX (com ON em MySQL)", () => {
    const prev = base();
    const next = adicionarIndice(prev, "users", ["email"], true);

    expect(diffEsquemas(prev, next, "postgres")).toEqual([
      'CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email");'
    ]);
    expect(diffEsquemasDown(prev, next, "postgres")).toEqual(['DROP INDEX "idx_users_email";']);
    expect(diffEsquemasDown(prev, next, "mysql")).toEqual(["DROP INDEX `idx_users_email` ON `users`;"]);
  });

  it("troca de tipo: MODIFY em MySQL, ALTER COLUMN TYPE em Postgres, SET DATA TYPE no resto", () => {
    const prev = base();
    const next = alterarCampo(prev, "users", "email", { type: "varchar" });

    expect(diffEsquemas(prev, next, "mysql")).toEqual(["ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(255);"]);
    expect(diffEsquemas(prev, next, "postgres")).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar(255);'
    ]);
    expect(diffEsquemas(prev, next, "mssql")).toEqual([
      "ALTER TABLE [users] ALTER COLUMN [email] SET DATA TYPE NVARCHAR(255);"
    ]);
  });

  it("rename sai como DROP + ADD (limitação declarada: o diff compara por nome)", () => {
    const prev = base();
    const next = renomearCampo(prev, "users", "email", "correio");

    const up = diffEsquemas(prev, next, "postgres");
    expect(up).toContain('ALTER TABLE "users" ADD COLUMN "correio" text;');
    expect(up).toContain('ALTER TABLE "users" DROP COLUMN "email";');
  });

  it("sem diferença, nenhum statement — é o número do status 'N mudanças vs snapshot'", () => {
    const prev = base();
    expect(diffEsquemas(prev, prev, "postgres")).toEqual([]);
  });

  it("tipos são mapeados por dialeto no ADD COLUMN (uuid → CHAR(36) no ANSI)", () => {
    const prev = base();
    const next = alterarCampo(criarCampo(prev, "users"), "users", "campo_3", { type: "uuid", required: true });

    expect(diffEsquemas(prev, next, "ansi")).toEqual(['ALTER TABLE "users" ADD COLUMN "campo_3" CHAR(36) NOT NULL;']);
    expect(diffEsquemas(prev, next, "sqlite")).toEqual(['ALTER TABLE "users" ADD COLUMN "campo_3" TEXT NOT NULL;']);
  });
});
