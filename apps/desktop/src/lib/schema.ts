/**
 * Núcleo puro do modo Data — documento de schema (ERD), operações do canal
 * "data" (chat → superfície), export SQL multi-dialeto e import básico.
 * Sem DOM: tudo aqui roda em Node e é coberto por vitest (schema.test.ts).
 */
import type {
  SchemaDoc,
  SchemaField,
  SchemaRelation,
  SchemaTable,
  SqlDialect as SqlDialectBase
} from "@ai-orchestrator/contracts";
import type { StructuredOp } from "./ops";

/* ------------------------------ Constantes ------------------------------- */

/**
 * Dialetos suportados no export/diff — superset local do SqlDialect de
 * contracts (adiciona sqlite/mssql sem tocar no pacote contracts).
 */
export type SqlDialect = SqlDialectBase | "sqlite" | "mssql";

/** Ações referenciais de FK (ON UPDATE / ON DELETE). */
export type FkAction = "CASCADE" | "RESTRICT" | "SET NULL" | "NO ACTION";

export const SQL_DIALECTS: SqlDialect[] = ["postgres", "mysql", "ansi", "sqlite", "mssql"];

/** Tons categóricos — mapeados para var(--tone-*) no CSS da view. */
const TONES = ["cyan", "violet", "mint", "amber", "blue", "pink", "rose"];

