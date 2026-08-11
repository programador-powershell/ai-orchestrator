/**
 * WORK — cowork real: pasta do projeto + artefatos Markdown + automações no rail.
 * - Estado compartilhado num store zustand de módulo (rail e centro leem o mesmo):
 *   board/regras/log PERSISTEM em localStorage "work.board" (formato preservado);
 *   artefatos em "work.artifacts"; pasta do projeto em "work.root".
 * - O kanban saiu do centro, mas o motor de automações (lib/automations.ts)
 *   segue íntegro: ops do chat (add_task/move_task/…) e due dates vencidos
 *   continuam passando pelas regras — sem quadro visível, triggers de cartão
 *   ficam dormentes (dito honestamente no tooltip das regras).
 * - Centro estilo cowork: adicionar pasta (fs_list nativo ESTRITO no desktop —
 *   sem fallback demo; falha de leitura vira erro honesto; aviso honesto no
 *   navegador) ou iniciar artefato (editor Markdown real, export .md).
 * - Conectores M365 rotulados com o estado REAL (não conectados).
 * Sem input próprio: o composer é global (canal ops:work).
 */
import "../styles/modes/work.css";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  Cloud,
  Download,
  FilePlus2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  Mail,
  MessagesSquare,
  Plug,
  Plus,
  ScrollText,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Trash2,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { FsEntry } from "@ai-orchestrator/contracts";
import { opsBus, type StructuredOp } from "../lib/ops";
import { isTauriFs } from "../lib/fsx";
import {
  addCard,
  describeAction,
  describeTrigger,
  emptyBoard,
  ensureLane,
  findCardByTitle,
  isOverdue,
  makeCard,
  moveCard,
  newCardId,
  ruleFromTexts,
  runRules,
  todayISO,
  type Action,
  type Board,
  type BoardEvent,
  type Rule,
  type Trigger
} from "../lib/automations";
import { useApp } from "../lib/store";
import {
  EmptyHero,
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
import { RailConversations } from "../components/RailConversations";

/* --------------------------- Estado persistido ---------------------- */

const STORAGE_KEY = "work.board";
const ARTIFACTS_KEY = "work.artifacts";
const ROOT_KEY = "work.root";
const LOG_CAP = 120;

/** Aviso honesto sobre o motor sem quadro visível — usado em tooltips. */
const DORMANT_HINT =
  "Motor de automações íntegro: sem o quadro visível, os gatilhos de cartão ficam dormentes — " +
  "disparam quando cartões mudam pelo chat (ops:work) ou quando um due date vence no quadro salvo, com a aba Work aberta.";

interface LogEntry {
  at: number;
  line: string;
}

interface WorkState {
  board: Board;
  rules: Rule[];
  log: LogEntry[];
  /** chaves `${cardId}:${due}` já processadas pelo trigger card_overdue */
  overdueSeen: string[];
}

/** Artefato de texto/Markdown REAL, salvo localmente. */
interface Artifact {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

function initialWorkState(): WorkState {
  return { board: emptyBoard(), rules: [], log: [], overdueSeen: [] };
}

function loadWorkState(): WorkState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialWorkState();
    const parsed = JSON.parse(raw) as Partial<WorkState> | null;
    if (!parsed || !Array.isArray(parsed.board?.lanes)) return initialWorkState();
    return {
      board: { lanes: parsed.board.lanes },
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      log: Array.isArray(parsed.log) ? parsed.log : [],
      overdueSeen: Array.isArray(parsed.overdueSeen) ? parsed.overdueSeen : []
    };
  } catch {
    return initialWorkState();
  }
}

function loadArtifacts(): Artifact[] {
  try {
    const raw = localStorage.getItem(ARTIFACTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Artifact =>
        Boolean(item) &&
        typeof (item as Artifact).id === "string" &&
        typeof (item as Artifact).title === "string" &&
        typeof (item as Artifact).content === "string" &&
        typeof (item as Artifact).createdAt === "number" &&
        typeof (item as Artifact).updatedAt === "number"
    );
  } catch {
    return [];
  }
}

function loadRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) ?? "";
  } catch {
    return "";
  }
}

/* ------------------- Store de módulo (rail + centro) ----------------- */

interface WorkStore extends WorkState {
  artifacts: Artifact[];
  root: string;
}

/** Store zustand de módulo: WorkRail e WorkView compartilham o MESMO estado. */
const useWork = create<WorkStore>()(() => ({
  ...loadWorkState(),
  artifacts: loadArtifacts(),
  root: loadRoot()
}));

