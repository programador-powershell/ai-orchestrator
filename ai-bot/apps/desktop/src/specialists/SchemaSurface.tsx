/**
 * Superfície do especialista de DADOS.
 *
 * O ERD é SVG escrito à mão — não há biblioteca de grafo aprovada, e o desenho
 * aqui é simples: retângulo, linha ortogonal e texto.
 *
 * O layout é AUTOMÁTICO, e a tela diz isso em voz alta. A tentação era oferecer
 * arrastar as tabelas; o problema é que não existe onde guardar a posição — o
 * schema chega por `tool.result`, não é documento nosso —, então o arrasto se
 * perderia no próximo resultado. Arrasto que volta sozinho é pior do que arrasto
 * nenhum: ensina que a tela esquece.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Database, Download, LayoutGrid, TableProperties } from "lucide-react";
import type { ConversationLine, ToolResult } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";

/* -------------------------------- dialeto ------------------------------- */

const DIALECTS = ["postgres", "mysql", "ansi"] as const;
type Dialect = (typeof DIALECTS)[number];

const DIALECT_LABEL: Record<Dialect, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  ansi: "ANSI"
};

function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

/* --------------------------- leitura do tool.result --------------------- */

interface Column {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  required: boolean;
}

interface Table {
  name: string;
  columns: Column[];
  note: string;
}

type Cardinality = "1" | "n";

interface Relation {
  id: string;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  fromCard: Cardinality;
  toCard: Cardinality;
}

interface SchemaSnapshot {
  tables: Table[];
  relations: Relation[];
  sql: string;
  dialect: string;
}

const EMPTY: SchemaSnapshot = { tables: [], relations: [], sql: "", dialect: "" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function safeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function readColumns(value: unknown): Column[] {
  if (!Array.isArray(value)) return [];
  const out: Column[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item, type: "", pk: false, fk: false, required: false });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const name = asText(record.name) || asText(record.column) || asText(record.field);
    if (name === "") continue;
    out.push({
      name,
      type: asText(record.type) || asText(record.dataType),
      pk: asFlag(record.pk) || asFlag(record.primary) || asFlag(record.primaryKey),
      fk: asFlag(record.fk) || asFlag(record.foreign) || asFlag(record.foreignKey) || asText(record.references) !== "",
      // Sem afirmação explícita a coluna NÃO é marcada como obrigatória: pintar
      // NOT NULL que ninguém disse é inventar restrição em cima do schema.
      required: asFlag(record.notNull) || asFlag(record.required) || record.nullable === false
    });
  }
  return out;
}

function readTables(value: unknown): Table[] {
  if (!Array.isArray(value)) return [];
  const out: Table[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const name = asText(record.name) || asText(record.table);
    if (name === "") continue;
    out.push({
      name,
      columns: readColumns(record.columns ?? record.fields),
      note: asText(record.comment) || asText(record.note)
    });
  }
  return out;
}

/** Aceita "1-n", "1:N", "one-to-many", "many-to-many"… e devolve os dois lados. */
function readCardinality(value: unknown): { fromCard: Cardinality; toCard: Cardinality } {
  const raw = asText(value).toLowerCase().replace(/[\s_]/g, "");
  // Sem informação, o padrão é o caso comum de chave estrangeira: muitos de um
  // lado, um do outro.
  if (raw === "") return { fromCard: "n", toCard: "1" };
  if (/(n[-:]n|m[-:]n|n[-:]m|manytomany|many2many)/.test(raw)) return { fromCard: "n", toCard: "n" };
  if (/(1[-:]n|1[-:]m|onetomany|hasmany)/.test(raw)) return { fromCard: "1", toCard: "n" };
  if (/(n[-:]1|m[-:]1|manytoone|belongsto)/.test(raw)) return { fromCard: "n", toCard: "1" };
  if (/(1[-:]1|onetoone|hasone)/.test(raw)) return { fromCard: "1", toCard: "1" };
  return { fromCard: "n", toCard: "1" };
}

