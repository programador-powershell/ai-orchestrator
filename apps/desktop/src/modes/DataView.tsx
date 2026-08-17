/**
 * Modo DATA — editor ERD estilo drawdb com chat-to-schema (canal ops:data),
 * arrasto de tabelas, relações em bezier, editor de campos e índices,
 * undo/redo (Ctrl+Z / Ctrl+Shift+Z), auto-layout por grau de conexões,
 * persistência local do diagrama e migração real por diff de snapshot.
 * O schema navegável vive no rail dinâmico (DataRail) e compartilha estado
 * com a view por um store zustand de módulo (doc, seleção, histórico, foco).
 * O input de chat é o Composer global; esta view só aplica as operações.
 */
import "../styles/modes/data.css";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import {
  Check,
  Copy,
  Database,
  Download,
  GitCompare,
  LayoutGrid,
  Link2,
  Plus,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  Undo2,
  Upload,
  X
} from "lucide-react";
import type { SchemaField, SchemaRelation, SchemaTable } from "@orchestrator/contracts";
import {
  EmptyHero,
  FloatingPulse,
  PanelScroll,
  PanelTitle,
  PromptCards,
  RowItem,
  Surface,
  TopbarActions,
  VBody,
  VCenter,
  VRight,
  VStatus
} from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { ErdCanvas, type LigacaoResolvida } from "../components/data/ErdCanvas";
import { opsBus } from "../lib/ops";
import {
  applyOps,
  autoLayout,
  dialectFieldTypes,
  diffSchemas,
  diffSchemasDown,
  emptyDoc,
  exportSql,
  importSql,
  indexName,
  parseDocJson,
  SQL_DIALECTS,
  type SchemaDocExt,
  type SchemaIndexDef
} from "../lib/schema";
import { renderErdSvg } from "../lib/erdSvg";
import { useApp } from "../lib/store";

/** Persistência local real: diagrama e snapshot de migração. */
const DOC_KEY = "data.schema.doc";
const SNAPSHOT_KEY = "data.schema.snapshot";
const HISTORY_LIMIT = 50;

const heroPrompts = [
  "Modele um SaaS multi-tenant com billing",
  "Crie tabelas de pedidos, itens e pagamentos",
  "Adicione auditoria com trilha de eventos"
];

function loadDoc(): SchemaDocExt {
  return parseDocJson(localStorage.getItem(DOC_KEY)) ?? emptyDoc("Schema");
}

function loadSnapshot(): SchemaDocExt | null {
  return parseDocJson(localStorage.getItem(SNAPSHOT_KEY));
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage indisponível/cheio: o editor continua funcionando em memória
  }
}

/* --------------- Store de módulo — estado compartilhado rail ↔ view -------- */

interface DataStore {
  doc: SchemaDocExt;
  snapshot: SchemaDocExt | null;
  selectedId: string | null;
  /** Pedido de centralização no canvas (rail → view); nonce dispara o efeito. */
  focusId: string | null;
  focusNonce: number;
  past: SchemaDocExt[];
  future: SchemaDocExt[];
  select: (id: string | null) => void;
  focusTable: (id: string) => void;
  /** Toda mutação passa por aqui: empilha o estado anterior (limite 50). */
  commitDoc: (next: SchemaDocExt | ((current: SchemaDocExt) => SchemaDocExt)) => void;
  /** Movimento ao vivo do arrasto — sem entrada de histórico por frame. */
  moveTable: (id: string, x: number, y: number) => void;
  /** Várias de uma vez: com seleção múltipla o arrasto move um grupo. */
  moveTables: (movidas: Array<{ id: string; x: number; y: number }>) => void;
  /** O arrasto inteiro vira UMA entrada de histórico (snapshot do início). */
  commitMove: (before: SchemaDocExt) => void;
  undo: () => void;
  redo: () => void;
  saveSnapshot: () => void;
  addTable: () => void;
}

