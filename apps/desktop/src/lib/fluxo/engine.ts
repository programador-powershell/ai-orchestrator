/**
 * Motor do fluxo — usado pelo botão "Testar".
 *
 * Ele **simula**: percorre o grafo, avalia as condições com um contexto de
 * exemplo e devolve a lista de efeitos que SAIRIAM do app. Nada é enviado.
 * Um teste que já dispara WhatsApp para o cliente não é teste, e o gate de
 * ação externa do Work continua sendo o único lugar que fala com o mundo.
 *
 * Módulo puro: sem rede, sem DOM, sem relógio. Coberto por engine.test.ts.
 */

import { labelFor } from "./catalog";
import type {
  ConditionOperator,
  ExecutionContext,
  ExecutionLog,
  FlowDefinition,
  FlowEffect,
  FlowNode,
  FlowNodeData,
  RunResult
} from "./types";

/** Contexto de exemplo do teste — o que um gatilho real entregaria. */
export const CONTEXTO_EXEMPLO: ExecutionContext = {
  name: "Ana Prado",
  email: "ana@exemplo.com.br",
  phone: "+55 11 99999-0000",
  budget: 1200,
  temperature: "morno",
  source: "landing",
  tags: ["landing"],
  title: "Proposta comercial",
  lane: "A fazer",
  message: "Quero saber o preço",
  variables: {}
};

function leCampo(campo: string, context: ExecutionContext): unknown {
  return campo.split(".").reduce<unknown>((valor, parte) => {
    if (valor && typeof valor === "object") return (valor as Record<string, unknown>)[parte];
    return undefined;
  }, context);
}

const vazio = (valor: unknown): boolean =>
  valor === undefined || valor === null || valor === "" || (Array.isArray(valor) && valor.length === 0);

export function evaluateCondition(
  field: string | undefined,
  operator: ConditionOperator | undefined,
  value: string | number | boolean | undefined,
  context: ExecutionContext
): boolean {
  if (!field || !operator) return false;
  const atual = leCampo(field, context);
  switch (operator) {
    case "equals":
      return String(atual) === String(value);
    case "not_equals":
      return String(atual) !== String(value);
    case "greater_than":
      return Number(atual) > Number(value);
    case "less_than":
      return Number(atual) < Number(value);
    case "contains":
      return String(atual ?? "").toLowerCase().includes(String(value ?? "").toLowerCase());
    case "starts_with":
      return String(atual ?? "").toLowerCase().startsWith(String(value ?? "").toLowerCase());
    case "is_empty":
      return vazio(atual);
    case "is_not_empty":
      return !vazio(atual);
    default:
      return false;
  }
}

/** `{{campo}}` vira o valor do contexto. Campo ausente vira string vazia. */
export function interpolate(template: string, context: ExecutionContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, caminho: string) => {
    const valor = leCampo(caminho, context);
    return valor === undefined || valor === null ? "" : String(valor);
  });
}

function executaAcao(
  data: FlowNodeData,
  context: ExecutionContext
): { message: string; effect?: FlowEffect; patch?: Record<string, unknown> } {
  const tipo = data.actionType;
  if (!tipo) return { message: "ação sem tipo definido" };
  const rotulo = labelFor("action", tipo);
  switch (tipo) {
    case "send_whatsapp": {
      const texto = interpolate(data.message ?? "Olá {{name}}", context);
      return {
        message: `${rotulo} para ${context.phone ?? "contato"}: “${texto}”`,
        effect: { kind: tipo, message: texto, payload: { phone: context.phone, text: texto } }
      };
    }
    case "create_task": {
      const titulo = interpolate(data.taskTitle ?? data.label ?? "Nova tarefa", context);
      return {
        message: `${rotulo}: “${titulo}”`,
        effect: { kind: tipo, message: titulo, payload: { title: titulo } }
      };
    }
    case "add_tag": {
      const tag = data.tagName ?? "etiqueta";
      const tags = [...((context.tags as string[] | undefined) ?? [])];
      if (!tags.includes(tag)) tags.push(tag);
      return { message: `${rotulo}: ${tag}`, effect: { kind: tipo, message: tag }, patch: { tags } };
    }
    case "mark_hot":
      return { message: rotulo, effect: { kind: tipo, message: "quente" }, patch: { temperature: "quente" } };
    case "mark_cold":
      return { message: rotulo, effect: { kind: tipo, message: "frio" }, patch: { temperature: "frio" } };
    case "notify_manager": {
      const texto = interpolate(data.message ?? "Fluxo disparou", context);
      return { message: `${rotulo}: “${texto}”`, effect: { kind: tipo, message: texto } };
    }
    case "update_lead":
      return { message: rotulo, effect: { kind: tipo, message: data.label } };
    case "http_request": {
      const url = interpolate(data.url ?? "", context);
      const metodo = (data.method ?? "POST").toUpperCase();
      return {
        message: `${rotulo}: ${metodo} ${url || "(sem URL)"}`,
        effect: { kind: tipo, message: url, payload: { method: metodo, url } }
      };
    }
    case "run_agent": {
      const objetivo = interpolate(data.message ?? data.label, context);
      return { message: `${rotulo}: “${objetivo}”`, effect: { kind: tipo, message: objetivo } };
    }
    case "webhook":
      return { message: rotulo, effect: { kind: tipo, message: interpolate(data.message ?? data.label, context) } };
    default:
      return { message: `ação desconhecida: ${tipo}` };
  }
}

