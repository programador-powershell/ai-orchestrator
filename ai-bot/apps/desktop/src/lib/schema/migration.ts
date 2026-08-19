/**
 * Migração por SNAPSHOT — o diff real entre dois estados do schema, por
 * dialeto, com o SQL de ida (up) e de volta (down).
 *
 * Porte de diffSchemas/diffSchemasDown do orquestrador (lib/schema.ts),
 * adaptado ao modelo do AI-BOT: as FKs saem das RELAÇÕES (o snapshot não tem
 * `references` por campo), NOT NULL sai de `required`, e as ações
 * referenciais (ON UPDATE/ON DELETE) ficam de fora porque o modelo daqui não
 * as tem — acrescentá-las sem UI que as edite seria SQL que ninguém pediu.
 *
 * O vocabulário de dialetos é o da Onda 1 (schemaDoc.SQL_DIALECTS): os cinco
 * que o gateway aceita. O TYPE_MAP é o do orquestrador, com o mesmo raciocínio
 * por dialeto (SQLite tem afinidade de tipos; mssql não tem boolean; etc.).
 */
import { nomeDoIndice, type CampoEdit, type EsquemaEditavel, type IndiceEdit, type SqlDialect, type TabelaEdit } from "./schemaDoc";

/* ----------------------------- tipos por dialeto -------------------------- */

const TYPE_MAP: Record<SqlDialect, Record<string, string>> = {
  postgres: {
    uuid: "uuid",
    text: "text",
    varchar: "varchar(255)",
    int: "integer",
    integer: "integer",
    bigint: "bigint",
    serial: "serial",
    boolean: "boolean",
    timestamptz: "timestamptz",
    timestamp: "timestamp",
    date: "date",
    jsonb: "jsonb",
    json: "jsonb",
    numeric: "numeric(18,6)",
    float: "double precision"
  },
  mysql: {
    uuid: "CHAR(36)",
    text: "TEXT",
    varchar: "VARCHAR(255)",
    int: "INT",
    integer: "INT",
    bigint: "BIGINT",
    serial: "INT AUTO_INCREMENT",
    boolean: "TINYINT(1)",
    timestamptz: "DATETIME",
    timestamp: "DATETIME",
    date: "DATE",
    jsonb: "JSON",
    json: "JSON",
    numeric: "DECIMAL(18,6)",
    float: "DOUBLE"
  },
  sqlite: {
    // SQLite tem afinidade de tipos: sem UUID/BOOLEAN nativos, tudo em TEXT/INTEGER.
    uuid: "TEXT",
    text: "TEXT",
    varchar: "VARCHAR(255)",
    int: "INTEGER",
    integer: "INTEGER",
    bigint: "INTEGER",
    serial: "INTEGER",
    boolean: "INTEGER",
    timestamptz: "DATETIME",
    timestamp: "DATETIME",
    date: "DATE",
    jsonb: "TEXT",
    json: "TEXT",
    numeric: "NUMERIC",
    float: "REAL"
  },
  mssql: {
    uuid: "UNIQUEIDENTIFIER",
    text: "NVARCHAR(MAX)",
    varchar: "NVARCHAR(255)",
    int: "INT",
    integer: "INT",
    bigint: "BIGINT",
    serial: "INT IDENTITY(1,1)",
    boolean: "BIT",
    timestamptz: "DATETIME2",
    timestamp: "DATETIME2",
    date: "DATE",
    jsonb: "NVARCHAR(MAX)",
    json: "NVARCHAR(MAX)",
    numeric: "DECIMAL(18,6)",
    float: "FLOAT"
  },
  ansi: {
    uuid: "CHAR(36)",
    text: "VARCHAR(4000)",
    varchar: "VARCHAR(255)",
    int: "INTEGER",
    integer: "INTEGER",
    bigint: "BIGINT",
    serial: "INTEGER",
    boolean: "SMALLINT",
    timestamptz: "TIMESTAMP",
    timestamp: "TIMESTAMP",
    date: "DATE",
    jsonb: "VARCHAR(4000)",
    json: "VARCHAR(4000)",
    numeric: "NUMERIC(18,6)",
    float: "DOUBLE PRECISION"
  }
};

function mapearTipo(tipo: string, dialect: SqlDialect): string {
  // Tipo vazio existe: o parser tolerante do tool.result aceita coluna sem
  // tipo. `text` é o neutro que todo dialeto tem — DDL sem tipo não compila.
  const chave = (tipo.trim() === "" ? "text" : tipo).trim().toLowerCase();
  return TYPE_MAP[dialect][chave] ?? tipo;
}

/** now() só é literal em Postgres; nos outros vira a função nativa. */
function mapearDefault(valor: string, dialect: SqlDialect): string {
  if (dialect === "postgres" || valor.toLowerCase() !== "now()") return valor;
  return dialect === "mssql" ? "SYSUTCDATETIME()" : "CURRENT_TIMESTAMP";
}

function citar(nome: string, dialect: SqlDialect): string {
  if (dialect === "mysql") return `\`${nome}\``;
  if (dialect === "mssql") return `[${nome}]`;
  return `"${nome}"`;
}

