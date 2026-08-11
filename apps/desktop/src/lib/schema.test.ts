import { describe, expect, it } from "vitest";
import {
  applyOps,
  autoLayout,
  diffSchemas,
  emptyDoc,
  exportSql,
  importSql,
  indexName,
  parseDocJson,
  tableHeight,
  TABLE_GEOMETRY,
  type SchemaDocExt
} from "./schema";

/** Fixture construída por operações reais do canal ops:data (nada hardcoded). */
function demoDoc(): SchemaDocExt {
  return applyOps(emptyDoc("Demo"), [
    {
      op: "add_table",
      name: "users",
      fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "email", type: "text", unique: true },
        { name: "nome", type: "text" },
        { name: "criado_em", type: "timestamptz", defaultValue: "now()" }
      ]
    },
    {
      op: "add_table",
      name: "workspaces",
      fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "nome", type: "text" },
        { name: "owner_id", type: "uuid", references: { table: "users", field: "id" } },
        { name: "criado_em", type: "timestamptz", defaultValue: "now()" }
      ]
    },
    {
      op: "add_table",
      name: "runs",
      fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "workspace_id", type: "uuid", references: { table: "workspaces", field: "id" } },
        { name: "status", type: "text", defaultValue: "'queued'" },
        { name: "grafo", type: "jsonb", nullable: true }
      ]
    }
  ]);
}

describe("emptyDoc", () => {
  it("cria documento realmente vazio, sem tabelas de exemplo", () => {
    const doc = emptyDoc("Demo");
    expect(doc.name).toBe("Demo");
    expect(doc.dialect).toBe("postgres");
    expect(doc.tables).toEqual([]);
    expect(doc.relations).toEqual([]);
  });
});

describe("exportSql", () => {
  const doc = demoDoc();

  it("postgres: CREATE TABLE, tipos nativos e FK via ALTER TABLE", () => {
    const sql = exportSql(doc, "postgres");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"id" uuid NOT NULL');
    expect(sql).toContain('"criado_em" timestamptz NOT NULL DEFAULT now()');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).toContain('UNIQUE ("email")');
    expect(sql).toContain(
      'ALTER TABLE "workspaces" ADD CONSTRAINT "fk_workspaces_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id");'
    );
  });

  it("mysql: CHAR(36), DATETIME, ENGINE=InnoDB e FK correta", () => {
    const sql = exportSql(doc, "mysql");
    expect(sql).toContain("CREATE TABLE `users`");
    expect(sql).toContain("`id` CHAR(36) NOT NULL");
    expect(sql).toContain("`criado_em` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    expect(sql).toContain(") ENGINE=InnoDB;");
    expect(sql).toContain("FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`);");
  });

  it("ansi: conservador, sem extensões de fornecedor", () => {
    const sql = exportSql(doc, "ansi");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"criado_em" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain('"grafo" VARCHAR(4000)');
    expect(sql).not.toContain('"grafo" VARCHAR(4000) NOT NULL');
    expect(sql).not.toContain("ENGINE=InnoDB");
    expect(sql).not.toContain("`");
    expect(sql).toContain('FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id");');
  });

  it("FKs saem ao final, em ordem estável", () => {
    const sql = exportSql(doc, "postgres");
    const first = sql.indexOf("fk_workspaces_owner_id");
    const second = sql.indexOf("fk_runs_workspace_id");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(sql.lastIndexOf("CREATE TABLE")).toBeLessThan(first);
  });

  it("inclui CREATE INDEX e CREATE UNIQUE INDEX por dialeto", () => {
    const withIndexes = applyOps(doc, [
      { op: "add_index", table: "users", fields: ["email"], unique: true },
      { op: "add_index", table: "runs", fields: ["workspace_id", "status"] }
    ]);
    const pg = exportSql(withIndexes, "postgres");
    expect(pg).toContain('CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");');
    expect(pg).toContain('CREATE INDEX "idx_runs_workspace_id_status" ON "runs" ("workspace_id", "status");');
    const my = exportSql(withIndexes, "mysql");
    expect(my).toContain("CREATE UNIQUE INDEX `ux_users_email` ON `users` (`email`);");
  });

  it("omite índices órfãos (tabela ou campo inexistente)", () => {
    const withIndex = applyOps(doc, [{ op: "add_index", table: "users", fields: ["email"] }]);
    const broken = { ...withIndex, indexes: [...(withIndex.indexes ?? []), { table: "ghost", fields: ["x"], unique: false }] };
    const sql = exportSql(broken, "postgres");
    expect(sql).toContain("idx_users_email");
    expect(sql).not.toContain("ghost");
  });
});

