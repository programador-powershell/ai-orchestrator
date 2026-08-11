/**
 * Motor de automações do quadro Work (Butler-like) — 100% puro e testado.
 *
 * O quadro é um valor imutável (Board); eventos (BoardEvent) passam pelas
 * regras (Rule) em runRules, que devolve um novo quadro + log das execuções.
 * Ações podem gerar novos eventos (mover cria "card_moved" etc.) e o
 * encadeamento é limitado a MAX_CHAIN derivações para impedir loops.
 *
 * Também vivem aqui (puros, testáveis):
 * - helpers imutáveis do quadro (makeCard/addCard/moveCard/updateCard/removeCard)
 * - atraso real de due date (isOverdue/todayISO)
 * - export/import do quadro em Markdown (round-trip testado)
 * - ruleFromTexts: converte trigger/action em texto (op add_automation do chat)
 *   para uma regra estruturada do motor.
 */

/* ------------------------------- Tipos ------------------------------ */

export interface Card {
  id: string;
  title: string;
  /** Descrição livre do cartão. */
  detail: string;
  labels: string[];
  /** Due date em ISO "YYYY-MM-DD" ou null. */
  due: string | null;
  createdAt: number;
}

export interface Lane {
  name: string;
  cards: Card[];
}

export interface Board {
  lanes: Lane[];
}

export type Trigger =
  | { kind: "card_moved"; toLane?: string }
  | { kind: "card_created"; titleContains?: string }
  | { kind: "card_overdue" };

export type Action =
  | { kind: "move_to"; lane: string }
  | { kind: "add_label"; label: string }
  | { kind: "create_card"; lane: string; title: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
}

export type BoardEvent =
  | { kind: "card_moved"; cardId: string; toLane: string }
  | { kind: "card_created"; cardId: string }
  | { kind: "card_overdue"; cardId: string };

export interface RunResult {
  board: Board;
  log: string[];
}

/** Máximo de eventos DERIVADOS processados a partir do evento original. */
export const MAX_CHAIN = 5;

/* ----------------------------- Utilidades --------------------------- */

export const DEFAULT_LANES = ["A fazer", "Em andamento", "Concluído"] as const;

export function newCardId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Quadro inicial REAL: 3 colunas padrão, zero cartões. */
export function emptyBoard(): Board {
  return { lanes: DEFAULT_LANES.map((name) => ({ name, cards: [] })) };
}

export function makeCard(
  title: string,
  init?: Partial<Omit<Card, "id" | "title">>,
  newId: () => string = newCardId
): Card {
  return {
    id: newId(),
    title,
    detail: init?.detail ?? "",
    labels: init?.labels ?? [],
    due: init?.due ?? null,
    createdAt: init?.createdAt ?? Date.now()
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findCard(board: Board, cardId: string): { lane: Lane; card: Card } | null {
  for (const lane of board.lanes) {
    const card = lane.cards.find((entry) => entry.id === cardId);
    if (card) return { lane, card };
  }
  return null;
}

export function findCardByTitle(board: Board, title: string): Card | null {
  for (const lane of board.lanes) {
    const card = lane.cards.find((entry) => sameName(entry.title, title));
    if (card) return card;
  }
  return null;
}

/** Garante a coluna (case-insensitive) devolvendo um novo Board. */
export function ensureLane(board: Board, laneName: string): Board {
  if (board.lanes.some((lane) => sameName(lane.name, laneName))) return board;
  return { lanes: [...board.lanes, { name: laneName.trim(), cards: [] }] };
}

/** Adiciona um cartão à coluna (cria a coluna se preciso). Imutável. */
export function addCard(board: Board, laneName: string, card: Card): Board {
  const withLane = ensureLane(board, laneName);
  return {
    lanes: withLane.lanes.map((lane) =>
      sameName(lane.name, laneName) ? { ...lane, cards: [...lane.cards, card] } : lane
    )
  };
}

/** Move um cartão para a coluna destino. moved=false se já estava lá / não existe. */
export function moveCard(
  board: Board,
  cardId: string,
  laneName: string
): { board: Board; moved: boolean } {
  const hit = findCard(board, cardId);
  if (!hit) return { board, moved: false };
  if (sameName(hit.lane.name, laneName)) return { board, moved: false };
  const withLane = ensureLane(board, laneName);
  return {
    board: {
      lanes: withLane.lanes.map((lane) => {
        if (lane.cards.some((entry) => entry.id === cardId)) {
          return { ...lane, cards: lane.cards.filter((entry) => entry.id !== cardId) };
        }
        if (sameName(lane.name, laneName)) return { ...lane, cards: [...lane.cards, hit.card] };
        return lane;
      })
    },
    moved: true
  };
}

export function updateCard(board: Board, cardId: string, patch: Partial<Omit<Card, "id">>): Board {
  return {
    lanes: board.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card))
    }))
  };
}

