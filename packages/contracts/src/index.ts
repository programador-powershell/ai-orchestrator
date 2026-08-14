/**
 * Modos do CONTRATO DE WIRE com o gateway. Igual a UI_MODES de propósito:
 * quando divergiam, o cliente reescrevia office/tune para "chat" antes de
 * chamar o servidor — e aí o gateway não tinha como bloquear por módulo,
 * porque nunca via o módulo real.
 */
export const MODES = [
  "chat",
  "work",
  "design",
  "data",
  "agent",
  "fluxo",
  "code",
  "security",
  "office",
  "tune"
] as const;
export type Mode = (typeof MODES)[number];

/** Abas expostas na UI — produto completo + Office e Fine-Tuning. */
export const UI_MODES = [
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
export type UiMode = (typeof UI_MODES)[number];

export const CAPABILITIES = ["chat", "image", "embedding", "rerank"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "moonshot"
  | "deepseek"
  | "mistral"
  | "openai-compatible"
  | "openai-images"
  | "imagen"
  | "black-forest-labs"
  | "local";

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface RouteConfig {
  mode: Mode;
  capability: Capability;
  primary: ModelTarget;
  fallbacks: ModelTarget[];
  temperature?: number;
  maxTokens?: number;
  allowedCapabilities: Capability[];
  timeoutMs?: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export type LanguageRuntimeId = "node" | "python" | "go" | "rust" | "deno" | "bun" | "java" | "dotnet" | "php" | "git";

export interface ReleaseComponent {
  id: "desktop" | "runtime-cpu" | "runtime-vulkan" | "runtime-kimi-k3-c" | `language-${LanguageRuntimeId}`;
  optional: boolean;
  url: string;
  size: number;
  sha256: string;
  signature?: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: "Multiplike-AI";
  channel: "stable" | "beta";
  version: string;
  minimumBootstrapperVersion: string;
  publishedAt: string;
  publisher: string;
  components: ReleaseComponent[];
  signature: string;
}

export interface RuntimeStatus {
  installed: boolean;
  running: boolean;
  variant?: "cpu" | "vulkan";
  version?: string;
  port?: number;
  /** Token do servidor local (127.0.0.1) para conectar agentes externos. */
  apiKey?: string;
  models: Array<{ id: string; fileName: string; size: number }>;
}

export interface RuntimeCatalogItem {
  id: "llama-cpu" | "llama-vulkan" | "kimi-k3-c";
  name: string;
  installed: boolean;
  optional: true;
  platform: "windows-x64" | "linux-x64-wsl2";
  downloadMode: "managed" | "user-initiated";
  requirements: string[];
  sourceUrl: string;
}

export interface LanguageRuntime {
  id: LanguageRuntimeId;
  label: string;
  commands: string[];
  installed: boolean;
  source: string;
  managed: boolean;
}

export interface TerminalResult {
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  runtimeRequired?: LanguageRuntimeId;
}

export type ExtensionFormat = "openai-plugin" | "anthropic-plugin" | "agent-skill" | "artifact-bundle";

export interface ExtensionBundle {
  name: string;
  format: ExtensionFormat;
  version?: string;
  sourcePath: string;
  skills: string[];
  agents: string[];
  artifacts: string[];
  hasMcp: boolean;
  compatible: boolean;
  warnings: string[];
}

export type DesignCaptureMode = "static" | "ultra";

export interface DesignReplicationRequest {
  sourceUrl: string;
  mode: DesignCaptureMode;
  maxPages?: number;
}

export interface DesignReplicationResult {
  id: string;
  status: "ready";
  sourceUrl: string;
  title: string;
  mode: DesignCaptureMode;
  pages: Array<{ path: string; title: string }>;
  tokens: {
    colors: string[];
    cssVariables: Array<{ name: string; value: string }>;
    fonts: string[];
  };
  analysis: {
    stylesheets: number;
    inlineStyleBlocks: number;
    componentFingerprints: number;
    layoutSignals: string[];
    animations: string[];
  };
  artifacts: string[];
}

export const ORCHESTRATION_NODE_KINDS = ["input", "agent", "tool", "gate", "merge", "human"] as const;
export type OrchestrationNodeKind = (typeof ORCHESTRATION_NODE_KINDS)[number];

export interface OrchestrationNode {
  id: string;
  name: string;
  kind: OrchestrationNodeKind;
  mode?: Mode;
  dependsOn: string[];
  config?: {
    model?: string;
    tools?: string[];
    timeoutMs?: number;
    retries?: number;
    concurrencyKey?: string;
  };
}

export interface OrchestrationGraph {
  schemaVersion: 1;
  name: string;
  maxConcurrency: number;
  nodes: OrchestrationNode[];
}

export interface OrchestrationPlan {
  valid: true;
  graphName: string;
  waves: string[][];
  criticalPath: string[];
  maxParallelism: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* V2 — motor de execução, fusion, memória, planejamento e superfícies */
/* ------------------------------------------------------------------ */

export type FusionStrategy = "orchestrate" | "merge" | "race";

/** Modelos específicos para um tipo de atividade (aba) dentro de um preset. */
export interface FusionModeOverride {
  orchestrator?: ModelTarget;
  executors?: ModelTarget[];
  strategy?: FusionStrategy;
}

export interface FusionPreset {
  id: string;
  name: string;
  strategy: FusionStrategy;
  /** Modelo que planeja/critica/funde. */
  orchestrator: ModelTarget;
  /** Modelos que produzem o conteúdo. Em "merge"/"race" pode haver vários. */
  executors: ModelTarget[];
  /**
   * Modelos por TIPO DE ATIVIDADE (chat, code, data…): sobrepõem o preset base
   * só na aba correspondente. Ausente = usa o preset base.
   */
  perMode?: Partial<Record<UiMode, FusionModeOverride>>;
  notes?: string;
}

export type EngineSelection =
  | { kind: "workspace" }
  | { kind: "local" }
  | { kind: "model"; target: ModelTarget }
  | { kind: "fusion"; presetId: string };

export type MemoryKind = "fact" | "preference" | "project" | "decision" | "reference";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  uses: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** Origem da memória (conversa, import claude/openai, manual). */
  source: string;
}

export interface MemorySearchHit {
  item: MemoryItem;
  score: number;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "skipped";
}

export interface ExecutionPlan {
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string[];
}

export type SqlDialect = "postgres" | "mysql" | "ansi";

export interface SchemaField {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  nullable?: boolean;
  defaultValue?: string;
  references?: { table: string; field: string };
}

export interface SchemaTable {
  id: string;
  name: string;
  x: number;
  y: number;
  tone: string;
  fields: SchemaField[];
}

export interface SchemaRelation {
  id: string;
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  cardinality: "1-1" | "1-n" | "n-n";
}

export interface SchemaDoc {
  name: string;
  dialect: SqlDialect;
  tables: SchemaTable[];
  relations: SchemaRelation[];
}

export interface ResearchSource {
  url: string;
  title: string;
  kind: "site" | "video" | "doc";
  credibility: number;
  summary: string;
}

export interface ResearchReport {
  question: string;
  sources: ResearchSource[];
  synthesis: string;
  confidence: number;
  openQuestions: string[];
}

export interface SandboxResult {
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  isolated: boolean;
  /** Rodou dentro de um Job Object — a árvore inteira morre junto (Windows). */
  jailed: boolean;
}

export interface SecurityFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  file: string;
  line?: number;
  detail: string;
  suggestion?: string;
  /** Patch proposto em diff unificado, quando houver correção sugerida. */
  patch?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

/* ------------------- Bootstrap do cliente gerenciado -------------------- */
/* Ver docs/adr-edicao-gerenciada.md: a política nasce no servidor, viaja    */
/* assinada e a UI apenas reflete.                                           */

export interface BootstrapProfile {
  userId: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  groups: string[];
  workspaceId: string;
  workspaceName: string;
  role: "owner" | "admin" | "member";
}

export interface BootstrapPromptMaster {
  content: string;
  allowLocalAppend: boolean;
  localMaxChars: number;
  version: number;
}

export interface BootstrapPolicy {
  allowedModes: UiMode[];
  agentTools: boolean;
  approvalPolicy: "ask" | "edits" | "all";
  byokAllowed: boolean;
  localRuntimeAllowed: boolean;
  effortMax: number;
  /**
   * Modelo de agente definido pelo ADMIN. Um agente que aciona agentes é
   * recursão dirigida por modelo: estes tetos decidem quanto uma execução
   * pode custar, e por isso vivem no servidor. O cliente pode apertá-los,
   * nunca afrouxá-los.
   */
  agentMaxDepth: number;
  agentMaxChildren: number;
  agentMaxTotal: number;
  /**
   * Modelo por PAPEL da equipe (`idea`, `scope`, `plan`, `code`, `review`).
   *
   * A escalação da aba Agent é pré-determinada pela complexidade, e cada papel
   * tem custo diferente. Quem define é o admin: escolher o modelo é escolher
   * quanto gastar, e essa não é decisão do usuário. Papel ausente cai no
   * modelo do módulo.
   */
  agentRoleModels: Record<string, string>;
  /**
   * Plugins GLOBAIS do grupo (manifesto declarativo — ver `lib/plugins.ts`).
   * Valem para todo mundo do grupo e o usuário não os remove.
   */
  agentPlugins: unknown[];
  /**
   * Deixa a pessoa criar plugin próprio, válido só no agente dela.
   * Fechado por padrão: é ampliação do que a IA alcança.
   */
  userPluginsAllowed: boolean;
  /**
   * Code mode: o modelo entrega um programa que combina várias ferramentas,
   * interpretado por um subconjunto fechado no cliente — não é `eval`. Cada
   * chamada dentro do programa mantém a aprovação. Fechado por padrão.
   */
  codeModeAllowed: boolean;
  /** Área isolada com execução de código na estação — ver ADR do computer use. */
  computerUseAllowed: boolean;
  /**
   * Domínios que o app não pode alcançar (pesquisa, webhook, MCP).
   * `exemplo.com` pega os subdomínios; `*.exemplo.com` pega só eles.
   * A checagem que VALE é a do Rust, sobre a política assinada.
   */
  blockedDomains: string[];
  promptMaster: BootstrapPromptMaster | null;
  offlineGraceHours: number;
}

export interface BootstrapResponse {
  schemaVersion: 1;
  issuedAt: string;
  expiresAt: string;
  etag: string;
  /** Ed25519 sobre o corpo — obrigatória na edição managed (S3). */
  signature: string | null;
  profile: BootstrapProfile;
  policy: BootstrapPolicy;
}