/** Tipos comuns oferecidos no editor por dialeto (o export mapeia o restante). */
export const dialectFieldTypes: Record<SqlDialect, string[]> = {
  postgres: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  mysql: ["uuid", "varchar", "text", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  ansi: ["uuid", "varchar", "text", "int", "bigint", "boolean", "timestamptz", "date", "numeric"],
  sqlite: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  mssql: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"]
};

/* --------------------- Extensão local: índices nomeados ------------------- */

/** Índice de tabela — extensão local do documento, sem alterar contracts. */
export interface SchemaIndexDef {
  table: string;
  fields: string[];
  unique: boolean;
}

/**
 * Relação + ações referenciais opcionais (ON UPDATE / ON DELETE) — extensão
 * local sobre SchemaRelation, sem alterar contracts. As ações são opcionais,
 * então toda SchemaRelation é uma SchemaRelationExt válida e vice-versa.
 */
export interface SchemaRelationExt extends SchemaRelation {
  onUpdate?: FkAction;
  onDelete?: FkAction;
}

/**
 * SchemaDoc + índices, dialetos estendidos (sqlite/mssql) e ações de FK.
 * `dialect`/`relations` são alargados localmente (Omit) — todo SchemaDoc
 * atribui a SchemaDocExt; a volta vale para os três dialetos de contracts.
 */
export interface SchemaDocExt extends Omit<SchemaDoc, "dialect" | "relations"> {
  dialect: SqlDialect;
  relations: SchemaRelationExt[];
  indexes?: SchemaIndexDef[];
}

/** Nome determinístico do índice — idx_/ux_ + tabela + campos. */
export function indexName(index: SchemaIndexDef): string {
  return `${index.unique ? "ux" : "idx"}_${index.table}_${index.fields.join("_")}`;
}

function docIndexes(doc: SchemaDocExt): SchemaIndexDef[] {
  return doc.indexes ?? [];
}

function sameFields(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** Índices cujo alvo (tabela e todos os campos) ainda existe no documento. */
function validIndexes(doc: SchemaDocExt): SchemaIndexDef[] {
  return docIndexes(doc).filter((index) => {
    const table = doc.tables.find((t) => t.name === index.table);
    return Boolean(table && index.fields.length && index.fields.every((name) => table.fields.some((f) => f.name === name)));
  });
}

/* --------------------------- Grade de posições --------------------------- */

const GRID_X = 250;
const GRID_Y = 215;
const GRID_ORIGIN = 40;
const GRID_COLS = 4;

/** Primeira célula livre da grade — usada para tabelas novas (chat, UI, import). */
export function nextFreePosition(tables: SchemaTable[]): { x: number; y: number } {
  for (let slot = 0; slot < 400; slot += 1) {
    const x = GRID_ORIGIN + (slot % GRID_COLS) * GRID_X;
    const y = GRID_ORIGIN + Math.floor(slot / GRID_COLS) * GRID_Y;
    const taken = tables.some(
      (table) => Math.abs(table.x - x) < GRID_X * 0.55 && Math.abs(table.y - y) < GRID_Y * 0.55
    );
    if (!taken) return { x, y };
  }
  return { x: GRID_ORIGIN, y: GRID_ORIGIN };
}

/* ------------------------- Geometria e auto-layout ------------------------ */

/** Geometria real dos cards — única fonte: a view e o auto-layout usam esta. */
export const TABLE_GEOMETRY = { width: 190, headerHeight: 30, rowHeight: 22 } as const;

/** Altura real do card de uma tabela no canvas. */
export function tableHeight(table: SchemaTable): number {
  return TABLE_GEOMETRY.headerHeight + table.fields.length * TABLE_GEOMETRY.rowHeight;
}

const LAYOUT_GAP_X = 60;
const LAYOUT_GAP_Y = 48;
const LAYOUT_ORIGIN = 40;

/**
 * Auto-layout determinístico: ordena por grau de conexões (hubs primeiro,
 * desempate alfabético) e distribui em grade ~quadrada; a altura de cada
 * linha é a da tabela mais alta, então nunca há sobreposição de retângulos
 * para os tamanhos reais dos cards (TABLE_GEOMETRY).
 */
export function autoLayout(doc: SchemaDocExt): SchemaDocExt {
  if (!doc.tables.length) return doc;
  const degree = new Map<string, number>(doc.tables.map((table) => [table.name, 0]));
  for (const relation of doc.relations) {
    if (degree.has(relation.fromTable)) degree.set(relation.fromTable, (degree.get(relation.fromTable) ?? 0) + 1);
    if (degree.has(relation.toTable)) degree.set(relation.toTable, (degree.get(relation.toTable) ?? 0) + 1);
  }
  const ordered = [...doc.tables].sort((a, b) => {
    const diff = (degree.get(b.name) ?? 0) - (degree.get(a.name) ?? 0);
    if (diff !== 0) return diff;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const positions = new Map<string, { x: number; y: number }>();
  let y = LAYOUT_ORIGIN;
  for (let start = 0; start < ordered.length; start += cols) {
    const row = ordered.slice(start, start + cols);
    row.forEach((table, col) => {
      positions.set(table.id, { x: LAYOUT_ORIGIN + col * (TABLE_GEOMETRY.width + LAYOUT_GAP_X), y });
    });
    y += Math.max(...row.map(tableHeight)) + LAYOUT_GAP_Y;
  }
  return {
    ...doc,
    tables: doc.tables.map((table) => ({ ...table, ...(positions.get(table.id) ?? { x: table.x, y: table.y }) }))
  };
}

/* -------------------------------- Helpers -------------------------------- */

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "tabela";
}

function uniqueId(name: string, tables: SchemaTable[]): string {
  const base = slugify(name);
  let id = base;
  let next = 2;
  while (tables.some((table) => table.id === id)) id = `${base}_${next++}`;
  return id;
}

function toneFor(index: number): string {
  return TONES[index % TONES.length];
}

function makeTable(doc: SchemaDocExt, name: string, fields: SchemaField[]): SchemaTable {
  const { x, y } = nextFreePosition(doc.tables);
  return { id: uniqueId(name, doc.tables), name, x, y, tone: toneFor(doc.tables.length), fields };
}

function relationId(fromTable: string, fromField: string, toTable: string, toField: string): string {
  return `rel_${fromTable}_${fromField}__${toTable}_${toField}`;
}

function upsertRelation(doc: SchemaDocExt, relation: Omit<SchemaRelationExt, "id">): SchemaDocExt {
  const exists = doc.relations.some(
    (r) =>
      r.fromTable === relation.fromTable &&
      r.fromField === relation.fromField &&
      r.toTable === relation.toTable &&
      r.toField === relation.toField
  );
  if (exists) return doc;
  const id = relationId(relation.fromTable, relation.fromField, relation.toTable, relation.toField);
  return { ...doc, relations: [...doc.relations, { id, ...relation }] };
}

/** Cria relações automaticamente para campos com `references`. */
function withFieldRelations(doc: SchemaDocExt, tableName: string, fields: SchemaField[]): SchemaDocExt {
  let next = doc;
  for (const field of fields) {
    if (!field.references) continue;
    next = upsertRelation(next, {
      fromTable: tableName,
      fromField: field.name,
      toTable: field.references.table,
      toField: field.references.field,
      cardinality: "1-n"
    });
  }
  return next;
}

/* ------------------------------ Documento base --------------------------- */

/**
 * Documento realmente vazio — nada de tabelas de exemplo decorativas.
 * O diagrama nasce do chat (ops:data), do editor ou de um import SQL real.
 */
export function emptyDoc(name: string): SchemaDocExt {
  return { name, dialect: "postgres", tables: [], relations: [] };
}

/* ------------------------ Leitores de valores de op ---------------------- */

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asReference(value: unknown): SchemaField["references"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const table = asString(raw.table);
  const field = asString(raw.field);
  return table && field ? { table, field } : undefined;
}

function asField(value: unknown): SchemaField | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const name = asString(raw.name);
  if (!name) return undefined;
  const field: SchemaField = { name, type: asString(raw.type) || "text" };
  const primaryKey = asBool(raw.primaryKey);
  const unique = asBool(raw.unique);
  const nullable = asBool(raw.nullable);
  const defaultValue = asString(raw.defaultValue);
  const references = asReference(raw.references);
  if (primaryKey !== undefined) field.primaryKey = primaryKey;
  if (unique !== undefined) field.unique = unique;
  if (nullable !== undefined) field.nullable = nullable;
  if (defaultValue) field.defaultValue = defaultValue;
  if (references) field.references = references;
  return field;
}

function asCardinality(value: unknown): SchemaRelation["cardinality"] {
  return value === "1-1" || value === "n-n" ? value : "1-n";
}

function asFkAction(value: unknown): FkAction | undefined {
  return value === "CASCADE" || value === "RESTRICT" || value === "SET NULL" || value === "NO ACTION" ? value : undefined;
}

/* ------------------------- applyOps (canal "data") ------------------------ */

/**
 * Aplica as operações do catálogo ops:data (ver lib/opsCatalogs.ts) de forma
 * imutável. Ops desconhecidas ou malformadas são ignoradas.
 */
export function applyOps(doc: SchemaDocExt, ops: StructuredOp[]): SchemaDocExt {
  return ops.reduce(applyOp, doc);
}

function applyOp(doc: SchemaDocExt, op: StructuredOp): SchemaDocExt {
  switch (op.op) {
    case "add_table": {
      const name = asString(op.name);
      if (!name || doc.tables.some((t) => t.name === name)) return doc;
      const rawFields = Array.isArray(op.fields) ? op.fields : [];
      const fields = rawFields.map(asField).filter((f): f is SchemaField => Boolean(f));
      const table = makeTable(doc, name, fields.length ? fields : [{ name: "id", type: "uuid", primaryKey: true }]);
      return withFieldRelations({ ...doc, tables: [...doc.tables, table] }, name, table.fields);
    }
    case "drop_table": {
      const name = asString(op.table);
      if (!doc.tables.some((t) => t.name === name)) return doc;
      return {
        ...doc,
        tables: doc.tables
          .filter((t) => t.name !== name)
          .map((t) => ({
            ...t,
            fields: t.fields.map((f) => (f.references?.table === name ? { ...f, references: undefined } : f))
          })),
        relations: doc.relations.filter((r) => r.fromTable !== name && r.toTable !== name),
        indexes: docIndexes(doc).filter((index) => index.table !== name)
      };
    }
    case "rename_table": {
      const from = asString(op.table);
      const to = asString(op.name);
      if (!from || !to || from === to) return doc;
      if (!doc.tables.some((t) => t.name === from) || doc.tables.some((t) => t.name === to)) return doc;
      return {
        ...doc,
        tables: doc.tables.map((t) => ({
          ...t,
          name: t.name === from ? to : t.name,
          fields: t.fields.map((f) =>
            f.references?.table === from ? { ...f, references: { table: to, field: f.references.field } } : f
          )
        })),
        relations: doc.relations.map((r) => ({
          ...r,
          fromTable: r.fromTable === from ? to : r.fromTable,
          toTable: r.toTable === from ? to : r.toTable
        })),
        indexes: docIndexes(doc).map((index) => (index.table === from ? { ...index, table: to } : index))
      };
    }
    case "add_field": {
      const name = asString(op.table);
      const field = asField(op.field);
      const table = doc.tables.find((t) => t.name === name);
      if (!table || !field) return doc;
      const fields = table.fields.some((f) => f.name === field.name)
        ? table.fields.map((f) => (f.name === field.name ? field : f))
        : [...table.fields, field];
      const next = { ...doc, tables: doc.tables.map((t) => (t.id === table.id ? { ...t, fields } : t)) };
      return withFieldRelations(next, name, [field]);
    }
    case "drop_field": {
      const name = asString(op.table);
      const fieldName = asString(op.field);
      const table = doc.tables.find((t) => t.name === name);
      if (!table || !table.fields.some((f) => f.name === fieldName)) return doc;
      return {
        ...doc,
        tables: doc.tables.map((t) =>
          t.id === table.id ? { ...t, fields: t.fields.filter((f) => f.name !== fieldName) } : t
        ),
        relations: doc.relations.filter(
          (r) => !(r.fromTable === name && r.fromField === fieldName) && !(r.toTable === name && r.toField === fieldName)
        ),
        indexes: docIndexes(doc)
          .map((index) => (index.table === name ? { ...index, fields: index.fields.filter((f) => f !== fieldName) } : index))
          .filter((index) => index.fields.length > 0)
      };
    }
    case "add_relation": {
      const fromTable = asString(op.fromTable);
      const fromField = asString(op.fromField);
      const toTable = asString(op.toTable);
      const toField = asString(op.toField);
      if (!fromTable || !fromField || !toTable || !toField) return doc;
      const relation: Omit<SchemaRelationExt, "id"> = {
        fromTable,
        fromField,
        toTable,
        toField,
        cardinality: asCardinality(op.cardinality)
      };
      const onUpdate = asFkAction(op.onUpdate);
      const onDelete = asFkAction(op.onDelete);
      if (onUpdate) relation.onUpdate = onUpdate;
      if (onDelete) relation.onDelete = onDelete;
      const next = upsertRelation(doc, relation);
      // Mantém o campo de origem coerente com a FK exportada.
      return {
        ...next,
        tables: next.tables.map((t) =>
          t.name === fromTable
            ? {
                ...t,
                fields: t.fields.map((f) =>
                  f.name === fromField ? { ...f, references: { table: toTable, field: toField } } : f
                )
              }
            : t
        )
      };
    }
    case "add_index": {
      const table = doc.tables.find((t) => t.name === asString(op.table));
      const fields = Array.isArray(op.fields) ? op.fields.map(asString).filter(Boolean) : [];
      if (!table || !fields.length) return doc;
      if (!fields.every((name) => table.fields.some((f) => f.name === name))) return doc;
      if (docIndexes(doc).some((index) => index.table === table.name && sameFields(index.fields, fields))) return doc;
      return { ...doc, indexes: [...docIndexes(doc), { table: table.name, fields, unique: asBool(op.unique) ?? false }] };
    }
    case "drop_index": {
      const tableName = asString(op.table);
      const fields = Array.isArray(op.fields) ? op.fields.map(asString).filter(Boolean) : [];
      const remaining = docIndexes(doc).filter((index) => !(index.table === tableName && sameFields(index.fields, fields)));
      if (remaining.length === docIndexes(doc).length) return doc;
      return { ...doc, indexes: remaining };
    }
    case "set_dialect": {
      const dialect = asString(op.dialect) as SqlDialect;
      return SQL_DIALECTS.includes(dialect) ? { ...doc, dialect } : doc;
    }
    default:
      return doc;
  }
}

/* -------------------------------- Export SQL ------------------------------ */

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
  }
};

