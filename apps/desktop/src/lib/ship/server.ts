/**
 * Cadastro do servidor remoto de deploy (o VPS configurado pelo admin).
 *
 * Decisão central: este formulário NÃO tem campo de senha nem de chave privada.
 * Ferramentas de deploy costumam guardar sshPassword, sshKeyPath,
 * sshKeyPassphrase e tunnelToken em JSON texto puro no userData — é
 * exatamente o anti-padrão que não repetimos. Aqui só trafega metadado; segredo mora no agente SSH (padrão)
 * ou no keyring do SO, e o JS nunca lê nenhum dos dois de volta.
 *
 * Puro: validação sem IO. Quem chama faz a rede e o keyring.
 */

export type AuthMethod = "agent" | "keyFile";
export type ServerEnvironment = "dev" | "staging" | "prod";
export type ServerNetwork = "internet" | "corporate";

export interface DeployServer {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  /** CAMINHO do arquivo de chave — nunca o conteúdo. */
  keyPath?: string;
  /** Fixada por TOFU no cadastro; é pública, não é segredo. */
  hostKeyFingerprint?: string;
  network: ServerNetwork;
  environment: ServerEnvironment;
  remoteWorkdir: string;
  dockerSocket: string;
  /** Painel de administração do servidor, só para o botão "abrir". */
  panelUrl?: string;
  /** Rastreabilidade: onde a credencial mora no cofre. Metadado, não segredo. */
  vaultItemRef?: string;
  enabled: boolean;
  createdAt: string;
  lastTestedAt?: string;
  lastTestOutcome?: "ok" | "failed";
}

export type ServerDraft = Omit<DeployServer, "id" | "createdAt" | "enabled">;

export interface FieldIssue {
  field: keyof ServerDraft | "secret";
  message: string;
}

/**
 * Material de chave privada colado num campo de texto. Mesmo detector do
 * lib/scan.ts — se aparecer aqui, o certo é recusar e mandar para o cofre.
 */
const PRIVATE_KEY_MARKER = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;

/** Hostname RFC 1123 ou IPv4. Sem esquema, sem caminho, sem porta embutida. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const match = value.match(IPV4);
  return Boolean(match) && match!.slice(1).every((part) => Number(part) <= 255);
}

export function validateHost(host: string): string | undefined {
  const value = host.trim();
  if (!value) return "Informe o host do servidor.";
  if (/^[a-z]+:\/\//i.test(value)) return "Só o host — sem http:// nem ssh://.";
  if (value.includes("/")) return "Só o host — sem caminho.";
  if (value.includes(":")) return "A porta vai no campo ao lado.";
  // Forma de IPv4 é julgada COMO IPv4: "999.1.1.1" casa com a regra de
  // hostname (rótulos numéricos são válidos) e passaria batido.
  if (IPV4.test(value)) return isIpv4(value) ? undefined : "Endereço IP inválido.";
  if (!HOSTNAME.test(value)) return "Host inválido.";
  return undefined;
}

export function validatePort(port: number): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Porta entre 1 e 65535.";
  return undefined;
}

/**
 * Recusa ativamente material de chave. O usuário deve apontar o CAMINHO do
 * arquivo, ou usar o agente SSH — nunca colar a chave.
 */
export function looksLikeSecret(value: string): boolean {
  return PRIVATE_KEY_MARKER.test(value);
}

export function validateDraft(draft: ServerDraft): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const push = (field: FieldIssue["field"], message: string | undefined) => {
    if (message) issues.push({ field, message });
  };

  if (!draft.name.trim()) push("name", "Dê um nome ao servidor.");
  push("host", validateHost(draft.host));
  push("port", validatePort(draft.port));
  if (!draft.user.trim()) push("user", "Informe o usuário SSH.");

  if (draft.authMethod === "keyFile") {
    const keyPath = draft.keyPath?.trim() ?? "";
    if (!keyPath) push("keyPath", "Informe o caminho do arquivo de chave.");
    else if (looksLikeSecret(keyPath)) {
      push("secret", "Isso é o conteúdo da chave, não um caminho. Guarde a chave no cofre e aponte só o arquivo.");
    }
  }

  if (!draft.remoteWorkdir.trim()) push("remoteWorkdir", "Informe a pasta do projeto no servidor.");
  else if (!draft.remoteWorkdir.startsWith("/")) push("remoteWorkdir", "Caminho absoluto (começa com /).");

  if (draft.panelUrl?.trim() && !/^https:\/\//i.test(draft.panelUrl.trim())) {
    push("panelUrl", "O painel de administração precisa ser https.");
  }

  return issues;
}

export function newServer(id: string, draft: ServerDraft, createdAt: string): DeployServer {
  return {
    ...draft,
    id,
    name: draft.name.trim(),
    host: draft.host.trim(),
    user: draft.user.trim(),
    remoteWorkdir: draft.remoteWorkdir.trim(),
    enabled: true,
    createdAt
  };
}

export function emptyDraft(): ServerDraft {
  return {
    name: "",
    host: "",
    port: 22,
    user: "",
    authMethod: "agent",
    network: "internet",
    environment: "prod",
    remoteWorkdir: "/opt/app",
    dockerSocket: "/var/run/docker.sock"
  };
}

/** Conta no keyring. Derivada do id — renomear o servidor não órfã o segredo. */
export function passphraseAccount(serverId: string): string {
  return `server:${serverId}:passphrase`;
}

/**
 * Comandos remotos permitidos. Enum fechado, nunca string livre vinda da UI ou
 * do modelo — o servidor de produção não recebe shell arbitrário.
 */
export const REMOTE_ACTIONS = [
  { id: "status", label: "Status", command: "docker compose ps" },
  { id: "pull", label: "Atualizar código", command: "git pull --ff-only" },
  { id: "build", label: "Build", command: "docker compose build" },
  { id: "up", label: "Subir", command: "docker compose up -d" },
  { id: "restart", label: "Reiniciar", command: "docker compose restart" },
  { id: "logs", label: "Logs", command: "docker compose logs --tail=200" }
] as const;

export type RemoteActionId = (typeof REMOTE_ACTIONS)[number]["id"];

export function remoteCommand(action: RemoteActionId): string | undefined {
  return REMOTE_ACTIONS.find((item) => item.id === action)?.command;
}

/**
 * Ambiente de produção exige confirmação explícita para ações que mudam o
 * estado do serviço. Ler status/logs nunca exige.
 */
export function needsConfirmation(server: DeployServer, action: RemoteActionId): boolean {
  if (action === "status" || action === "logs") return false;
  return server.environment === "prod";
}
