/**
 * Modelo do fluxo — o que o canvas desenha e o motor executa.
 *
 * O formato é o do React Flow (`nodes` com `position`, `edges` com
 * `source`/`target`) de propósito: guardar um formato próprio e converter nas
 * duas pontas só criaria um lugar a mais para os dois divergirem.
 *
 * O que NÃO está aqui: nada de execução em si. Este arquivo é só forma.
 */

export type NodeType = "trigger" | "condition" | "action" | "wait" | "end";

export type TriggerType =
  | "new_lead"
  | "lead_updated"
  | "whatsapp_reply"
  | "card_created"
  | "card_moved"
  | "card_overdue"
  | "new_conversation"
  | "manual"
  | "schedule";

export type ActionType =
  | "send_whatsapp"
  | "create_task"
  | "add_tag"
  | "mark_hot"
  | "mark_cold"
  | "notify_manager"
  | "update_lead"
  | "http_request"
  | "run_agent"
  | "webhook";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "contains"
  | "starts_with"
  | "is_empty"
  | "is_not_empty";

export interface FlowNodeData {
  label: string;
  description?: string;
  triggerType?: TriggerType;
  field?: string;
  operator?: ConditionOperator;
  value?: string | number | boolean;
  actionType?: ActionType;
  message?: string;
  taskTitle?: string;
  tagName?: string;
  url?: string;
  method?: string;
  waitAmount?: number;
  waitUnit?: "minutes" | "hours" | "days";
  /** Marca o nó recém-criado pelo assistente — a UI destaca por alguns instantes. */
  fresh?: boolean;
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** "true" / "false" nas saídas de condição; ausente nas demais. */
  sourceHandle?: string | null;
  label?: string;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SavedFlow {
  id: string;
  name: string;
  enabled: boolean;
  definition: FlowDefinition;
  updatedAt: number;
}

export const emptyDefinition = (): FlowDefinition => ({ nodes: [], edges: [] });

/* ------------------------------- execução ------------------------------- */

export interface ExecutionContext {
  variables: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExecutionLog {
  nodeId: string;
  nodeType: string;
  status: "ok" | "skipped" | "failed" | "waiting";
  message: string;
}

/** Efeito que SAIRIA do app — no teste ele é só listado, nunca disparado. */
export interface FlowEffect {
  kind: ActionType;
  message: string;
  payload?: Record<string, unknown>;
}

export interface RunResult {
  status: "ok" | "failed" | "waiting";
  context: ExecutionContext;
  logs: ExecutionLog[];
  effects: FlowEffect[];
  /** Nós por onde a execução passou, na ordem — a UI acende o caminho. */
  path: string[];
  error?: string;
}
