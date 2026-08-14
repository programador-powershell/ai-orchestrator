/**
 * Contratos do AI-BOT — o espelho TypeScript do Canonical Agent Protocol.
 *
 * A fonte da verdade é o Go (`services/gateway/internal/protocol`). Este arquivo
 * existe para o cliente não redigitar os campos e para o `tsc` reclamar quando
 * eles divergirem. Quando o Go mudar, isto muda junto — um envelope com campo a
 * mais que o cliente ignora é um recurso que ninguém vê, e é assim que features
 * somem sem deixar rastro.
 */

export const PROTOCOL_VERSION = 1;

/* ----------------------------- especialistas ---------------------------- */

/**
 * Os especialistas. Substituem as dez ABAS do produto anterior: o app tem uma
 * tela só, e o que muda é quem está atendendo.
 */
export const SPECIALISTS = [
  "chat",
  "code",
  "office",
  "design",
  "data",
  "work",
  "security",
  "agent",
  "fluxo",
  "tune"
] as const;
export type SpecialistId = (typeof SPECIALISTS)[number];

/** O master não é um especialista escolhível — ele roda ANTES da escolha existir. */
export const MASTER_ID = "master";

/** A forma que a tela única assume. Um componente por superfície. */
export const SURFACES = [
  "conversation",
  "editor",
  "document",
  "canvas",
  "schema",
  "board",
  "findings",
  "crew",
  "flow",
  "train"
] as const;
export type Surface = (typeof SURFACES)[number];

/** O que a barra lateral esquerda serve enquanto o especialista está ativo. */
export const RAILS = [
  "conversations",
  "files",
  "document",
  "layers",
  "tables",
  "tasks",
  "findings",
  "crew",
  "nodes",
  "runs"
] as const;
export type RailKind = (typeof RAILS)[number];

/** Atalho que aparece no composer quando o especialista está ativo. */
export interface SpecialistAction {
  id: string;
  label: string;
  insert: string;
  glyph: string;
}

/**
 * Parâmetros PROCEDURAIS do retrato do bot — não um arquivo de imagem.
 * O laboratório de avatares edita exatamente estes campos.
 */
export interface Avatar {
  seed: number;
  shape: "orb" | "squircle" | "hex" | "shield" | "bloom" | "chip";
  eyes: "dot" | "arc" | "visor" | "spark" | "scan" | "ring";
  mouth: "none" | "line" | "smile" | "wave" | "grid";
  accessory: "none" | "antenna" | "halo" | "bolt" | "glasses" | "crown" | "shield";
  motion: "idle" | "breathe" | "pulse" | "scan" | "orbit";
  hue: number;
  saturation: number;
  custom?: boolean;
}

/** A definição completa, servida pelo gateway. */
export interface SpecialistDefinition {
  id: string;
  name: string;
  tagline: string;
  glyph: string;
  hue: number;
  surface: Surface;
  rail: RailKind;
  system: string;
  placeholder: string;
  newLabel: string;
  actions?: SpecialistAction[];
  tools?: string[];
  triggers?: string[];
  preferredSkills?: string[];
  avatar: Avatar;
}

/* -------------------------------- envelope ------------------------------ */

export type EnvelopeKind =
  | "hello"
  | "ready"
  | "error"
  | "done"
  | "prompt"
  | "route"
  | "delta"
  | "message"
  | "thinking"
  | "tool.call"
  | "tool.result"
  | "approval.request"
  | "approval.decision"
  | "task.dispatch"
  | "task.progress"
  | "worker.done"
  | "escalate"
  | "ask"
  | "reply"
  | "gate"
  | "state";

export type ActorKind = "user" | "supervisor" | "specialist" | "worker" | "tool" | "system";

export interface Actor {
  kind: ActorKind;
  id?: string;
  /**
   * O especialista sob o qual o ator agiu. É o que a UI usa para desenhar o
   * ícone na frente da linha — por isso viaja no envelope e não é deduzido do
   * estado da tela: deduzir dá certo até a conversa trocar de especialista no
   * meio, que aqui é o caso normal.
   */
  specialist?: string;
}

export interface Envelope<P = unknown> {
  v: number;
  id: string;
  ts: string;
  seq: number;
  session: string;
  turn?: string;
  kind: EnvelopeKind;
  from: Actor;
  to?: Actor;
  payload?: P;
}

/* -------------------------------- payloads ------------------------------ */

export interface Hello {
  client: string;
  version: string;
  /**
   * Autentica a conexão. Vai no PRIMEIRO FRAME, nunca na query string da URL —
   * query entra em log de proxy e em histórico, e o navegador não aplica CORS a
   * WebSocket: sem token, qualquer página aberta na estação conversa com o
   * gateway e manda o AI-BOT executar ferramenta.
   */
  token?: string;
  sessionHint?: string;
  resumeFrom?: number;
  /**
   * Pede ao gateway que PULE o replay e mande só o que acontecer daqui em
   * diante. Existe para quem abre a conexão para observar (uma segunda janela,
   * um painel de acompanhamento): sem isto, toda conexão nova recebe o log
   * inteiro da sessão de volta, e um histórico longo entope o socket antes do
   * primeiro evento novo aparecer. Quem quer a conversa reconstruída — o caso
   * normal do app — não manda este campo e continua usando `resumeFrom`.
   */
  liveOnly?: boolean;
}

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  context: number;
  skills?: string[];
  local?: boolean;
}