function mapType(type: string, dialect: SqlDialect): string {
  const key = type.trim().toLowerCase();
  return TYPE_MAP[dialect][key] ?? type;
}

/** Base inteira "referenciável" por dialeto — para colunas de FK apontando serial. */
const REFERENCEABLE_INT: Record<SqlDialect, { serial: string; bigserial: string }> = {
  postgres: { serial: "integer", bigserial: "bigint" },
  mysql: { serial: "INT", bigserial: "BIGINT" },
  ansi: { serial: "INTEGER", bigserial: "BIGINT" },
  sqlite: { serial: "INTEGER", bigserial: "INTEGER" },
  mssql: { serial: "INT", bigserial: "BIGINT" }
};

/**
 * Tipo de uma coluna que REFERENCIA a PK dada. Colunas de FK nunca podem herdar
 * o auto-incremento (serial → INT IDENTITY/AUTO_INCREMENT): isso gera DDL
 * inválido (dois auto-incremento na mesma tabela em mssql/mysql). Mapeia
 * serial/bigserial para o inteiro simples e mantém os demais tipos.
 */
function referenceableType(type: string, dialect: SqlDialect): string {
  const key = type.trim().toLowerCase();
  if (key === "serial") return REFERENCEABLE_INT[dialect].serial;
  if (key === "bigserial") return REFERENCEABLE_INT[dialect].bigserial;
  return mapType(type, dialect);
}

