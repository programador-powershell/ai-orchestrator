/**
 * Catálogo de gatilhos, ações e campos.
 *
 * Uma lista só, usada por TRÊS consumidores: o painel de detalhes (para
 * montar os selects), o prompt do assistente (para o modelo saber o que
 * existe) e a validação das operações que chegam do modelo. Manter três
 * listas paralelas era garantia de o modelo propor uma ação que a tela não
 * sabe editar — ou pior, que o motor não sabe executar.
 */

import type { ActionType, ConditionOperator, NodeType, TriggerType } from "./types";

export interface CatalogEntry<T extends string> {
  id: T;
  label: string;
  hint: string;
}

export const TRIGGERS: Array<CatalogEntry<TriggerType>> = [
  { id: "new_lead", label: "Novo lead", hint: "uma oportunidade nova chega" },
  { id: "lead_updated", label: "Lead atualizado", hint: "algum campo do lead muda" },
  { id: "whatsapp_reply", label: "Resposta no WhatsApp", hint: "o contato responde" },
  { id: "card_created", label: "Cartão criado", hint: "novo cartão no quadro Work" },
  { id: "card_moved", label: "Cartão movido", hint: "o cartão troca de coluna" },
  { id: "card_overdue", label: "Cartão atrasado", hint: "o prazo do cartão venceu" },
  { id: "new_conversation", label: "Nova conversa", hint: "alguém abre uma conversa no Chat" },
  { id: "manual", label: "Manual", hint: "alguém dispara pelo botão" },
  { id: "schedule", label: "Agendado", hint: "em um horário definido" }
];

export const ACTIONS: Array<CatalogEntry<ActionType>> = [
  { id: "send_whatsapp", label: "Enviar WhatsApp", hint: "mensagem para o contato" },
  { id: "create_task", label: "Criar tarefa", hint: "cartão no quadro Work" },
  { id: "add_tag", label: "Adicionar etiqueta", hint: "marca o lead/cartão" },
  { id: "mark_hot", label: "Marcar como quente", hint: "temperatura = quente" },
  { id: "mark_cold", label: "Marcar como frio", hint: "temperatura = frio" },
  { id: "notify_manager", label: "Avisar o gestor", hint: "notificação interna" },
  { id: "update_lead", label: "Atualizar lead", hint: "grava campos no lead" },
  { id: "http_request", label: "Requisição HTTP", hint: "chama uma URL (https)" },
  { id: "run_agent", label: "Acionar agente", hint: "manda o objetivo para a aba Agent" },
  { id: "webhook", label: "Webhook", hint: "dispara um webhook cadastrado" }
];

export const OPERATORS: Array<CatalogEntry<ConditionOperator>> = [
  { id: "equals", label: "é igual a", hint: "" },
  { id: "not_equals", label: "é diferente de", hint: "" },
  { id: "greater_than", label: "é maior que", hint: "" },
  { id: "less_than", label: "é menor que", hint: "" },
  { id: "contains", label: "contém", hint: "" },
  { id: "starts_with", label: "começa com", hint: "" },
  { id: "is_empty", label: "está vazio", hint: "" },
  { id: "is_not_empty", label: "não está vazio", hint: "" }
];

/** Campos que a condição consegue ler do contexto do gatilho. */
export const FIELDS = [
  "name",
  "email",
  "phone",
  "budget",
  "temperature",
  "source",
  "tags",
  "title",
  "lane",
  "message"
] as const;

/** Operadores que dispensam valor — a UI esconde o campo. */
export const OPERADOR_SEM_VALOR = new Set<ConditionOperator>(["is_empty", "is_not_empty"]);

export const NODE_LABEL: Record<NodeType, string> = {
  trigger: "Gatilho",
  condition: "Condição",
  action: "Ação",
  wait: "Espera",
  end: "Fim"
};

const triggerIds = new Set(TRIGGERS.map((item) => item.id));
const actionIds = new Set(ACTIONS.map((item) => item.id));
const operatorIds = new Set(OPERATORS.map((item) => item.id));

export const isTriggerType = (value: unknown): value is TriggerType =>
  typeof value === "string" && triggerIds.has(value as TriggerType);
export const isActionType = (value: unknown): value is ActionType =>
  typeof value === "string" && actionIds.has(value as ActionType);
export const isOperator = (value: unknown): value is ConditionOperator =>
  typeof value === "string" && operatorIds.has(value as ConditionOperator);
export const isNodeType = (value: unknown): value is NodeType =>
  value === "trigger" || value === "condition" || value === "action" || value === "wait" || value === "end";

/** Rótulo legível de um gatilho/ação — usado no nó e na trilha do teste. */
export function labelFor(kind: "trigger" | "action", id: string | undefined): string {
  const lista: Array<CatalogEntry<string>> = kind === "trigger" ? TRIGGERS : ACTIONS;
  return lista.find((item) => item.id === id)?.label ?? id ?? "";
}

/**
 * O catálogo em texto, para o prompt do assistente.
 *
 * Gerado a partir das mesmas listas: se alguém acrescentar uma ação e
 * esquecer do prompt, o modelo continua sabendo dela.
 */
export function catalogPrompt(): string {
  const linha = <T extends string>(item: CatalogEntry<T>) =>
    `  - ${item.id}${item.hint ? ` (${item.hint})` : ""}`;
  return [
    "GATILHOS (type:\"trigger\", campo triggerType):",
    ...TRIGGERS.map(linha),
    "AÇÕES (type:\"action\", campo actionType):",
    ...ACTIONS.map(linha),
    "OPERADORES de condição (type:\"condition\", campos field/operator/value):",
    ...OPERATORS.map((item) => `  - ${item.id} (${item.label})`),
    `CAMPOS de condição: ${FIELDS.join(", ")}`,
    'ESPERA (type:"wait"): waitAmount + waitUnit (minutes|hours|days)'
  ].join("\n");
}