/* Persistência real: cada fatia na sua chave, só quando muda. */
useWork.subscribe((state, previous) => {
  try {
    if (
      state.board !== previous.board ||
      state.rules !== previous.rules ||
      state.log !== previous.log ||
      state.overdueSeen !== previous.overdueSeen
    ) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ board: state.board, rules: state.rules, log: state.log, overdueSeen: state.overdueSeen })
      );
    }
    if (state.artifacts !== previous.artifacts) localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(state.artifacts));
    if (state.root !== previous.root) localStorage.setItem(ROOT_KEY, state.root);
  } catch {
    // storage cheio/indisponível: o estado segue em memória
  }
});

const entry = (line: string): LogEntry => ({ at: Date.now(), line });

/** Aplica uma transformação pura sobre a fatia do motor (board/regras/log). */
function updateEngine(mutate: (prev: WorkState) => WorkState) {
  const current = useWork.getState();
  const prev: WorkState = {
    board: current.board,
    rules: current.rules,
    log: current.log,
    overdueSeen: current.overdueSeen
  };
  const next = mutate(prev);
  if (next !== prev) useWork.setState(next);
}

/** Roda o motor para um evento e anexa as execuções ao log (imutável). */
function withEvent(prev: WorkState, board: Board, event: BoardEvent): WorkState {
  const result = runRules(board, event, prev.rules);
  if (!result.log.length) return { ...prev, board: result.board };
  return {
    ...prev,
    board: result.board,
    log: [...result.log.map(entry), ...prev.log].slice(0, LOG_CAP)
  };
}

/* ---------------- Mission control derivado (item 6 do original) ------- */

/**
 * "Objetivo ativo" 100% derivado do estado real — nada inventado:
 * marcos = pasta definida, artefatos criados, automações ativas e cartões
 * concluídos do quadro salvo; o % vem da média dos marcos alcançados.
 */