function mapDefault(value: string, dialect: SqlDialect): string {
  if (dialect === "postgres" || value.toLowerCase() !== "now()") return value;
  return dialect === "mssql" ? "SYSUTCDATETIME()" : "CURRENT_TIMESTAMP";
}

function quote(name: string, dialect: SqlDialect): string {
  if (dialect === "mysql") return `\`${name}\``;
  if (dialect === "mssql") return `[${name}]`;
  return `"${name}"`;
}

/** DDL de uma coluna (sem indentação): nome, tipo mapeado, NULL e DEFAULT. */
function columnDdl(field: SchemaField, dialect: SqlDialect): string {
  const q = (name: string) => quote(name, dialect);
  let line = `${q(field.name)} ${mapType(field.type, dialect)}`;
  if (field.nullable !== true) line += " NOT NULL";
  if (field.defaultValue) line += ` DEFAULT ${mapDefault(field.defaultValue, dialect)}`;
  return line;
}

function renderCreateTable(table: SchemaTable, dialect: SqlDialect): string {
  const q = (name: string) => quote(name, dialect);
  const lines = table.fields.map((field) => `  ${columnDdl(field, dialect)}`);
  const pk = table.fields.filter((f) => f.primaryKey);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((f) => q(f.name)).join(", ")})`);
  for (const field of table.fields) {
    if (field.unique && !field.primaryKey) lines.push(`  UNIQUE (${q(field.name)})`);
  }
  const tail = dialect === "mysql" ? ") ENGINE=InnoDB;" : ");";
  return `CREATE TABLE ${q(table.name)} (\n${lines.join(",\n")}\n${tail}`;
}

/** Ações referenciais opcionais de uma FK, na ordem canônica ON UPDATE → ON DELETE. */
interface FkActions {
  onUpdate?: FkAction;
  onDelete?: FkAction;
}

function renderAddFk(
  table: string,
  field: string,
  refTable: string,
  refField: string,
  dialect: SqlDialect,
  actions?: FkActions
): string {
  const q = (name: string) => quote(name, dialect);
  let sql =
    `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(`fk_${table}_${field}`)} ` +
    `FOREIGN KEY (${q(field)}) REFERENCES ${q(refTable)} (${q(refField)})`;
  if (actions?.onUpdate) sql += ` ON UPDATE ${actions.onUpdate}`;
  if (actions?.onDelete) sql += ` ON DELETE ${actions.onDelete}`;
  return `${sql};`;
}

/** Chave estável de uma relação por seus endpoints (from → to). */
function relKey(fromTable: string, fromField: string, toTable: string, toField: string): string {
  return `${fromTable}\u0000${fromField}\u0000${toTable}\u0000${toField}`;
}

/** Índice das relações por endpoints — usado para ações de FK e junções n-n. */
function relationIndex(doc: SchemaDocExt): Map<string, SchemaRelationExt> {
  const map = new Map<string, SchemaRelationExt>();
  for (const r of doc.relations) map.set(relKey(r.fromTable, r.fromField, r.toTable, r.toField), r);
  return map;
}

/** PK de uma tabela para referência de junção (fallback: 1º campo ou id/uuid). */
function primaryKeyField(table: SchemaTable): SchemaField {
  return table.fields.find((f) => f.primaryKey) ?? table.fields[0] ?? { name: "id", type: "uuid" };
}

/**
 * Tabelas de junção derivadas das relações n-n: `<tabelaA>_<tabelaB>` com uma
 * FK para a PK de cada lado e PK composta das duas colunas. Retorna os CREATE
 * TABLE e os ALTER TABLE … ADD CONSTRAINT correspondentes.
 */
function renderJunctionTables(doc: SchemaDocExt, dialect: SqlDialect): { creates: string[]; fks: string[] } {
  const creates: string[] = [];
  const fks: string[] = [];
  const seen = new Set<string>();
  const byName = new Map(doc.tables.map((t) => [t.name, t]));
  const q = (name: string) => quote(name, dialect);
  for (const relation of doc.relations) {
    if (relation.cardinality !== "n-n") continue;
    const a = byName.get(relation.fromTable);
    const b = byName.get(relation.toTable);
    if (!a || !b) continue;
    const name = `${a.name}_${b.name}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const pkA = primaryKeyField(a);
    const pkB = primaryKeyField(b);
    const colA = `${a.name}_${pkA.name}`;
    let colB = `${b.name}_${pkB.name}`;
    if (colA === colB) colB = `${colB}_2`;
    const lines = [
      `  ${q(colA)} ${referenceableType(pkA.type, dialect)} NOT NULL`,
      `  ${q(colB)} ${referenceableType(pkB.type, dialect)} NOT NULL`,
      `  PRIMARY KEY (${q(colA)}, ${q(colB)})`
    ];
    const tail = dialect === "mysql" ? ") ENGINE=InnoDB;" : ");";
    creates.push(`CREATE TABLE ${q(name)} (\n${lines.join(",\n")}\n${tail}`);
    fks.push(renderAddFk(name, colA, a.name, pkA.name, dialect));
    fks.push(renderAddFk(name, colB, b.name, pkB.name, dialect));
  }
  return { creates, fks };
}