describe("applyOps", () => {
  it("add_table posiciona em grade livre e cria relação a partir de references", () => {
    const doc = demoDoc();
    const next = applyOps(doc, [
      {
        op: "add_table",
        name: "invoices",
        fields: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "workspace_id", type: "uuid", references: { table: "workspaces", field: "id" } }
        ]
      }
    ]);
    expect(doc.tables).toHaveLength(3); // imutável: o doc original não muda
    expect(next.tables).toHaveLength(4);
    const created = next.tables.find((t) => t.name === "invoices");
    expect(created).toBeDefined();
    const overlap = next.tables.some((t) => t.id !== created?.id && t.x === created?.x && t.y === created?.y);
    expect(overlap).toBe(false);
    expect(
      next.relations.some(
        (r) => r.fromTable === "invoices" && r.fromField === "workspace_id" && r.toTable === "workspaces" && r.toField === "id"
      )
    ).toBe(true);
  });

  it("add_field adiciona e drop_field remove campo e relações do campo", () => {
    const doc = demoDoc();
    const withField = applyOps(doc, [{ op: "add_field", table: "users", field: { name: "avatar_url", type: "text" } }]);
    expect(withField.tables[0].fields.some((f) => f.name === "avatar_url")).toBe(true);

    const without = applyOps(withField, [{ op: "drop_field", table: "workspaces", field: "owner_id" }]);
    const workspaces = without.tables.find((t) => t.name === "workspaces");
    expect(workspaces?.fields.some((f) => f.name === "owner_id")).toBe(false);
    expect(without.relations.some((r) => r.fromTable === "workspaces" && r.fromField === "owner_id")).toBe(false);
  });

  it("add_relation liga campos e marca references no campo de origem", () => {
    const doc = applyOps(demoDoc(), [
      { op: "add_table", name: "logs", fields: [{ name: "id", type: "uuid", primaryKey: true }, { name: "run_id", type: "uuid" }] },
      { op: "add_relation", fromTable: "logs", fromField: "run_id", toTable: "runs", toField: "id", cardinality: "1-n" }
    ]);
    expect(doc.relations.some((r) => r.fromTable === "logs" && r.toTable === "runs")).toBe(true);
    const logs = doc.tables.find((t) => t.name === "logs");
    expect(logs?.fields.find((f) => f.name === "run_id")?.references).toEqual({ table: "runs", field: "id" });
  });

  it("drop_table remove a tabela, relações e referências órfãs", () => {
    const next = applyOps(demoDoc(), [{ op: "drop_table", table: "users" }]);
    expect(next.tables.map((t) => t.name)).toEqual(["workspaces", "runs"]);
    expect(next.relations).toHaveLength(1);
    const owner = next.tables.find((t) => t.name === "workspaces")?.fields.find((f) => f.name === "owner_id");
    expect(owner?.references).toBeUndefined();
  });

  it("rename_table atualiza relações e references em cascata", () => {
    const next = applyOps(demoDoc(), [{ op: "rename_table", table: "users", name: "accounts" }]);
    expect(next.tables.some((t) => t.name === "accounts")).toBe(true);
    expect(next.relations.some((r) => r.toTable === "accounts")).toBe(true);
    expect(next.relations.some((r) => r.toTable === "users")).toBe(false);
    const owner = next.tables.find((t) => t.name === "workspaces")?.fields.find((f) => f.name === "owner_id");
    expect(owner?.references?.table).toBe("accounts");
  });

  it("set_dialect valida o dialeto e ignora valores inválidos", () => {
    const next = applyOps(demoDoc(), [{ op: "set_dialect", dialect: "mysql" }]);
    expect(next.dialect).toBe("mysql");
    const same = applyOps(next, [{ op: "set_dialect", dialect: "oracle" }]);
    expect(same.dialect).toBe("mysql");
  });

  it("ignora operações desconhecidas sem alterar o documento", () => {
    const doc = demoDoc();
    expect(applyOps(doc, [{ op: "explode" }])).toEqual(doc);
  });

  it("add_index valida tabela/campos e recusa duplicatas", () => {
    const doc = demoDoc();
    const withIndex = applyOps(doc, [{ op: "add_index", table: "users", fields: ["email"], unique: true }]);
    expect(withIndex.indexes).toEqual([{ table: "users", fields: ["email"], unique: true }]);
    // duplicata: nada muda
    expect(applyOps(withIndex, [{ op: "add_index", table: "users", fields: ["email"] }])).toBe(withIndex);
    // campo inexistente: nada muda
    expect(applyOps(doc, [{ op: "add_index", table: "users", fields: ["ghost"] }])).toBe(doc);
    // tabela inexistente: nada muda
    expect(applyOps(doc, [{ op: "add_index", table: "ghost", fields: ["id"] }])).toBe(doc);
  });

  it("drop_index remove por tabela+campos", () => {
    const doc = applyOps(demoDoc(), [
      { op: "add_index", table: "users", fields: ["email"], unique: true },
      { op: "add_index", table: "runs", fields: ["workspace_id", "status"] }
    ]);
    const next = applyOps(doc, [{ op: "drop_index", table: "users", fields: ["email"] }]);
    expect(next.indexes).toEqual([{ table: "runs", fields: ["workspace_id", "status"], unique: false }]);
  });

  it("drop_table e drop_field limpam índices; rename_table renomeia o alvo", () => {
    const doc = applyOps(demoDoc(), [
      { op: "add_index", table: "users", fields: ["email"], unique: true },
      { op: "add_index", table: "runs", fields: ["workspace_id", "status"] }
    ]);
    const semUsers = applyOps(doc, [{ op: "drop_table", table: "users" }]);
    expect(semUsers.indexes).toEqual([{ table: "runs", fields: ["workspace_id", "status"], unique: false }]);

    const semStatus = applyOps(doc, [{ op: "drop_field", table: "runs", field: "status" }]);
    expect(semStatus.indexes).toContainEqual({ table: "runs", fields: ["workspace_id"], unique: false });

    const renomeado = applyOps(doc, [{ op: "rename_table", table: "users", name: "accounts" }]);
    expect(renomeado.indexes).toContainEqual({ table: "accounts", fields: ["email"], unique: true });
  });
});