function MissionCard() {
  const root = useWork((state) => state.root);
  const artifacts = useWork((state) => state.artifacts);
  const rules = useWork((state) => state.rules);
  const board = useWork((state) => state.board);
  const doneLane = board.lanes.find((lane) => /conclu/i.test(lane.name));
  const totalCards = board.lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
  const doneCards = doneLane?.cards.length ?? 0;
  const milestones: Array<{ label: string; detail: string; done: boolean }> = [
    {
      label: "Pasta do projeto",
      detail: root ? root : "não definida",
      done: Boolean(root.trim())
    },
    {
      label: "Artefatos",
      detail: artifacts.length ? `${artifacts.length} criado${artifacts.length === 1 ? "" : "s"}` : "nenhum ainda",
      done: artifacts.length > 0
    },
    {
      label: "Automações ativas",
      detail: `${rules.filter((rule) => rule.enabled).length} de ${rules.length}`,
      done: rules.some((rule) => rule.enabled)
    },
    {
      label: "Cartões concluídos",
      detail: totalCards ? `${doneCards}/${totalCards} no quadro salvo` : "quadro vazio",
      done: totalCards > 0 && doneCards === totalCards
    }
  ];
  const progress = Math.round((milestones.filter((milestone) => milestone.done).length / milestones.length) * 100);
  return (
    <div className="workx-mission">
      <header>
        <strong>Objetivo ativo</strong>
        <small>{progress}%</small>
      </header>
      <div className="workx-mission-bar">
        <i style={{ width: `${progress}%` }} />
      </div>
      {milestones.map((milestone) => (
        <div className={`workx-mission-step ${milestone.done ? "done" : ""}`} key={milestone.label}>
          <span>{milestone.done ? "✓" : "○"}</span>
          <div>
            <strong>{milestone.label}</strong>
            <small>{milestone.detail}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------- Ops do chat via motor ------------------------ */

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Aplica as ops do canal "work" passando cada efeito pelo motor de regras. */
function applyWorkOps(prev: WorkState, ops: StructuredOp[]): WorkState {
  let next = prev;
  for (const op of ops) {
    switch (op.op) {
      case "add_task": {
        const title = asText(op.title);
        if (!title || findCardByTitle(next.board, title)) break;
        const laneName = asText(op.lane) ?? next.board.lanes[0]?.name ?? "A fazer";
        const card = makeCard(title, { detail: asText(op.detail) ?? "" });
        next = withEvent(next, addCard(next.board, laneName, card), {
          kind: "card_created",
          cardId: card.id
        });
        break;
      }
      case "move_task": {
        const title = asText(op.title);
        const laneName = asText(op.lane);
        if (!title || !laneName) break;
        const card = findCardByTitle(next.board, title);
        if (!card) break;
        const moved = moveCard(next.board, card.id, laneName);
        if (moved.moved) {
          next = withEvent(next, moved.board, { kind: "card_moved", cardId: card.id, toLane: laneName });
        }
        break;
      }
      case "add_lane": {
        const name = asText(op.name);
        if (name) next = { ...next, board: ensureLane(next.board, name) };
        break;
      }
      case "add_automation": {
        const name = asText(op.name);
        if (!name || next.rules.some((rule) => rule.name.toLowerCase() === name.toLowerCase())) break;
        const rule = ruleFromTexts(name, asText(op.trigger) ?? "", asText(op.action) ?? "");
        const line = rule
          ? `regra "${name}" criada pelo chat: quando ${describeTrigger(rule.trigger)} → ${describeAction(rule.action)}`
          : `automação "${name}" não reconhecida pelo motor (trigger/ação sem forma estruturável) — nada foi criado`;
        next = {
          ...next,
          rules: rule ? [...next.rules, rule] : next.rules,
          log: [entry(line), ...next.log].slice(0, LOG_CAP)
        };
        break;
      }
      default:
        break;
    }
  }
  return next;
}

/* Trigger card_overdue REAL: dispara uma vez por (cartão, due) vencido. */
function processOverdue(prev: WorkState, today: string): WorkState {
  const cards = prev.board.lanes.flatMap((lane) => lane.cards);
  const liveKeys = new Set(cards.filter((card) => card.due).map((card) => `${card.id}:${card.due}`));
  const seen = prev.overdueSeen.filter((key) => liveKeys.has(key));
  const pending = cards.filter((card) => isOverdue(card.due, today) && !seen.includes(`${card.id}:${card.due}`));
  if (!pending.length) {
    return seen.length === prev.overdueSeen.length ? prev : { ...prev, overdueSeen: seen };
  }
  let next: WorkState = { ...prev, overdueSeen: [...seen, ...pending.map((card) => `${card.id}:${card.due}`)] };
  for (const card of pending) {
    next = withEvent(next, next.board, { kind: "card_overdue", cardId: card.id });
  }
  return next;
}

/* ------------------------- Ações das regras -------------------------- */

function toggleRule(id: string) {
  useWork.setState((state) => ({
    rules: state.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule))
  }));
}

function deleteRule(id: string) {
  useWork.setState((state) => ({ rules: state.rules.filter((rule) => rule.id !== id) }));
}

function addRule(rule: Rule) {
  useWork.setState((state) => ({
    rules: [...state.rules, rule],
    log: [
      entry(`regra "${rule.name}" criada: quando ${describeTrigger(rule.trigger)} → ${describeAction(rule.action)}`),
      ...state.log
    ].slice(0, LOG_CAP)
  }));
}

/* ------------------------- Ações dos artefatos ------------------------ */

function createArtifact(): string {
  const id = newCardId();
  const now = Date.now();
  useWork.setState((state) => ({
    artifacts: [{ id, title: "", content: "", createdAt: now, updatedAt: now }, ...state.artifacts]
  }));
  return id;
}

function patchArtifact(id: string, patch: Partial<Pick<Artifact, "title" | "content">>) {
  useWork.setState((state) => ({
    artifacts: state.artifacts.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item))
  }));
}

function removeArtifact(id: string) {
  useWork.setState((state) => ({ artifacts: state.artifacts.filter((item) => item.id !== id) }));
}

function artifactFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "artefato"}.md`;
}

/** Exporta o artefato REAL como download .md (título vira H1 quando existe). */
function exportArtifact(artifact: Artifact) {
  const body = artifact.title.trim() ? `# ${artifact.title.trim()}\n\n${artifact.content}` : artifact.content;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifactFileName(artifact.title);
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------- Utilidades ----------------------------- */

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "agora";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