const useDataStore = create<DataStore>()((set, get) => ({
  doc: loadDoc(),
  snapshot: loadSnapshot(),
  selectedId: null,
  focusId: null,
  focusNonce: 0,
  past: [],
  future: [],
  select: (id) => set({ selectedId: id }),
  focusTable: (id) => set((state) => ({ selectedId: id, focusId: id, focusNonce: state.focusNonce + 1 })),
  commitDoc: (next) => {
    const current = get().doc;
    const resolved = typeof next === "function" ? next(current) : next;
    if (resolved === current) return;
    set((state) => ({ doc: resolved, past: [...state.past.slice(1 - HISTORY_LIMIT), current], future: [] }));
  },
  moveTable: (id, x, y) =>
    set((state) => ({
      doc: { ...state.doc, tables: state.doc.tables.map((t) => (t.id === id ? { ...t, x, y } : t)) }
    })),
  moveTables: (movidas) =>
    set((state) => {
      const posicoes = new Map(movidas.map((item) => [item.id, item]));
      return {
        doc: {
          ...state.doc,
          tables: state.doc.tables.map((table) => {
            const nova = posicoes.get(table.id);
            return nova ? { ...table, x: nova.x, y: nova.y } : table;
          })
        }
      };
    }),
  commitMove: (before) => set((state) => ({ past: [...state.past.slice(1 - HISTORY_LIMIT), before], future: [] })),
  undo: () => {
    const { past, doc } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set((state) => ({ doc: previous, past: state.past.slice(0, -1), future: [...state.future, doc] }));
  },
  redo: () => {
    const { future, doc } = get();
    const next = future[future.length - 1];
    if (!next) return;
    set((state) => ({ doc: next, future: state.future.slice(0, -1), past: [...state.past, doc] }));
  },
  saveSnapshot: () => set({ snapshot: get().doc }),
  addTable: () => {
    const { doc, commitDoc, focusTable } = get();
    let index = doc.tables.length + 1;
    let name = `tabela_${index}`;
    while (doc.tables.some((table) => table.name === name)) name = `tabela_${++index}`;
    const next = applyOps(doc, [
      {
        op: "add_table",
        name,
        fields: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "criado_em", type: "timestamptz", defaultValue: "now()" }
        ]
      }
    ]);
    commitDoc(next);
    const created = next.tables.find((table) => table.name === name);
    if (created) focusTable(created.id);
    else set({ selectedId: null });
  }
}));

/** Persistência real: cada mudança vai para localStorage e volta ao abrir. */
useDataStore.subscribe((state, previous) => {
  if (state.doc !== previous.doc) persist(DOC_KEY, state.doc);
  if (state.snapshot !== previous.snapshot && state.snapshot) persist(SNAPSHOT_KEY, state.snapshot);
});

/*
 * As curvas das relações eram calculadas aqui, com a bezier escrita à mão.
 * Agora quem as desenha é o canvas (`ErdCanvas`), a partir das alças de cada
 * campo — e elas seguem a tabela sozinhas durante o arrasto, sem recalcular
 * o documento inteiro a cada quadro.
 */

function relationLabel(relation: SchemaRelation): string {
  return `${relation.fromTable}.${relation.fromField} → ${relation.toTable}.${relation.toField}`;
}

/* ------------------------- Rail dinâmico (DataRail) ------------------------ */