function renderCreateIndex(index: SchemaIndexDef, dialect: SqlDialect): string {
  const q = (name: string) => quote(name, dialect);
  return (
    `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(indexName(index))} ` +
    `ON ${q(index.table)} (${index.fields.map(q).join(", ")});`
  );
}

/**
 * CREATE TABLE com PK/UNIQUE/NULL/DEFAULT por dialeto, seguido das tabelas de
 * junção das relações n-n. FKs saem como ALTER TABLE ao final, em ordem estável
 * (tabela → campo; depois as FKs das junções), com ON UPDATE/ON DELETE quando
 * definidos na relação, seguidas dos CREATE INDEX (SchemaDocExt.indexes).
 */
export function exportSql(doc: SchemaDocExt, dialect: SqlDialect): string {
  const statements: string[] = [`-- Esquema: ${doc.name}`, `-- Dialeto: ${dialect}`, ""];
  const relations = relationIndex(doc);

  for (const table of doc.tables) {
    statements.push(renderCreateTable(table, dialect), "");
  }

  const junction = renderJunctionTables(doc, dialect);
  for (const create of junction.creates) statements.push(create, "");

  const fks: string[] = [];
  for (const table of doc.tables) {
    for (const field of table.fields) {
      if (!field.references) continue;
      const relation = relations.get(relKey(table.name, field.name, field.references.table, field.references.field));
      if (relation?.cardinality === "n-n") continue; // n-n é resolvido pela tabela de junção
      fks.push(renderAddFk(table.name, field.name, field.references.table, field.references.field, dialect, relation));
    }
  }
  fks.push(...junction.fks);
  if (fks.length) statements.push(...fks, "");

  const indexes = validIndexes(doc).map((index) => renderCreateIndex(index, dialect));
  if (indexes.length) statements.push(...indexes, "");
  return `${statements.join("\n").trimEnd()}\n`;
}