function readRelations(value: unknown): Relation[] {
  if (!Array.isArray(value)) return [];
  const out: Relation[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const from = asText(record.from) || asText(record.source) || asText(record.child);
    const to = asText(record.to) || asText(record.target) || asText(record.parent);
    if (from === "" || to === "") return;
    const { fromCard, toCard } = readCardinality(record.kind ?? record.cardinality ?? record.type);
    out.push({
      id: `${from}~${to}~${index}`,
      from,
      to,
      fromColumn: asText(record.fromColumn) || asText(record.column) || asText(record.fk),
      toColumn: asText(record.toColumn) || asText(record.references) || asText(record.pk),
      fromCard,
      toCard
    });
  });
  return out;
}

function parse(result: ToolResult): SchemaSnapshot {
  const raw = result.output ?? "";
  const root = asRecord(safeJson(raw));
  // `sql.render` pode devolver só o texto do DDL; isso ainda enche o rodapé.
  if (!root) return { ...EMPTY, sql: raw.trim() };

  const source = asRecord(root.schema) ?? root;
  return {
    tables: readTables(source.tables),
    relations: readRelations(source.relations ?? source.references ?? source.edges),
    sql: asText(root.sql) || asText(root.ddl),
    dialect: asText(root.dialect)
  };
}

/**
 * Junta os dois lados: `schema.export` costuma trazer as tabelas e `sql.render`
 * o texto. O mais recente de cada um vence — e o SQL segue o resultado que
 * chegou por último, que é o que a pessoa acabou de pedir.
 */
function readSchema(lines: ConversationLine[]): SchemaSnapshot {
  let structure: SchemaSnapshot | null = null;
  let sql = "";
  let dialect = "";

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const results = lines[index]?.toolResults;
    if (results === undefined) continue;
    for (let inner = results.length - 1; inner >= 0; inner -= 1) {
      const result = results[inner];
      if (result === undefined || !result.ok) continue;
      if (result.tool !== "schema.export" && result.tool !== "sql.render") continue;
      const parsed = parse(result);
      if (sql === "" && parsed.sql !== "") {
        sql = parsed.sql;
        dialect = parsed.dialect;
      }
      if (structure === null && parsed.tables.length > 0) structure = parsed;
    }
    if (structure !== null && sql !== "") break;
  }

  return {
    tables: structure?.tables ?? [],
    relations: structure?.relations ?? [],
    sql,
    dialect: dialect || structure?.dialect || ""
  };
}

/* ------------------------------ layout do ERD --------------------------- */

const CARD_W = 214;
const HEAD_H = 28;
const ROW_H = 18;
const PAD_Y = 8;
const GAP_X = 108;
const GAP_Y = 34;
/** Sobra à esquerda para as linhas que precisam contornar a coluna. */
const MARGIN_X = 64;
const MARGIN_Y = 24;

interface Placed {
  table: Table;
  x: number;
  y: number;
  h: number;
  hue: number;
}

interface Diagram {
  nodes: Placed[];
  byName: Map<string, Placed>;
  width: number;
  height: number;
}

function cardHeight(table: Table): number {
  return HEAD_H + PAD_Y * 2 + Math.max(1, table.columns.length) * ROW_H;
}

/**
 * Empacotamento por prateleira: a próxima tabela cai na coluna mais baixa. Uma
 * grade de linhas com altura fixa abriria buracos enormes ao lado de uma tabela
 * de trinta campos.
 */
