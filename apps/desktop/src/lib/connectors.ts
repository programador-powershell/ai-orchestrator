/**
 * Catálogo de conectores de app (galeria MCP) e ambientes de execução.
 *
 * O usuário conecta os apps DELE; a lista aprovada é governada pelo admin
 * (política) — regra corporativa: só conectores aprovados, autenticação pela
 * conta corporativa Microsoft. Aqui é tudo puro: catálogo + status + filtro,
 * testável sem tocar em rede.
 */

export type ConnectorCategory =
  | "produtividade"
  | "comunicacao"
  | "design"
  | "automacao"
  | "arquivos"
  | "crm"
  | "dev";

/** Como o conector autentica. Muda o que a janela oferece ao clicar. */
export type ConnectorAuth =
  | "microsoft" // conta corporativa Microsoft (SSO) — o caminho aprovado
  | "oauth" // OAuth do provedor
  | "endpoint"; // servidor MCP self-hosted (URL) — ex.: n8n

export interface Connector {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  auth: ConnectorAuth;
  /** Marcado como novidade na galeria. */
  isNew?: boolean;
}

export type ConnectorState = "connected" | "available" | "blocked";

export const CATEGORY_LABELS: Record<ConnectorCategory | "todos", string> = {
  todos: "Todos",
  produtividade: "Produtividade",
  comunicacao: "Comunicação",
  design: "Design",
  automacao: "Automação",
  arquivos: "Arquivos",
  crm: "CRM",
  dev: "Dev"
};

export const CATEGORY_ORDER: Array<ConnectorCategory | "todos"> = [
  "todos",
  "produtividade",
  "comunicacao",
  "design",
  "automacao",
  "arquivos",
  "crm",
  "dev"
];

/** Catálogo base. O admin pode restringir por política (allow-list). */
export const CONNECTOR_CATALOG: Connector[] = [
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    category: "produtividade",
    description: "Acesse e gerencie e-mails, calendário, contatos e documentos do Microsoft 365.",
    auth: "microsoft"
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "comunicacao",
    description: "Leia, envie e organize e-mails com segurança via MCP.",
    auth: "oauth"
  },
  {
    id: "n8n",
    name: "n8n",
    category: "automacao",
    description: "Execute e orquestre workflows e automações do n8n.",
    auth: "endpoint",
    isNew: true
  },
  {
    id: "figma",
    name: "Figma",
    category: "design",
    description: "Recupere arquivos, componentes e bibliotecas dos seus projetos.",
    auth: "oauth"
  },
  {
    id: "canva",
    name: "Canva",
    category: "design",
    description: "Busque designs, pastas e ativos diretamente do Canva.",
    auth: "oauth"
  },
  {
    id: "slack",
    name: "Slack",
    category: "comunicacao",
    description: "Leia mensagens, canais e arquivos e envie notificações.",
    auth: "oauth"
  },
  {
    id: "notion",
    name: "Notion",
    category: "produtividade",
    description: "Acesse páginas, bancos de dados e conteúdo do Notion.",
    auth: "oauth"
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "arquivos",
    description: "Pesquise e gerencie arquivos e pastas no Google Drive.",
    auth: "oauth"
  },
  {
    id: "github",
    name: "GitHub",
    category: "dev",
    description: "Leia repositórios, issues, PRs e execute ações no GitHub.",
    auth: "oauth"
  },
  {
    id: "trello",
    name: "Trello",
    category: "produtividade",
    description: "Crie, leia e atualize cartões, listas e quadros no Trello.",
    auth: "oauth"
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    description: "Acesse contatos, empresas, deals e registros do HubSpot.",
    auth: "oauth"
  },
  {
    id: "discord",
    name: "Discord",
    category: "comunicacao",
    description: "Leia mensagens, canais e membros e envie notificações.",
    auth: "oauth"
  }
];

/** Cor de acento por conector — monograma na galeria (sem baixar logo). */
export const CONNECTOR_ACCENT: Record<string, string> = {
  "microsoft-365": "#ea4d1a",
  gmail: "#ea4335",
  n8n: "#ea4b71",
  figma: "#a259ff",
  canva: "#00c4cc",
  slack: "#4a154b",
  notion: "#111111",
  "google-drive": "#1fa463",
  github: "#6e7681",
  trello: "#0079bf",
  hubspot: "#ff7a59",
  discord: "#5865f2"
};

const norm = (value: string) => value.trim().toLowerCase();

/**
 * Estado de um conector para o usuário.
 * - `blocked`: fora da allow-list do admin (não aparece como conectável);
 * - `connected`: há um servidor MCP casando pelo id OU pelo nome;
 * - `available`: aprovado e não conectado.
 */
export function connectorState(
  connector: Connector,
  connected: ReadonlyArray<{ name: string }>,
  allowed?: ReadonlyArray<string> | null
): ConnectorState {
  if (allowed && !allowed.includes(connector.id)) return "blocked";
  const hit = connected.some((server) => {
    const name = norm(server.name);
    return name === norm(connector.id) || name === norm(connector.name);
  });
  return hit ? "connected" : "available";
}

export interface ConnectorFilter {
  category?: ConnectorCategory | "todos";
  query?: string;
}

/** Filtra por categoria e busca (nome + descrição), preservando a ordem. */
export function filterConnectors(catalog: Connector[], filter: ConnectorFilter): Connector[] {
  const category = filter.category ?? "todos";
  const query = norm(filter.query ?? "");
  return catalog.filter((connector) => {
    if (category !== "todos" && connector.category !== category) return false;
    if (!query) return true;
    return norm(connector.name).includes(query) || norm(connector.description).includes(query);
  });
}

/* ------------------------------- ambientes ------------------------------- */

/**
 * Onde o trabalho roda. O usuário escolhe; o admin configura cada opção.
 * - local: a máquina do usuário;
 * - vps: o servidor configurado pelo admin;
 * - cloud: um host git (GitHub, GitLab, Gitea…).
 */
export type Environment = "local" | "vps" | "cloud";

export const ENVIRONMENTS: Array<{ id: Environment; label: string; detail: string }> = [
  { id: "local", label: "Local", detail: "No seu computador" },
  { id: "vps", label: "VPS", detail: "Servidor configurado pela TI" },
  { id: "cloud", label: "Nuvem", detail: "GitHub, GitLab, Gitea…" }
];

export function environmentLabel(environment: Environment): string {
  return ENVIRONMENTS.find((item) => item.id === environment)?.label ?? "Local";
}