/* ------------------------------ DDL de pedaços ---------------------------- */

/** DDL de uma coluna (sem indentação): nome, tipo mapeado, NULL e DEFAULT. */
function ddlDaColuna(campo: CampoEdit, dialect: SqlDialect): string {
  let linha = `${citar(campo.name, dialect)} ${mapearTipo(campo.type, dialect)}`;
  // No snapshot a coluna só é NOT NULL quando alguém AFIRMOU (required); o
  // orquestrador assumia o contrário (NOT NULL por padrão) porque o doc lá
  // nascia do próprio editor — aqui ele nasce de um tool.result tolerante.
  if (campo.required) linha += " NOT NULL";
  if (campo.defaultValue !== undefined && campo.defaultValue !== "") {
    linha += ` DEFAULT ${mapearDefault(campo.defaultValue, dialect)}`;
  }
  return linha;
}

function renderCreateTable(tabela: TabelaEdit, dialect: SqlDialect): string {
  const q = (nome: string) => citar(nome, dialect);
  const linhas = tabela.columns.map((campo) => `  ${ddlDaColuna(campo, dialect)}`);
  const pk = tabela.columns.filter((campo) => campo.pk);
  if (pk.length > 0) linhas.push(`  PRIMARY KEY (${pk.map((campo) => q(campo.name)).join(", ")})`);
  const cauda = dialect === "mysql" ? ") ENGINE=InnoDB;" : ");";
  return `CREATE TABLE ${q(tabela.name)} (\n${linhas.join(",\n")}\n${cauda}`;
}

function renderAddFk(tabela: string, campo: string, refTabela: string, refCampo: string, dialect: SqlDialect): string {
  const q = (nome: string) => citar(nome, dialect);
  return (
    `ALTER TABLE ${q(tabela)} ADD CONSTRAINT ${q(`fk_${tabela}_${campo}`)} ` +
    `FOREIGN KEY (${q(campo)}) REFERENCES ${q(refTabela)} (${q(refCampo)});`
  );
}

function renderCreateIndex(indice: IndiceEdit, dialect: SqlDialect): string {
  const q = (nome: string) => citar(nome, dialect);
  return (
    `CREATE ${indice.unique ? "UNIQUE " : ""}INDEX ${q(nomeDoIndice(indice))} ` +
    `ON ${q(indice.table)} (${indice.fields.map(q).join(", ")});`
  );
}

function renderAlterType(tabela: string, campo: CampoEdit, dialect: SqlDialect): string {
  const q = (nome: string) => citar(nome, dialect);
  if (dialect === "mysql") return `ALTER TABLE ${q(tabela)} MODIFY COLUMN ${ddlDaColuna(campo, dialect)};`;
  if (dialect === "postgres") {
    return `ALTER TABLE ${q(tabela)} ALTER COLUMN ${q(campo.name)} TYPE ${mapearTipo(campo.type, dialect)};`;
  }
  return `ALTER TABLE ${q(tabela)} ALTER COLUMN ${q(campo.name)} SET DATA TYPE ${mapearTipo(campo.type, dialect)};`;
}

/* ------------------------------- arestas de FK ---------------------------- */

interface ArestaFk {
  table: string;
  field: string;
  refTable: string;
  refField: string;
}

/**
 * As FKs que viram SQL: relações com as DUAS colunas nomeadas, cuja tabela de
 * origem existe no doc, e que não sejam n-n (n-n é tabela de junção, assunto
 * do export completo — que é do gateway, não desta migração). Relação sem
 * coluna não tem como virar constraint: não há o que escrever no FOREIGN KEY.
 */
function arestasFk(doc: EsquemaEditavel): Map<string, ArestaFk> {
  const arestas = new Map<string, ArestaFk>();
  const nomes = new Set(doc.tables.map((tabela) => tabela.name.toLowerCase()));
  for (const relacao of doc.relations) {
    if (relacao.fromColumn === "" || relacao.toColumn === "") continue;
    if (relacao.fromCard === "n" && relacao.toCard === "n") continue;
    if (!nomes.has(relacao.from.toLowerCase())) continue;
    const aresta: ArestaFk = {
      table: relacao.from,
      field: relacao.fromColumn,
      refTable: relacao.to,
      refField: relacao.toColumn
    };
    arestas.set(`${aresta.table}.${aresta.field}->${aresta.refTable}.${aresta.refField}`, aresta);
  }
  return arestas;
}

/** Índices cujo alvo (tabela e todos os campos) ainda existe no documento —
 *  índice órfão não entra no diff: CREATE INDEX nele falharia no banco. */
function indicesValidos(doc: EsquemaEditavel): Map<string, IndiceEdit> {
  const entradas = new Map<string, IndiceEdit>();
  for (const indice of doc.indexes) {
    const tabela = doc.tables.find((item) => item.name.toLowerCase() === indice.table.toLowerCase());
    if (!tabela || indice.fields.length === 0) continue;
    if (!indice.fields.every((nome) => tabela.columns.some((campo) => campo.name.toLowerCase() === nome.toLowerCase()))) continue;
    entradas.set(`${indice.unique ? "u" : "i"}:${indice.table}(${indice.fields.join(",")})`, indice);
  }
  return entradas;
}