function layout(tables: Table[]): Diagram {
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tables.length))));
  const heights = new Array<number>(columns).fill(0);
  const nodes: Placed[] = [];
  const byName = new Map<string, Placed>();

  tables.forEach((table, order) => {
    let column = 0;
    let lowest = heights[0] ?? 0;
    for (let candidate = 1; candidate < columns; candidate += 1) {
      const height = heights[candidate] ?? 0;
      if (height < lowest) {
        lowest = height;
        column = candidate;
      }
    }
    const node: Placed = {
      table,
      x: MARGIN_X + column * (CARD_W + GAP_X),
      y: MARGIN_Y + lowest,
      h: cardHeight(table),
      // O matiz só serve para separar as caixas a olho; fica na família fria do
      // especialista de dados para não brigar com o acento do app.
      hue: (172 + order * 29) % 360
    };
    heights[column] = lowest + node.h + GAP_Y;
    nodes.push(node);
    byName.set(table.name.toLowerCase(), node);
  });

  const tallest = heights.length > 0 ? Math.max(...heights) : 0;
  return {
    nodes,
    byName,
    width: MARGIN_X * 2 + columns * CARD_W + (columns - 1) * GAP_X,
    height: MARGIN_Y * 2 + Math.max(120, tallest - GAP_Y)
  };
}

/** Y da linha da coluna citada; sem coluna conhecida, o meio do cartão. */
function anchorY(node: Placed, column: string): number {
  if (column !== "") {
    const row = node.table.columns.findIndex((item) => item.name.toLowerCase() === column.toLowerCase());
    if (row >= 0) return node.y + HEAD_H + PAD_Y + row * ROW_H + ROW_H / 2;
  }
  return node.y + node.h / 2;
}

interface Wire {
  relation: Relation;
  path: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  midX: number;
  midY: number;
}

/**
 * Três segmentos ortogonais. Quando as duas tabelas caem na mesma coluna não há
 * corredor entre elas: a linha sai pela esquerda e contorna — é para isso que a
 * margem esquerda é maior que a de cima.
 */
function route(relation: Relation, a: Placed, b: Placed, order: number): Wire {
  const fromY = anchorY(a, relation.fromColumn);
  const toY = anchorY(b, relation.toColumn);
  // Desvio por relação para duas linhas paralelas não virarem uma só.
  const jitter = ((order % 3) - 1) * 11;

  if (b.x >= a.x + CARD_W) {
    const fromX = a.x + CARD_W;
    const toX = b.x;
    const midX = fromX + (toX - fromX) / 2 + jitter;
    return { relation, path: `M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}`, fromX, fromY, toX, toY, midX, midY: (fromY + toY) / 2 };
  }

  if (b.x + CARD_W <= a.x) {
    const fromX = a.x;
    const toX = b.x + CARD_W;
    const midX = toX + (fromX - toX) / 2 + jitter;
    return { relation, path: `M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}`, fromX, fromY, toX, toY, midX, midY: (fromY + toY) / 2 };
  }

  const lane = Math.min(a.x, b.x) - (22 + (order % 3) * 12);
  return {
    relation,
    path: `M ${a.x} ${fromY} H ${lane} V ${toY} H ${b.x}`,
    fromX: a.x,
    fromY,
    toX: b.x,
    toY,
    midX: lane,
    midY: (fromY + toY) / 2
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* -------------------------------- copiar -------------------------------- */

type CopyState = "idle" | "done" | "fail";

function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);

  function copy(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => setState("done"),
      () => setState("fail")
    );
  }

  return [state, copy];
}

/* --------------------------------- ERD ---------------------------------- */

