/**
 * Motor da aba Work — store, persistência, ops do chat e agendador.
 *
 * Saiu de dentro do WorkView por um motivo concreto: App.tsx monta só a view
 * do modo ATIVO (e por `lazy`), então o `setInterval` de due date e a
 * assinatura de `opsBus` morriam ao trocar de aba — o "agendador" só existia
 * enquanto o usuário estava olhando para ele. Aqui o módulo é importado no
 * boot e vale com qualquer aba aberta.
 *
 * Limite honesto: continua vivo apenas enquanto o APP está aberto. Rodar com o
 * app fechado exigiria bandeja + autostart + agendador em Rust — dependência
 * nova, fora do que está aprovado.
 *
 * Os efeitos EXTERNOS (webhook/MCP) não são executados aqui: `runRules` os
 * devolve como descrição e este módulo os põe numa fila que só sai com
 * aprovação (ver `approveEffect`/`rejectEffect`).
 */
import { create } from "zustand";
import { opsBus, type StructuredOp } from "../lib/ops";
import {
  addCard,
  describeAction,
  describeTrigger,
  emptyBoard,
  ensureLane,
  findCardByTitle,
  isExternal,
  isOverdue,
  makeCard,
  moveCard,
  ruleFromTexts,
  runRules,
  todayISO,
  type Board,
  type BoardEvent,
  type Effect,
  type Rule
} from "./automations";
import { drainEffects } from "./workEffects";
import { useApp } from "./store";

/* --------------------------- Estado persistido ---------------------- */

const STORAGE_KEY = "work.board";
const ARTIFACTS_KEY = "work.artifacts";
const ROOT_KEY = "work.root";
export const LOG_CAP = 120;

/**
 * Alcance real do motor — usado em tooltips.
 *
 * A redação anterior dizia que os gatilhos ficavam "dormentes" fora da aba
 * Work. Deixou de ser verdade quando este módulo passou a ser carregado no
 * boot; e, com ações externas em jogo, dizer que nada dispara seria pior que
 * impreciso — seria enganoso sobre o que o app faz sozinho.
 */
export const DORMANT_HINT =
  "Motor de automações ativo com o app aberto, em qualquer aba: ops do chat (ops:work) e vencimento de due date " +
  "disparam as regras mesmo com o quadro fora da tela. Ações externas (webhook/MCP) ficam numa fila e só saem " +
  "com aprovação. Com o app fechado, nada roda.";

export interface LogEntry {
  at: number;
  line: string;
}

export interface WorkState {
  board: Board;
  rules: Rule[];
  log: LogEntry[];
  /** chaves `${cardId}:${due}` já processadas pelo trigger card_overdue */
  overdueSeen: string[];
  /**
   * Ações externas esperando aprovação. NÃO é persistida de propósito: uma
   * fila salva em disco significaria que fechar o app e reabrir dias depois
   * dispararia webhooks de um contexto que não existe mais.
   */
  pending: PendingEffect[];
}