/**
 * Percorre o fluxo a partir do gatilho.
 *
 * Nó já visitado é PULADO com aviso, em vez de estourar a pilha: o canvas
 * deixa ligar A→B→A, e um ciclo desenhado por engano tem de virar aviso na
 * trilha, não travamento da aba.
 */
export function runFlow(definition: FlowDefinition, contexto: ExecutionContext = CONTEXTO_EXEMPLO): RunResult {
  const context: ExecutionContext = { ...contexto, variables: { ...contexto.variables } };
  const logs: ExecutionLog[] = [];
  const effects: FlowEffect[] = [];
  const path: string[] = [];
  const visitados = new Set<string>();

  const inicio = definition.nodes.find((node) => node.type === "trigger");
  if (!inicio) {
    return {
      status: "failed",
      context,
      logs,
      effects,
      path,
      error: "O fluxo precisa de um gatilho para começar."
    };
  }

  const porId = new Map(definition.nodes.map((node) => [node.id, node]));
  const saidas = (id: string) => definition.edges.filter((edge) => edge.source === id);
  let esperou: string | null = null;

  const andar = (id: string): void => {
    if (esperou) return;
    if (visitados.has(id)) {
      logs.push({ nodeId: id, nodeType: "system", status: "skipped", message: "já visitado (ciclo no desenho)" });
      return;
    }
    visitados.add(id);
    const node = porId.get(id);
    if (!node) return;
    path.push(id);

    if (node.type === "wait") {
      const quanto = node.data.waitAmount ?? 1;
      const unidade = node.data.waitUnit ?? "hours";
      logs.push({
        nodeId: id,
        nodeType: node.type,
        status: "waiting",
        message: `pausa de ${quanto} ${unidade} — no teste o fluxo para aqui`
      });
      esperou = id;
      return;
    }

    if (node.type === "condition") {
      const verdade = evaluateCondition(node.data.field, node.data.operator, node.data.value, context);
      logs.push({
        nodeId: id,
        nodeType: node.type,
        status: "ok",
        message: `${node.data.field ?? "?"} ${node.data.operator ?? "?"} ${node.data.value ?? ""} → ${verdade ? "sim" : "não"}`
      });
      for (const edge of saidas(id)) {
        // Sem ramo declarado a aresta vale para os dois lados: é o desenho
        // "condição só para registrar", que não deve travar o teste.
        const ramo = edge.sourceHandle;
        if (!ramo || (ramo === "true") === verdade) andar(edge.target);
      }
      return;
    }

    if (node.type === "trigger") {
      logs.push({
        nodeId: id,
        nodeType: node.type,
        status: "ok",
        message: `gatilho: ${labelFor("trigger", node.data.triggerType) || node.data.label}`
      });
    } else if (node.type === "action") {
      const resultado = executaAcao(node.data, context);
      if (resultado.effect) effects.push(resultado.effect);
      if (resultado.patch) Object.assign(context, resultado.patch);
      logs.push({ nodeId: id, nodeType: node.type, status: "ok", message: resultado.message });
    } else if (node.type === "end") {
      logs.push({ nodeId: id, nodeType: node.type, status: "ok", message: "fim do fluxo" });
      return;
    }

    for (const edge of saidas(id)) andar(edge.target);
  };

  andar(inicio.id);
  return { status: esperou ? "waiting" : "ok", context, logs, effects, path };
}

/** Problemas do desenho que a UI mostra ANTES de rodar. */
export function lintFlow(definition: FlowDefinition): string[] {
  const avisos: string[] = [];
  const gatilhos = definition.nodes.filter((node) => node.type === "trigger");
  if (!gatilhos.length) avisos.push("Sem gatilho: o fluxo não tem por onde começar.");
  if (gatilhos.length > 1) avisos.push(`${gatilhos.length} gatilhos — cada um inicia um caminho separado.`);

  const temEntrada = new Set(definition.edges.map((edge) => edge.target));
  const soltos = definition.nodes.filter((node) => node.type !== "trigger" && !temEntrada.has(node.id));
  for (const node of soltos) avisos.push(`“${node.data.label}” não está ligado a nada — nunca vai rodar.`);

  for (const node of definition.nodes) {
    if (node.type === "condition" && (!node.data.field || !node.data.operator)) {
      avisos.push(`“${node.data.label}” está sem campo ou operador.`);
    }
    if (node.type === "action" && !node.data.actionType) {
      avisos.push(`“${node.data.label}” está sem o tipo de ação.`);
    }
    if (node.type === "action" && node.data.actionType === "http_request" && !node.data.url?.startsWith("https://")) {
      // Mesma regra do webhook do Work: sem TLS o corpo vai em claro.
      avisos.push(`“${node.data.label}”: a URL precisa ser https://.`);
    }
  }
  return avisos;
}

/** Nó por id — atalho usado pelo painel de detalhes. */
export const findNode = (definition: FlowDefinition, id: string | null): FlowNode | undefined =>
  id ? definition.nodes.find((node) => node.id === id) : undefined;
