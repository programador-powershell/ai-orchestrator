/**
 * Superfície do especialista de FLUXO — o editor do pipeline.
 *
 * O grafo é SVG escrito à mão, com arestas ORTOGONAIS: cotovelo em ângulo reto
 * em vez de curva. Não é preferência estética — num fluxo o que se lê é "de que
 * porta sai, em que porta entra", e a linha reta com uma dobra deixa isso óbvio
 * mesmo com vinte nós na tela. A curva fica para o DAG da equipe, onde o que
 * importa é a hierarquia e não o roteamento.
 *
 * Os nós vêm do `tool.result` de `flow.validate`. A tela NÃO monta o fluxo: ela
 * mostra o que a conversa montou e o que a validação disse sobre ele.
 */

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Play, Workflow } from "lucide-react";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";

/* -------------------------------- modelo -------------------------------- */

interface FlowNode {
  id: string;
  label: string;
  kind: string;
  description: string;
  inputs: string[];
  outputs: string[];
  onError: string;
  config: [string, string][];
  x?: number;
  y?: number;
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface FlowIssue {
  level: "error" | "warn" | "info";
  message: string;
  nodeId: string;
}

interface FlowModel {
  nodes: FlowNode[];
  edges: FlowEdge[];
  issues: FlowIssue[];
  ok: boolean | null;
  /** O JSON cru do último `flow.validate` — é o que o botão de exportar grava. */
  raw: unknown;
}

const EMPTY_MODEL: FlowModel = { nodes: [], edges: [], issues: [], ok: null, raw: null };

/* --------------------------- geometria do grafo -------------------------- */

const NODE_W = 172;
const NODE_H = 66;
const GAP_X = 90;
const GAP_Y = 24;
const PAD = 22;

/* ------------------------------ parsing cru ----------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "sim" : "não";
  return "";
}

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = text(source[key]);
    if (found) return found;
  }
  return "";
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  const list: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) list.push(item.trim());
    else if (isRecord(item)) {
      const label = firstText(item, ["name", "id", "label", "port", "key"]);
      if (label) list.push(label);
    }
  }
  return list;
}

/** Achata a config do nó em pares chave/valor — o painel é uma lista, não um editor. */
function pairs(value: unknown): [string, string][] {
  if (!isRecord(value)) return [];
  const list: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    list.push([key, text(item) || JSON.stringify(item)]);
  }
  return list;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function listOf(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const wrapper of ["flow", "graph", "result", "data"]) {
    const nested = value[wrapper];
    if (!isRecord(nested)) continue;
    for (const key of keys) {
      const candidate = nested[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

function toNode(raw: unknown, index: number): FlowNode | null {
  if (!isRecord(raw)) return null;
  const id = firstText(raw, ["id", "name", "key"]) || `n${index + 1}`;
  return {
    id,
    label: firstText(raw, ["label", "title", "name"]) || id,
    kind: firstText(raw, ["kind", "type", "op", "action"]) || "etapa",
    description: firstText(raw, ["description", "detail", "summary", "goal"]),
    inputs: stringList(raw["inputs"] ?? raw["in"] ?? raw["input"]),
    outputs: stringList(raw["outputs"] ?? raw["out"] ?? raw["output"]),
    onError: firstText(raw, ["onError", "on_error", "fallback", "catch", "erro"]),
    config: pairs(raw["config"] ?? raw["params"] ?? raw["args"] ?? raw["options"]),
    x: numeric(raw["x"]),
    y: numeric(raw["y"])
  };
}

function toEdge(raw: unknown, index: number): FlowEdge | null {
  if (!isRecord(raw)) return null;
  const from = firstText(raw, ["from", "source", "src", "de"]);
  const to = firstText(raw, ["to", "target", "dst", "para"]);
  if (!from || !to) return null;
  return {
    id: firstText(raw, ["id"]) || `${from}->${to}-${index}`,
    from,
    to,
    label: firstText(raw, ["label", "condition", "when", "case"])
  };
}

function toIssue(raw: unknown): FlowIssue | null {
  if (typeof raw === "string" && raw.trim()) return { level: "error", message: raw.trim(), nodeId: "" };
  if (!isRecord(raw)) return null;
  const message = firstText(raw, ["message", "detail", "text", "error", "reason"]);
  if (!message) return null;
  const level = firstText(raw, ["level", "severity", "kind"]).toLowerCase();
  return {
    level: level.startsWith("warn") || level.startsWith("avis") ? "warn" : level.startsWith("info") ? "info" : "error",
    message,
    nodeId: firstText(raw, ["nodeId", "node", "id", "target"])
  };
}

function latestResult(lines: ConversationLine[], tool: string): ToolResult | null {
  let latest: ToolResult | null = null;
  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      // A validação que FALHA também carrega o fluxo, e é justamente a que a
      // pessoa precisa ver desenhada — por isso `ok` não filtra aqui.
      if (result.tool === tool && result.output) latest = result;
    }
  }
  return latest;
}

function buildModel(result: ToolResult | null): FlowModel {
  if (!result?.output) return EMPTY_MODEL;
  const parsed = parseJson(result.output);
  if (parsed === null) return EMPTY_MODEL;

  const nodes = listOf(parsed, ["nodes", "steps", "tasks"])
    .map((item, index) => toNode(item, index))
    .filter((node): node is FlowNode => node !== null);

  const edges = listOf(parsed, ["edges", "links", "connections", "transitions"])
    .map((item, index) => toEdge(item, index))
    .filter((edge): edge is FlowEdge => edge !== null);

  const issues = listOf(parsed, ["issues", "errors", "problems", "warnings"])
    .map((item) => toIssue(item))
    .filter((issue): issue is FlowIssue => issue !== null);

  const ok = isRecord(parsed) && typeof parsed["ok"] === "boolean" ? parsed["ok"] : null;

  return { nodes, edges, issues, ok, raw: parsed };
}

/** As duas partes desta superfície (palco e barra) leem o MESMO fluxo. */
function useFlowModel(): FlowModel {
  const lines = useApp((state) => state.lines);
  // MEMO EM DUAS ETAPAS, e não um só sobre `lines`: o array de linhas troca de
  // identidade A CADA delta do streaming, e o memo único reparseava o JSON
  // inteiro do resultado por token — para produzir um modelo idêntico, porque
  // o tool result não tinha mudado. A identidade do ToolResult sobrevive aos
  // deltas (patchLine preserva as linhas não tocadas), então a etapa cara só
  // roda quando chega resultado NOVO.
  const result = useMemo(() => latestResult(lines, "flow.validate"), [lines]);
  return useMemo(() => buildModel(result), [result]);
}

/* ------------------------------- layout --------------------------------- */

interface Placed extends FlowNode {
  px: number;
  py: number;
}

/**
 * Camada = maior distância até uma raiz. Só é calculada quando o payload não
 * traz x/y: fluxo que já veio posicionado tem posição por um motivo, e recalcular
 * seria desfazer o arranjo que alguém escolheu.
 */
function place(nodes: FlowNode[], edges: FlowEdge[]): { placed: Placed[]; width: number; height: number } {
  const index = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const cache = new Map<string, number>();
  const depthOf = (id: string, stack: Set<string>): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0; // ciclo: o validador reclama, a tela não trava
    stack.add(id);
    let depth = 0;
    for (const parent of incoming.get(id) ?? []) depth = Math.max(depth, depthOf(parent, stack) + 1);
    stack.delete(id);
    cache.set(id, depth);
    return depth;
  };

  const byColumn = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const column = depthOf(node.id, new Set<string>());
    byColumn.set(column, [...(byColumn.get(column) ?? []), node]);
  }