describe("importSql", () => {
  it("faz round-trip do próprio export (postgres)", () => {
    const original = demoDoc();
    const imported = importSql(exportSql(original, "postgres"));

    expect(imported.dialect).toBe("postgres");
    expect(imported.tables.map((t) => t.name)).toEqual(["users", "workspaces", "runs"]);
    for (const table of original.tables) {
      const twin = imported.tables.find((t) => t.name === table.name);
      expect(twin?.fields.map((f) => f.name)).toEqual(table.fields.map((f) => f.name));
    }
    expect(imported.relations).toHaveLength(2);
    const owner = imported.tables.find((t) => t.name === "workspaces")?.fields.find((f) => f.name === "owner_id");
    expect(owner?.references).toEqual({ table: "users", field: "id" });
    const users = imported.tables.find((t) => t.name === "users");
    expect(users?.fields.find((f) => f.name === "id")?.primaryKey).toBe(true);
    expect(users?.fields.find((f) => f.name === "email")?.unique).toBe(true);
    expect(users?.fields.find((f) => f.name === "criado_em")?.defaultValue).toBe("now()");
  });

  it("round-trip mysql preserva estrutura e detecta o dialeto", () => {
    const imported = importSql(exportSql(demoDoc(), "mysql"));
    expect(imported.dialect).toBe("mysql");
    expect(imported.tables).toHaveLength(3);
    expect(imported.relations).toHaveLength(2);
  });

  it("round-trip ansi preserva tabelas e FKs", () => {
    const imported = importSql(exportSql(demoDoc(), "ansi"));
    expect(imported.dialect).toBe("ansi");
    expect(imported.tables.map((t) => t.name)).toEqual(["users", "workspaces", "runs"]);
    expect(imported.relations).toHaveLength(2);
  });

  it("round-trip preserva CREATE [UNIQUE] INDEX", () => {
    const original = applyOps(demoDoc(), [
      { op: "add_index", table: "users", fields: ["email"], unique: true },
      { op: "add_index", table: "runs", fields: ["workspace_id", "status"] }
    ]);
    const imported = importSql(exportSql(original, "postgres"));
    expect(imported.indexes).toEqual([
      { table: "users", fields: ["email"], unique: true },
      { table: "runs", fields: ["workspace_id", "status"], unique: false }
    ]);
  });
});