export function removeCard(board: Board, cardId: string): Board {
  return {
    lanes: board.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.filter((card) => card.id !== cardId)
    }))
  };
}

/* --------------------------- Due date real -------------------------- */

/** Data local em ISO "YYYY-MM-DD" (comparável lexicamente). */
export function todayISO(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Atrasado = due estritamente anterior a hoje. Sem due nunca atrasa. */
export function isOverdue(due: string | null, today: string): boolean {
  return Boolean(due) && (due as string) < today;
}

/* ------------------------------ O motor ----------------------------- */

function triggerMatches(trigger: Trigger, event: BoardEvent, board: Board): boolean {
  if (trigger.kind !== event.kind) return false;
  if (trigger.kind === "card_moved" && event.kind === "card_moved") {
    return !trigger.toLane || sameName(trigger.toLane, event.toLane);
  }
  if (trigger.kind === "card_created" && event.kind === "card_created") {
    if (!trigger.titleContains) return true;
    const card = findCard(board, event.cardId)?.card;
    return Boolean(card && card.title.toLowerCase().includes(trigger.titleContains.toLowerCase()));
  }
  return true; // card_overdue: sem filtro adicional
}

interface Applied {
  board: Board;
  line: string;
  next: BoardEvent | null;
}

function applyAction(board: Board, rule: Rule, event: BoardEvent, newId: () => string): Applied | null {
  const action = rule.action;
  if (action.kind === "move_to") {
    const hit = findCard(board, event.cardId);
    if (!hit) return null;
    const result = moveCard(board, event.cardId, action.lane);
    if (!result.moved) return null;
    return {
      board: result.board,
      line: `regra "${rule.name}": moveu "${hit.card.title}" para "${action.lane}"`,
      next: { kind: "card_moved", cardId: event.cardId, toLane: action.lane }
    };
  }
  if (action.kind === "add_label") {
    const hit = findCard(board, event.cardId);
    if (!hit || hit.card.labels.some((label) => sameName(label, action.label))) return null;
    return {
      board: updateCard(board, hit.card.id, { labels: [...hit.card.labels, action.label] }),
      line: `regra "${rule.name}": etiquetou "${hit.card.title}" com "${action.label}"`,
      next: null
    };
  }
  // create_card
  const card = makeCard(action.title, undefined, newId);
  return {
    board: addCard(board, action.lane, card),
    line: `regra "${rule.name}": criou "${action.title}" em "${action.lane}"`,
    next: { kind: "card_created", cardId: card.id }
  };
}

/**
 * Processa um evento pelas regras habilitadas. Imutável.
 * Eventos derivados de ações são reencadeados até MAX_CHAIN derivações;
 * ao estourar, a cadeia é cortada e o corte registrado no log.
 */
export function runRules(
  board: Board,
  event: BoardEvent,
  rules: Rule[],
  opts?: { newId?: () => string }
): RunResult {
  const newId = opts?.newId ?? newCardId;
  const log: string[] = [];
  let current = board;
  const queue: Array<{ event: BoardEvent; depth: number }> = [{ event, depth: 0 }];

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!triggerMatches(rule.trigger, item.event, current)) continue;
      const applied = applyAction(current, rule, item.event, newId);
      if (!applied) continue;
      current = applied.board;
      log.push(applied.line);
      if (!applied.next) continue;
      if (item.depth + 1 > MAX_CHAIN) {
        log.push(`anti-loop: cadeia interrompida após ${MAX_CHAIN} encadeamentos (regra "${rule.name}")`);
      } else {
        queue.push({ event: applied.next, depth: item.depth + 1 });
      }
    }
  }
  return { board: current, log };
}

/* -------------------- Descrições legíveis das regras ----------------- */

export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "card_moved":
      return trigger.toLane ? `cartão movido para "${trigger.toLane}"` : "cartão movido (qualquer coluna)";
    case "card_created":
      return trigger.titleContains
        ? `cartão criado com título contendo "${trigger.titleContains}"`
        : "cartão criado";
    case "card_overdue":
      return "cartão atrasado (due vencido)";
  }
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "move_to":
      return `mover para "${action.lane}"`;
    case "add_label":
      return `adicionar etiqueta "${action.label}"`;
    case "create_card":
      return `criar cartão "${action.title}" em "${action.lane}"`;
  }
}

/* --------------- Regra a partir de texto (op add_automation) --------- */