/* ---------------------------------- diff ---------------------------------- */

/**
 * SQL de migração de `prev` para `next`, por dialeto, em ordem estável:
 * CREATE TABLE novas → DROP TABLE removidas → ADD COLUMN → ALTER TYPE →
 * DROP COLUMN → ADD/DROP CONSTRAINT FK → CREATE/DROP INDEX.
 * Rename de tabela/coluna sai como DROP + CREATE (limitação declarada, a
 * mesma do orquestrador: o diff compara por nome, não tem como saber que
 * `clientes` era `users`). Um statement por item; array vazio = nenhum diff.
 */
export function diffEsquemas(prev: EsquemaEditavel, next: EsquemaEditavel, dialect: SqlDialect): string[] {
  const q = (nome: string) => citar(nome, dialect);
  const statements: string[] = [];
  const antesPorNome = new Map(prev.tables.map((tabela) => [tabela.name, tabela]));
  const depoisPorNome = new Map(next.tables.map((tabela) => [tabela.name, tabela]));

  for (const tabela of next.tables) {
    if (!antesPorNome.has(tabela.name)) statements.push(renderCreateTable(tabela, dialect));
  }
  for (const tabela of prev.tables) {
    if (!depoisPorNome.has(tabela.name)) statements.push(`DROP TABLE ${q(tabela.name)};`);
  }

  for (const tabela of next.tables) {
    const antes = antesPorNome.get(tabela.name);
    if (!antes) continue;
    for (const campo of tabela.columns) {
      const velho = antes.columns.find((item) => item.name === campo.name);
      if (!velho) {
        statements.push(`ALTER TABLE ${q(tabela.name)} ADD COLUMN ${ddlDaColuna(campo, dialect)};`);
      } else if (velho.type !== campo.type) {
        // LIMITAÇÃO HERDADA DO PORTE, declarada de propósito: só a mudança de
        // TIPO gera ALTER. Trocar apenas NOT NULL ou DEFAULT não produz
        // statement — o orquestrador também não produzia, e inventar a sintaxe
        // certa por dialeto (SET/DROP NOT NULL vs MODIFY vs rebuild no sqlite)
        // é trabalho de uma onda própria, não de um else escondido.
        statements.push(renderAlterType(tabela.name, campo, dialect));
      }
    }
    for (const campo of antes.columns) {
      if (!tabela.columns.some((item) => item.name === campo.name)) {
        statements.push(`ALTER TABLE ${q(tabela.name)} DROP COLUMN ${q(campo.name)};`);
      }
    }
  }

  const fksAntes = arestasFk(prev);
  const fksDepois = arestasFk(next);
  for (const [chave, aresta] of fksDepois) {
    if (!fksAntes.has(chave)) statements.push(renderAddFk(aresta.table, aresta.field, aresta.refTable, aresta.refField, dialect));
  }
  for (const [chave, aresta] of fksAntes) {
    // Tabela que saiu leva as constraints junto no DROP TABLE — repetir o
    // DROP CONSTRAINT depois falharia no banco.
    if (fksDepois.has(chave) || !depoisPorNome.has(aresta.table)) continue;
    statements.push(
      dialect === "mysql"
        ? `ALTER TABLE ${q(aresta.table)} DROP FOREIGN KEY ${q(`fk_${aresta.table}_${aresta.field}`)};`
        : `ALTER TABLE ${q(aresta.table)} DROP CONSTRAINT ${q(`fk_${aresta.table}_${aresta.field}`)};`
    );
  }

  const idxAntes = indicesValidos(prev);
  const idxDepois = indicesValidos(next);
  for (const [chave, indice] of idxDepois) {
    if (!idxAntes.has(chave)) statements.push(renderCreateIndex(indice, dialect));
  }
  for (const [chave, indice] of idxAntes) {
    if (idxDepois.has(chave) || !depoisPorNome.has(indice.table)) continue;
    statements.push(
      dialect === "mysql"
        ? `DROP INDEX ${q(nomeDoIndice(indice))} ON ${q(indice.table)};`
        : `DROP INDEX ${q(nomeDoIndice(indice))};`
    );
  }
  return statements;
}

/**
 * SQL de reversão (down) da migração `prev` → `next`: é exatamente o diff no
 * sentido oposto (`next` → `prev`). CREATE TABLE vira DROP TABLE, ADD COLUMN
 * vira DROP COLUMN, ADD CONSTRAINT vira DROP CONSTRAINT, e assim por diante.
 * Herda as mesmas limitações de diffEsquemas (rename = DROP + CREATE).
 */
export function diffEsquemasDown(prev: EsquemaEditavel, next: EsquemaEditavel, dialect: SqlDialect): string[] {
  return diffEsquemas(next, prev, dialect);
}
