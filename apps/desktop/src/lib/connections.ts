/**
 * Conexões ativas — o que alimenta o pill da barra superior.
 *
 * Antes o pill dizia só "Desconectado" e abria as Configurações inteiras. Ele
 * agora responde a pergunta certa: a QUÊ este app está conectado agora —
 * gateway, runtime local, VPS de deploy, repositório, WSL, servidores MCP — e
 * clicar abre o painel para adicionar o que falta.
 *
 * Puro: recebe o estado já lido; quem chama faz o IO.
 */

export type ConnectionKind = "gateway" | "runtime" | "vps" | "git" | "wsl" | "mcp";

export type ConnectionState = "online" | "offline" | "configured" | "error";

export interface Connection {
  kind: ConnectionKind;
  /** Rótulo curto: "VPS produção", "github.com/acme/api". */
  label: string;
  state: ConnectionState;
  /** Linha secundária no painel — host, versão, motivo do erro. */
  detail?: string;
}

export interface ConnectionsInput {
  gateway: { configured: boolean; connected: boolean; baseUrl?: string };
  runtime: { running: boolean; model?: string };
  /** Servidores de deploy cadastrados. */
  servers: Array<{ name: string; host: string; enabled: boolean; lastTestOutcome?: "ok" | "failed" }>;
  /** Repositório do projeto aberto, quando houver. */
  repo?: { remote?: string; branch?: string };
  /** Distro WSL detectada, quando houver. */
  wsl?: { distro: string; running: boolean };
  mcpServers: Array<{ name: string; enabled: boolean; connected?: boolean }>;
}

/** Uma conexão "vale" para o resumo quando está de fato ligada. */
const LIVE: ConnectionState[] = ["online"];

export function collectConnections(input: ConnectionsInput): Connection[] {
  const list: Connection[] = [];

  if (input.gateway.configured) {
    list.push({
      kind: "gateway",
      label: "Gateway",
      state: input.gateway.connected ? "online" : "offline",
      detail: input.gateway.baseUrl
    });
  }

  if (input.runtime.running) {
    list.push({ kind: "runtime", label: "Runtime local", state: "online", detail: input.runtime.model });
  }

  for (const server of input.servers) {
    if (!server.enabled) continue;
    list.push({
      kind: "vps",
      label: server.name,
      // Cadastrado não é conectado: sem teste bem-sucedido, o estado honesto
      // é "configurado", não "online".
      state: server.lastTestOutcome === "ok" ? "online" : server.lastTestOutcome === "failed" ? "error" : "configured",
      detail: server.host
    });
  }

  if (input.repo?.remote) {
    list.push({
      kind: "git",
      label: shortRemote(input.repo.remote),
      state: "online",
      detail: input.repo.branch ? `branch ${input.repo.branch}` : undefined
    });
  }

  if (input.wsl) {
    list.push({
      kind: "wsl",
      label: `WSL · ${input.wsl.distro}`,
      state: input.wsl.running ? "online" : "configured"
    });
  }

  for (const server of input.mcpServers) {
    if (!server.enabled) continue;
    list.push({
      kind: "mcp",
      label: server.name,
      state: server.connected ? "online" : "configured"
    });
  }

  return list;
}

/** "https://github.com/acme/api.git" → "acme/api". */
export function shortRemote(remote: string): string {
  const cleaned = remote.trim().replace(/\.git$/i, "");
  const match = cleaned.match(/[/:]([^/:]+\/[^/:]+)$/);
  return match ? match[1] : cleaned;
}

/**
 * Texto do pill. Uma conexão → mostra qual. Várias → conta. Nenhuma →
 * "Desconectado", que continua sendo a verdade quando é a verdade.
 */
export function summarize(connections: Connection[]): { label: string; online: boolean } {
  const live = connections.filter((item) => LIVE.includes(item.state));
  if (!live.length) return { label: "Desconectado", online: false };
  if (live.length === 1) return { label: live[0].label, online: true };
  return { label: `${live.length} conexões`, online: true };
}

export const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  gateway: "Gateway",
  runtime: "Runtime local",
  vps: "Servidor de deploy",
  git: "Repositório",
  wsl: "WSL",
  mcp: "Servidor MCP"
};

export const STATE_LABELS: Record<ConnectionState, string> = {
  online: "conectado",
  offline: "fora do ar",
  configured: "cadastrado",
  error: "falhou"
};