/** Rail da aba Data: schema navegável (tabelas/relações) + sessões reais. */
export function DataRail() {
  const doc = useDataStore((state) => state.doc);
  const selectedId = useDataStore((state) => state.selectedId);
  const focusTable = useDataStore((state) => state.focusTable);
  const addTable = useDataStore((state) => state.addTable);
  const [tab, setTab] = useState<"tables" | "relations">("tables");
  const [query, setQuery] = useState("");

  const term = query.trim().toLowerCase();
  const tables = doc.tables.filter(
    (table) => !term || table.name.toLowerCase().includes(term) || table.fields.some((f) => f.name.toLowerCase().includes(term))
  );
  const relations = doc.relations.filter((relation) => !term || relationLabel(relation).toLowerCase().includes(term));

  return (
    <>
      <span className="eyebrow">{`Schema · ${doc.tables.length}T · ${doc.relations.length}R`}</span>
      <div className="segmented datax-tabs">
        <button className={tab === "tables" ? "active" : ""} onClick={() => setTab("tables")}>
          <Table2 size={11} />
          Tabelas
        </button>
        <button className={tab === "relations" ? "active" : ""} onClick={() => setTab("relations")}>
          <Link2 size={11} />
          Relações
        </button>
      </div>
      <label className="rail-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar no schema…"
          aria-label="Buscar no schema"
        />
      </label>
      <div className="datax-rail-list">
        {tab === "tables"
          ? tables.map((table) => (
              <RowItem
                key={table.id}
                icon={<Table2 size={13} />}
                label={table.name}
                meta={`${table.fields.length} campos`}
                active={table.id === selectedId}
                onClick={() => focusTable(table.id)}
              />
            ))
          : relations.map((relation) => {
              const from = doc.tables.find((t) => t.name === relation.fromTable);
              return (
                <RowItem
                  key={relation.id}
                  icon={<Link2 size={13} />}
                  label={relationLabel(relation)}
                  meta={relation.cardinality}
                  active={Boolean(from && from.id === selectedId)}
                  onClick={() => {
                    if (from) focusTable(from.id);
                  }}
                />
              );
            })}
        {tab === "tables" && !tables.length && (
          <div className="datax-hint">
            {doc.tables.length ? "Nenhuma tabela encontrada." : "Sem tabelas ainda — peça no composer ou crie abaixo."}
          </div>
        )}
        {tab === "relations" && !relations.length && (
          <div className="datax-hint">{doc.relations.length ? "Nenhuma relação encontrada." : "Sem relações ainda."}</div>
        )}
      </div>
      <button className="lg-button datax-add" onClick={addTable}>
        <Plus size={13} />
        Add table
      </button>
      <span className="eyebrow">SESSÕES</span>
      <RailConversations mode="data" />
    </>
  );
}

/* ----------------------------- Construtor de índice ------------------------ */