function Erd({ snapshot }: { snapshot: SchemaSnapshot }): ReactNode {
  const diagram = useMemo(() => layout(snapshot.tables), [snapshot.tables]);
  const wires = useMemo(() => {
    const out: Wire[] = [];
    snapshot.relations.forEach((relation, order) => {
      const a = diagram.byName.get(relation.from.toLowerCase());
      const b = diagram.byName.get(relation.to.toLowerCase());
      // Relação para tabela que não veio no export vira ruído: sai de cena,
      // porque uma ponta solta sugere um erro de modelagem que não existe.
      if (a === undefined || b === undefined || a === b) return;
      out.push(route(relation, a, b, order));
    });
    return out;
  }, [snapshot.relations, diagram]);

  return (
    <svg
      className="erd"
      width={diagram.width}
      height={diagram.height}
      viewBox={`0 0 ${diagram.width} ${diagram.height}`}
      role="img"
      aria-label={`Diagrama com ${snapshot.tables.length} tabelas e ${wires.length} relações`}
    >
      {wires.map((item) => {
        const kind = `${item.relation.fromCard}-${item.relation.toCard}`;
        const from = `${item.relation.from}${item.relation.fromColumn ? `.${item.relation.fromColumn}` : ""}`;
        const to = `${item.relation.to}${item.relation.toColumn ? `.${item.relation.toColumn}` : ""}`;
        return (
          <g key={item.relation.id}>
            <title>{`${from} → ${to} (${kind})`}</title>
            <path className="erd-rel" d={item.path} />
            <circle cx={item.fromX} cy={item.fromY} r={2.5} className="erd-key" />
            <circle cx={item.toX} cy={item.toY} r={2.5} className="erd-key" />
            {/* A cardinalidade fica na ponta, junto da tabela a que se refere:
                lida no meio da linha ela não diz qual lado é qual. */}
            <text x={item.fromX + (item.midX > item.fromX ? 10 : -10)} y={item.fromY - 5} textAnchor="middle" fontSize={10}>
              {item.relation.fromCard}
            </text>
            <text x={item.toX + (item.midX > item.toX ? 10 : -10)} y={item.toY - 5} textAnchor="middle" fontSize={10}>
              {item.relation.toCard}
            </text>
            <text className="erd-column" x={item.midX} y={item.midY - 5} textAnchor="middle">
              {kind}
            </text>
          </g>
        );
      })}

      {diagram.nodes.map((node) => (
        <g key={node.table.name}>
          <title>{node.table.note || node.table.name}</title>
          <rect className="erd-table" x={node.x} y={node.y} width={CARD_W} height={node.h} rx={10} />
          {/* Cabeçalho com os cantos de baixo retos: um path evita precisar de
              clipPath só por causa de dois cantos. O matiz é DADO (uma cor por
              tabela), então vai em `style` — atributo de apresentação perderia
              para a regra .erd-table-head do CSS. */}
          <path
            className="erd-table-head"
            style={{ fill: `hsl(${node.hue} 44% 42%)` }}
            d={`M ${node.x} ${node.y + 10} a 10 10 0 0 1 10 -10 h ${CARD_W - 20} a 10 10 0 0 1 10 10 v ${HEAD_H - 10} h ${-CARD_W} Z`}
          />
          <text className="erd-table-name" x={node.x + 12} y={node.y + 18} fill="#ffffff">
            {truncate(node.table.name, 24)}
          </text>
          <text x={node.x + CARD_W - 12} y={node.y + 18} textAnchor="end" fontSize={9.5} fill="rgba(255,255,255,.75)">
            {node.table.columns.length}
          </text>

          {node.table.columns.map((column, row) => {
            const y = node.y + HEAD_H + PAD_Y + row * ROW_H + ROW_H - 6;
            return (
              <g key={column.name}>
                <text className={column.pk ? "erd-column erd-key" : "erd-column"} x={node.x + 12} y={y}>
                  {truncate(column.name, 18)}
                  {column.required ? " *" : ""}
                </text>
                <text className="erd-column" x={node.x + CARD_W - 12} y={y} textAnchor="end">
                  {column.pk ? "PK " : column.fk ? "FK " : ""}
                  {truncate(column.type, 12)}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

/* -------------------------------- superfície ---------------------------- */

export function SchemaSurface(): ReactNode {
  const lines = useApp((state) => state.lines);
  const send = useApp((state) => state.send);
  const busy = useApp((state) => state.busy);
  const setInput = useApp((state) => state.setInput);
  const snapshot = useMemo(() => readSchema(lines), [lines]);

  // O dialeto é preferência da tela, não do gateway: escolher aqui não reescreve
  // sozinho o SQL que já está na mão — quem regera é um botão explícito, porque
  // regerar custa uma ida ao modelo.
  const [dialect, setDialect] = useState<Dialect>("postgres");
  const [copyState, copy] = useCopy();
  const [exportState, exportSql] = useCopy();

  const columns = snapshot.tables.reduce((total, table) => total + table.columns.length, 0);
  const mismatch = snapshot.dialect !== dialect;

  return (
    <div className="surface schema-surface">
      <TopbarActions>
        <select
          className="model-select"
          value={dialect}
          aria-label="dialeto do SQL"
          title="dialeto usado ao pedir um SQL novo"
          onChange={(event) => {
            const next = event.target.value;
            if (isDialect(next)) setDialect(next);
          }}
        >
          {DIALECTS.map((item) => (
            <option key={item} value={item}>
              {DIALECT_LABEL[item]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={snapshot.sql === ""}
          title={snapshot.sql === "" ? "nenhum SQL gerado ainda" : "copia o SQL gerado para a área de transferência"}
          onClick={() => exportSql(snapshot.sql)}
        >
          {exportState === "done" ? <Check size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          {exportState === "done" ? "copiado" : exportState === "fail" ? "não deu" : "Exportar SQL"}
        </button>
      </TopbarActions>

      <div className="surface-toolbar">
        <TableProperties size={13} aria-hidden="true" />
        <span className="surface-title">Diagrama</span>
        <span className="chip">{snapshot.tables.length} tabelas</span>
        <span className="chip">{snapshot.relations.length} relações</span>
        <span className="surface-toolbar-spacer" />
        <span
          className="chip"
          title="As caixas são posicionadas por um empacotamento automático a cada resultado. Não existe arrastar porque não haveria onde guardar a posição — ela se perderia no próximo schema."
        >
          <LayoutGrid size={12} aria-hidden="true" />
          posição automática
        </span>
      </div>

      <div className="surface-body schema-split">
        {snapshot.tables.length === 0 ? (
          <div className="surface-empty">
            <Database size={22} aria-hidden="true" />
            <p>Sem schema ainda.</p>
            <p>
              Peça as tabelas ao especialista. O que voltar de <code>schema.export</code> ou{" "}
              <code>sql.render</code> vira este diagrama, e o SQL aparece no painel de baixo.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => setInput("/erd ")}
              title="preenche o campo de texto com o atalho"
            >
              Preencher /erd
            </button>
          </div>
        ) : (
          <Erd snapshot={snapshot} />
        )}

        <section className="card schema-sql">
          <div className="card-head">
            <Database size={13} aria-hidden="true" />
            <span className="card-title">SQL gerado</span>
            {snapshot.dialect !== "" ? <span className="chip">{snapshot.dialect}</span> : null}
            <span className="surface-toolbar-spacer" />
            {mismatch ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                title={
                  snapshot.sql === ""
                    ? `pede o SQL em ${DIALECT_LABEL[dialect]}`
                    : `o texto abaixo veio em ${snapshot.dialect || "dialeto não informado"}; pedir de novo em ${DIALECT_LABEL[dialect]}`
                }
                onClick={() => send(`/sql ${dialect}`)}
              >
                Gerar em {DIALECT_LABEL[dialect]}
              </button>
            ) : null}
            <button
              type="button"
              className="btn icon-btn"
              disabled={snapshot.sql === ""}
              title={copyState === "fail" ? "não deu para copiar" : "copiar o SQL"}
              onClick={() => copy(snapshot.sql)}
            >
              {copyState === "done" ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          {snapshot.sql !== "" ? (
            <pre className="sql-block">
              <code>{snapshot.sql}</code>
            </pre>
          ) : (
            <div className="card-body">
              Nenhum SQL ainda. Peça <code>/sql</code> e o DDL do dialeto escolhido aparece aqui.
            </div>
          )}
        </section>
      </div>

      <div className="surface-status">
        <span>
          tabelas <b>{snapshot.tables.length}</b>
        </span>
        <span>
          colunas <b>{columns}</b>
        </span>
        <span>
          relações <b>{snapshot.relations.length}</b>
        </span>
        <span>
          dialeto <b>{DIALECT_LABEL[dialect]}</b>
        </span>
      </div>
    </div>
  );
}

export default SchemaSurface;
