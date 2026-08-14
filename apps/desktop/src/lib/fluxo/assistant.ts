/**
 * O assistente que monta o fluxo — e o que fazer quando não há modelo.
 *
 * A instrução pede **uma operação por linha** porque é isso que permite
 * desenhar durante a resposta (ver `ops.ts`). E manda o fluxo ATUAL junto,
 * com os ids, porque sem ele o modelo só saberia criar do zero: "tire a
 * espera" e "troque a mensagem" exigem apontar para o que está na tela.
 *
 * Sem gateway, sem provedor e sem runtime, a heurística assume. Ela não
 * entende a frase — ela reconhece PALAVRAS e monta um esqueleto plausível,
 * que a pessoa ajusta no painel. Um canvas vazio com "configure um motor"
 * seria pior: o recurso pareceria quebrado quando é só falta de conexão.
 */

import { catalogPrompt } from "./catalog";
import { describeFlow, takeOps, type FlowOp } from "./ops";
import type { FlowDefinition, FlowNodeData, NodeType } from "./types";

export const SYSTEM = [
  "Você monta fluxos de automação no editor visual do Multiplike-AI.",
  "",
  "Responda SOMENTE com operações, UMA POR LINHA, cada uma um JSON completo.",
  "Nada de markdown, nada de texto explicativo, nada de cerca de código.",
  "As operações são aplicadas na ordem, e cada linha aparece na tela na hora.",
  "",
  "OPERAÇÕES:",
  '{"op":"clear"}  — apaga tudo (use só quando pedirem um fluxo novo do zero)',
  '{"op":"add","id":"t1","type":"trigger","triggerType":"new_lead","label":"Novo lead"}',
  '{"op":"add","id":"c1","type":"condition","field":"budget","operator":"greater_than","value":1000,"label":"Orçamento alto?"}',
  '{"op":"add","id":"a1","type":"action","actionType":"send_whatsapp","message":"Olá {{name}}!","label":"Boas-vindas"}',
  '{"op":"add","id":"w1","type":"wait","waitAmount":2,"waitUnit":"days","label":"Aguardar 2 dias"}',
  '{"op":"connect","from":"t1","to":"c1"}',
  '{"op":"connect","from":"c1","to":"a1","branch":"true"}   — ramo SIM da condição',
  '{"op":"connect","from":"c1","to":"a2","branch":"false"}  — ramo NÃO da condição',
  '{"op":"update","id":"a1","message":"Novo texto"}         — edita um nó existente',
  '{"op":"remove","id":"w1"}                                 — remove um nó',
  '{"op":"disconnect","from":"t1","to":"c1"}                 — remove uma ligação',
  '{"op":"rename","name":"Qualificação de lead"}             — renomeia o fluxo',
  "",
  catalogPrompt(),
  "",
  "REGRAS:",
  "- Todo fluxo começa por um gatilho, e todo nó novo precisa de um `connect`.",
  "- NÃO mande posição: o editor posiciona sozinho.",
  "- Use `{{name}}`, `{{phone}}`, `{{budget}}` nas mensagens.",
  "- Rótulos em português, curtos.",
  "- Para EDITAR o fluxo existente, use os ids que aparecem abaixo e mexa só no que foi pedido.",
  "- Não repita `clear` numa edição: isso apagaria o trabalho da pessoa."
].join("\n");

export function buildRequest(pedido: string, definition: FlowDefinition) {
  return [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content: [
        "FLUXO ATUAL:",
        describeFlow(definition),
        "",
        "PEDIDO:",
        pedido
      ].join("\n")
    }
  ];
}

/**
 * Consome o stream do modelo e entrega operação por operação.
 *
 * `onOp` é chamado assim que a LINHA fecha, não no fim da resposta: é o que
 * faz o nó aparecer enquanto o modelo ainda escreve.
 */
export function createOpStream(onOp: (op: FlowOp) => void) {
  let buffer = "";
  return {
    push(delta: string) {
      buffer += delta;
      const { ops, rest } = takeOps(buffer);
      buffer = rest;
      for (const op of ops) onOp(op);
    },
    /** Fim do stream: a última linha pode ter ficado sem quebra. */
    end() {
      const { ops } = takeOps(`${buffer}\n`);
      buffer = "";
      for (const op of ops) onOp(op);
    }
  };
}

/* ------------------------------ heurística ------------------------------ */

const contem = (texto: string, ...termos: string[]) => termos.some((termo) => texto.includes(termo));

/**
 * Fluxo de reserva, montado por palavra-chave.
 *
 * Devolve OPERAÇÕES, não um fluxo pronto: assim a tela desenha do mesmo jeito
 * (uma por vez) e o caminho sem modelo não vira um segundo comportamento.
 */