/** Artefato de texto/Markdown REAL, salvo localmente. */
export interface Artifact {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

function initialWorkState(): WorkState {
  return { board: emptyBoard(), rules: [], log: [], overdueSeen: [], pending: [] };
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
      overdueSeen: Array.isArray(parsed.overdueSeen) ? parsed.overdueSeen : [],
      pending: [] // fila de aprovação nunca vem do disco
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

export interface WorkStore extends WorkState {
  artifacts: Artifact[];
  root: string;
}

/** Store zustand de módulo: WorkRail e WorkView compartilham o MESMO estado. */
export const useWork = create<WorkStore>()(() => ({
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

/** Uma linha de log carimbada. Exportada: a view também registra ações. */
export const entry = (line: string): LogEntry => ({ at: Date.now(), line });

/** Aplica uma transformação pura sobre a fatia do motor (board/regras/log). */
export function updateEngine(mutate: (prev: WorkState) => WorkState) {
  const current = useWork.getState();
  const prev: WorkState = {
    board: current.board,
    rules: current.rules,
    log: current.log,
    overdueSeen: current.overdueSeen,
    pending: current.pending
  };
  const next = mutate(prev);
  if (next !== prev) useWork.setState(next);
}

/**
 * Roda o motor para um evento e anexa as execuções ao log (imutável).
 *
 * Os efeitos externos NÃO saem daqui: `withEvent` continua sendo uma função
 * de estado. Ela só enfileira — quem envia é `sendEffects`, depois do gate.
 */
export function withEvent(prev: WorkState, board: Board, event: BoardEvent): WorkState {
  const result = runRules(board, event, prev.rules);
  const queued = enqueueEffects(prev, result.effects);
  if (!result.log.length) return { ...prev, board: result.board, pending: queued.pending, log: queued.log ?? prev.log };
  return {
    ...prev,
    board: result.board,
    pending: queued.pending,
    log: [...(queued.log ?? []), ...result.log.map(entry), ...prev.log].slice(0, LOG_CAP)
  };
}

/* ----------------------- Fila de efeitos externos -------------------- */

export interface PendingEffect {
  id: string;
  at: number;
  effect: Effect;
}

let effectSeq = 0;

/**
 * Separa o que sai na hora do que espera aprovação.
 *
 * Regra externa nasce com `requireApproval` ligado no builder. O motivo é
 * concreto: `card_overdue` é disparado por TIMER — sem gate, o app chamaria
 * serviço de terceiro sozinho, sem ninguém no circuito. Regra marcada como
 * automática pelo admin sai direto, e isso fica registrado no log.
 */
function enqueueEffects(prev: WorkState, effects: readonly Effect[]): { pending: PendingEffect[]; log?: LogEntry[] } {
  if (!effects.length) return { pending: prev.pending };
  const byRule = new Map(prev.rules.map((rule) => [rule.id, rule]));
  const auto: Effect[] = [];
  const held: PendingEffect[] = [];
  for (const effect of effects) {
    const rule = byRule.get(effect.ruleId);
    // Ausência de regra ou flag indefinida ⇒ exige aprovação. O default seguro
    // é pedir, não presumir.
    if (rule?.requireApproval === false) auto.push(effect);
    else held.push({ id: `eff-${(effectSeq += 1)}`, at: Date.now(), effect });
  }
  if (auto.length) void sendEffects(auto);
  if (!held.length) return { pending: prev.pending };
  return {
    pending: [...prev.pending, ...held],
    log: [entry(`${held.length} ação(ões) externa(s) aguardando aprovação`)]
  };
}

/** Envia de fato e escreve o resultado no log. Nunca lança. */
async function sendEffects(effects: readonly Effect[]) {
  const servers = useApp.getState().settings.mcpServers ?? [];
  const outcomes = await drainEffects(effects, servers);
  if (!outcomes.length) return;
  useWork.setState((state) => ({
    log: [...outcomes.map((outcome) => entry(outcome.line)), ...state.log].slice(0, LOG_CAP)
  }));
}

/** Aprova um efeito pendente: tira da fila e envia. */
export function approveEffect(id: string) {
  const found = useWork.getState().pending.find((item) => item.id === id);
  if (!found) return;
  useWork.setState((state) => ({ pending: state.pending.filter((item) => item.id !== id) }));
  void sendEffects([found.effect]);
}

/** Recusa: sai da fila sem sair do processo, e fica registrado. */
export function rejectEffect(id: string) {
  const found = useWork.getState().pending.find((item) => item.id === id);
  if (!found) return;
  useWork.setState((state) => ({
    pending: state.pending.filter((item) => item.id !== id),
    log: [entry(`ação externa de "${found.effect.ruleName}" recusada — nada foi enviado`), ...state.log].slice(0, LOG_CAP)
  }));
}

/* ---------------------- Ops do chat via motor ------------------------ */

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Aplica as ops do canal "work" passando cada efeito pelo motor de regras. */
export function applyWorkOps(prev: WorkState, ops: StructuredOp[]): WorkState {
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
export function processOverdue(prev: WorkState, today: string): WorkState {
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


/* -------------------------- Agendador do módulo ---------------------- */

/**
 * Liga ops do chat e relógio de due date. Idempotente: chamar duas vezes não
 * duplica assinatura nem timer (React 18 monta o efeito duas vezes em dev).
 */
let started = false;

export function startWorkEngine(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // ops:work valem em qualquer aba. Antes a assinatura vivia no componente, e
  // `opsBus.publish` não tem buffer: op emitida com outra aba ativa era PERDIDA.
  opsBus.subscribe("work", (ops) => {
    updateEngine((previous) => applyWorkOps(previous, ops));
  });

  // Relógio de due date. A cada minuto reavalia; `processOverdue` já grava o
  // `overdueSeen` ANTES de rodar os eventos, então virar o dia não duplica.
  const tick = () => updateEngine((previous) => processOverdue(previous, todayISO()));
  tick();
  window.setInterval(tick, 60_000);
}