const logTime = (at: number) =>
  new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function projectNameFrom(root: string): string {
  const clean = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

/**
 * Listagem ESTRITA da raiz do projeto: chama o comando nativo fs_list direto,
 * sem o fallback de demonstração do fsx — no Work, falha de leitura vira erro
 * honesto na UI; nunca uma árvore inventada exibida como se fosse a pasta real.
 */
async function listProjectRoot(root: string): Promise<FsEntry[]> {
  const entries = await invoke<FsEntry[]>("fs_list", { root, sub: "" });
  return [...entries].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
}

const connectors: Array<{ name: string; icon: LucideIcon; tone: string }> = [
  { name: "Outlook", icon: Mail, tone: "--tone-blue" },
  { name: "Teams", icon: MessagesSquare, tone: "--tone-violet" },
  { name: "SharePoint", icon: FolderOpen, tone: "--tone-mint" },
  { name: "OneDrive", icon: Cloud, tone: "--tone-cyan" }
];

/* ------------------------ Builder de regras ------------------------- */

interface RuleDraft {
  name: string;
  triggerKind: Trigger["kind"];
  toLane: string;
  titleContains: string;
  actionKind: Action["kind"];
  actionLane: string;
  actionLabel: string;
  actionTitle: string;
}

const emptyDraft = (): RuleDraft => ({
  name: "",
  triggerKind: "card_moved",
  toLane: "",
  titleContains: "",
  actionKind: "add_label",
  actionLane: "",
  actionLabel: "",
  actionTitle: ""
});

function buildRule(draft: RuleDraft): Rule | null {
  const name = draft.name.trim();
  if (!name) return null;
  let trigger: Trigger;
  if (draft.triggerKind === "card_moved") {
    trigger = draft.toLane.trim() ? { kind: "card_moved", toLane: draft.toLane.trim() } : { kind: "card_moved" };
  } else if (draft.triggerKind === "card_created") {
    trigger = draft.titleContains.trim()
      ? { kind: "card_created", titleContains: draft.titleContains.trim() }
      : { kind: "card_created" };
  } else {
    trigger = { kind: "card_overdue" };
  }
  let action: Action;
  if (draft.actionKind === "move_to") {
    const lane = draft.actionLane.trim();
    if (!lane) return null;
    action = { kind: "move_to", lane };
  } else if (draft.actionKind === "add_label") {
    const label = draft.actionLabel.trim();
    if (!label) return null;
    action = { kind: "add_label", label };
  } else {
    const title = draft.actionTitle.trim();
    if (!title) return null;
    action = { kind: "create_card", lane: draft.actionLane.trim() || "A fazer", title };
  }
  return { id: newCardId(), name, enabled: true, trigger, action };
}

/** Popup glass central (portal) com o builder estruturado de regras. */
function RuleBuilderModal({ onClose }: { onClose: () => void }) {
  const lanes = useWork((state) => state.board.lanes);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function createRuleFromDraft() {
    const rule = buildRule(draft);
    if (!rule) return;
    addRule(rule);
    onClose();
  }

  return createPortal(
    <div className="workx-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="workx-modal glass-strong"
        role="dialog"
        aria-modal="true"
        aria-label="Nova regra de automação"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="workx-modal-head">
          <span className="workx-modal-icon">
            <Zap size={14} />
          </span>
          <div>
            <strong>Nova regra de automação</strong>
            <small>quando (gatilho) → então (ação)</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar builder">
            <X size={14} />
          </button>
        </header>

        <div className="workx-builder">
          <label className="lg-field">
            Nome
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="ex.: etiquetar entregues"
              autoFocus
            />
          </label>
          <label className="lg-field">
            Quando
            <select
              value={draft.triggerKind}
              onChange={(event) => setDraft({ ...draft, triggerKind: event.target.value as Trigger["kind"] })}
            >
              <option value="card_moved">cartão movido</option>
              <option value="card_created">cartão criado</option>
              <option value="card_overdue">cartão atrasado</option>
            </select>
          </label>
          {draft.triggerKind === "card_moved" && (
            <label className="lg-field">
              Para a coluna (vazio = qualquer)
              <input
                list="workx-lanes"
                value={draft.toLane}
                onChange={(event) => setDraft({ ...draft, toLane: event.target.value })}
              />
            </label>
          )}
          {draft.triggerKind === "card_created" && (
            <label className="lg-field">
              Título contém (opcional)
              <input
                value={draft.titleContains}
                onChange={(event) => setDraft({ ...draft, titleContains: event.target.value })}
              />
            </label>
          )}
          <label className="lg-field">
            Então
            <select
              value={draft.actionKind}
              onChange={(event) => setDraft({ ...draft, actionKind: event.target.value as Action["kind"] })}
            >
              <option value="add_label">adicionar etiqueta</option>
              <option value="move_to">mover para coluna</option>
              <option value="create_card">criar cartão</option>
            </select>
          </label>
          {draft.actionKind === "add_label" && (
            <label className="lg-field">
              Etiqueta
              <input
                value={draft.actionLabel}
                onChange={(event) => setDraft({ ...draft, actionLabel: event.target.value })}
              />
            </label>
          )}
          {draft.actionKind !== "add_label" && (
            <label className="lg-field">
              Coluna destino
              <input
                list="workx-lanes"
                value={draft.actionLane}
                onChange={(event) => setDraft({ ...draft, actionLane: event.target.value })}
              />
            </label>
          )}
          {draft.actionKind === "create_card" && (
            <label className="lg-field">
              Título do cartão
              <input
                value={draft.actionTitle}
                onChange={(event) => setDraft({ ...draft, actionTitle: event.target.value })}
              />
            </label>
          )}
          <datalist id="workx-lanes">
            {lanes.map((lane) => (
              <option key={lane.name} value={lane.name} />
            ))}
          </datalist>
        </div>

        <p className="workx-dormant-note">{DORMANT_HINT}</p>

        <div className="workx-builder-actions">
          <button className="lg-button primary" onClick={createRuleFromDraft} disabled={!buildRule(draft)}>
            Criar regra
          </button>
          <button className="lg-button ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ----------------------- Rail dinâmico da aba ------------------------ */

/** Barra lateral esquerda: automações (toggle real + builder) + log + sessões. */
export function WorkRail() {
  const rules = useWork((state) => state.rules);
  const log = useWork((state) => state.log);
  const [builderOpen, setBuilderOpen] = useState(false);
  const activeRules = rules.filter((rule) => rule.enabled).length;

  return (
    <>
      <span className="eyebrow">
        AUTOMAÇÕES{rules.length ? ` · ${activeRules}/${rules.length}` : ""}
      </span>
      {rules.map((rule) => (
        <div className="workx-rail-rule" key={rule.id} title={DORMANT_HINT}>
          <span className="workx-rail-rule-top">
            <strong>{rule.name}</strong>
            <button
              className={`lg-toggle ${rule.enabled ? "on" : ""}`}
              onClick={() => toggleRule(rule.id)}
              title={rule.enabled ? "Desligar regra" : "Ligar regra"}
            >
              <i />
              {rule.enabled ? "on" : "off"}
            </button>
            <button className="workx-rule-del" onClick={() => deleteRule(rule.id)} title="Excluir regra">
              <Trash2 size={12} />
            </button>
          </span>
          <small>
            quando {describeTrigger(rule.trigger)} → {describeAction(rule.action)}
          </small>
        </div>
      ))}
      {!rules.length && (
        <span className="rail-empty">Nenhuma regra ainda — crie abaixo ou pelo chat (op add_automation).</span>
      )}
      <button className="lg-button workx-rail-new" onClick={() => setBuilderOpen(true)}>
        <Plus size={13} />
        Nova regra
      </button>

      <span className="eyebrow">ÚLTIMAS EXECUÇÕES</span>
      {log.length ? (
        <div className="workx-log">
          {log.slice(0, 5).map((item, index) => (
            <p key={`${item.at}-${index}`}>
              <time>{logTime(item.at)}</time>
              {item.line}
            </p>
          ))}
        </div>
      ) : (
        <span className="rail-empty">Nenhuma execução ainda — quando uma regra rodar, aparece aqui com horário real.</span>
      )}

      <span className="eyebrow">SESSÕES</span>
      <RailConversations mode="work" />

      {builderOpen && <RuleBuilderModal onClose={() => setBuilderOpen(false)} />}
    </>
  );
}

/* -------------------------------- View ------------------------------ */

type Pane = "home" | "project" | "artifact";

export function WorkView() {
  const sending = useApp((state) => state.threads.work.sending);
  const stage = useApp((state) => state.stage);

  const board = useWork((state) => state.board);
  const rules = useWork((state) => state.rules);
  const log = useWork((state) => state.log);
  const artifacts = useWork((state) => state.artifacts);
  const root = useWork((state) => state.root);

  const [pane, setPane] = useState<Pane>("home");
  const [artifactId, setArtifactId] = useState<string | null>(null);
  /* Exclusão em dois cliques (armar → confirmar): artefato é conteúdo real. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmEditorDelete, setConfirmEditorDelete] = useState(false);
  const [rootDraft, setRootDraft] = useState(root);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState(false);
  const [today, setToday] = useState(() => todayISO());

  /* Ops do chat (canal work) passam pelo motor — regras seguem aplicáveis. */
  useEffect(() => {
    return opsBus.subscribe("work", (ops) => {
      updateEngine((previous) => applyWorkOps(previous, ops));
    });
  }, []);

  /* Relógio de due date: revalida a cada minuto (vira o dia → reprocessa). */
  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayISO()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /* Trigger card_overdue REAL sobre o quadro salvo (dormente, sem exibição). */
  useEffect(() => {
    updateEngine((previous) => processOverdue(previous, today));
  }, [board, rules, today]);

  /* Listagem REAL da pasta (só no desktop; no navegador o aviso é honesto).
     Estrita: erro do fs_list vira aviso — jamais uma árvore demo como real. */
  useEffect(() => {
    if (!isTauriFs || !root) {
      setEntries(null);
      setListError(false);
      return;
    }
    let alive = true;
    setListing(true);
    setListError(false);
    listProjectRoot(root)
      .then((result) => {
        if (alive) setEntries(result);
      })
      .catch(() => {
        if (alive) {
          setEntries(null);
          setListError(true);
        }
      })
      .finally(() => {
        if (alive) setListing(false);
      });
    return () => {
      alive = false;
    };
  }, [root]);

  /* ----------------------------- Derivados --------------------------- */

  const totalCards = useMemo(
    () => board.lanes.reduce((sum, lane) => sum + lane.cards.length, 0),
    [board]
  );
  const activeRules = rules.filter((rule) => rule.enabled).length;
  const projectName = useMemo(() => (root ? projectNameFrom(root) : ""), [root]);
  const fileCount = entries ? entries.filter((item) => !item.isDir).length : 0;
  const dirCount = entries ? entries.filter((item) => item.isDir).length : 0;
  const lastArtifactAt = useMemo(
    () => (artifacts.length ? Math.max(...artifacts.map((item) => item.updatedAt)) : null),
    [artifacts]
  );
  const artifact = artifactId ? artifacts.find((item) => item.id === artifactId) ?? null : null;
  const artifactWords = artifact && artifact.content.trim() ? artifact.content.trim().split(/\s+/).length : 0;

  /* Artefato excluído em outro lugar → volta para o início. */
  useEffect(() => {
    if (pane === "artifact" && !artifact) setPane("home");
  }, [pane, artifact]);

  /* Troca de artefato/pane desarma a confirmação de exclusão do editor. */
  useEffect(() => {
    setConfirmEditorDelete(false);
  }, [artifactId, pane]);

  /* ------------------------------ Ações ------------------------------ */

  function startArtifact() {
    const id = createArtifact();
    setArtifactId(id);
    setPane("artifact");
  }

  function openArtifact(id: string) {
    setArtifactId(id);
    setPane("artifact");
  }

  function applyRoot() {
    const next = rootDraft.trim();
    setRootDraft(next);
    useWork.setState({ root: next });
  }

  function askPlanFromProject() {
    if (!entries || !root) return;
    const top = entries.slice(0, 20).map((item) => (item.isDir ? `${item.name}/` : item.name));
    useApp
      .getState()
      .setInput(
        `Monte um plano de trabalho para o projeto "${projectName}" (pasta ${root}). ` +
          `Estrutura real no nível raiz: ${top.join(", ")}.`
      );
  }

  function askAgentForAutomation() {
    useApp
      .getState()
      .setInput('Crie uma automação: quando um cartão for movido para "Concluído", adicionar etiqueta "entregue"');
  }

  /* ------------------------------ Render ----------------------------- */

  return (
    <Surface>
      <TopbarActions>
        {pane !== "home" && (
          <button className="lg-button ghost" onClick={() => setPane("home")}>
            <ArrowLeft size={13} />
            Início
          </button>
        )}
        <button className="lg-button ghost" onClick={() => setPane("project")}>
          <FolderOpen size={13} />
          Pasta do projeto
        </button>
        <button className="lg-button" onClick={startArtifact}>
          <FilePlus2 size={13} />
          Novo artefato
        </button>
      </TopbarActions>

      <VBody>
        <VCenter>
          {sending && (
            <FloatingPulse label={stage || "Processando"} detail="gerando resposta — ops:work aplicam ao final do turno" />
          )}

          {pane === "home" && (
            <div className="workx-stage" key="home">
              <EmptyHero
                icon={<Briefcase size={26} />}
                kicker="COWORK"
                title="Por onde começamos?"
                detail="Adicione a pasta do projeto para trabalhar sobre os arquivos reais, ou inicie um artefato de texto/Markdown salvo localmente."
              >
                <div className="workx-actions">
                  <button className="workx-action glint" onClick={() => setPane("project")}>
                    <span className="workx-action-icon">
                      <FolderOpen size={18} />
                    </span>
                    <strong>Adicionar pasta do projeto</strong>
                    <small>
                      {root
                        ? root
                        : isTauriFs
                          ? "aponte um caminho e o desktop lista os arquivos reais"
                          : "leitura real de pasta requer o app desktop"}
                    </small>
                  </button>
                  <button className="workx-action glint" onClick={startArtifact}>
                    <span className="workx-action-icon">
                      <FilePlus2 size={18} />
                    </span>
                    <strong>Iniciar artefato</strong>
                    <small>editor Markdown real, salvo localmente — exporte como .md quando quiser</small>
                  </button>
                </div>

                {artifacts.length > 0 && (
                  <div className="workx-artifacts">
                    <span className="eyebrow">ARTEFATOS SALVOS · {artifacts.length}</span>
                    <div className="workx-artifact-list">
                      {artifacts.map((item) => (
                        <div
                          className="workx-artifact-row"
                          key={item.id}
                          onMouseLeave={() =>
                            setConfirmDeleteId((current) => (current === item.id ? null : current))
                          }
                        >
                          <button
                            className="workx-artifact-open"
                            onClick={() => openArtifact(item.id)}
                            title={`Abrir "${item.title || "Sem título"}"`}
                          >
                            <FileText size={13} />
                            <span>{item.title || "Sem título"}</span>
                            <small>{relativeTime(item.updatedAt)}</small>
                          </button>
                          <button className="workx-artifact-act" onClick={() => exportArtifact(item)} title="Exportar .md">
                            <Download size={12} />
                          </button>
                          <button
                            className={`workx-artifact-act danger ${confirmDeleteId === item.id ? "armed" : ""}`}
                            onClick={() => {
                              if (confirmDeleteId === item.id) {
                                removeArtifact(item.id);
                                setConfirmDeleteId(null);
                              } else {
                                setConfirmDeleteId(item.id);
                              }
                            }}
                            title={
                              confirmDeleteId === item.id
                                ? "Clique de novo para excluir definitivamente"
                                : "Excluir artefato"
                            }
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </EmptyHero>
            </div>
          )}

          {pane === "project" && (
            <div className="workx-stage" key="project">
              <div className="workx-project">
                <div className="workx-project-head glint">
                  <FolderOpen size={15} />
                  <input
                    value={rootDraft}
                    placeholder={isTauriFs ? "caminho da pasta do projeto (ex.: C:/Code/meu-projeto ou .)" : "disponível no app desktop"}
                    onChange={(event) => setRootDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyRoot();
                    }}
                    aria-label="Caminho da pasta do projeto"
                  />
                  <button className="lg-button primary" onClick={applyRoot} disabled={rootDraft.trim() === root}>
                    Usar pasta
                  </button>
                </div>

                {!isTauriFs && (
                  <p className="workx-web-note">
                    <AlertTriangle size={13} />
                    Leitura real de pasta requer o app desktop — no navegador nenhum arquivo é listado.
                  </p>
                )}

                {isTauriFs && !root && (
                  <p className="workx-empty-note">
                    Nenhuma pasta definida ainda. Informe o caminho acima e pressione Enter — o valor fica salvo em
                    work.root.
                  </p>
                )}

                {isTauriFs && root && (
                  <>
                    <div className="workx-project-card glint">
                      <strong>{projectName}</strong>
                      <small>{root}</small>
                      <span className="workx-project-meta">
                        {entries
                          ? `${fileCount} arquivo${fileCount === 1 ? "" : "s"} · ${dirCount} pasta${dirCount === 1 ? "" : "s"} no nível raiz`
                          : listing
                            ? "lendo a pasta…"
                            : listError
                              ? "leitura falhou"
                              : "sem leitura ainda"}
                      </span>
                      <button
                        className="lg-button primary"
                        onClick={askPlanFromProject}
                        disabled={!entries || !entries.length}
                        title="Preenche o composer com um pedido de plano baseado nos arquivos reais"
                      >
                        <Sparkles size={13} />
                        Pedir plano ao agente
                      </button>
                    </div>

                    {listing && <div className="workx-listing" aria-hidden="true" />}
                    {!listing && listError && (
                      <p className="workx-web-note">
                        <AlertTriangle size={13} />
                        Não foi possível ler a pasta — caminho inexistente ou sem permissão de leitura. Nada foi
                        listado (nenhum dado é inventado); corrija o caminho e use “Usar pasta” de novo.
                      </p>
                    )}
                    {!listing && entries && (
                      <div className="workx-entries">
                        {entries.map((item) => (
                          <div className="workx-entry" key={item.path}>
                            {item.isDir ? <Folder size={13} /> : <FileText size={13} />}
                            <span>{item.name}</span>
                            <small>{item.isDir ? "pasta" : formatSize(item.size)}</small>
                          </div>
                        ))}
                        {!entries.length && (
                          <p className="workx-empty-note">Nada listado: pasta vazia ou sem permissão de leitura.</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {pane === "artifact" && artifact && (
            <div className="workx-stage" key="artifact">
              <div className="workx-editor glass-strong">
                <header>
                  <span className="workx-editor-icon">
                    <FileText size={14} />
                  </span>
                  <input
                    className="workx-editor-title"
                    value={artifact.title}
                    placeholder="Título do artefato"
                    onChange={(event) => patchArtifact(artifact.id, { title: event.target.value })}
                    aria-label="Título do artefato"
                  />
                  <button className="lg-button ghost" onClick={() => exportArtifact(artifact)}>
                    <Download size={13} />
                    Exportar .md
                  </button>
                  <button
                    className={`lg-button ghost ${confirmEditorDelete ? "workx-del-armed" : ""}`}
                    onClick={() => {
                      if (!confirmEditorDelete) {
                        setConfirmEditorDelete(true);
                        return;
                      }
                      removeArtifact(artifact.id);
                      setPane("home");
                    }}
                    onMouseLeave={() => setConfirmEditorDelete(false)}
                    title={confirmEditorDelete ? "Clique de novo para excluir definitivamente" : "Excluir artefato"}
                  >
                    <Trash2 size={13} />
                    {confirmEditorDelete ? "Confirmar exclusão" : "Excluir"}
                  </button>
                </header>
                <textarea
                  className="workx-editor-body"
                  value={artifact.content}
                  placeholder={"Escreva em Markdown…\n\n# Título\n- lista\n**negrito**"}
                  onChange={(event) => patchArtifact(artifact.id, { content: event.target.value })}
                  aria-label="Conteúdo do artefato"
                />
                <footer>
                  <span>criado {new Date(artifact.createdAt).toLocaleString("pt-BR")}</span>
                  <span>atualizado {relativeTime(artifact.updatedAt)}</span>
                  <span className="spacer" />
                  <span>
                    {artifactWords} palavras · {artifact.content.length} caracteres · salvo em work.artifacts
                  </span>
                </footer>
              </div>
            </div>
          )}
        </VCenter>

        <VRight>
          <PanelTitle icon={<Gauge size={13} />} label="Resumo" meta="derivado do estado" />
          <PanelScroll>
            <MissionCard />
            <div className="workx-summary">
              <div className="workx-sum-row">
                <FolderOpen size={13} />
                <span>
                  <strong>Projeto</strong>
                  <small>{root ? root : "nenhuma pasta adicionada"}</small>
                </span>
              </div>
              <div className="workx-sum-row">
                <Files size={13} />
                <span>
                  <strong>Nível raiz</strong>
                  <small>
                    {entries
                      ? `${fileCount} arquivo${fileCount === 1 ? "" : "s"} · ${dirCount} pasta${dirCount === 1 ? "" : "s"}`
                      : isTauriFs
                        ? listing
                          ? "lendo a pasta…"
                          : listError
                            ? "leitura falhou — confira o caminho"
                            : "sem leitura ainda"
                        : "leitura real requer o app desktop"}
                  </small>
                </span>
              </div>
              <div className="workx-sum-row">
                <FileText size={13} />
                <span>
                  <strong>Artefatos</strong>
                  <small>
                    {artifacts.length
                      ? `${artifacts.length} salvo${artifacts.length === 1 ? "" : "s"} · última edição ${relativeTime(lastArtifactAt as number)}`
                      : "nenhum ainda"}
                  </small>
                </span>
              </div>
              <div className="workx-sum-row">
                <Zap size={13} />
                <span>
                  <strong>Automações</strong>
                  <small>
                    {rules.length
                      ? `${activeRules} de ${rules.length} ativa${rules.length === 1 ? "" : "s"} · ${log.length} execuç${log.length === 1 ? "ão" : "ões"} no log`
                      : "nenhuma regra ainda"}
                  </small>
                </span>
              </div>
              <div className="workx-sum-row" title={DORMANT_HINT}>
                <SquareKanban size={13} />
                <span>
                  <strong>Quadro salvo</strong>
                  <small>
                    {totalCards} cart{totalCards === 1 ? "ão" : "ões"} em work.board · sem exibição (triggers dormentes)
                  </small>
                </span>
              </div>
            </div>

            <PanelTitle icon={<Plug size={13} />} label="Suíte de trabalho" meta="microsoft 365" />
            {connectors.map(({ name, icon: Icon, tone }) => (
              <div
                className="workx-connector"
                key={name}
                style={{ "--workx-tone": `var(${tone})` } as CSSProperties}
              >
                <span className="workx-connector-icon">
                  <Icon size={14} />
                </span>
                <span className="workx-connector-copy">
                  <strong>{name}</strong>
                  <small>não conectado — requer aprovação de TI</small>
                </span>
                <i className="workx-connector-dot" aria-hidden="true" />
              </div>
            ))}
            <p className="workx-policy">
              <ShieldCheck size={13} />
              Política Multiplike: conectores externos só entram após análise da TI/SI, sempre com a conta corporativa
              Microsoft.
            </p>

            <button className="lg-button primary workx-automate" onClick={askAgentForAutomation}>
              <Sparkles size={13} />
              Sugerir automação no composer
            </button>
          </PanelScroll>
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <FolderOpen size={11} />
          {root ? projectName : "sem pasta"}
        </span>
        <span>
          <FileText size={11} />
          {artifacts.length} artefato{artifacts.length === 1 ? "" : "s"}
        </span>
        <span>
          <Zap size={11} />
          {activeRules} regra{activeRules === 1 ? "" : "s"} ativa{activeRules === 1 ? "" : "s"}
        </span>
        <span>
          <ScrollText size={11} />
          {log.length} execuç{log.length === 1 ? "ão" : "ões"} no log
        </span>
        <span className="spacer" />
        <span>
          <HardDrive size={11} />
          salvo localmente · work.board · work.artifacts · work.root
        </span>
      </VStatus>
    </Surface>
  );
}