describe("diffSchemas (migração)", () => {
  it("sem mudanças → nenhum statement", () => {
    const doc = demoDoc();
    expect(diffSchemas(doc, doc, "postgres")).toEqual([]);
  });

  it("tabela nova → CREATE TABLE + FK via ADD CONSTRAINT", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [
      {
        op: "add_table",
        name: "invoices",
        fields: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "workspace_id", type: "uuid", references: { table: "workspaces", field: "id" } }
        ]
      }
    ]);
    const sql = diffSchemas(prev, next, "postgres").join("\n");
    expect(sql).toContain('CREATE TABLE "invoices"');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).toContain(
      'ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id");'
    );
    expect(sql).not.toContain("DROP");
  });

  it("tabela removida → DROP TABLE, sem DROP CONSTRAINT redundante da própria tabela", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [{ op: "drop_table", table: "runs" }]);
    const statements = diffSchemas(prev, next, "postgres");
    expect(statements).toContain('DROP TABLE "runs";');
    expect(statements.join("\n")).not.toContain("fk_runs_workspace_id");
  });

  it("coluna nova → ADD COLUMN com tipo mapeado, NOT NULL e DEFAULT", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [{ op: "add_field", table: "users", field: { name: "idade", type: "int", defaultValue: "0" } }]);
    expect(diffSchemas(prev, next, "postgres")).toContain('ALTER TABLE "users" ADD COLUMN "idade" integer NOT NULL DEFAULT 0;');
  });

  it("coluna removida → DROP COLUMN", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [{ op: "drop_field", table: "users", field: "nome" }]);
    expect(diffSchemas(prev, next, "postgres")).toContain('ALTER TABLE "users" DROP COLUMN "nome";');
  });

  it("mudança de tipo → ALTER por dialeto (TYPE / MODIFY / SET DATA TYPE)", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [{ op: "add_field", table: "users", field: { name: "nome", type: "varchar" } }]);
    expect(diffSchemas(prev, next, "postgres")).toContain('ALTER TABLE "users" ALTER COLUMN "nome" TYPE varchar(255);');
    expect(diffSchemas(prev, next, "mysql")).toContain("ALTER TABLE `users` MODIFY COLUMN `nome` VARCHAR(255) NOT NULL;");
    expect(diffSchemas(prev, next, "ansi")).toContain('ALTER TABLE "users" ALTER COLUMN "nome" SET DATA TYPE VARCHAR(255);');
  });

  it("FK nova entre tabelas existentes → ADD CONSTRAINT", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [
      { op: "add_field", table: "runs", field: { name: "criado_por", type: "uuid" } },
      { op: "add_relation", fromTable: "runs", fromField: "criado_por", toTable: "users", toField: "id" }
    ]);
    const sql = diffSchemas(prev, next, "postgres").join("\n");
    expect(sql).toContain(
      'ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_criado_por" FOREIGN KEY ("criado_por") REFERENCES "users" ("id");'
    );
  });

  it("FK removida em tabela viva → DROP CONSTRAINT (mysql: DROP FOREIGN KEY)", () => {
    const prev = demoDoc();
    const next = applyOps(prev, [{ op: "drop_field", table: "workspaces", field: "owner_id" }]);
    expect(diffSchemas(prev, next, "postgres")).toContain('ALTER TABLE "workspaces" DROP CONSTRAINT "fk_workspaces_owner_id";');
    expect(diffSchemas(prev, next, "mysql")).toContain("ALTER TABLE `workspaces` DROP FOREIGN KEY `fk_workspaces_owner_id`;");
  });

  it("índice novo/removido → CREATE INDEX / DROP INDEX por dialeto", () => {
    const base = demoDoc();
    const withIndex = applyOps(base, [{ op: "add_index", table: "users", fields: ["email"], unique: true }]);
    expect(diffSchemas(base, withIndex, "postgres")).toContain('CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");');
    expect(diffSchemas(withIndex, base, "postgres")).toContain('DROP INDEX "ux_users_email";');
    expect(diffSchemas(withIndex, base, "mysql")).toContain("DROP INDEX `ux_users_email` ON `users`;");
  });
});

