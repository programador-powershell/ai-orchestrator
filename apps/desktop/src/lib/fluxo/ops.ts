/**
 * Operações de fluxo — a linguagem entre o assistente e o canvas.
 *
 * O assistente NÃO devolve o fluxo pronto num JSON só. Ele emite **uma
 * operação por linha**, e cada linha completa é aplicada na hora. Três coisas
 * saem de graça dessa escolha:
 *
 * 1. **Montagem ao vivo.** O nó aparece no canvas no instante em que a linha
 *    fecha, em vez de tudo surgir de uma vez no fim. É o que se vê na tela.
 * 2. **Edição pelo mesmo caminho.** "tire a espera e troque a mensagem" vira
 *    `remove` + `update`; não existe um segundo mecanismo para editar.
 * 3. **Tolerância a lixo.** Uma linha malformada é descartada sozinha — num
 *    JSON único, um caractere errado no fim perderia o fluxo inteiro.
 *
 * Módulo puro: sem React, sem rede. Coberto por ops.test.ts.
 */

import { isActionType, isNodeType, isOperator, isTriggerType, labelFor } from "./catalog";
import type { FlowDefinition, FlowNode, FlowNodeData, NodeType } from "./types";

export type FlowOp =
  | { op: "add"; id: string; type: NodeType; data: FlowNodeData }
  | { op: "update"; id: string; data: Partial<FlowNodeData> }
  | { op: "remove"; id: string }
  | { op: "connect"; from: string; to: string; branch?: "true" | "false" }
  | { op: "disconnect"; from: string; to: string }
  | { op: "rename"; name: string }
  | { op: "clear" };

const texto = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Só os campos conhecidos entram — o resto do que o modelo inventar cai fora. */
function lerDados(bruto: Record<string, unknown>): FlowNodeData {
  const data: FlowNodeData = { label: texto(bruto.label) ?? "" };
  if (texto(bruto.description)) data.description = texto(bruto.description);
  if (isTriggerType(bruto.triggerType)) data.triggerType = bruto.triggerType;
  if (isActionType(bruto.actionType)) data.actionType = bruto.actionType;
  if (isOperator(bruto.operator)) data.operator = bruto.operator;
  if (texto(bruto.field)) data.field = texto(bruto.field);
  if (typeof bruto.value === "string" || typeof bruto.value === "number" || typeof bruto.value === "boolean") {
    data.value = bruto.value;
  }
  if (texto(bruto.message)) data.message = texto(bruto.message);
  if (texto(bruto.taskTitle)) data.taskTitle = texto(bruto.taskTitle);
  if (texto(bruto.tagName)) data.tagName = texto(bruto.tagName);
  if (texto(bruto.url)) data.url = texto(bruto.url);
  if (texto(bruto.method)) data.method = texto(bruto.method);
  if (typeof bruto.waitAmount === "number" && Number.isFinite(bruto.waitAmount)) {
    data.waitAmount = Math.max(1, Math.round(bruto.waitAmount));
  }
  if (bruto.waitUnit === "minutes" || bruto.waitUnit === "hours" || bruto.waitUnit === "days") {
    data.waitUnit = bruto.waitUnit;
  }
  return data;
}

/** Uma linha do stream vira operação — ou `null`, se não for uma. */
export function parseOpLine(raw: string): FlowOp | null {
  const linha = raw.trim().replace(/^[-*]\s*/, "");
  if (!linha.startsWith("{")) return null;
  let bruto: Record<string, unknown>;
  try {
    bruto = JSON.parse(linha) as Record<string, unknown>;
  } catch {
    return null;
  }
  const op = texto(bruto.op);
  switch (op) {
    case "add": {
      const id = texto(bruto.id);
      if (!id || !isNodeType(bruto.type)) return null;
      const data = lerDados(bruto);
      // Rótulo é o que a pessoa lê no nó: sem ele, o catálogo dá um.
      if (!data.label) {
        data.label =
          bruto.type === "trigger"
            ? labelFor("trigger", data.triggerType)
            : bruto.type === "action"
              ? labelFor("action", data.actionType)
              : bruto.type === "condition"
                ? "Condição"
                : bruto.type === "wait"
                  ? "Aguardar"
                  : "Fim";
      }
      return { op: "add", id, type: bruto.type, data };
    }
    case "update": {
      const id = texto(bruto.id);
      if (!id) return null;
      const data = lerDados(bruto);
      // `update` sem rótulo não deve APAGAR o rótulo que já existe.
      if (!texto(bruto.label)) delete (data as Partial<FlowNodeData>).label;
      return { op: "update", id, data };
    }
    case "remove": {
      const id = texto(bruto.id);
      return id ? { op: "remove", id } : null;
    }
    case "connect": {
      const from = texto(bruto.from);
      const to = texto(bruto.to);
      if (!from || !to) return null;
      const branch = bruto.branch === "true" || bruto.branch === "false" ? bruto.branch : undefined;
      return { op: "connect", from, to, branch };
    }
    case "disconnect": {
      const from = texto(bruto.from);
      const to = texto(bruto.to);
      return from && to ? { op: "disconnect", from, to } : null;
    }
    case "rename": {
      const name = texto(bruto.name);
      return name ? { op: "rename", name } : null;
    }
    case "clear":
      return { op: "clear" };
    default:
      return null;
  }
}

