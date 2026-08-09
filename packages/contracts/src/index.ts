export const MODES = ["chat", "work", "design", "data", "agent", "code", "security", "game"] as const;
export type Mode = (typeof MODES)[number];

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
  product: "AI Orchestrator";
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
