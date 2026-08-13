/**
 * Agent — flow builder visual sobre um DAG real (lib/dag.ts).
 *
 * O grafo é desenhado de verdade: topoWaves vira colunas (layout
 * determinístico por grid), cada nó é um cartão glass com portas de
 * entrada/saída e os conectores são beziers SVG calculados das posições
 * reais — com traço animado enquanto o nó executa. Conectar é clicar na
 * porta de saída de A e depois na porta de entrada de B (connect/disconnect
 * de dag.ts, com o aviso real do detectCycle). "Executar" roda as ondas e
 * dispara chatOnce por nó agent; gate/human pausam com popup de aprovação
 * no próprio nó. Rail (paleta, roster, import/export) e view compartilham o
 * mesmo store zustand de módulo. Sem motor, respostas em modo demo rotulado.
 */
import "../styles/modes/agent.css";
import "../styles/modes/ship.css";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { create } from "zustand";
import {
  Bot,
  Check,
  Clock3,
  Download,
  Link2,
  Maximize,
  Merge,
  Network,
  Play,
  RotateCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserCheck,
  Waypoints,
  X,
  Zap,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EngineSelection, OrchestrationGraph, UiMode } from "@ai-orchestrator/contracts";
import {
  addNode,
  connect,
  detectCycle,
  disconnect,
  edgeCount,
  fromJson,
  nextId,
  releaseTrainDoc,
  removeNode,
  toJson,
  topoWaves,
  updateNode,
  type DagDoc,
  type DagNode,
  type DagNodeKind
} from "../lib/dag";
import { chatOnce, describeSelection, type EngineContext } from "../lib/engine";
import { validateOrchestration, type ChatMessage } from "../lib/gateway";
import {
  RUN_STORAGE_KEY,
  docFingerprint,
  isRefusal,
  makeRun,
  parseRun,
  planResume,
  serializeRun,
  type NodeRun,
  type PersistedRun,
  type ResumePlan,
  type RunState,
  type RunStatus
} from "../lib/agentRun";
import { runWithLimit } from "../lib/pool";
import { AgentTreeView } from "../components/AgentTreeView";
import { CrewRail, CrewView } from "../components/CrewView";
import { SpecFlowView } from "../components/SpecFlowView";
import { useApp } from "../lib/store";
import { Markdown } from "../components/Markdown";
import { RailConversations } from "../components/RailConversations";
import {
  FloatingPulse,
  PanelScroll,
  PanelTitle,
  Surface,
  TopbarActions,
  VBody,
  VCenter,
  VRight,
  VStatus
} from "../components/Primitives";

/* ------------------------------ modelo ------------------------------ */

type PaletteKind = Extract<DagNodeKind, "agent" | "tool" | "gate" | "human">;

// RunStatus/NodeRun vivem em lib/agentRun.ts — o formato é o mesmo que vai
// para o disco, e duplicar aqui deixaria os dois divergirem.

interface RunSummary {
  durationMs: number;
  ok: number;
  failed: number;
  total: number;
}

const kindIcon: Record<DagNodeKind, LucideIcon> = {
  input: Sparkles,
  agent: Bot,
  tool: Zap,
  gate: ShieldCheck,
  human: UserCheck,
  merge: Merge
};

const kindLabel: Record<DagNodeKind, string> = {
  input: "Entrada",
  agent: "Agente",
  tool: "Ferramenta",
  gate: "Gate",
  human: "Humano",
  merge: "Merge"
};

const runStatusText: Record<RunStatus, string> = {
  queued: "fila",
  running: "rodando",
  waiting: "aprovação",
  done: "feito",
  failed: "falhou",
  skipped: "pulado"
};

const paletteKinds: PaletteKind[] = ["agent", "tool", "gate", "human"];
const fusionModes: UiMode[] = ["agent", "chat", "work", "code", "design", "security"];
const DEMO_MARK = "modo demonstração";