const quoted = (text: string): string | null => {
  const match = /["“']([^"”']+)["”']/.exec(text);
  return match ? match[1].trim() : null;
};

const afterKeyword = (text: string, keyword: string): string | null => {
  const lower = text.toLowerCase();
  const index = lower.indexOf(keyword);
  if (index === -1) return null;
  const value = text.slice(index + keyword.length).trim().replace(/[.;,]+$/, "");
  return value || null;
};

function parseTriggerText(text: string): Trigger | null {
  const lower = text.toLowerCase();
  if (/atras|vencid|overdue/.test(lower)) return { kind: "card_overdue" };
  if (/mov/.test(lower)) {
    const toLane = quoted(text) ?? afterKeyword(text, "para ");
    return toLane ? { kind: "card_moved", toLane } : { kind: "card_moved" };
  }
  if (/criad|criar|novo cart|nova tarefa|created/.test(lower)) {
    const titleContains = quoted(text) ?? afterKeyword(text, "contendo ");
    return titleContains ? { kind: "card_created", titleContains } : { kind: "card_created" };
  }
  return null;
}

function parseActionText(text: string): Action | null {
  const lower = text.toLowerCase();
  if (/mover|move/.test(lower)) {
    const lane = quoted(text) ?? afterKeyword(text, "para ");
    return lane ? { kind: "move_to", lane } : null;
  }
  if (/etiquet|label|r[oó]tul|marcar/.test(lower)) {
    const label = quoted(text) ?? afterKeyword(text, "etiqueta ") ?? afterKeyword(text, "com ");
    return label ? { kind: "add_label", label } : null;
  }
  if (/(criar|novo|nova).*(cart|tarefa)/.test(lower)) {
    const title = quoted(text) ?? "Nova tarefa";
    const lane = afterKeyword(text, " em ") ?? DEFAULT_LANES[0];
    return { kind: "create_card", lane, title };
  }
  return null;
}

/**
 * Converte a op de chat {"op":"add_automation","trigger":texto,"action":texto}
 * numa regra estruturada do motor. null = não reconhecida (a view loga isso,
 * nada é simulado).
 */
export function ruleFromTexts(
  name: string,
  triggerText: string,
  actionText: string,
  newId: () => string = newCardId
): Rule | null {
  const trigger = parseTriggerText(triggerText);
  const action = parseActionText(actionText);
  if (!trigger || !action) return null;
  return { id: newId(), name, enabled: true, trigger, action };
}

/* ----------------------- Markdown export/import ---------------------- */

const DONE_LANE = "concluído";

/**
 * Exporta o quadro em Markdown legível e re-importável:
 *   ## Coluna
 *   - [ ] Título
 *     labels: a, b
 *     due: 2026-08-15
 *     desc: descrição em uma linha
 */
export function exportBoardMarkdown(board: Board): string {
  const lines: string[] = ["# Quadro Work", ""];
  for (const lane of board.lanes) {
    lines.push(`## ${lane.name}`, "");
    for (const card of lane.cards) {
      const check = sameName(lane.name, DONE_LANE) ? "x" : " ";
      lines.push(`- [${check}] ${card.title}`);
      if (card.labels.length) lines.push(`  labels: ${card.labels.join(", ")}`);
      if (card.due) lines.push(`  due: ${card.due}`);
      if (card.detail) lines.push(`  desc: ${card.detail.replace(/\s*\n\s*/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Faz o parse do mesmo formato exportado (round-trip testado). */
export function parseBoardMarkdown(markdown: string, newId: () => string = newCardId): Board {
  const lanes: Lane[] = [];
  let currentLane: Lane | null = null;
  let currentCard: Card | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const laneMatch = /^##\s+(.+)$/.exec(raw);
    if (laneMatch) {
      currentLane = { name: laneMatch[1].trim(), cards: [] };
      lanes.push(currentLane);
      currentCard = null;
      continue;
    }
    const cardMatch = /^-\s+\[( |x|X)\]\s+(.+)$/.exec(raw);
    if (cardMatch && currentLane) {
      currentCard = makeCard(cardMatch[2].trim(), undefined, newId);
      currentLane.cards.push(currentCard);
      continue;
    }
    const metaMatch = /^\s+(labels|due|desc):\s*(.*)$/.exec(raw);
    if (metaMatch && currentCard) {
      const value = metaMatch[2].trim();
      if (metaMatch[1] === "labels") {
        currentCard.labels = value
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean);
      } else if (metaMatch[1] === "due") {
        currentCard.due = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
      } else {
        currentCard.detail = value;
      }
    }
  }
  return { lanes };
}
