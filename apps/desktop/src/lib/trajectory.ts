/**
 * Trilha da execução — o registro append-only do que o modelo viu.
 *
 * O buraco que isto fecha: o composer monta o prompt de sistema a partir de
 * **oito fontes** — prompt master do admin, regras do projeto, contrato de
 * design, memória recuperada, catálogo de ops, contexto do Office, contexto do
 * Ship, menções de arquivo — e agora também os plugins. Nenhuma delas deixava
 * rastro. Quando a resposta saía errada, ninguém conseguia dizer qual injeção
 * causou: nem o usuário, nem o admin, nem quem estivesse depurando.
 *
 * Isso é pior aqui do que num app pessoal, porque o produto é governança. O
 * console do admin já responde *quanto custou* e a auditoria já responde *o que
 * a IA rodou na máquina*. Faltava a pergunta do meio: **por que o modelo
 * respondeu isso**.
 *
 * ## Decisões
 *
 * - **Append-only.** Evento não se edita nem se apaga; corrigir o passado
 *   destruiria a única coisa que a trilha promete.
 * - **Prévia, não conteúdo.** Guardar o texto inteiro de cada injeção duplicaria
 *   a conversa em memória. Guardamos tamanho + um recorte, que basta para
 *   identificar a origem.
 * - **Redigido na entrada.** O que parece segredo é mascarado ANTES de virar
 *   evento — trilha não é lugar de chave.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por trajectory.test.ts.
 */

import type { UiMode } from "@ai-bot/contracts";

/** De onde veio o texto que entrou no prompt. */
export type ContextSource =
  | "prompt-master"
  | "project-rules"
  | "design-contract"
  | "memory"
  | "ops-catalog"
  | "office-context"
  | "ship-context"
  | "mentions"
  | "plugins"
  | "user";

export const SOURCE_LABEL: Record<ContextSource, string> = {
  "prompt-master": "Prompt master (admin)",
  "project-rules": "Regras do projeto",
  "design-contract": "Contrato de design",
  memory: "Memória",
  "ops-catalog": "Catálogo de ações",
  "office-context": "Contexto do Office",
  "ship-context": "Contexto do Ship",
  mentions: "Arquivos mencionados",
  plugins: "Plugins",
  user: "Mensagem do usuário"
};

export type TrajectoryEvent =
  | { kind: "context"; at: number; source: ContextSource; chars: number; preview: string }
  | { kind: "tool"; at: number; name: string; ok: boolean; ms: number; detail: string }
  | { kind: "agent"; at: number; id: string; role: string; model: string; status: string }
  | { kind: "note"; at: number; text: string };

export interface Trajectory {
  id: string;
  mode: UiMode;
  startedAt: number;
  events: TrajectoryEvent[];
  /** Eventos descartados pelo teto — dizer que houve corte é parte da trilha. */
  dropped: number;
}

/** Teto de eventos guardados. Acima disso o começo é preservado e o meio cai. */
export const MAX_EVENTS = 500;
const PREVIEW_CHARS = 160;

export function createTrajectory(id: string, mode: UiMode, startedAt: number): Trajectory {
  return { id, mode, startedAt, events: [], dropped: 0 };
}

/**
 * Máscara do que parece segredo.
 *
 * A trilha é lida por outra pessoa (o admin) e o `exportText` vira anexo de
 * chamado, então ela não pode virar um caminho lateral para ver a chave que o
 * cofre guarda.
 *
 * Duas formas que passavam batido e agora não passam:
 *
 * - `authorization: Bearer 3f9c8a…` — o `\S+` genérico parava no primeiro
 *   espaço, ou seja, mascarava a palavra "Bearer" e deixava o token do lado;
 * - `"api_key": "hunter2"` — a aspa de fechamento do NOME da chave ficava
 *   entre ele e o `:`, e o padrão exigia os dois colados.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, "«segredo»")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "«token»")
    // O esquema (Bearer/Basic/Token) fica: ele diz COMO autentica, e isso é
    // informação de auditoria. O que vem depois é que é segredo.
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "$1 «segredo»")
    // As duas exclusões evitam mascarar o que a regra acima já tratou: sem
    // elas `authorization: Bearer «segredo»` virava `«segredo» «segredo»` e a
    // trilha perdia a informação de COMO a chamada autenticava. O esquema
    // colado ao valor (`Bearer-abc…`) continua caindo aqui.
    .replace(
      /(authorization|api[-_]?key|senha|password|secret|token)(["']?\s*[:=]\s*)(["']?)(?!«)(?!(?:Bearer|Basic|Token)\s)[^\s"';,|&]+\3/gi,
      "$1$2$3«segredo»$3"
    );
}

export function preview(text: string): string {
  const limpo = redact(text).replace(/\s+/g, " ").trim();
  return limpo.length > PREVIEW_CHARS ? `${limpo.slice(0, PREVIEW_CHARS)}…` : limpo;
}

/**
 * Acrescenta um evento. Devolve uma trilha NOVA — o chamador guarda o retorno.
 *
 * No estouro do teto, o **começo é preservado** e o meio é descartado: o início
 * tem as injeções de contexto, que são justamente o que se quer auditar; o fim
 * tem o que acabou de acontecer. O meio é o que menos falta.
 */