/** Construtor de índice: escolhe campos na ordem do clique + flag UNIQUE. */
function IndexBuilder({ table, onCreate }: { table: SchemaTable; onCreate: (fields: string[], unique: boolean) => void }) {
  const [fields, setFields] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);

  function toggle(name: string) {
    setFields((current) => (current.includes(name) ? current.filter((f) => f !== name) : [...current, name]));
  }

  return (
    <div className="datax-indexbuilder">
      <div className="datax-indexfields">
        {table.fields.map((field) => (
          <button
            key={field.name}
            className={`datax-flag ${fields.includes(field.name) ? "on" : ""}`}
            onClick={() => toggle(field.name)}
            title={`Incluir ${field.name} no índice`}
          >
            {field.name}
          </button>
        ))}
      </div>
      <div className="datax-indexactions">
        <button className={`datax-flag ${unique ? "on" : ""}`} onClick={() => setUnique((value) => !value)} title="Índice único">
          UNIQUE
        </button>
        <button
          className="lg-button"
          disabled={!fields.length}
          onClick={() => {
            onCreate(fields, unique);
            setFields([]);
            setUnique(false);
          }}
        >
          <Plus size={13} />
          Criar índice
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- View ----------------------------------- */

export function DataView() {
  const sending = useApp((state) => state.threads.data.sending);
  const stage = useApp((state) => state.stage);

  const doc = useDataStore((state) => state.doc);
  const snapshot = useDataStore((state) => state.snapshot);
  const selectedId = useDataStore((state) => state.selectedId);
  const focusId = useDataStore((state) => state.focusId);
  const focusNonce = useDataStore((state) => state.focusNonce);
  const canUndo = useDataStore((state) => state.past.length > 0);
  const canRedo = useDataStore((state) => state.future.length > 0);
  const select = useDataStore((state) => state.select);
  const commitDoc = useDataStore((state) => state.commitDoc);
  const undo = useDataStore((state) => state.undo);
  const redo = useDataStore((state) => state.redo);
  const addTable = useDataStore((state) => state.addTable);
  const saveSnapshot = useDataStore((state) => state.saveSnapshot);

  const [modal, setModal] = useState<"export" | "import" | "migrate" | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [copied, setCopied] = useState(false);

  /** Canal chat → superfície: o Composer publica, a view aplica (com histórico). */
  useEffect(
    () => opsBus.subscribe("data", (ops) => useDataStore.getState().commitDoc((current) => applyOps(current, ops))),
    []
  );

  /** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — fora de inputs (que têm undo nativo). */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        useDataStore.getState().undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        useDataStore.getState().redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = doc.tables.find((table) => table.id === selectedId) ?? null;
  const sqlPreview = useMemo(() => (modal === "export" ? exportSql(doc, doc.dialect) : ""), [modal, doc]);

  /** Diff real snapshot → atual; alimenta o modal de migração e o status. */
  const migration = useMemo(() => (snapshot ? diffSchemas(snapshot, doc, doc.dialect) : []), [snapshot, doc]);
  const migrationSql = useMemo(() => (migration.length ? `${migration.join("\n\n")}\n` : ""), [migration]);
  const migrationDown = useMemo(() => (snapshot ? diffSchemasDown(snapshot, doc, doc.dialect) : []), [snapshot, doc]);
  const migrationDownSql = useMemo(() => (migrationDown.length ? `${migrationDown.join("\n\n")}\n` : ""), [migrationDown]);

  const problems = doc.relations.filter((relation) => {
    const from = doc.tables.find((t) => t.name === relation.fromTable);
    const to = doc.tables.find((t) => t.name === relation.toTable);
    return (
      !from ||
      !to ||
      !from.fields.some((f) => f.name === relation.fromField) ||
      !to.fields.some((f) => f.name === relation.toField)
    );
  }).length;

  const tableIndexes: SchemaIndexDef[] = selected ? (doc.indexes ?? []).filter((index) => index.table === selected.name) : [];

  /* ------------------------------- Ações --------------------------------- */

  function removeTable(table: SchemaTable) {
    commitDoc((current) => applyOps(current, [{ op: "drop_table", table: table.name }]));
    select(null);
  }

  function addField(table: SchemaTable) {
    let index = table.fields.length + 1;
    let name = `campo_${index}`;
    while (table.fields.some((field) => field.name === name)) name = `campo_${++index}`;
    commitDoc((current) => applyOps(current, [{ op: "add_field", table: table.name, field: { name, type: "text" } }]));
  }

  function removeField(table: SchemaTable, field: SchemaField) {
    commitDoc((current) => applyOps(current, [{ op: "drop_field", table: table.name, field: field.name }]));
  }

  function patchField(table: SchemaTable, index: number, patch: Partial<SchemaField>) {
    commitDoc((current) => ({
      ...current,
      tables: current.tables.map((t) =>
        t.id === table.id ? { ...t, fields: t.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : t
      )
    }));
  }

  function commitTableName(table: SchemaTable, raw: string): boolean {
    const name = raw.trim();
    if (!name || name === table.name) return false;
    if (doc.tables.some((t) => t.name === name)) return false;
    commitDoc((current) => applyOps(current, [{ op: "rename_table", table: table.name, name }]));
    return true;
  }

  function commitFieldName(table: SchemaTable, index: number, raw: string): boolean {
    const name = raw.trim();
    const current = table.fields[index]?.name;
    if (!current || !name || name === current) return false;
    if (table.fields.some((field, i) => i !== index && field.name === name)) return false;
    commitDoc((prev) => ({
      ...prev,
      tables: prev.tables.map((t) => ({
        ...t,
        fields: t.fields.map((f, i) => {
          const withRef =
            f.references && f.references.table === table.name && f.references.field === current
              ? { ...f, references: { table: table.name, field: name } }
              : f;
          return t.id === table.id && i === index ? { ...withRef, name } : withRef;
        })
      })),
      relations: prev.relations.map((r) => ({
        ...r,
        fromField: r.fromTable === table.name && r.fromField === current ? name : r.fromField,
        toField: r.toTable === table.name && r.toField === current ? name : r.toField
      })),
      indexes: (prev.indexes ?? []).map((entry) =>
        entry.table === table.name ? { ...entry, fields: entry.fields.map((f) => (f === current ? name : f)) } : entry
      )
    }));
    return true;
  }

  function setFieldReference(table: SchemaTable, index: number, raw: string) {
    const field = table.fields[index];
    if (!field) return;
    const [refTable, refField] = raw.split(".");
    commitDoc((current) => {
      const relations = current.relations.filter((r) => !(r.fromTable === table.name && r.fromField === field.name));
      const next: SchemaDocExt = {
        ...current,
        tables: current.tables.map((t) =>
          t.id === table.id
            ? {
                ...t,
                fields: t.fields.map((f, i) =>
                  i === index ? { ...f, references: raw ? { table: refTable, field: refField } : undefined } : f
                )
              }
            : t
        ),
        relations
      };
      if (!raw) return next;
      return {
        ...next,
        relations: [
          ...relations,
          {
            id: `rel_${table.name}_${field.name}__${refTable}_${refField}`,
            fromTable: table.name,
            fromField: field.name,
            toTable: refTable,
            toField: refField,
            cardinality: "1-n"
          }
        ]
      };
    });
  }

  function addIndex(table: SchemaTable, fields: string[], unique: boolean) {
    commitDoc((current) => applyOps(current, [{ op: "add_index", table: table.name, fields, unique }]));
  }

  function removeIndex(index: SchemaIndexDef) {
    commitDoc((current) => applyOps(current, [{ op: "drop_index", table: index.table, fields: index.fields }]));
  }

  function runAutoLayout() {
    commitDoc((current) => autoLayout(current));
  }

  /* ----------------------- Gestos na área de trabalho ---------------------- */
  /*
   * Zoom com a roda, arrasto do fundo, seleção múltipla e o traço da ligação
   * são do React Flow — o mesmo motor da aba Fluxo. O que sobra aqui é a
   * tradução do gesto para uma operação no documento do schema.
   */

  /** Ligou dois campos: vira FK, e a FK vira relação (uma entrada de undo). */
  function ligar({ origem, campoOrigem, destino, campoDestino }: LigacaoResolvida) {
    const alvo = destino.fields[campoDestino];
    if (!alvo) return;
    setFieldReference(origem, campoOrigem, `${destino.name}.${alvo.name}`);
  }

  /** Apagou a aresta: a referência do campo de origem some junto. */
  function desligar(relationId: string) {
    const relation = doc.relations.find((item) => item.id === relationId);
    if (!relation) return;
    const origem = doc.tables.find((table) => table.name === relation.fromTable);
    if (!origem) return;
    const indice = origem.fields.findIndex((field) => field.name === relation.fromField);
    if (indice < 0) return;
    setFieldReference(origem, indice, "");
  }

  /**
   * O arrasto inteiro vira UMA entrada de histórico (o estado do começo) —
   * inclusive quando várias tabelas foram arrastadas juntas.
   */
  function mover(movidas: Array<{ id: string; x: number; y: number }>, antes: SchemaDocExt) {
    const posicoes = new Map(movidas.map((item) => [item.id, item]));
    const atual = useDataStore.getState().doc;
    const mudou = atual.tables.some((table) => {
      const nova = posicoes.get(table.id);
      return nova && (table.x !== nova.x || table.y !== nova.y);
    });
    if (!mudou) return;
    // `moveTables` grava sem histórico e `commitMove` empilha o estado do
    // COMEÇO do gesto: as duas juntas fazem o arrasto inteiro — de uma ou de
    // dez tabelas — caber num único Ctrl+Z.
    useDataStore.getState().moveTables(movidas);
    useDataStore.getState().commitMove(antes);
  }

  /** Delete com seleção: tabelas e relações somem no MESMO passo de histórico. */
  function apagar(tabelas: SchemaTable[], relationIds: string[]) {
    if (!tabelas.length && !relationIds.length) return;
    const nomes = new Set(tabelas.map((table) => table.name));
    commitDoc((current) => {
      const semTabelas = applyOps(
        current,
        tabelas.map((table) => ({ op: "drop_table", table: table.name }))
      );
      // Relação apagada sozinha (aresta selecionada) precisa limpar a FK do
      // campo de origem; se a tabela toda foi embora, o drop_table já cuidou.
      const alvos = new Set(relationIds);
      return {
        ...semTabelas,
        tables: semTabelas.tables.map((table) => ({
          ...table,
          fields: table.fields.map((field) => {
            const relacao = current.relations.find(
              (item) => alvos.has(item.id) && item.fromTable === table.name && item.fromField === field.name
            );
            return relacao ? { ...field, references: undefined } : field;
          })
        })),
        relations: semTabelas.relations.filter(
          (relation) => !alvos.has(relation.id) && !nomes.has(relation.fromTable) && !nomes.has(relation.toTable)
        )
      };
    });
    select(null);
  }

  /* ----------------------------- Export/Import ---------------------------- */

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function downloadText(fileName: string, text: string) {
    const type = fileName.endsWith(".svg") ? "image/svg+xml" : "application/sql";
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function runImport() {
    const next = importSql(importText);
    if (!next.tables.length) {
      setImportError("Nenhum CREATE TABLE reconhecido no SQL colado.");
      return;
    }
    commitDoc(next);
    select(null);
    setImportText("");
    setImportError("");
    setModal(null);
  }

  /** Prompt com o schema REAL embutido — sem isso o modelo não vê o diagrama. */
  function askAgentForMigration() {
    const tables = doc.tables.map((table) => {
      const fields = table.fields
        .map((field) => {
          let spec = `${field.name} ${field.type}`;
          if (field.primaryKey) spec += " PK";
          if (field.unique) spec += " UQ";
          if (field.nullable) spec += " NULL";
          if (field.references) spec += ` -> ${field.references.table}.${field.references.field}`;
          return spec;
        })
        .join(", ");
      return `${table.name}(${fields})`;
    });
    const indexes = (doc.indexes ?? []).map(indexName);
    useApp
      .getState()
      .setInput(
        "Analise o schema e proponha a próxima migração.\n" +
          `Schema atual (${doc.dialect}): ${tables.join("; ")}` +
          (indexes.length ? `\nÍndices: ${indexes.join(", ")}` : "")
      );
  }

  const typeOptions = dialectFieldTypes[doc.dialect];

  /* --------------------------------- Render ------------------------------- */

  return (
    <Surface>
      <TopbarActions>
        <button className="lg-button ghost" onClick={() => { setImportError(""); setModal("import"); }}>
          <Upload size={13} />
          Importar SQL
        </button>
        <button className="lg-button ghost" onClick={() => setModal("migrate")}>
          <GitCompare size={13} />
          Migração
        </button>
        <button className="lg-button primary" onClick={() => setModal("export")}>
          <Download size={13} />
          Exportar SQL
        </button>
      </TopbarActions>

      <VBody>
        <VCenter>
          {sending && <FloatingPulse label={stage || "Processando"} detail="Aplicando operações do canal ops:data" />}
          <div className="infinite-canvas">
            {doc.tables.length ? (
              <ErdCanvas
                doc={doc}
                selectedId={selectedId}
                focusId={focusId}
                focusNonce={focusNonce}
                onSelect={select}
                onConnect={ligar}
                onDisconnect={desligar}
                onMove={mover}
                onDelete={apagar}
              />
            ) : (
              <>
                <div className="canvas-dots" />
                <EmptyHero
                  icon={<Database size={26} />}
                  kicker="MODELAGEM ASSISTIDA"
                  title="Comece pelo schema."
                  detail="Peça tabelas e relações no composer — o diagrama nasce das operações do chat e fica salvo localmente."
                >
                  <PromptCards prompts={heroPrompts} onPrompt={(prompt) => useApp.getState().setInput(prompt)} />
                </EmptyHero>
              </>
            )}
            {/* Zoom, enquadrar e minimapa são do canvas, no canto de sempre.
                Aqui ficam só as ações que são DESTA aba. */}
            <div className="canvas-controls datax-controls">
              <button
                disabled={!canUndo}
                onClick={undo}
                aria-label="Desfazer (Ctrl+Z)"
                title="Desfazer (Ctrl+Z)"
              >
                <Undo2 size={14} />
              </button>
              <button
                disabled={!canRedo}
                onClick={redo}
                aria-label="Refazer (Ctrl+Shift+Z)"
                title="Refazer (Ctrl+Shift+Z)"
              >
                <Redo2 size={14} />
              </button>
              <i />
              <button
                disabled={!doc.tables.length}
                onClick={runAutoLayout}
                aria-label="Auto-layout por conexões"
                title="Auto-layout por conexões"
              >
                <LayoutGrid size={14} />
              </button>
              <button onClick={addTable} aria-label="Adicionar tabela" title="Adicionar tabela">
                <Plus size={14} />
              </button>
            </div>
            {doc.tables.length > 0 && (
              <button className="canvas-ask" onClick={askAgentForMigration}>
                <Sparkles size={13} />
                Pedir ao agente
              </button>
            )}
          </div>

          {modal && (
            <div className="datax-overlay" onClick={() => setModal(null)}>
              <div
                className="datax-sql"
                role="dialog"
                aria-label={modal === "export" ? "SQL exportado" : modal === "import" ? "Importar SQL" : "Migração por snapshot"}
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <strong>
                    {modal === "export"
                      ? `Export SQL — ${doc.dialect}`
                      : modal === "import"
                        ? "Importar SQL"
                        : `Migração — snapshot → atual (${doc.dialect})`}
                  </strong>
                  <button className="icon-button" onClick={() => setModal(null)} aria-label="Fechar">
                    <X size={14} />
                  </button>
                </header>
                {modal === "export" && (
                  <>
                    <pre>{sqlPreview}</pre>
                    <footer>
                      <button className="lg-button" onClick={() => void copyText(sqlPreview)}>
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        {copied ? "Copiado" : "Copiar"}
                      </button>
                      <button className="lg-button" onClick={() => downloadText("schema.svg", renderErdSvg(doc))}>
                        <Download size={13} />
                        Baixar SVG
                      </button>
                      <button className="lg-button primary" onClick={() => downloadText("schema.sql", sqlPreview)}>
                        <Download size={13} />
                        Baixar schema.sql
                      </button>
                    </footer>
                  </>
                )}
                {modal === "import" && (
                  <>
                    <textarea
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                      placeholder={'Cole aqui o DDL — ex.: CREATE TABLE "users" (…);'}
                      aria-label="SQL para importar"
                    />
                    {importError && <small className="datax-error">{importError}</small>}
                    <small className="datax-note">Importar substitui o diagrama atual — Ctrl+Z desfaz.</small>
                    <footer>
                      <button className="lg-button" onClick={() => setModal(null)}>
                        Cancelar
                      </button>
                      <button className="lg-button primary" disabled={!importText.trim()} onClick={runImport}>
                        <Upload size={13} />
                        Importar
                      </button>
                    </footer>
                  </>
                )}
                {modal === "migrate" && (
                  <>
                    {!snapshot ? (
                      <div className="datax-migration-empty">
                        Nenhum snapshot salvo ainda. Salve o estado atual como base, continue editando o schema e volte
                        aqui para gerar o SQL de migração (CREATE/DROP/ALTER) do snapshot até a versão nova.
                      </div>
                    ) : migration.length ? (
                      <pre>{migrationSql}</pre>
                    ) : (
                      <div className="datax-migration-empty">
                        Nenhuma diferença entre o snapshot salvo e o schema atual.
                      </div>
                    )}
                    <footer>
                      {migration.length > 0 && (
                        <>
                          <button className="lg-button" onClick={() => void copyText(migrationSql)}>
                            {copied ? <Check size={13} /> : <Copy size={13} />}
                            {copied ? "Copiado" : "Copiar"}
                          </button>
                          <button className="lg-button" onClick={() => downloadText("migration.up.sql", migrationSql)}>
                            <Download size={13} />
                            Baixar up.sql
                          </button>
                          {migrationDownSql && (
                            <button className="lg-button" onClick={() => downloadText("migration.down.sql", migrationDownSql)}>
                              <Download size={13} />
                              Baixar down.sql
                            </button>
                          )}
                        </>
                      )}
                      <button className="lg-button primary" onClick={saveSnapshot}>
                        <Save size={13} />
                        Salvar snapshot
                      </button>
                    </footer>
                  </>
                )}
              </div>
            </div>
          )}
        </VCenter>

        <VRight>
          {selected ? (
            <>
              <PanelTitle icon={<Table2 size={13} />} label="Tabela" meta={selected.id} />
              <PanelScroll>
                <div className="datax-editor">
                  <label className="lg-field">
                    Nome da tabela
                    <input
                      key={`${selected.id}:${selected.name}`}
                      defaultValue={selected.name}
                      aria-label="Nome da tabela"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      onBlur={(event) => {
                        if (!commitTableName(selected, event.target.value)) event.target.value = selected.name;
                      }}
                    />
                  </label>

                  <div className="datax-subhead">
                    <span>Campos · {selected.fields.length}</span>
                    <button className="datax-iconbtn" onClick={() => addField(selected)} aria-label="Adicionar campo">
                      <Plus size={13} />
                    </button>
                  </div>

                  {selected.fields.map((field, index) => (
                    <div className="datax-fieldrow" key={`${selected.id}-${index}`}>
                      <div className="datax-fieldmain">
                        <input
                          key={`${selected.id}-${index}-${field.name}`}
                          defaultValue={field.name}
                          aria-label="Nome do campo"
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          onBlur={(event) => {
                            if (!commitFieldName(selected, index, event.target.value)) event.target.value = field.name;
                          }}
                        />
                        <select
                          value={field.type}
                          aria-label="Tipo do campo"
                          onChange={(event) => patchField(selected, index, { type: event.target.value })}
                        >
                          {(typeOptions.includes(field.type) ? typeOptions : [field.type, ...typeOptions]).map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                        <button
                          className="datax-iconbtn"
                          onClick={() => removeField(selected, field)}
                          aria-label={`Remover campo ${field.name}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="datax-flags">
                        <button
                          className={`datax-flag ${field.primaryKey ? "on" : ""}`}
                          onClick={() => patchField(selected, index, { primaryKey: !field.primaryKey })}
                          title="Chave primária"
                        >
                          PK
                        </button>
                        <button
                          className={`datax-flag ${field.unique ? "on" : ""}`}
                          onClick={() => patchField(selected, index, { unique: !field.unique })}
                          title="Valor único"
                        >
                          UQ
                        </button>
                        <button
                          className={`datax-flag ${field.nullable ? "on" : ""}`}
                          onClick={() => patchField(selected, index, { nullable: !field.nullable })}
                          title="Aceita nulo"
                        >
                          NULL
                        </button>
                        <select
                          className="datax-ref"
                          value={field.references ? `${field.references.table}.${field.references.field}` : ""}
                          aria-label="Referência (FK)"
                          onChange={(event) => setFieldReference(selected, index, event.target.value)}
                        >
                          <option value="">sem referência</option>
                          {doc.tables
                            .filter((table) => table.id !== selected.id)
                            .flatMap((table) => table.fields.map((f) => `${table.name}.${f.name}`))
                            .map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                  ))}

                  <div className="datax-subhead">
                    <span>Índices · {tableIndexes.length}</span>
                  </div>
                  {tableIndexes.map((index) => (
                    <div className="datax-indexrow" key={indexName(index)}>
                      <LayoutGrid size={12} />
                      <code title={indexName(index)}>{index.fields.join(", ")}</code>
                      {index.unique && <em>UNIQUE</em>}
                      <button
                        className="datax-iconbtn"
                        onClick={() => removeIndex(index)}
                        aria-label={`Remover índice ${indexName(index)}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <IndexBuilder key={selected.id} table={selected} onCreate={(fields, unique) => addIndex(selected, fields, unique)} />

                  <div className="datax-subhead">
                    <span>Dialeto SQL</span>
                  </div>
                  <div className="segmented datax-dialect">
                    {SQL_DIALECTS.map((dialect) => (
                      <button
                        key={dialect}
                        className={doc.dialect === dialect ? "active" : ""}
                        onClick={() => commitDoc((current) => applyOps(current, [{ op: "set_dialect", dialect }]))}
                      >
                        {dialect}
                      </button>
                    ))}
                  </div>

                  <div className="datax-actions">
                    <button className="lg-button datax-remove" onClick={() => removeTable(selected)}>
                      <Trash2 size={13} />
                      Remover tabela
                    </button>
                  </div>
                </div>
              </PanelScroll>
            </>
          ) : (
            <>
              <PanelTitle icon={<Table2 size={13} />} label="Editor" />
              <div className="datax-empty">
                <Table2 size={22} />
                <p>Selecione uma tabela no canvas ou no rail de schema para editar campos, chaves, índices e referências.</p>
              </div>
            </>
          )}
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <Table2 size={11} />
          {doc.tables.length} tabelas
        </span>
        <span>
          <Link2 size={11} />
          {doc.relations.length} relações
        </span>
        <span>
          <Database size={11} />
          {doc.dialect}
        </span>
        <span>
          <GitCompare size={11} />
          {snapshot ? `${migration.length} mudanças vs snapshot` : "sem snapshot"}
        </span>
        <span className="spacer" />
        <span>
          <Save size={11} />
          salvo localmente
        </span>
        <span>
          <ShieldCheck size={11} />
          {problems} problemas
        </span>
      </VStatus>
    </Surface>
  );
}