  const placed: Placed[] = [];
  for (const [column, bucket] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    bucket.forEach((node, row) => {
      placed.push({
        ...node,
        px: node.x ?? PAD + column * (NODE_W + GAP_X),
        py: node.y ?? PAD + row * (NODE_H + GAP_Y)
      });
    });
  }

  const width = Math.max(NODE_W + PAD * 2, ...placed.map((node) => node.px + NODE_W + PAD));
  const height = Math.max(NODE_H + PAD * 2, ...placed.map((node) => node.py + NODE_H + PAD));
  return { placed, width, height };
}

/** Cotovelo ortogonal. Quando o destino está atrás, a linha contorna por baixo. */
function orthogonal(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 - x1 > GAP_X / 2) {
    const middle = (x1 + x2) / 2;
    return `M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`;
  }
  const detour = Math.max(y1, y2) + NODE_H / 2 + GAP_Y / 2;
  return `M ${x1} ${y1} h 18 V ${detour} H ${x2 - 18} V ${y2} H ${x2}`;
}

/* --------------------------- barra do especialista ----------------------- */

/**
 * Ações da barra superior. Lê o mesmo store, então não recebe props — quem as
 * leva para o slot da barra do app é o portal `TopbarActions` do shell, montado
 * por `FlowSurface`. Sem esse portal os botões ficariam desenhados dentro do
 * palco (ou, como estava, em componente nenhum: exportado e nunca renderizado —
 * "Validar" e "Exportar JSON" não existiam na tela).
 */
