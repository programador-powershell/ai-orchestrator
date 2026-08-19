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
  | "delegate"
  | "state"
  | "notice";

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
  /**
   * O dono da conversa NOVA: "novo schema" na tela de Dados abre uma conversa
   * que já nasce do bot de Dados — a pessoa fica na tela, e o primeiro pedido
   * vai direto a ele. Ignorado quando a sessão já existe e quando o id não é
   * de nenhum especialista.
   */
  specialist?: string;
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

/* -------------------------- ambiente de execução ------------------------- */

/**
 * ONDE o próximo comando roda.
 *
 * Não é preferência de exibição: é o destino real da execução. O produto
 * anterior tinha este seletor no rodapé e roteava SÓ o terminal — o agente
 * compilava no servidor e lia os arquivos na estação, e ninguém percebia que
 * eram duas máquinas. Aqui o gateway consulta o ambiente antes de despachar
 * `proc.run`, e a tela apenas escolhe.
 */
export const ENVIRONMENTS = ["local", "docker", "wsl", "vps", "cloud"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Um ambiente como a tela precisa vê-lo, com a disponibilidade JÁ medida pelo
 * gateway.
 *
 * `available` e `detail` andam juntos: uma opção que não funciona não some da
 * lista — ela aparece cinza com o motivo. Esconder faz a pessoa procurar pela
 * função que leu que existe; mostrar sem motivo faz ela clicar e receber erro
 * sem saber o que fazer.
 */
export interface EnvironmentInfo {
  id: Environment;
  label: string;
  hint: string;
  available: boolean;
  detail?: string;
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
  /** O bot dono desta conversa. Vazio = conversa comum. */
  botId?: string;
  /** A conversa que a originou (delegação). Vazio = conversa raiz. */
  parentId?: string;
  /** O último pedido feito ao bot — o subtítulo da linha na barra. */
  lastGoal?: string;
}

export interface Ready {
  session: string;
  seq: number;
  specialists: string[];
  models: ModelInfo[];
  activeSpecialist?: string;
  activeModel?: string;
  /** Ambiente em vigor para o PRÓXIMO comando desta sessão. */
  environment?: Environment;
  /** O catálogo medido nesta máquina; o cliente tem um de reserva para abrir. */
  environments?: EnvironmentInfo[];
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
/** Um especialista de apoio, e QUANDO ele entra. */
export interface Standby {
  specialist: string;
  /**
   * "parallel" trabalha junto do dono; "after" trabalha sobre o que ele
   * produziu. É o formato do plano, não enfeite: paralelizar quem depende
   * produz um parecer sobre trabalho que ainda não existe, e serializar quem é
   * independente dobra o tempo por nada.
   */
  when: "parallel" | "after";
  /** A frase que a tela mostra, escrita para a pessoa ler. */
  why: string;
}

export type RouteReason = "explicit" | "heuristic" | "needle" | "model" | "sticky" | "fallback";

export interface Route {
  specialist: string;
  previous?: string;
  reason: RouteReason;
  /**
   * O ELENCO DE APOIO do primeiro input: quem fica **em espera** junto com o
   * dono, e em que forma.
   *
   * Escolher o dono nunca foi o trabalho todo. "Crie uma aplicação completa" é
   * do Código, mas se ela tem interface o Design tem o que fazer, e depois de
   * existir código alguém revisa a segurança. Sem isto a pessoa precisaria
   * lembrar de pedir cada um — devolvendo a ela o roteamento que o master
   * existe para fazer.
   *
   * Só vem no PRIMEIRO input: conversa que já tem dono já tem elenco, e
   * remontá-lo a cada mensagem trocaria a barra lateral debaixo de quem está
   * trabalhando.
   */
  standby?: Standby[];
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
  /**
   * A saída passou do teto inline: `output` é uma PROJEÇÃO (início + fim) e o
   * integral vive no Artifact Store do gateway, recuperável em fatias pela
   * ferramenta context.fetch.
   */
  truncated?: boolean;
  artifactRef?: string;
  rawBytes?: number;
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
  /**
   * Hoje é o processo lógico da onda (w-1-t1); no cluster passa a ser o PC
   * registrado ("pc-02") e o processo lógico vive no taskRunId. Os dois campos
   * existem desde já para o contrato não mudar no dia da troca.
   */
  workerId: string;
  /** Esta execução da tarefa (tentativa incluída). */
  taskRunId?: string;
  /** O plano de workspace congelado e a época do lease (internal/workspace). */
  workspacePlanId?: string;
  leaseEpoch?: number;
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
  /**
   * O corpo da decisão — o plano proposto, por exemplo. Separado da pergunta
   * porque a pergunta é a frase que se lê antes de decidir; o detail é o que
   * se CONFERE antes de apertar. O gateway sempre o mandou; o campo faltava
   * aqui, e o cartão pedia "Aprovar?" escondendo exatamente o que seria
   * aprovado.
   */
  detail?: string;
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

/**
 * Um especialista chamou OUTRO no meio do próprio turno.
 *
 * Não confundir com `task.dispatch`: aquilo é o supervisor abrindo um plano com
 * trabalhadores; isto é o bot que está atendendo decidindo, sozinho, que a
 * próxima parte não é com ele. A delegação NÃO pede permissão — quem decide de
 * quem é o assunto é o bot. O que o delegado FAZ (as ferramentas dele) continua
 * passando pelo portão de aprovação de sempre.
 *
 * Não tem id: o par `from`+`to`+`goal` é o que identifica a delegação, e é por
 * ele que o `done` reencontra a entrada aberta.
 */
export interface Delegate {
  from: string;
  to: string;
  goal: string;
  reason?: string;
  /** Quantos níveis abaixo do turno original — o limite que evita o laço. */
  depth: number;
  done?: boolean;
  result?: string;
  /**
   * A conversa DO BOT delegado, pendurada na conversa que o chamou. É por ela
   * que a barra lateral desenha a linha aninhada e que se fala direto com ele.
   *
   * Vem pronta do gateway em vez de ser remontada aqui: a regra que forma o id
   * é do store, e uma segunda cópia dela em TypeScript discordaria em silêncio
   * no dia em que a primeira mudasse.
   */
  session?: string;
}

/**
 * Aviso EFÊMERO de execução — o supervisor contando, ANTES de fazer, onde um
 * passo vai rodar. Espelha `protocol.Notice` do gateway.
 *
 * Nasceu para o Docker: "este passo vai rodar num container" (ou "sem sbx
 * nesta máquina — vai para o ai-jail da VPS") aparece como popup animado por
 * alguns segundos e some sozinho. Não pede decisão nenhuma — não confundir com
 * `ApprovalRequest` — e não sobrevive ao replay: o gateway o publica fora do
 * log durável, porque reencenar o aviso de ontem ao abrir a conversa seria
 * defeito.
 */
export interface Notice {
  /** O desenho ao lado do bot ("docker" → contêiner). */
  icon: string;
  title: string;
  /** O porquê, em uma frase. */
  detail?: string;
  /** O especialista ativo — é o avatar dele que desliza no popup. */
  specialist?: string;
}

/**
 * A trilha de uma atualização — o "o que muda" de `docs/atualizacao.md`.
 *
 * Espelha `update.Track` do gateway. A divisão existe porque o CUSTO para a
 * pessoa é diferente em cada uma, e é esse custo que a tela precisa dizer:
 *
 * - `data`    catálogo de especialistas, de modelos e política — aplica a
 *             quente, então nunca chega a virar aviso;
 * - `ui`      o bundle web — trocado na próxima abertura: pede reabrir;
 * - `gateway` o `aibotd` — é sidecar, reinicia sozinho: não pede nada;
 * - `shell`   a casca Tauri/Rust — só troca por instalador: pede instalar.
 */
export type UpdateTrack = "data" | "ui" | "gateway" | "shell";

export interface State {
  specialist?: string;
  model?: string;
  surface?: string;
  busy: boolean;
  promptTokens?: number;
  outputTokens?: number;
  /** Trocou o ambiente (por esta janela ou por outra). */
  environment?: Environment;
  /**
   * Há publicação nova PENDENTE — já baixada e verificada, esperando um
   * reinício, uma reabertura ou o instalador.
   *
   * "Pendente" e não "existe versão nova": o que aplica sozinho (a trilha de
   * dados) não aparece aqui. Avisar sobre o que já está valendo faria o aviso
   * da atualização que realmente pede algo virar ruído.
   */
  updateAvailable?: boolean;
  updateVersion?: string;
  updateTracks?: UpdateTrack[];
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
  /** O bot DONO desta conversa. Vazio = conversa comum, sem dono fixo. */
  botId?: string;
  /** A conversa que deu origem a esta (delegação). Vazio = conversa raiz. */
  parentId?: string;
  /** O último pedido feito ao bot desta conversa (só conversa de bot o tem). */
  lastGoal?: string;
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
  /**
   * Quem FALOU esta linha (`envelope.from.id`), que não é o mesmo que o
   * especialista: numa equipe, dois trabalhadores podem ser do mesmo
   * especialista e ainda assim precisam de bolhas separadas. É por este campo
   * que o texto de cada um acha a própria linha.
   */
  speakerId?: string;
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