/* -------------------------------- Import SQL ------------------------------ */

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitNames(raw: string): string[] {
  return raw
    .split(",")
    .map((name) => name.replace(/[`"\s]/g, ""))
    .filter(Boolean);
}

/** `public.pedidos` / `` `db`.`t` `` → `pedidos` / `t`. O ERD é por tabela. */
function unqualify(raw: string): string {
  const parts = raw.split(".").map((piece) => piece.trim().replace(/^[`"]|[`"]$/g, ""));
  return parts[parts.length - 1];
}

function parseColumn(part: string): SchemaField | undefined {
  const head = part.match(/^[`"]?(\w+)[`"]?\s+([\s\S]+)$/);
  if (!head) return undefined;
  const name = head[1];
  const rest = head[2].trim();
  const typeMatch = rest.match(/^(\w+(?:\s*\([^)]*\))?(?:\s+(?:precision|varying))?(?:\s+auto_increment)?)/i);
  if (!typeMatch) return undefined;
  const type = typeMatch[1].replace(/\s+/g, " ").trim();
  const tail = rest.slice(typeMatch[0].length);
  const field: SchemaField = { name, type };
  if (!/not\s+null/i.test(tail)) field.nullable = true;
  if (/primary\s+key/i.test(tail)) field.primaryKey = true;
  if (/\bunique\b/i.test(tail)) field.unique = true;
  const def = tail.match(/default\s+((?:'[^']*')|(?:\w+\s*\([^)]*\))|[^\s,]+)/i);
  if (def) field.defaultValue = def[1];
  // REFERENCES pode vir qualificado (public.clientes) — o ERD guarda só a tabela.
  const ref = tail.match(/references\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(\s*[`"]?(\w+)[`"]?\s*\)/i);
  if (ref) field.references = { table: unqualify(ref[1]), field: ref[2] };
  return field;
}

/**
 * Parser básico de CREATE TABLE (nome, colunas, tipos, PRIMARY KEY, UNIQUE,
 * REFERENCES, ALTER TABLE … FOREIGN KEY e CREATE [UNIQUE] INDEX) —
 * suficiente para round-trip dos próprios exports de exportSql nos três dialetos.
 */
export function importSql(sql: string): SchemaDocExt {
  // Comentário de linha E de bloco: um dump real vem com cabeçalho /* … */,
  // e sem tirar isso o CREATE TABLE seguinte nem era reconhecido.
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const dialect: SqlDialect = /`|engine\s*=\s*innodb/i.test(clean)
    ? "mysql"
    : /\b(timestamptz|jsonb|serial)\b/i.test(clean)
      ? "postgres"
      : "ansi";

  let doc: SchemaDocExt = { name: "Schema importado", dialect, tables: [], relations: [] };

  // Nome pode vir qualificado por schema (public.pedidos, `db`.`t`) — sem
  // isto o dump inteiro era ignorado em silêncio.
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(([\s\S]*?)\)\s*(?:engine\s*=\s*\w+)?\s*;/gi;
  for (const match of clean.matchAll(createRe)) {
    const tableName = unqualify(match[1]);
    const fields: SchemaField[] = [];
    const foreignKeys: Array<{ fromField: string; toTable: string; toField: string }> = [];
    const pkNames = new Set<string>();
    const uniqueNames = new Set<string>();

    for (const part of splitTopLevel(match[2])) {
      const pk = part.match(/^primary\s+key\s*\(([^)]*)\)/i);
      if (pk) {
        for (const name of splitNames(pk[1])) pkNames.add(name);
        continue;
      }
      const uq = part.match(/^unique\s*(?:key\s*)?\(([^)]*)\)/i);
      if (uq) {
        for (const name of splitNames(uq[1])) uniqueNames.add(name);
        continue;
      }
      const fk = part.match(
        /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*[`"]?(\w+)[`"]?\s*\)\s*references\s+[`"]?(\w+)[`"]?\s*\(\s*[`"]?(\w+)[`"]?\s*\)/i
      );
      if (fk) {
        foreignKeys.push({ fromField: fk[1], toTable: unqualify(fk[2]), toField: fk[3] });
        continue;
      }
      const field = parseColumn(part);
      if (field) fields.push(field);
    }

    for (const field of fields) {
      if (pkNames.has(field.name)) field.primaryKey = true;
      if (uniqueNames.has(field.name)) field.unique = true;
      const fk = foreignKeys.find((entry) => entry.fromField === field.name);
      if (fk) field.references = { table: fk.toTable, field: fk.toField };
    }

    const table = makeTable(doc, tableName, fields);
    doc = withFieldRelations({ ...doc, tables: [...doc.tables, table] }, tableName, fields);
  }

  // Nomes qualificados nos dois lados (ALTER TABLE public.b … REFERENCES public.a).
  const alterRe =
    /alter\s+table\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s+add\s+(?:constraint\s+[`"]?\w+[`"]?\s+)?foreign\s+key\s*\(\s*[`"]?(\w+)[`"]?\s*\)\s*references\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(\s*[`"]?(\w+)[`"]?\s*\)/gi;
  for (const match of clean.matchAll(alterRe)) {
    doc = applyOps(doc, [
      { op: "add_relation", fromTable: unqualify(match[1]), fromField: match[2], toTable: unqualify(match[3]), toField: match[4], cardinality: "1-n" }
    ]);
  }

  const indexRe =
    /create\s+(unique\s+)?index\s+[`"]?\w+[`"]?\s+on\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(([^)]*)\)\s*;/gi;
  for (const match of clean.matchAll(indexRe)) {
    doc = applyOps(doc, [{ op: "add_index", table: unqualify(match[2]), fields: splitNames(match[3]), unique: Boolean(match[1]) }]);
  }
  return doc;
}

/* ---------------------- Migração: diff entre schemas ---------------------- */

interface FkEdge {
  table: string;
  field: string;
  refTable: string;
  refField: string;
  onUpdate?: FkAction;
  onDelete?: FkAction;
}

function fkEdges(doc: SchemaDocExt): Map<string, FkEdge> {
  const edges = new Map<string, FkEdge>();
  const relations = relationIndex(doc);
  for (const table of doc.tables) {
    for (const field of table.fields) {
      if (!field.references) continue;
      const relation = relations.get(relKey(table.name, field.name, field.references.table, field.references.field));
      if (relation?.cardinality === "n-n") continue; // n-n não vira FK simples no diff
      const edge: FkEdge = {
        table: table.name,
        field: field.name,
        refTable: field.references.table,
        refField: field.references.field
      };
      if (relation?.onUpdate) edge.onUpdate = relation.onUpdate;
      if (relation?.onDelete) edge.onDelete = relation.onDelete;
      edges.set(`${edge.table}.${edge.field}->${edge.refTable}.${edge.refField}`, edge);
    }
  }
  return edges;
}

function indexEntries(doc: SchemaDocExt): Map<string, SchemaIndexDef> {
  const entries = new Map<string, SchemaIndexDef>();
  for (const index of validIndexes(doc)) {
    entries.set(`${index.unique ? "u" : "i"}:${index.table}(${index.fields.join(",")})`, index);
  }
  return entries;
}

function renderAlterType(table: string, field: SchemaField, dialect: SqlDialect): string {
  const q = (name: string) => quote(name, dialect);
  if (dialect === "mysql") return `ALTER TABLE ${q(table)} MODIFY COLUMN ${columnDdl(field, dialect)};`;
  if (dialect === "postgres") {
    return `ALTER TABLE ${q(table)} ALTER COLUMN ${q(field.name)} TYPE ${mapType(field.type, dialect)};`;
  }
  return `ALTER TABLE ${q(table)} ALTER COLUMN ${q(field.name)} SET DATA TYPE ${mapType(field.type, dialect)};`;
}

/**
 * SQL de migração de `prev` para `next`, por dialeto, em ordem estável:
 * CREATE TABLE novas → DROP TABLE removidas → ADD COLUMN → ALTER TYPE →
 * DROP COLUMN → ADD/DROP CONSTRAINT FK → CREATE/DROP INDEX.
 * Rename de tabela/coluna sai como DROP + CREATE (limitação declarada).
 * Retorna um statement por item; array vazio = nenhum diff.
 */
export function diffSchemas(prev: SchemaDocExt, next: SchemaDocExt, dialect: SqlDialect): string[] {
  const q = (name: string) => quote(name, dialect);
  const statements: string[] = [];
  const prevByName = new Map(prev.tables.map((t) => [t.name, t]));
  const nextByName = new Map(next.tables.map((t) => [t.name, t]));

  for (const table of next.tables) {
    if (!prevByName.has(table.name)) statements.push(renderCreateTable(table, dialect));
  }
  for (const table of prev.tables) {
    if (!nextByName.has(table.name)) statements.push(`DROP TABLE ${q(table.name)};`);
  }

  for (const table of next.tables) {
    const before = prevByName.get(table.name);
    if (!before) continue;
    for (const field of table.fields) {
      const old = before.fields.find((f) => f.name === field.name);
      if (!old) {
        statements.push(`ALTER TABLE ${q(table.name)} ADD COLUMN ${columnDdl(field, dialect)};`);
      } else if (old.type !== field.type) {
        statements.push(renderAlterType(table.name, field, dialect));
      }
    }
    for (const field of before.fields) {
      if (!table.fields.some((f) => f.name === field.name)) {
        statements.push(`ALTER TABLE ${q(table.name)} DROP COLUMN ${q(field.name)};`);
      }
    }
  }

  const prevFks = fkEdges(prev);
  const nextFks = fkEdges(next);
  for (const [key, edge] of nextFks) {
    if (!prevFks.has(key)) statements.push(renderAddFk(edge.table, edge.field, edge.refTable, edge.refField, dialect, edge));
  }
  for (const [key, edge] of prevFks) {
    if (nextFks.has(key) || !nextByName.has(edge.table)) continue;
    statements.push(
      dialect === "mysql"
        ? `ALTER TABLE ${q(edge.table)} DROP FOREIGN KEY ${q(`fk_${edge.table}_${edge.field}`)};`
        : `ALTER TABLE ${q(edge.table)} DROP CONSTRAINT ${q(`fk_${edge.table}_${edge.field}`)};`
    );
  }

  const prevIdx = indexEntries(prev);
  const nextIdx = indexEntries(next);
  for (const [key, index] of nextIdx) {
    if (!prevIdx.has(key)) statements.push(renderCreateIndex(index, dialect));
  }
  for (const [key, index] of prevIdx) {
    if (nextIdx.has(key) || !nextByName.has(index.table)) continue;
    statements.push(
      dialect === "mysql" ? `DROP INDEX ${q(indexName(index))} ON ${q(index.table)};` : `DROP INDEX ${q(indexName(index))};`
    );
  }
  return statements;
}

/**
 * SQL de reversão (down) da migração `prev` → `next`: é exatamente o diff no
 * sentido oposto (`next` → `prev`). CREATE TABLE vira DROP TABLE, ADD COLUMN
 * vira DROP COLUMN, ADD CONSTRAINT vira DROP CONSTRAINT, e assim por diante.
 * Herda as mesmas limitações de diffSchemas (rename = DROP + CREATE).
 */
export function diffSchemasDown(prev: SchemaDocExt, next: SchemaDocExt, dialect: SqlDialect): string[] {
  return diffSchemas(next, prev, dialect);
}

/* ------------------- Persistência: parse seguro de JSON ------------------- */

/**
 * Valida JSON persistido (localStorage) de volta para SchemaDocExt.
 * Retorna null para JSON inválido ou shape irreconhecível — nunca lança.
 */
export function parseDocJson(raw: string | null): SchemaDocExt | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawDoc = value as Record<string, unknown>;
  const name = asString(rawDoc.name);
  if (!name || !Array.isArray(rawDoc.tables) || !Array.isArray(rawDoc.relations)) return null;
  const dialect = SQL_DIALECTS.includes(rawDoc.dialect as SqlDialect) ? (rawDoc.dialect as SqlDialect) : "postgres";

  const tables: SchemaTable[] = [];
  for (const entry of rawDoc.tables) {
    if (!entry || typeof entry !== "object") return null;
    const t = entry as Record<string, unknown>;
    const tableName = asString(t.name);
    if (!tableName || !Array.isArray(t.fields)) return null;
    tables.push({
      id: asString(t.id) || tableName,
      name: tableName,
      x: typeof t.x === "number" && Number.isFinite(t.x) ? t.x : GRID_ORIGIN,
      y: typeof t.y === "number" && Number.isFinite(t.y) ? t.y : GRID_ORIGIN,
      tone: asString(t.tone) || toneFor(tables.length),
      fields: t.fields.map(asField).filter((f): f is SchemaField => Boolean(f))
    });
  }

  const relations: SchemaRelationExt[] = [];
  for (const entry of rawDoc.relations) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const fromTable = asString(r.fromTable);
    const fromField = asString(r.fromField);
    const toTable = asString(r.toTable);
    const toField = asString(r.toField);
    if (!fromTable || !fromField || !toTable || !toField) continue;
    const relation: SchemaRelationExt = {
      id: asString(r.id) || relationId(fromTable, fromField, toTable, toField),
      fromTable,
      fromField,
      toTable,
      toField,
      cardinality: asCardinality(r.cardinality)
    };
    const onUpdate = asFkAction(r.onUpdate);
    const onDelete = asFkAction(r.onDelete);
    if (onUpdate) relation.onUpdate = onUpdate;
    if (onDelete) relation.onDelete = onDelete;
    relations.push(relation);
  }

  const indexes: SchemaIndexDef[] = [];
  if (Array.isArray(rawDoc.indexes)) {
    for (const entry of rawDoc.indexes) {
      if (!entry || typeof entry !== "object") continue;
      const i = entry as Record<string, unknown>;
      const table = asString(i.table);
      const fields = Array.isArray(i.fields) ? i.fields.map(asString).filter(Boolean) : [];
      if (table && fields.length) indexes.push({ table, fields, unique: asBool(i.unique) ?? false });
    }
  }

  const doc: SchemaDocExt = { name, dialect, tables, relations };
  if (indexes.length) doc.indexes = indexes;
  return doc;
}