function selectionValue(selection: EngineSelection): string {
  if (selection.kind === "fusion") return `fusion:${selection.presetId}`;
  if (selection.kind === "local") return "local";
  if (selection.kind === "model") return "model";
  return "workspace";
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/* -------------------- store compartilhado rail ↔ view ---------------- */

interface FlowState {
  doc: DagDoc;
  selectedId: string;
  connectFrom: string | null;
  notice: string;
  runs: Record<string, NodeRun>;
  running: boolean;
  runningNode: string;
  lastRun: RunSummary | null;
}

/** Store zustand de módulo: AgentRail e AgentView editam o MESMO fluxo. */
const useFlow = create<FlowState>(() => ({
  doc: releaseTrainDoc(),
  selectedId: "planner",
  connectFrom: null,
  notice: "Flow builder — porta de saída → porta de entrada conecta",
  runs: {},
  running: false,
  runningNode: "",
  lastRun: null
}));

function report(cause: unknown) {
  useFlow.setState({ notice: cause instanceof Error ? cause.message : String(cause) });
}

function patchRun(id: string, patch: Partial<NodeRun> | ((run: NodeRun) => NodeRun)) {
  useFlow.setState((state) => {
    const base = state.runs[id] ?? { status: "queued" as RunStatus, output: "" };
    const next = typeof patch === "function" ? patch(base) : { ...base, ...patch };
    return { runs: { ...state.runs, [id]: next } };
  });
}

/* --------------------------- edição do DAG --------------------------- */

function selectNode(id: string) {
  useFlow.setState({ selectedId: id });
}

/** Clique na porta de saída: define (ou alterna) a origem da conexão. */
function startConnect(id: string) {
  const { connectFrom } = useFlow.getState();
  useFlow.setState({ connectFrom: connectFrom === id ? null : id, selectedId: id });
}

/** Clique na porta de entrada: fecha a aresta origem → destino no doc real. */
function completeConnect(to: string) {
  const { doc, connectFrom } = useFlow.getState();
  if (!connectFrom) {
    useFlow.setState({ selectedId: to, notice: "Escolha primeiro uma porta de saída para conectar." });
    return;
  }
  const names = new Map(doc.nodes.map((node) => [node.id, node.name]));
  try {
    const next = connect(doc, connectFrom, to); // auto-referência lança aqui
    const created = detectCycle(next);
    if (created) {
      useFlow.setState({ notice: `Conexão recusada — criaria ciclo: ${created.join(" → ")}` });
    } else {
      useFlow.setState({ doc: next, notice: `Conectado ${names.get(connectFrom) ?? connectFrom} → ${names.get(to) ?? to}` });
    }
  } catch (cause) {
    report(cause);
  }
  useFlow.setState({ connectFrom: null });
}

/** Clique no corpo do nó: seleciona (ou conclui a conexão em andamento). */
function onNodeClick(id: string) {
  if (useFlow.getState().connectFrom) completeConnect(id);
  else selectNode(id);
}

function addKind(kind: PaletteKind) {
  const { doc, selectedId, running } = useFlow.getState();
  if (running) return;
  const id = nextId(doc, kind);
  const anchor = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const deps = anchor ? [anchor.id] : [];
  try {
    const next = addNode(doc, {
      id,
      name: `${kindLabel[kind]} ${id.split("-").at(-1)}`,
      kind,
      dependsOn: deps,
      ...(kind === "agent" ? { prompt: "" } : {})
    });
    useFlow.setState({
      doc: next,
      selectedId: id,
      notice: deps.length ? `"${id}" criado após ${anchor?.name}` : `"${id}" criado como raiz`
    });
  } catch (cause) {
    report(cause);
  }
}

function removeEdge(dep: string, to: string) {
  const { doc } = useFlow.getState();
  try {
    useFlow.setState({ doc: disconnect(doc, dep, to), notice: `Aresta removida: ${dep} → ${to}` });
  } catch (cause) {
    report(cause);
  }
}

function deleteSelected() {
  const { doc, selectedId } = useFlow.getState();
  const node = doc.nodes.find((entry) => entry.id === selectedId);
  if (!node) return;
  try {
    const next = removeNode(doc, node.id);
    useFlow.setState({
      doc: next,
      selectedId: next.nodes[0]?.id ?? "",
      notice: `Nó "${node.name}" removido — arestas limpas`
    });
  } catch (cause) {
    report(cause);
  }
}

/* ------------------------- import / export -------------------------- */

function exportJson() {
  const { doc } = useFlow.getState();
  const blob = new Blob([toJson(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${doc.name.toLowerCase().replace(/\s+/g, "-")}.dag.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  useFlow.setState({ notice: `Exportado ${anchor.download} (${doc.nodes.length} nós, ${edgeCount(doc)} arestas)` });
}

function importJsonText(text: string) {
  try {
    const next = fromJson(text);
    const imported = detectCycle(next);
    useFlow.setState({
      doc: next,
      runs: {},
      lastRun: null,
      connectFrom: null,
      selectedId: next.nodes[0]?.id ?? "",
      notice: imported
        ? `Importado com ciclo: ${imported.join(" → ")}`
        : `Importado "${next.name}" · ${next.nodes.length} nós`
    });
  } catch (cause) {
    report(cause);
  }
}

/* ---------------------- geometria determinística --------------------- */

const NODE_W = 190;
const NODE_H = 54;
const GAP_X = 84;
const GAP_Y = 30;
const PAD_X = 28;
const PAD_TOP = 46;
const PAD_BOTTOM = 96;

interface XY {
  x: number;
  y: number;
}

/**
 * Grid por ondas: cada onda do topoWaves é uma coluna; dentro da onda os nós
 * viram linhas centralizadas. Com ciclo (waves null) cai em uma coluna por nó.
 */
function computeLayout(doc: DagDoc, waves: string[][] | null) {
  const columns = waves ?? doc.nodes.map((node) => [node.id]);
  const rows = columns.reduce((max, column) => Math.max(max, column.length), 1);
  const innerH = rows * NODE_H + (rows - 1) * GAP_Y;
  const pos = new Map<string, XY>();
  columns.forEach((column, columnIndex) => {
    const columnH = column.length * NODE_H + (column.length - 1) * GAP_Y;
    const yStart = PAD_TOP + (innerH - columnH) / 2;
    column.forEach((id, rowIndex) => {
      pos.set(id, { x: PAD_X + columnIndex * (NODE_W + GAP_X), y: yStart + rowIndex * (NODE_H + GAP_Y) });
    });
  });
  const width = PAD_X * 2 + Math.max(1, columns.length) * NODE_W + Math.max(0, columns.length - 1) * GAP_X;
  const height = PAD_TOP + innerH + PAD_BOTTOM;
  return { pos, width, height };
}

/** Bezier horizontal porta de saída → porta de entrada. */
function edgePath(from: XY, to: XY): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const reach = Math.max(30, Math.min(96, Math.abs(x2 - x1) * 0.5));
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

/** Estado visual da aresta a partir dos runs reais dos dois extremos. */
function edgeTone(runs: Record<string, NodeRun>, from: string, to: string): string {
  const target = runs[to]?.status;
  const source = runs[from]?.status;
  if (target === "running") return "active";
  if (target === "waiting") return "waiting";
  if (target === "failed") return "failed";
  if (source === "done" && target === "done") return "done";
  return "";
}

/* ---------------------------- execução ------------------------------ */

const approvals = new Map<string, (approved: boolean) => void>();
let abortController: AbortController | null = null;

function decide(id: string, approved: boolean) {
  approvals.get(id)?.(approved);
}

function stopRun() {
  abortController?.abort();
  for (const resolve of approvals.values()) resolve(false);
  approvals.clear();
}

/* ------------------------ persistência de runs ----------------------- */

/** Execução salva no disco do navegador — sobrevive a reload e a crash da aba. */
function saveRun(doc: DagDoc, state: RunState, startedAt: number) {
  if (typeof window === "undefined") return;
  const runs = useFlow.getState().runs;
  const record: PersistedRun = {
    ...makeRun(doc, startedAt),
    state,
    ...(state === "running" ? {} : { finishedAt: Date.now() }),
    runs
  };
  try {
    window.localStorage.setItem(RUN_STORAGE_KEY, serializeRun(record));
  } catch {
    // Cota estourada não pode derrubar a execução — persistência é acessório.
  }
}

function loadRun(): PersistedRun | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(RUN_STORAGE_KEY);
  return raw ? parseRun(raw) : null;
}

/** Retoma a última execução reaproveitando só os nós que terminaram bem. */
function resumeGraph() {
  const { doc, running } = useFlow.getState();
  if (running) return;
  const plan = planResume(doc, loadRun());
  if (isRefusal(plan)) {
    useFlow.setState({ notice: plan.message });
    return;
  }
  void runGraph(plan);
}

async function runGraph(resume?: ResumePlan) {
  const { doc, running } = useFlow.getState();
  if (running) return;
  const cycle = detectCycle(doc);
  if (cycle) {
    useFlow.setState({ notice: `Não executa com ciclo: ${cycle.join(" → ")}` });
    return;
  }
  let plan: string[][] = [];
  try {
    plan = topoWaves(doc);
  } catch {
    plan = [];
  }
  if (!plan.length) {
    useFlow.setState({ notice: "Nada a executar — o documento está vazio." });
    return;
  }
  const app = useApp.getState();
  const selection = app.settings.engines.agent;
  const nodeMap = new Map(doc.nodes.map((node) => [node.id, node]));
  const abort = new AbortController();
  abortController = abort;
  const skip = new Set(resume?.reuse ?? []);
  const initial: Record<string, NodeRun> = {};
  for (const node of doc.nodes) {
    initial[node.id] = skip.has(node.id)
      ? { status: "done", output: resume?.outputs.get(node.id) ?? "", note: "reaproveitado da execução anterior" }
      : { status: "queued", output: "" };
  }
  const startedAt = Date.now();
  useFlow.setState({ running: true, connectFrom: null, runs: initial });

  const ctx: EngineContext = {
    session: app.session,
    runtimeRunning: app.runtimeStatus.running,
    fusionPresets: app.settings.fusionPresets
  };
  // Com a onda em paralelo um único nome mentiria: mostra a contagem. Chave é
  // o id do nó (não o rótulo), senão o nó que troca de rótulo ao entrar em
  // aprovação nunca sairia do mapa e a contagem só cresceria.
  const liveNodes = new Map<string, string>();
  const publishLabel = () => {
    const rest = [...liveNodes.values()];
    useFlow.setState({
      runningNode: rest.length > 1 ? `${rest.length} nós em paralelo` : (rest[0] ?? "")
    });
  };
  const setRunningLabel = (id: string, name: string) => {
    liveNodes.set(id, name);
    publishLabel();
  };
  const clearRunningLabel = (id: string) => {
    liveNodes.delete(id);
    publishLabel();
  };
  // Saídas reaproveitadas entram já preenchidas: os nós seguintes recebem o
  // mesmo contexto que receberiam se tudo tivesse rodado agora.
  const outputs = new Map<string, string>(resume?.outputs ?? []);
  const blocked = new Set<string>();
  let ok = skip.size;
  let failed = 0;
  const t0 = performance.now();

  /**
   * Executa UM nó. Extraído do laço para a onda poder rodar em paralelo:
   * nós da mesma onda não dependem entre si, então concorrem sem corrida —
   * `outputs` e `blocked` só são lidos de ondas anteriores.
   */
  async function runNode(id: string): Promise<void> {
    // finally: sem isto o nó nunca sai do rótulo e a contagem de paralelos
    // ficaria crescendo até o fim da execução.
    try {
      const node = nodeMap.get(id);
      if (!node) return;
      if (skip.has(id)) return; // já concluído na execução retomada
      if (abort.signal.aborted) {
        patchRun(id, { status: "skipped", note: "execução interrompida" });
        blocked.add(id);
        return;
      }
      if (node.dependsOn.some((dep) => blocked.has(dep))) {
        patchRun(id, { status: "skipped", note: "dependência falhou ou foi pulada" });
        blocked.add(id);
        return;
      }
      const context = node.dependsOn
        .map((dep) => (outputs.get(dep) ? `### ${nodeMap.get(dep)?.name ?? dep}\n${outputs.get(dep)}` : null))
        .filter(Boolean)
        .join("\n\n");
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);

      if (node.kind === "input") {
        const content = node.prompt?.trim() ?? "";
        outputs.set(id, content);
        patchRun(id, {
          status: "done",
          output: content,
          note: content ? "conteúdo literal do nó" : "entrada vazia",
          durationMs: elapsed()
        });
        ok += 1;
        return;
      }

      if (node.kind === "tool" || node.kind === "merge") {
        outputs.set(id, context);
        patchRun(id, {
          status: "done",
          output: context,
          note:
            node.kind === "tool"
              ? "pass-through — executor de ferramenta não conectado nesta build"
              : "merge das saídas anteriores",
          durationMs: elapsed()
        });
        ok += 1;
        return;
      }

      if (node.kind === "gate" || node.kind === "human") {
        patchRun(id, { status: "waiting", note: "aguardando aprovação humana" });
        setRunningLabel(id, `${node.name} (aprovação)`);
        const approved = await new Promise<boolean>((resolve) => approvals.set(id, resolve));
        approvals.delete(id);
        if (abort.signal.aborted) {
          patchRun(id, { status: "skipped", note: "execução interrompida", durationMs: elapsed() });
          blocked.add(id);
          return;
        }
        if (approved) {
          outputs.set(id, context);
          patchRun(id, {
            status: "done",
            output: context,
            note: `aprovado manualmente após ${seconds(elapsed())}`,
            durationMs: elapsed()
          });
          ok += 1;
        } else {
          patchRun(id, { status: "failed", note: "reprovado manualmente", durationMs: elapsed() });
          blocked.add(id);
          failed += 1;
        }
        return;
      }

      // kind === "agent"
      if (!node.prompt?.trim()) {
        patchRun(id, { status: "skipped", note: "agent sem prompt — edite no inspetor" });
        blocked.add(id);
        return;
      }
      patchRun(id, { status: "running", output: "" });
      setRunningLabel(id, node.name);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `Você é o nó "${node.name}" do fluxo "${doc.name}". Execute somente a sua tarefa e responda em markdown conciso.`
        },
        {
          role: "user",
          content: context ? `${node.prompt}\n\n## Saídas dos nós anteriores\n${context}` : node.prompt
        }
      ];
      try {
        const answer = await chatOnce(
          selection,
          "agent",
          messages,
          ctx,
          {
            onDelta: (delta) => patchRun(id, (run) => ({ ...run, output: run.output + delta })),
            onStage: (stage) => patchRun(id, (run) => ({ ...run, note: stage }))
          },
          abort.signal
        );
        outputs.set(id, answer);
        patchRun(id, { status: "done", output: answer, durationMs: elapsed() });
        ok += 1;
      } catch (cause) {
        if (abort.signal.aborted) {
          patchRun(id, { status: "skipped", note: "execução interrompida", durationMs: elapsed() });
          blocked.add(id);
          return;
        }
        patchRun(id, {
          status: "failed",
          note: cause instanceof Error ? cause.message : String(cause),
          durationMs: elapsed()
        });
        blocked.add(id);
        failed += 1;
      }
    } finally {
      clearRunningLabel(id);
      // Salva por nó (não por token): se a aba morrer no meio, o que já
      // terminou continua disponível para retomar.
      saveRun(doc, "running", startedAt);
    }
  }

  // Nós da mesma onda rodam EM PARALELO, com o teto do documento. Antes o
  // laço era serial e o maxConcurrency era decorativo.
  for (const wave of plan) {
    await runWithLimit(
      wave.map((id) => () => runNode(id)),
      doc.maxConcurrency
    );
  }

  const durationMs = Math.round(performance.now() - t0);
  abortController = null;
  const resumed = skip.size ? ` · ${skip.size} reaproveitado(s)` : "";
  useFlow.setState({
    lastRun: { durationMs, ok, failed, total: doc.nodes.length },
    running: false,
    runningNode: "",
    notice: abort.signal.aborted
      ? `Execução interrompida após ${seconds(durationMs)} · ${ok} nó(s) ok`
      : `Execução: ${ok}/${doc.nodes.length} nós ok em ${seconds(durationMs)}${failed ? ` · ${failed} falha(s)` : ""}${resumed}`
  });
  saveRun(doc, abort.signal.aborted ? "aborted" : "done", startedAt);
}

