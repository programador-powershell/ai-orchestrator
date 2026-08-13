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
  | { kind: "create_card"; lane: string; title: string }
  /**
   * Efeito EXTERNO. `secretRef` é a chave no cofre do SO — a URL de webhook
   * de Slack/Teams É a credencial, então ela nunca entra no documento do
   * quadro (que vive em localStorage). Aqui fica só o ponteiro.
   */
  | { kind: "webhook"; secretRef: string; label: string; template?: string }
  /** Ferramenta MCP no formato `mcp:<servidor>:<tool>`. */
  | { kind: "mcp"; tool: string; args?: Record<string, unknown> };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  /**
   * Ação externa espera aprovação humana antes de sair. Padrão do builder é
   * `true`: um `card_overdue` disparado por timer não pode chamar serviço de
   * fora sem ninguém no circuito.
   */
  requireApproval?: boolean;
}

/** Ações que saem do processo — precisam de gate e de contagem própria. */
export function isExternal(action: Action): boolean {
  return action.kind === "webhook" || action.kind === "mcp";
}

export type BoardEvent =
  | { kind: "card_moved"; cardId: string; toLane: string }
  | { kind: "card_created"; cardId: string }
  | { kind: "card_overdue"; cardId: string };

/**
 * Efeito externo PENDENTE. O motor é puro: ele descreve o que sairia, quem
 * executa é `lib/workEffects.ts`. Sem isso, `automations.ts` teria de importar
 * o cliente MCP — que puxa `agent`/`fsx`/`terminal` e o `invoke` do Tauri,
 * matando a testabilidade em Node.
 */
export type Effect =
  | { kind: "webhook"; ruleId: string; ruleName: string; secretRef: string; label: string; body: string }
  | {
      kind: "mcp";
      ruleId: string;
      ruleName: string;
      server: string;
      tool: string;
      args: Record<string, unknown>;
    };

export interface RunResult {
  board: Board;
  log: string[];
  /** Efeitos externos a drenar depois — nunca executados aqui. */
  effects: Effect[];
}

/** Máximo de eventos DERIVADOS processados a partir do evento original. */
export const MAX_CHAIN = 5;

/**
 * Teto de efeitos externos por evento. MAX_CHAIN não protege: efeitos têm
 * `next: null`, então não entram na contagem de encadeamento — sem este teto,
 * um quadro com muitas regras metralharia o endpoint de fora.
 */
export const MAX_EFFECTS = 8;

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

/* ---------------------- Template do corpo externo -------------------- */

export interface TemplateContext {
  card: Card | null;
  lane: string;
  rule: string;
  event: string;
}

/** Placeholders reconhecidos — qualquer outro fica literal, não estoura. */
function templateValue(key: string, ctx: TemplateContext): string | null {
  switch (key) {
    case "card.id":
      return ctx.card?.id ?? "";
    case "card.title":
      return ctx.card?.title ?? "";
    case "card.detail":
      return ctx.card?.detail ?? "";
    case "card.labels":
      return (ctx.card?.labels ?? []).join(", ");
    case "card.due":
      return ctx.card?.due ?? "";
    case "lane":
      return ctx.lane;
    case "rule":
      return ctx.rule;
    case "event":
      return ctx.event;
    default:
      return null;
  }
}

/**
 * Renderiza o corpo do webhook. Sem template, monta um JSON default com o
 * cartão inteiro. Placeholder desconhecido é mantido como veio — engolir em
 * silêncio esconderia o erro de digitação de quem escreveu a regra.
 */
export function renderTemplate(template: string | undefined, ctx: TemplateContext): string {
  if (!template || !template.trim()) {
    return JSON.stringify({
      rule: ctx.rule,
      event: ctx.event,
      lane: ctx.lane,
      card: ctx.card
        ? {
            id: ctx.card.id,
            title: ctx.card.title,
            detail: ctx.card.detail,
            labels: ctx.card.labels,
            due: ctx.card.due
          }
        : null
    });
  }
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const value = templateValue(key, ctx);
    return value === null ? whole : value;
  });
}

/** `mcp:jira:create_issue` → `{server:"jira", tool:"create_issue"}`. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const parts = name.split(":");
  if (parts.length !== 3 || parts[0] !== "mcp") return null;
  const [, server, tool] = parts;
  if (!server.trim() || !tool.trim()) return null;
  return { server: server.trim(), tool: tool.trim() };
}

interface Applied {
  board: Board;
  line: string;
  next: BoardEvent | null;
  /** Presente só nas ações externas; o board volta intacto nesse caso. */
  effect?: Effect;
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
  if (action.kind === "create_card") {
    const card = makeCard(action.title, undefined, newId);
    return {
      board: addCard(board, action.lane, card),
      line: `regra "${rule.name}": criou "${action.title}" em "${action.lane}"`,
      next: { kind: "card_created", cardId: card.id }
    };
  }

  // A partir daqui é efeito EXTERNO: o quadro sai INTACTO (mesma referência).
  const hit = findCard(board, event.cardId);
  const ctx: TemplateContext = {
    card: hit?.card ?? null,
    lane: hit?.lane.name ?? "",
    rule: rule.name,
    event: event.kind
  };
  if (action.kind === "webhook") {
    return {
      board,
      line: `regra "${rule.name}": webhook "${action.label}" enfileirado`,
      next: null,
      effect: {
        kind: "webhook",
        ruleId: rule.id,
        ruleName: rule.name,
        secretRef: action.secretRef,
        label: action.label,
        body: renderTemplate(action.template, ctx)
      }
    };
  }
  // action.kind === "mcp"
  const target = parseMcpTool(action.tool);
  if (!target) {
    return {
      board,
      line: `regra "${rule.name}": ferramenta "${action.tool}" fora do formato mcp:<servidor>:<tool> — ignorada`,
      next: null
    };
  }
  return {
    board,
    line: `regra "${rule.name}": ${action.tool} enfileirado`,
    next: null,
    effect: {
      kind: "mcp",
      ruleId: rule.id,
      ruleName: rule.name,
      server: target.server,
      tool: target.tool,
      args: action.args ?? { cardId: event.cardId, cardTitle: ctx.card?.title ?? "", lane: ctx.lane }
    }
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
  const effects: Effect[] = [];
  let current = board;
  let dropped = 0;
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
      if (applied.effect) {
        if (effects.length < MAX_EFFECTS) effects.push(applied.effect);
        else dropped += 1;
      }
      if (!applied.next) continue;
      if (item.depth + 1 > MAX_CHAIN) {
        log.push(`anti-loop: cadeia interrompida após ${MAX_CHAIN} encadeamentos (regra "${rule.name}")`);
      } else {
        queue.push({ event: applied.next, depth: item.depth + 1 });
      }
    }
  }
  if (dropped) {
    log.push(`limite de efeitos: ${dropped} ação(ões) externa(s) descartada(s) acima de ${MAX_EFFECTS} por evento`);
  }
  return { board: current, log, effects };
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
    case "webhook":
      // Nunca a URL: ela é a credencial. Só o rótulo escolhido pelo admin.
      return `chamar webhook "${action.label}"`;
    case "mcp":
      return `chamar ferramenta ${action.tool}`;
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

/**
 * Ações EXTERNAS são deliberadamente ausentes daqui: este parser alimenta a op
 * `add_automation`, que nasce de texto do modelo. Deixar o chat criar uma regra
 * que chama serviço de fora seria injeção de prompt com efeito real — webhook e
 * MCP só existem pelo builder da UI, onde o admin escolhe o segredo.
 */
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