/**
 * A conversa vista de fora, para a LISTA — não a sessão inteira.
 *
 * É um resumo de propósito: a barra lateral precisa de título, ícone e tamanho
 * para desenhar a linha, e mandar `SessionMeta` completo de cada conversa no
 * `ready` faria o primeiro frame carregar metadado que a lista nem lê. Os
 * campos que faltam (`lastSeq`, `syncedSeq`, `createdAt`, `cwd`, `projectId`)
 * só existem para a sessão ABERTA, e essa chega pelo `ready` e pelo replay.
 */
export interface SessionSummary {
  id: string;
  title: string;
  specialist?: string;
  model?: string;
  updatedAt: string;
  turns: number;
}

export interface Ready {
  session: string;
  seq: number;
  specialists: string[];
  models: ModelInfo[];
  activeSpecialist?: string;
  activeModel?: string;
  /**
   * As outras conversas guardadas no gateway. Vem no `ready` porque a lista é
   * a primeira coisa que a barra lateral desenha: buscá-la depois, numa segunda
   * chamada, deixaria a coluna vazia no primeiro quadro — e uma lista vazia é
   * indistinguível de "não há conversa nenhuma".
   */
  sessions?: SessionSummary[];
}

export interface Attachment {
  name: string;
  mime: string;
  bytes: number;
  ref: string;
}

export interface Prompt {
  text: string;
  /** Vazio = o master decide, que é o caminho normal. */
  specialist?: string;
  model?: string;
  attachments?: Attachment[];
  mentions?: string[];
}

/**
 * Como a rota foi decidida.
 *
 * `sticky` é o caso MAIS COMUM depois do primeiro turno, e não significa
 * "desisti de decidir": significa que a conversa já tem modo. Só o primeiro
 * input passa pela cascata; do segundo em diante tudo vai para o mesmo
 * executor, até alguém escrever `/mode <id>`.
 */
export type RouteReason = "explicit" | "heuristic" | "needle" | "model" | "sticky" | "fallback";

export interface Route {
  specialist: string;
  previous?: string;
  reason: RouteReason;
  confidence: number;
  surface: string;
  model: string;
  signals?: string[];
}

export interface Delta {
  text: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  text: string;
  specialist?: string;
  model?: string;
}

export interface Thinking {
  label: string;
  done?: boolean;
}

export type Risk = "read" | "write" | "execute" | "network" | "secret";

export interface ToolCall {
  callId: string;
  tool: string;
  args?: unknown;
  digest?: string;
}

export interface ToolResult {
  callId: string;
  tool: string;
  ok: boolean;
  output?: string;
  error?: string;
  elapsedMs?: number;
}

export interface ApprovalRequest {
  callId: string;
  tool: string;
  risk: Risk;
  summary: string;
  detail?: string;
  digest?: string;
}

export interface ApprovalDecision {
  callId: string;
  allow: boolean;
  /** `once` não guarda nada; `digest` vale para estes argumentos; `session` para a sessão. */
  scope?: "once" | "digest" | "session";
  comment?: string;
}

export interface Task {
  id: string;
  title: string;
  specialist: string;
  goal: string;
  dependsOn?: string[];
  worktree?: boolean;
  model?: string;
}

export interface TaskDispatch {
  task: Task;
  workerId: string;
  wave: number;
}

export interface TaskProgress {
  taskId: string;
  workerId: string;
  note: string;
  fraction?: number;
}

export interface WorkerDone {
  taskId: string;
  workerId: string;
  ok: boolean;
  result?: string;
  error?: string;
  worktree?: string;
  branch?: string;
  /**
   * O trabalhador PAROU PARA PERGUNTAR (`ESCALAR:`) em vez de errar.
   *
   * Vem junto com `ok: false`, porque não houve resultado para as tarefas
   * dependentes lerem — e mesmo assim não é falha. Quem decide é o gateway, que
   * já separa os dois casos na contagem da onda; a tela lê daqui em vez de
   * cruzar a lista de escalações pelo `taskId` (ver `outcomeOf`, em lib/crew.ts,
   * para o porquê de a dedução estar errada).
   */
  escalated?: boolean;
}

export interface Escalate {
  taskId: string;
  workerId: string;
  question: string;
  options?: string[];
}

export interface Ask {
  askId: string;
  question: string;
  options?: string[];
  blocking: boolean;
}

export interface Reply {
  askId: string;
  answer: string;
}

export type GateDecision = "proceed" | "retry" | "abort";

export interface Gate {
  gateId: string;
  taskId?: string;
  decision: GateDecision;
  reason?: string;
}

export interface State {
  specialist?: string;
  model?: string;
  surface?: string;
  busy: boolean;
  promptTokens?: number;
  outputTokens?: number;
}

export interface ProtocolError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface Done {
  turn: string;
  specialist?: string;
  outputTokens?: number;
  interrupted?: boolean;
}

/* -------------------------------- sessões ------------------------------- */

export interface SessionMeta {
  id: string;
  title: string;
  specialist?: string;
  model?: string;
  cwd?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  syncedSeq: number;
  turns: number;
  archived?: boolean;
}

/* --------------------------- linha da conversa -------------------------- */

/**
 * Uma linha renderizada na tela.
 *
 * `specialist` por LINHA, e não por conversa, é a mudança central do produto:
 * a mesma conversa mistura especialistas, e cada linha carrega o ícone de quem
 * a atendeu. Guardar o especialista na conversa faria a conversa inteira mudar
 * de ícone ao trocar de assunto — apagando de quem era cada resposta anterior.
 */
export interface ConversationLine {
  id: string;
  seq: number;
  turn?: string;
  role: "user" | "assistant" | "system";
  specialist?: string;
  model?: string;
  text: string;
  /** Preenchido enquanto o texto ainda está chegando. */
  streaming?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  route?: Route;
  error?: ProtocolError;
  ts: string;
}