/* ---------------------------- subcomponentes ------------------------- */

function KindGlyph({ kind, size }: { kind: DagNodeKind; size: number }) {
  const Icon = kindIcon[kind];
  return <Icon size={size} />;
}

/** Cartão do nó no canvas: portas reais, anel de estado e popup de gate. */
function FlowNode({
  node,
  pos,
  selected,
  status,
  connecting,
  isOrigin,
  running
}: {
  node: DagNode;
  pos: XY;
  selected: boolean;
  status?: RunStatus;
  connecting: boolean;
  isOrigin: boolean;
  running: boolean;
}) {
  const stateClass = status && status !== "queued" ? `st-${status}` : "";
  return (
    <div
      className={`agx-node agx-k-${node.kind} ${selected ? "selected" : ""} ${stateClass} ${isOrigin ? "connect-origin" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      role="button"
      tabIndex={0}
      title={connecting && !isOrigin ? `Concluir conexão em ${node.name}` : `${node.name} · ${kindLabel[node.kind]}`}
      onClick={() => onNodeClick(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onNodeClick(node.id);
        }
      }}
    >
      <button
        type="button"
        className="agx-port in"
        disabled={running}
        aria-label={`Porta de entrada de ${node.name}`}
        title={connecting ? `Conectar aqui: entrada de ${node.name}` : "Porta de entrada — recebe conexões"}
        onClick={(event) => {
          event.stopPropagation();
          completeConnect(node.id);
        }}
      />
      <span className="agx-node-icon">
        <KindGlyph kind={node.kind} size={13} />
      </span>
      <span className="agx-node-copy">
        <strong>{node.name}</strong>
        <small>
          {kindLabel[node.kind]}
          {node.dependsOn.length ? ` · ${node.dependsOn.length} dep` : " · raiz"}
        </small>
      </span>
      <button
        type="button"
        className="agx-port out"
        disabled={running}
        aria-label={`Porta de saída de ${node.name}`}
        title={isOrigin ? "Origem da conexão — clique numa porta de entrada" : "Porta de saída — inicia uma conexão"}
        onClick={(event) => {
          event.stopPropagation();
          startConnect(node.id);
        }}
      />
      {status && status !== "queued" && <em className={`agx-node-state st-${status}`}>{runStatusText[status]}</em>}
      {status === "waiting" && (
        <div
          className="agx-node-pop"
          role="dialog"
          aria-label={`Aprovação de ${node.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <strong>
            <UserCheck size={12} />
            {node.kind === "human" ? "Aprovação humana" : "Gate de qualidade"}
          </strong>
          <small>O fluxo está pausado neste nó.</small>
          <div className="agx-pop-actions">
            <button className="lg-button primary" onClick={() => decide(node.id, true)}>
              <Check size={12} />
              Aprovar
            </button>
            <button className="lg-button" onClick={() => decide(node.id, false)}>
              <X size={12} />
              Rejeitar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- rail -------------------------------- */

/** Rail dinâmico da aba Agent: paleta, roster real do doc e import/export. */
export function AgentRail() {
  const doc = useFlow((state) => state.doc);
  const runs = useFlow((state) => state.runs);
  const running = useFlow((state) => state.running);
  const selectedId = useFlow((state) => state.selectedId);
  const fileRef = useRef<HTMLInputElement>(null);
  const edges = useMemo(() => edgeCount(doc), [doc]);

  function onImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.text().then(importJsonText);
  }

  return (
    <>
      {/* A equipe viva vem PRIMEIRO: é o que responde "o que está acontecendo
          agora". A paleta do flow builder é ferramenta de edição, não de
          acompanhamento, e empurrá-la para cima esconderia o que importa. */}
      <CrewRail />

      <span className="eyebrow">Paleta de nós</span>
      <div className="agxr-palette">
        {paletteKinds.map((kind) => (
          <button
            key={kind}
            className={`agx-k-${kind}`}
            onClick={() => addKind(kind)}
            disabled={running}
            title={`Adicionar nó ${kindLabel[kind]}`}
          >
            <KindGlyph kind={kind} size={12} />
            {kindLabel[kind]}
          </button>
        ))}
      </div>
      <small className="agxr-hint">Novo nó nasce ligado ao nó selecionado (ou como raiz).</small>

      <span className="eyebrow">
        Nós do fluxo · {doc.nodes.length} · {edges} arestas
      </span>
      <div className="agxr-roster">
        {doc.nodes.length === 0 && <small className="agxr-hint">Fluxo vazio — adicione pela paleta acima.</small>}
        {doc.nodes.map((node) => {
          const status = runs[node.id]?.status;
          return (
            <button
              key={node.id}
              className={`agxr-node agx-k-${node.kind} ${selectedId === node.id ? "active" : ""}`}
              onClick={() => selectNode(node.id)}
              title={`${node.name} · ${kindLabel[node.kind]}${status ? ` · ${runStatusText[status]}` : ""}`}
            >
              <span className="agxr-glyph">
                <KindGlyph kind={node.kind} size={11} />
              </span>
              <span className="agxr-name">{node.name}</span>
              <i className={`agxr-dot ${status && status !== "queued" ? `st-${status}` : ""}`} />
            </button>
          );
        })}
      </div>

      <div className="agxr-io">
        <button onClick={exportJson} title="Baixar o fluxo em JSON">
          <Download size={12} />
          Exportar
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={running} title="Carregar um fluxo em JSON">
          <Upload size={12} />
          Importar
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImportFile} />
      </div>

      <span className="eyebrow">CONVERSAS</span>
      <RailConversations mode="agent" />
    </>
  );
}

/* -------------------------------- view ------------------------------- */

export function AgentView() {
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const settings = useApp((state) => state.settings);
  const setEngine = useApp((state) => state.setEngine);
  const setInput = useApp((state) => state.setInput);

  const doc = useFlow((state) => state.doc);
  const selectedId = useFlow((state) => state.selectedId);
  const connectFrom = useFlow((state) => state.connectFrom);
  const notice = useFlow((state) => state.notice);
  const runs = useFlow((state) => state.runs);
  const running = useFlow((state) => state.running);
  const runningNode = useFlow((state) => state.runningNode);
  const lastRun = useFlow((state) => state.lastRun);
  const agentThread = useApp((state) => state.threads.agent);
  const stage = useApp((state) => state.stage);

  /**
   * Superfície da aba. Abre em "agents" porque acionar um agente é o modo
   * principal: quem decide dividir o trabalho é o modelo. O flow builder
   * continua em "flow" para quem quer fixar o grafo à mão.
   */
  const [surface, setSurface] = useState<"agents" | "livre" | "spec" | "flow">("agents");
  /** Mesma raiz que o Composer usa para as ferramentas de arquivo. */
  const projectRoot = typeof window === "undefined" ? "." : window.localStorage.getItem("code.root") ?? ".";
  const [zoom, setZoom] = useState(1);
  const [validating, setValidating] = useState(false);
  /** Execução salva no disco — só existe depois que algum nó terminou. */
  const [saved, setSaved] = useState<PersistedRun | null>(null);

  const nodeMap = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node])), [doc]);
  const cycle = useMemo(() => detectCycle(doc), [doc]);
  const waves = useMemo(() => {
    try {
      return topoWaves(doc);
    } catch {
      return null;
    }
  }, [doc]);
  const edges = useMemo(() => edgeCount(doc), [doc]);
  const layout = useMemo(() => computeLayout(doc, waves), [doc, waves]);
  const edgeList = useMemo(() => {
    const list: { from: string; to: string }[] = [];
    for (const node of doc.nodes) for (const dep of node.dependsOn) list.push({ from: dep, to: node.id });
    return list;
  }, [doc]);
  const agentNodes = useMemo(() => doc.nodes.filter((node) => node.kind === "agent"), [doc]);
  const promptedAgents = useMemo(() => agentNodes.filter((node) => node.prompt?.trim()).length, [agentNodes]);
  /** Última resposta do composer nesta aba — o "Perguntar ao agente" termina aqui. */
  const lastAnswer = useMemo(
    () => [...agentThread.messages].reverse().find((message) => message.role === "assistant" && message.content.trim()),
    [agentThread.messages]
  );

  const selectedNode = nodeMap.get(selectedId) ?? null;
  const selectedRun = selectedNode ? runs[selectedNode.id] : undefined;
  const selection = settings.engines.agent;
  const engineOffline =
    (selection.kind === "workspace" && !session) || (selection.kind === "local" && !runtimeStatus.running);

  const graph = useMemo<OrchestrationGraph>(
    () => ({
      schemaVersion: 1,
      name: doc.name,
      maxConcurrency: doc.maxConcurrency,
      nodes: doc.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        mode: "agent",
        dependsOn: node.dependsOn
      }))
    }),
    [doc]
  );

  useEffect(() => {
    if (!connectFrom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useFlow.setState({ connectFrom: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectFrom]);

  // Relê o disco ao montar e ao fim de cada execução: é o que decide se
  // "Retomar" aparece e o que ele vai reaproveitar.
  useEffect(() => {
    if (running) return;
    setSaved(loadRun());
  }, [running]);

  // Ao voltar para a aba com uma execução parada pela metade, mostra os
  // resultados que já existiam em vez de um canvas em branco.
  useEffect(() => {
    const stored = loadRun();
    if (stored && stored.fingerprint === docFingerprint(doc) && Object.keys(stored.runs).length) {
      useFlow.setState({ runs: stored.runs });
    }
    // Deps vazias de propósito: só na montagem. Durante a edição do fluxo o
    // usuário não quer o passado voltando por cima do que está fazendo.
  }, []);

  const resume = useMemo(() => planResume(doc, saved), [doc, saved]);
  const resumable = !isRefusal(resume);

  async function validate() {
    if (validating) return;
    setValidating(true);
    try {
      if (session) {
        const plan = await validateOrchestration(session, graph);
        useFlow.setState({
          notice: `Gateway: ${plan.waves.length} ondas · paralelo ${plan.maxParallelism} · crítico ${plan.criticalPath.length}`
        });
      } else if (cycle) {
        useFlow.setState({ notice: `Ciclo detectado: ${cycle.join(" → ")}` });
      } else {
        const widest = waves?.reduce((max, wave) => Math.max(max, wave.length), 0) ?? 0;
        useFlow.setState({
          notice: `${waves?.length ?? 0} ondas · paralelo ${Math.min(doc.maxConcurrency, widest)} (validação local)`
        });
      }
    } catch (cause) {
      report(cause);
    } finally {
      setValidating(false);
    }
  }

  function applyEngine(target: UiMode, value: string) {
    if (value === "workspace") setEngine(target, { kind: "workspace" });
    else if (value === "local") setEngine(target, { kind: "local" });
    else if (value.startsWith("fusion:")) setEngine(target, { kind: "fusion", presetId: value.slice("fusion:".length) });
  }

  return (
    <Surface className="agx-view">
      <TopbarActions>
        <div className="agx-modes">
          <button
            className={`agx-mode ${surface === "agents" ? "active" : ""}`}
            onClick={() => setSurface("agents")}
            title="Diga o objetivo; a equipe é escalada pela complexidade e segue a espinha spec-driven"
          >
            Agentes
          </button>
          <button
            className={`agx-mode ${surface === "livre" ? "active" : ""}`}
            onClick={() => setSurface("livre")}
            title="Delegação livre: o próprio modelo decide se e como divide o trabalho"
          >
            Livre
          </button>
          <button
            className={`agx-mode ${surface === "spec" ? "active" : ""}`}
            onClick={() => setSurface("spec")}
            title="Constituição → spec → plano → tarefas, com revisão humana entre as etapas"
          >
            Spec
          </button>
          <button
            className={`agx-mode ${surface === "flow" ? "active" : ""}`}
            onClick={() => setSurface("flow")}
            title="Grafo desenhado à mão, executado em ondas"
          >
            Fluxo
          </button>
        </div>
        {surface === "flow" && (
          <>
            <span className="chip" title="maxConcurrency do documento">
              Concorrência {doc.maxConcurrency}
            </span>
            <button className="lg-button" onClick={() => void validate()} disabled={validating}>
              <ShieldCheck size={13} />
              {validating ? "Validando…" : "Validar DAG"}
            </button>
            {running ? (
              <button className="lg-button" onClick={stopRun}>
                <Square size={13} />
                Parar
              </button>
            ) : (
              <>
                {resumable && (
                  <button
                    className="lg-button"
                    onClick={resumeGraph}
                    disabled={Boolean(cycle)}
                    title="Reexecuta só o que falhou, ficou pendente ou foi interrompido"
                  >
                    <RotateCw size={13} />
                    Retomar
                  </button>
                )}
                <button className="lg-button primary" onClick={() => void runGraph()} disabled={Boolean(cycle)}>
                  <Play size={13} />
                  Executar
                </button>
              </>
            )}
          </>
        )}
      </TopbarActions>

      {surface === "spec" && (
        <VBody>
          <VCenter>
            <SpecFlowView
              selection={selection}
              ctx={{
                session,
                runtimeRunning: runtimeStatus.running,
                fusionPresets: settings.fusionPresets
              }}
              root={projectRoot}
            />
          </VCenter>
        </VBody>
      )}

      {surface === "agents" && (
        <VBody>
          <VCenter>
            <CrewView
              selection={selection}
              ctx={{
                session,
                runtimeRunning: runtimeStatus.running,
                fusionPresets: settings.fusionPresets
              }}
            />
          </VCenter>
        </VBody>
      )}

      {surface === "livre" && (
        <VBody>
          <VCenter>
            <AgentTreeView
              selection={selection}
              ctx={{
                session,
                runtimeRunning: runtimeStatus.running,
                fusionPresets: settings.fusionPresets
              }}
              root={projectRoot}
            />
          </VCenter>
        </VBody>
      )}

      {surface === "flow" && (
      <VBody>
        <VCenter>
          {running ? (
            <FloatingPulse
              label={runningNode ? `Executando ${runningNode}` : "Executando fluxo"}
              detail={`motor: ${describeSelection(selection, settings.fusionPresets)}`}
            />
          ) : (
            agentThread.sending && (
              <FloatingPulse
                label={stage || "Gerando resposta"}
                detail={`motor: ${describeSelection(selection, settings.fusionPresets)}`}
              />
            )
          )}
          <div className="infinite-canvas agx-canvas">
            <div className="canvas-dots" />
            <div className="agx-overlays">
              {connectFrom && (
                <div className="agx-connect-banner">
                  <Link2 size={12} />
                  Conectando a partir de “{nodeMap.get(connectFrom)?.name ?? connectFrom}” — clique numa porta de entrada
                  <button onClick={() => useFlow.setState({ connectFrom: null })} aria-label="Cancelar conexão">
                    <X size={11} />
                  </button>
                </div>
              )}
              {cycle && (
                <div className="agx-cycle-warn">Ciclo detectado: {cycle.join(" → ")} — remova uma aresta para executar.</div>
              )}
              {!running && !connectFrom && notice && (
                <div className="agx-notice" role="status" aria-live="polite" key={notice}>
                  {notice}
                </div>
              )}
            </div>
            <div
              className="agx-scroll"
              onClick={(event) => {
                // clique no fundo do canvas cancela a conexão em andamento
                if (event.target === event.currentTarget && connectFrom) useFlow.setState({ connectFrom: null });
              }}
            >
              <div className="agx-zoombox" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                <div
                  className={`agx-stage ${connectFrom ? "agx-connecting" : ""}`}
                  style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
                >
                  <svg className="agx-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
                    {edgeList.map(({ from, to }) => {
                      const a = layout.pos.get(from);
                      const b = layout.pos.get(to);
                      if (!a || !b) return null;
                      return <path key={`${from}->${to}`} className={`agx-edge ${edgeTone(runs, from, to)}`} d={edgePath(a, b)} />;
                    })}
                  </svg>
                  {waves?.map((wave, index) => (
                    <span
                      className="agx-wave-tag"
                      key={index}
                      style={{ left: PAD_X + index * (NODE_W + GAP_X), width: NODE_W }}
                    >
                      Onda {index + 1}
                      {wave.length > 1 ? ` · ${wave.length} em paralelo` : ""}
                    </span>
                  ))}
                  {doc.nodes.map((node) => {
                    const pos = layout.pos.get(node.id);
                    if (!pos) return null;
                    return (
                      <FlowNode
                        key={node.id}
                        node={node}
                        pos={pos}
                        selected={selectedId === node.id}
                        status={runs[node.id]?.status}
                        connecting={connectFrom !== null}
                        isOrigin={connectFrom === node.id}
                        running={running}
                      />
                    );
                  })}
                </div>
              </div>
              {!doc.nodes.length && (
                <div className="agx-canvas-hint">
                  <Network size={22} />
                  <p>Canvas vazio — adicione nós pela paleta do rail e conecte pelas portas.</p>
                </div>
              )}
            </div>
            <div className="canvas-controls">
              <button onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))} aria-label="Reduzir zoom">
                <ZoomOut size={14} />
              </button>
              <span className="zoom-label">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((value) => Math.min(1.5, Number((value + 0.1).toFixed(2))))} aria-label="Ampliar zoom">
                <ZoomIn size={14} />
              </button>
              <i />
              <button onClick={() => setZoom(1)} aria-label="Restaurar zoom">
                <Maximize size={13} />
              </button>
            </div>
            <button
              className="canvas-ask"
              onClick={() =>
                setInput(
                  `Analise o fluxo "${doc.name}" (${doc.nodes.length} nós, ${edges} arestas, ${waves?.length ?? 0} ondas) e sugira otimizações de paralelismo, gates e fallbacks`
                )
              }
            >
              <Sparkles size={13} />
              Perguntar ao agente
            </button>
          </div>
        </VCenter>

        <VRight>
          <PanelTitle icon={<Settings2 size={13} />} label="Inspetor" meta={selectedNode ? selectedNode.id : "—"} />
          <PanelScroll>
            {selectedNode ? (
              <div className="agx-inspector">
                <div className={`agx-selected agx-k-${selectedNode.kind}`}>
                  <span>
                    <KindGlyph kind={selectedNode.kind} size={15} />
                  </span>
                  <div>
                    <strong>{selectedNode.name}</strong>
                    <small>
                      {kindLabel[selectedNode.kind]} · {selectedNode.dependsOn.length} dependência(s)
                    </small>
                  </div>
                </div>
                <label className="lg-field">
                  Nome
                  <input
                    value={selectedNode.name}
                    disabled={running}
                    onChange={(event) =>
                      useFlow.setState({ doc: updateNode(doc, selectedNode.id, { name: event.target.value }) })
                    }
                  />
                </label>
                {(selectedNode.kind === "agent" || selectedNode.kind === "input") && (
                  <label className="lg-field">
                    {selectedNode.kind === "agent" ? "Prompt (executado pelo motor)" : "Conteúdo literal"}
                    <textarea
                      className="agx-prompt"
                      rows={4}
                      value={selectedNode.prompt ?? ""}
                      disabled={running}
                      placeholder={
                        selectedNode.kind === "agent"
                          ? "Instrução deste agente; recebe as saídas dos dependsOn como contexto."
                          : "Texto injetado como saída deste nó."
                      }
                      onChange={(event) =>
                        useFlow.setState({ doc: updateNode(doc, selectedNode.id, { prompt: event.target.value }) })
                      }
                    />
                  </label>
                )}
                <span className="eyebrow agx-eyebrow">Depende de</span>
                {selectedNode.dependsOn.length ? (
                  <div className="agx-deps">
                    {selectedNode.dependsOn.map((dep) => (
                      <span className="agx-dep" key={dep}>
                        {nodeMap.get(dep)?.name ?? dep}
                        <button
                          onClick={() => removeEdge(dep, selectedNode.id)}
                          disabled={running}
                          aria-label={`Desconectar ${dep}`}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <small className="agx-hint">Nó raiz — sem dependências.</small>
                )}
                <div className="agx-grid2">
                  <button
                    className={`lg-button ${connectFrom === selectedNode.id ? "primary" : ""}`}
                    disabled={running}
                    onClick={() => startConnect(selectedNode.id)}
                  >
                    <Link2 size={13} />
                    {connectFrom === selectedNode.id ? "Escolha a entrada…" : "Conectar"}
                  </button>
                  <button className="lg-button" onClick={deleteSelected} disabled={running}>
                    <Trash2 size={13} />
                    Excluir nó
                  </button>
                </div>

                {selectedRun && (
                  <div className="agx-execution">
                    <span className="eyebrow agx-eyebrow">
                      <Play size={11} />
                      Execução do nó
                    </span>
                    <div className={`agx-run st-${selectedRun.status}`}>
                      <header>
                        <span className="agx-run-name">
                          <KindGlyph kind={selectedNode.kind} size={11} />
                          {selectedNode.name}
                        </span>
                        {selectedRun.output.includes(DEMO_MARK) && <em className="agx-demo">demo</em>}
                        <em className={`agx-run-state st-${selectedRun.status}`}>
                          {runStatusText[selectedRun.status]}
                          {selectedRun.durationMs !== undefined ? ` · ${seconds(selectedRun.durationMs)}` : ""}
                        </em>
                      </header>
                      {selectedRun.note && <small className="agx-run-note">{selectedRun.note}</small>}
                      {selectedRun.status === "waiting" && (
                        <div className="agx-approve">
                          <button className="lg-button primary" onClick={() => decide(selectedNode.id, true)}>
                            <Check size={12} />
                            Aprovar
                          </button>
                          <button className="lg-button" onClick={() => decide(selectedNode.id, false)}>
                            <X size={12} />
                            Rejeitar
                          </button>
                        </div>
                      )}
                      {selectedRun.output && selectedNode.kind !== "input" && (
                        <div className="agx-run-output">
                          <Markdown source={selectedRun.output} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="agx-empty">Selecione um nó no canvas para editar.</p>
            )}

            {engineOffline && (
              <small className="agx-hint">
                Sem {selection.kind === "local" ? "runtime local ativo" : "gateway conectado"} — os nós agent respondem
                no modo demonstração rotulado do motor. Configure um motor para saídas reais.
              </small>
            )}

            {(agentThread.sending || lastAnswer) && (
              <div className="agx-chat">
                <span className="eyebrow agx-eyebrow">
                  <Sparkles size={11} />
                  Resposta do composer
                </span>
                {lastAnswer ? (
                  <div className="agx-run">
                    <header>
                      <span className="agx-run-name">
                        <Bot size={11} />
                        Motor da aba
                      </span>
                      {lastAnswer.content.includes(DEMO_MARK) && <em className="agx-demo">demo</em>}
                    </header>
                    <div className="agx-run-output">
                      <Markdown source={lastAnswer.content} />
                    </div>
                  </div>
                ) : (
                  <small className="agx-hint">Gerando resposta do composer…</small>
                )}
              </div>
            )}

            <div className="agx-fusion">
              <span className="eyebrow agx-eyebrow">
                <Merge size={11} />
                Fusion por papel
              </span>
              {fusionModes.map((fusionMode) => {
                const current = settings.engines[fusionMode];
                return (
                  <label className="lg-field agx-fusion-row" key={fusionMode}>
                    {fusionMode}
                    <select value={selectionValue(current)} onChange={(event) => applyEngine(fusionMode, event.target.value)}>
                      <option value="workspace">Rota do workspace</option>
                      {settings.fusionPresets.map((preset) => (
                        <option key={preset.id} value={`fusion:${preset.id}`}>
                          Fusion · {preset.name}
                        </option>
                      ))}
                      <option value="local">Runtime local</option>
                      {current.kind === "model" && (
                        <option value="model">
                          {current.target.providerId} · {current.target.model}
                        </option>
                      )}
                    </select>
                  </label>
                );
              })}
              <small className="agx-hint">
                "agent" é o motor dos nós deste fluxo; os demais papéis valem nas outras abas. ex.: security = Deep
                Audit (Kimi orquestra, GPT executa).
              </small>
            </div>
          </PanelScroll>
        </VRight>
      </VBody>
      )}

      <VStatus>
        <span>
          <Network size={11} />
          {doc.nodes.length} nós · {edges} arestas
        </span>
        <span>
          <Waypoints size={11} />
          {cycle ? "ciclo detectado" : `${waves?.length ?? 0} ondas`}
        </span>
        <span>
          <Bot size={11} />
          {agentNodes.length} agentes · {promptedAgents} com prompt
        </span>
        <span>
          <Clock3 size={11} />
          {lastRun
            ? `última execução ${seconds(lastRun.durationMs)} · ${lastRun.ok}/${lastRun.total} ok${lastRun.failed ? ` · ${lastRun.failed} falha(s)` : ""}`
            : "nenhuma execução"}
        </span>
        <span>
          <Zap size={11} />
          {describeSelection(selection, settings.fusionPresets)}
        </span>
        <div className="spacer" />
        <span>{session ? "validação no gateway" : "validação local"}</span>
      </VStatus>
    </Surface>
  );
}