/**
 * Extrai do buffer as operações já COMPLETAS, devolvendo o resto.
 *
 * A última linha só entra quando fecha com quebra: uma linha ainda chegando é
 * JSON pela metade, e aplicá-la criaria um nó com dado truncado que sumiria
 * no token seguinte.
 */
export function takeOps(buffer: string): { ops: FlowOp[]; rest: string } {
  const partes = buffer.split("\n");
  const rest = partes.pop() ?? "";
  const ops: FlowOp[] = [];
  for (const parte of partes) {
    const op = parseOpLine(parte);
    if (op) ops.push(op);
  }
  return { ops, rest };
}

const edgeId = (from: string, to: string, branch?: string) => `e-${from}-${to}${branch ? `-${branch}` : ""}`;

/**
 * Aplica uma operação. Sempre devolve uma definição NOVA.
 *
 * Operação que não faz sentido (conectar a um nó que não existe, atualizar um
 * id desconhecido) é ignorada em silêncio: o modelo erra, e derrubar o fluxo
 * inteiro por causa de uma linha ruim seria pior que seguir sem ela.
 */
export function applyOp(definition: FlowDefinition, op: FlowOp): FlowDefinition {
  switch (op.op) {
    case "clear":
      return { nodes: [], edges: [] };
    case "rename":
      return definition;
    case "add": {
      const existente = definition.nodes.find((node) => node.id === op.id);
      if (existente) {
        // Repetir o `add` do mesmo id é atualização — o modelo faz isso quando
        // se corrige no meio da montagem.
        return {
          ...definition,
          nodes: definition.nodes.map((node) =>
            node.id === op.id ? { ...node, type: op.type, data: { ...node.data, ...op.data } } : node
          )
        };
      }
      const novo: FlowNode = {
        id: op.id,
        type: op.type,
        position: { x: 0, y: 0 },
        data: { ...op.data, fresh: true }
      };
      return { ...definition, nodes: [...definition.nodes, novo] };
    }
    case "update":
      return {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === op.id ? { ...node, data: { ...node.data, ...op.data, fresh: true } } : node
        )
      };
    case "remove":
      return {
        nodes: definition.nodes.filter((node) => node.id !== op.id),
        // Aresta pendurada num nó que sumiu vira linha para lugar nenhum.
        edges: definition.edges.filter((edge) => edge.source !== op.id && edge.target !== op.id)
      };
    case "connect": {
      const temOrigem = definition.nodes.some((node) => node.id === op.from);
      const temDestino = definition.nodes.some((node) => node.id === op.to);
      if (!temOrigem || !temDestino || op.from === op.to) return definition;
      const id = edgeId(op.from, op.to, op.branch);
      if (definition.edges.some((edge) => edge.id === id)) return definition;
      return {
        ...definition,
        edges: [
          ...definition.edges,
          {
            id,
            source: op.from,
            target: op.to,
            sourceHandle: op.branch ?? null,
            label: op.branch === "true" ? "sim" : op.branch === "false" ? "não" : undefined
          }
        ]
      };
    }
    case "disconnect":
      return {
        ...definition,
        edges: definition.edges.filter((edge) => !(edge.source === op.from && edge.target === op.to))
      };
    default:
      return definition;
  }
}

export function applyOps(definition: FlowDefinition, ops: FlowOp[]): FlowDefinition {
  return ops.reduce(applyOp, definition);
}

/** Tira o destaque de "recém-criado" — a UI chama quando a montagem termina. */
export function clearFresh(definition: FlowDefinition): FlowDefinition {
  if (!definition.nodes.some((node) => node.data.fresh)) return definition;
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.data.fresh ? { ...node, data: { ...node.data, fresh: false } } : node
    )
  };
}

/**
 * O fluxo atual em texto, para o assistente poder EDITAR o que existe.
 *
 * Sem isto ele só saberia criar do zero: para "troque a mensagem do
 * WhatsApp" ou "remova a espera", ele precisa dos ids que estão na tela.
 */
export function describeFlow(definition: FlowDefinition): string {
  if (!definition.nodes.length) return "(fluxo vazio)";
  const nos = definition.nodes.map((node) => {
    const partes = [`${node.id}: ${node.type}`, `"${node.data.label}"`];
    if (node.data.triggerType) partes.push(`triggerType=${node.data.triggerType}`);
    if (node.data.actionType) partes.push(`actionType=${node.data.actionType}`);
    if (node.data.field) partes.push(`${node.data.field} ${node.data.operator ?? ""} ${node.data.value ?? ""}`.trim());
    if (node.data.waitAmount) partes.push(`${node.data.waitAmount} ${node.data.waitUnit ?? "hours"}`);
    return `- ${partes.join(" · ")}`;
  });
  const arestas = definition.edges.map(
    (edge) => `- ${edge.source} -> ${edge.target}${edge.sourceHandle ? ` (${edge.sourceHandle})` : ""}`
  );
  return [`NÓS:`, ...nos, `CONEXÕES:`, ...(arestas.length ? arestas : ["- (nenhuma)"])].join("\n");
}