function FlowActions() {
  const flow = useFlowModel();
  const busy = useApp((state) => state.busy);
  const send = useApp((state) => state.send);

  const exportJson = () => {
    if (flow.raw === null) return;
    // Blob + âncora: sem dependência nova e sem escrever no disco por fora do
    // diálogo do navegador — quem escolhe onde salvar é a pessoa.
    const blob = new Blob([JSON.stringify(flow.raw, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fluxo.json";
    anchor.click();
    // Revogar na mesma linha cancela o download em alguns webviews; um tick depois é seguro.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Fragmento, e não um `div.topbar-actions`: o host do portal JÁ é esse div
  // (shell/TopbarActions). Repetir a classe aqui aninharia duas barras e dobraria
  // o espaçamento entre os botões.
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => send("/validar")}
        title="Roda flow.validate sobre o fluxo atual"
      >
        <Play size={13} aria-hidden />
        Validar
      </button>
      <button
        type="button"
        className="btn"
        disabled={flow.raw === null}
        onClick={exportJson}
        title="Grava o JSON do último flow.validate"
      >
        <Download size={13} aria-hidden />
        Exportar JSON
      </button>
    </>
  );
}

/* ------------------------------ componente ------------------------------ */

export function FlowSurface() {
  const flow = useFlowModel();
  const [selected, setSelected] = useState("");

  const layout = useMemo(() => place(flow.nodes, flow.edges), [flow]);
  const active = layout.placed.find((node) => node.id === selected) ?? layout.placed[0] ?? null;
  const activeIssues = active ? flow.issues.filter((issue) => issue.nodeId === active.id) : [];
  const byId = useMemo(() => new Map(layout.placed.map((node) => [node.id, node])), [layout]);

  return (
    <section className="surface flow-surface">
      {/* Os botões desta superfície entram na barra do app por portal — o palco
          não desenha barra própria (ver shell/TopbarActions). */}
      <TopbarActions>
        <FlowActions />
      </TopbarActions>

      <div className="surface-toolbar">
        <span className="surface-title">Fluxo</span>
        {flow.ok !== null ? (
          <span className="badge-risk" data-risk={flow.ok ? "read" : "execute"}>
            {flow.ok ? "validado" : "com problema"}
          </span>
        ) : null}
        <span className="surface-toolbar-spacer" />
        <span className="chip">
          {flow.nodes.length} {flow.nodes.length === 1 ? "nó" : "nós"}
        </span>
        <span className="chip">
          {flow.edges.length} {flow.edges.length === 1 ? "ligação" : "ligações"}
        </span>
      </div>

      <div className="surface-body">
        {flow.nodes.length === 0 ? (
          <div className="surface-empty">
            <Workflow size={26} aria-hidden />
            <b>Nenhum fluxo na tela</b>
            <span>
              O fluxo é montado pela CONVERSA, não arrastando caixas: descreva o que deve acontecer e o
              especialista devolve os nós, as portas e o caminho de erro. <code>/validar</code> desenha
              o resultado aqui.
            </span>
          </div>
        ) : (
          <>
            {flow.issues.length > 0 ? (
              <ul className="flow-issues">
                {flow.issues.map((issue, index) => (
                  <li key={`${issue.nodeId}-${index}`} className="flow-issue" data-level={issue.level}>
                    <AlertCircle size={13} aria-hidden />
                    <span>{issue.message}</span>
                    {issue.nodeId ? (
                      <button type="button" className="chip" onClick={() => setSelected(issue.nodeId)}>
                        {issue.nodeId}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="grid-2 flow-split">
              <div className="flow-canvas">
                <svg
                  className="flow"
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  aria-label="Grafo do fluxo"
                >
                  {flow.edges.map((edge) => {
                    const from = byId.get(edge.from);
                    const to = byId.get(edge.to);
                    if (!from || !to) return null;
                    const x1 = from.px + NODE_W;
                    const y1 = from.py + NODE_H / 2;
                    const x2 = to.px;
                    const y2 = to.py + NODE_H / 2;
                    const lit = active?.id === edge.from || active?.id === edge.to;
                    return (
                      <g key={edge.id}>
                        <path
                          className="flow-edge"
                          data-state={lit ? "active" : undefined}
                          d={orthogonal(x1, y1, x2, y2)}
                        />
                        {/* A ponta da seta é desenhada à mão, na porta de entrada. */}
                        <path
                          className="flow-edge"
                          data-state={lit ? "active" : undefined}
                          d={`M ${x2 - 7} ${y2 - 4} L ${x2} ${y2} L ${x2 - 7} ${y2 + 4}`}
                        />
                        {edge.label ? (
                          <text
                            className="flow-label"
                            x={(x1 + x2) / 2}
                            y={(y1 + y2) / 2 - 6}
                            textAnchor="middle"
                          >
                            {edge.label}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}

                  {layout.placed.map((node) => {
                    const isActive = active?.id === node.id;
                    const broken = flow.issues.some(
                      (issue) => issue.nodeId === node.id && issue.level === "error"
                    );
                    // O nó reaproveita os estados do CSS: falha = failed (danger),
                    // selecionado = running (accent), o resto fica no traço neutro.
                    const state = broken ? "failed" : isActive ? "running" : undefined;
                    return (
                      <g
                        key={node.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.label} — ${node.kind}`}
                        onClick={() => setSelected(node.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelected(node.id);
                          }
                        }}
                      >
                        <title>{node.description || node.label}</title>
                        <rect
                          className="flow-node"
                          data-state={state}
                          x={node.px}
                          y={node.py}
                          width={NODE_W}
                          height={NODE_H}
                          rx={12}
                        />
                        {/* Porta de ENTRADA à esquerda, de SAÍDA à direita — sempre
                            nos mesmos lugares, para a leitura não depender do rótulo. */}
                        <circle
                          cx={node.px}
                          cy={node.py + NODE_H / 2}
                          r={4}
                          fill="var(--panel)"
                          stroke="var(--line-strong)"
                          strokeWidth={1.5}
                        />
                        <circle
                          cx={node.px + NODE_W}
                          cy={node.py + NODE_H / 2}
                          r={4}
                          fill="var(--line-strong)"
                        />
                        <text className="flow-label" x={node.px + 14} y={node.py + 22}>
                          {node.kind.toUpperCase().slice(0, 16)}
                        </text>
                        <text x={node.px + 14} y={node.py + 43}>
                          {node.label.length > 19 ? `${node.label.slice(0, 18)}…` : node.label}
                        </text>
                        {node.onError ? null : (
                          // Nó sem caminho de erro é o defeito mais comum do fluxo:
                          // funciona no exemplo e para na primeira falha real.
                          <circle
                            cx={node.px + NODE_W - 13}
                            cy={node.py + 13}
                            r={4}
                            fill="var(--warn)"
                          >
                            <title>sem caminho de erro</title>
                          </circle>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              <aside className="card flow-props" aria-label="Propriedades do nó">
                {active ? (
                  <>
                    <div className="card-head">
                      <span className="card-title">{active.label}</span>
                      <span className="chip">{active.kind}</span>
                    </div>
                    <p className="card-eyebrow">{active.id}</p>

                    {active.description ? <p className="card-body">{active.description}</p> : null}

                    <div className="card-body">
                      <span className="card-eyebrow">portas</span>
                      <p>entrada: {active.inputs.join(", ") || "—"}</p>
                      <p>saída: {active.outputs.join(", ") || "—"}</p>
                    </div>

                    <div className="card-body">
                      <span className="card-eyebrow">caminho de erro</span>
                      <p data-missing={active.onError ? undefined : "true"}>
                        {active.onError || "não definido — diga o que acontece quando este nó falha"}
                      </p>
                    </div>

                    {active.config.length > 0 ? (
                      <div className="card-body">
                        <span className="card-eyebrow">configuração</span>
                        <dl className="flow-config">
                          {active.config.map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ) : null}

                    {activeIssues.length > 0 ? (
                      <div className="card-foot">
                        <AlertCircle size={13} aria-hidden />
                        <span>{activeIssues.map((issue) => issue.message).join(" · ")}</span>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="card-body">Escolha um nó para ver as propriedades.</p>
                )}
              </aside>
            </div>
          </>
        )}
      </div>

      <div className="surface-status">
        <span>
          {flow.ok === null ? (
            "sem validação nesta sessão"
          ) : flow.ok ? (
            <>
              <CheckCircle2 size={11} aria-hidden /> fluxo validado
            </>
          ) : (
            <>
              <AlertCircle size={11} aria-hidden /> {flow.issues.length} problema(s)
            </>
          )}
        </span>
        <span className="surface-toolbar-spacer" />
        <span>fonte: flow.validate</span>
      </div>
    </section>
  );
}

export default FlowSurface;