describe("autoLayout", () => {
  function buildWide(): SchemaDocExt {
    let doc = emptyDoc("Layout");
    // hub com muitos campos + 8 satélites de alturas variadas
    doc = applyOps(doc, [
      {
        op: "add_table",
        name: "hub",
        fields: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, type: "text" }))
      }
    ]);
    for (let i = 0; i < 8; i += 1) {
      doc = applyOps(doc, [
        {
          op: "add_table",
          name: `sat_${i}`,
          fields: [
            { name: "id", type: "uuid", primaryKey: true },
            ...Array.from({ length: i }, (_, j) => ({ name: `f${j}`, type: "text" })),
            { name: "hub_id", type: "uuid", references: { table: "hub", field: "c0" } }
          ]
        }
      ]);
    }
    return doc;
  }

  it("nunca sobrepõe retângulos com os tamanhos reais dos cards", () => {
    const laid = autoLayout(buildWide());
    const rects = laid.tables.map((table) => ({
      left: table.x,
      top: table.y,
      right: table.x + TABLE_GEOMETRY.width,
      bottom: table.y + tableHeight(table)
    }));
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const overlaps =
          rects[a].left < rects[b].right &&
          rects[b].left < rects[a].right &&
          rects[a].top < rects[b].bottom &&
          rects[b].top < rects[a].bottom;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("é determinístico e põe o hub (maior grau) na primeira célula", () => {
    const doc = buildWide();
    const first = autoLayout(doc);
    const second = autoLayout(doc);
    expect(second).toEqual(first);
    const hub = first.tables.find((t) => t.name === "hub");
    expect(hub?.x).toBe(40);
    expect(hub?.y).toBe(40);
    // idempotente: aplicar de novo não muda posições
    expect(autoLayout(first)).toEqual(first);
  });

  it("documento vazio permanece intacto", () => {
    const doc = emptyDoc("Vazio");
    expect(autoLayout(doc)).toBe(doc);
  });
});

describe("parseDocJson (persistência)", () => {
  it("round-trip do documento com índices", () => {
    const doc = applyOps(demoDoc(), [{ op: "add_index", table: "users", fields: ["email"], unique: true }]);
    const parsed = parseDocJson(JSON.stringify(doc));
    expect(parsed).toEqual(doc);
  });

  it("retorna null para JSON inválido, shape errado ou vazio", () => {
    expect(parseDocJson(null)).toBeNull();
    expect(parseDocJson("")).toBeNull();
    expect(parseDocJson("{nope")).toBeNull();
    expect(parseDocJson("[]")).toBeNull();
    expect(parseDocJson('{"name":"x"}')).toBeNull();
    expect(parseDocJson('{"name":"x","tables":[{"broken":true}],"relations":[]}')).toBeNull();
  });

  it("descarta relações/índices malformados e normaliza dialeto desconhecido", () => {
    const raw = JSON.stringify({
      name: "X",
      dialect: "oracle",
      tables: [{ id: "t", name: "t", x: 1, y: 2, tone: "cyan", fields: [{ name: "id", type: "uuid" }] }],
      relations: [{ fromTable: "t" }],
      indexes: [{ table: "t", fields: [] }, { table: "t", fields: ["id"], unique: true }]
    });
    const parsed = parseDocJson(raw);
    expect(parsed?.dialect).toBe("postgres");
    expect(parsed?.relations).toEqual([]);
    expect(parsed?.indexes).toEqual([{ table: "t", fields: ["id"], unique: true }]);
  });
});

describe("indexName", () => {
  it("gera idx_/ux_ determinístico por tabela+campos", () => {
    expect(indexName({ table: "users", fields: ["email"], unique: true })).toBe("ux_users_email");
    expect(indexName({ table: "runs", fields: ["a", "b"], unique: false })).toBe("idx_runs_a_b");
  });
});