export function heuristicOps(pedido: string): FlowOp[] {
  const texto = pedido.toLowerCase();
  const ops: FlowOp[] = [{ op: "clear" }];
  const add = (id: string, type: NodeType, data: Record<string, unknown>) =>
    ops.push({ op: "add", id, type, data: data as FlowNodeData });

  // "atrasa" e não "atras": o segundo casaria "3 dias atrás", que é o
  // oposto — ali a pessoa está descrevendo uma espera, não um vencimento.
  const gatilho = contem(texto, "atrasa", "venc")
    ? "card_overdue"
    : contem(texto, "respond", "resposta", "whatsapp responde")
      ? "whatsapp_reply"
      : contem(texto, "cartão", "cartao", "card", "quadro", "tarefa criada")
        ? "card_created"
        : contem(texto, "convers")
          ? "new_conversation"
          : contem(texto, "todo dia", "diariamente", "agendad", "toda semana")
            ? "schedule"
            : "new_lead";
  add("t1", "trigger", { triggerType: gatilho, label: gatilho === "new_lead" ? "Novo lead" : "Gatilho" });

  let anterior = "t1";
  let ramo: "true" | "false" | undefined;

  const valor = texto.match(/(\d[\d.]*)\s*(mil|k)?/);
  if (contem(texto, "orçamento", "orcamento", "acima", "maior", "valor", "budget") && valor) {
    const bruto = Number(valor[1].replace(/\./g, ""));
    const numero = valor[2] ? bruto * 1000 : bruto;
    add("c1", "condition", {
      field: "budget",
      operator: "greater_than",
      value: numero,
      label: `Orçamento > ${numero}`
    });
    ops.push({ op: "connect", from: anterior, to: "c1" });
    anterior = "c1";
    ramo = "true";
  }

  if (contem(texto, "espera", "aguard", "dias depois", "horas depois", "não responder", "nao responder")) {
    const quantidade = texto.match(/(\d+)\s*(dia|hora|minuto)/);
    add("w1", "wait", {
      waitAmount: quantidade ? Number(quantidade[1]) : 2,
      waitUnit: quantidade?.[2].startsWith("hora") ? "hours" : quantidade?.[2].startsWith("minuto") ? "minutes" : "days",
      label: "Aguardar"
    });
    ops.push({ op: "connect", from: anterior, to: "w1", branch: ramo });
    anterior = "w1";
    ramo = undefined;
  }

  const acoes: Array<{ id: string; actionType: string; label: string; extra?: Record<string, unknown> }> = [];
  if (contem(texto, "whatsapp", "mensagem", "mandar", "enviar", "boas-vindas", "retomada")) {
    acoes.push({
      id: "a1",
      actionType: "send_whatsapp",
      label: "Enviar WhatsApp",
      extra: { message: "Olá {{name}}, tudo bem?" }
    });
  }
  if (contem(texto, "quente", "hot")) acoes.push({ id: "a2", actionType: "mark_hot", label: "Marcar como quente" });
  if (contem(texto, "frio", "cold")) acoes.push({ id: "a3", actionType: "mark_cold", label: "Marcar como frio" });
  if (contem(texto, "gestor", "avisar", "notific")) {
    acoes.push({
      id: "a4",
      actionType: "notify_manager",
      label: "Avisar o gestor",
      extra: { message: "Lead {{name}} precisa de atenção" }
    });
  }
  if (contem(texto, "tarefa", "task", "cartão", "cartao", "card")) {
    acoes.push({
      id: "a5",
      actionType: "create_task",
      label: "Criar tarefa",
      extra: { taskTitle: "Primeiro contato com {{name}}" }
    });
  }
  if (contem(texto, "etiqueta", "tag")) {
    acoes.push({ id: "a6", actionType: "add_tag", label: "Adicionar etiqueta", extra: { tagName: "automação" } });
  }
  if (!acoes.length) {
    acoes.push({
      id: "a1",
      actionType: "send_whatsapp",
      label: "Enviar WhatsApp",
      extra: { message: "Olá {{name}}, tudo bem?" }
    });
  }

  for (const acao of acoes) {
    add(acao.id, "action", { actionType: acao.actionType, label: acao.label, ...(acao.extra ?? {}) });
    ops.push({ op: "connect", from: anterior, to: acao.id, branch: ramo });
    ramo = undefined;
    anterior = acao.id;
  }

  ops.push({ op: "rename", name: pedido.length > 40 ? `${pedido.slice(0, 40)}…` : pedido });
  return ops;
}