export function record(trajectory: Trajectory, event: TrajectoryEvent): Trajectory {
  const events = [...trajectory.events, event];
  if (events.length <= MAX_EVENTS) return { ...trajectory, events };
  const cabeca = Math.floor(MAX_EVENTS / 2);
  const cauda = MAX_EVENTS - cabeca;
  return {
    ...trajectory,
    events: [...events.slice(0, cabeca), ...events.slice(events.length - cauda)],
    dropped: trajectory.dropped + (events.length - MAX_EVENTS)
  };
}

/** Atalho para a injeção de contexto, já com prévia e redação. */
export function recordContext(
  trajectory: Trajectory,
  source: ContextSource,
  content: string,
  at: number
): Trajectory {
  return record(trajectory, {
    kind: "context",
    at,
    source,
    chars: content.length,
    preview: preview(content)
  });
}

/* ------------------------------- Leitura ------------------------------- */

export interface SourceShare {
  source: ContextSource;
  chars: number;
  count: number;
  /** Fração do contexto injetado, de 0 a 1. */
  share: number;
}

/**
 * Quanto cada fonte contribuiu.
 *
 * É a visão que responde a pergunta prática: "o que está ocupando o prompt?".
 * Ordena por tamanho porque o maior é quase sempre o culpado quando o modelo
 * ignora a instrução do fim.
 */
export function bySource(trajectory: Trajectory): SourceShare[] {
  const mapa = new Map<ContextSource, { chars: number; count: number }>();
  for (const event of trajectory.events) {
    if (event.kind !== "context") continue;
    const atual = mapa.get(event.source) ?? { chars: 0, count: 0 };
    mapa.set(event.source, { chars: atual.chars + event.chars, count: atual.count + 1 });
  }
  const total = [...mapa.values()].reduce((soma, item) => soma + item.chars, 0);
  return [...mapa.entries()]
    .map(([source, item]) => ({
      source,
      chars: item.chars,
      count: item.count,
      share: total > 0 ? item.chars / total : 0
    }))
    .sort((a, b) => b.chars - a.chars);
}

export interface TrajectorySummary {
  events: number;
  dropped: number;
  contextChars: number;
  tools: number;
  toolsFailed: number;
  agents: number;
  durationMs: number;
}

export function summarize(trajectory: Trajectory, now: number): TrajectorySummary {
  const tools = trajectory.events.filter((event) => event.kind === "tool");
  return {
    events: trajectory.events.length,
    dropped: trajectory.dropped,
    contextChars: trajectory.events.reduce(
      (soma, event) => soma + (event.kind === "context" ? event.chars : 0),
      0
    ),
    tools: tools.length,
    toolsFailed: tools.filter((event) => event.kind === "tool" && !event.ok).length,
    agents: new Set(
      trajectory.events.filter((event) => event.kind === "agent").map((event) => (event as { id: string }).id)
    ).size,
    durationMs: Math.max(0, now - trajectory.startedAt)
  };
}

/** Filtro por fonte, para a tela inspecionar uma origem de cada vez. */
export function eventsOf(trajectory: Trajectory, source: ContextSource): TrajectoryEvent[] {
  return trajectory.events.filter((event) => event.kind === "context" && event.source === source);
}

/**
 * Exporta a trilha para anexar a um chamado.
 *
 * Texto e não JSON de propósito: quem lê é uma pessoa investigando por que a
 * resposta saiu daquele jeito, não um programa.
 */
export function exportText(trajectory: Trajectory, now: number): string {
  const resumo = summarize(trajectory, now);
  const linhas = [
    `Trilha ${trajectory.id} · aba ${trajectory.mode}`,
    `${resumo.events} evento(s)${resumo.dropped ? ` (+${resumo.dropped} descartado(s) pelo teto)` : ""} · ${resumo.contextChars} caracteres de contexto · ${resumo.tools} ferramenta(s), ${resumo.toolsFailed} com falha`,
    "",
    "Contexto por fonte:"
  ];
  for (const item of bySource(trajectory)) {
    linhas.push(`  ${SOURCE_LABEL[item.source]}: ${item.chars} car. (${Math.round(item.share * 100)}%)`);
  }
  linhas.push("", "Eventos:");
  for (const event of trajectory.events) {
    const t = `+${((event.at - trajectory.startedAt) / 1000).toFixed(1)}s`;
    if (event.kind === "context") linhas.push(`  ${t} [contexto] ${SOURCE_LABEL[event.source]}: ${event.preview}`);
    else if (event.kind === "tool") linhas.push(`  ${t} [ferramenta] ${event.name} ${event.ok ? "ok" : "FALHOU"} ${event.ms}ms ${event.detail}`);
    else if (event.kind === "agent") linhas.push(`  ${t} [agente] ${event.model} - ${event.role}: ${event.status}`);
    else linhas.push(`  ${t} [nota] ${event.text}`);
  }
  return linhas.join("\n");
}
