"use client";

/**
 * Detalhes do nó selecionado — a coluna da direita.
 *
 * Os campos são derivados do CATÁLOGO, não escritos à mão por tipo de ação:
 * acrescentar uma ação nova em `catalog.ts` já a faz aparecer aqui, e não há
 * como o painel oferecer algo que o motor não executa.
 */

import { Trash2, X } from "lucide-react";

import {
  ACTIONS,
  FIELDS,
  NODE_LABEL,
  OPERADOR_SEM_VALOR,
  OPERATORS,
  TRIGGERS
} from "../../lib/fluxo/catalog";
import type { FlowNode, FlowNodeData } from "../../lib/fluxo/types";

/** Campos extras por tipo de ação — o que cada uma precisa para funcionar. */
function CamposDaAcao({
  data,
  onChange
}: {
  data: FlowNodeData;
  onChange: (patch: Partial<FlowNodeData>) => void;
}) {
  switch (data.actionType) {
    case "send_whatsapp":
    case "notify_manager":
    case "run_agent":
      return (
        <label className="fxp-field">
          Mensagem
          <textarea
            rows={3}
            value={data.message ?? ""}
            onChange={(event) => onChange({ message: event.target.value })}
            placeholder="Olá {{name}}, tudo bem?"
          />
          <small>Use {"{{name}}"}, {"{{phone}}"}, {"{{budget}}"} para os dados do gatilho.</small>
        </label>
      );
    case "create_task":
      return (
        <label className="fxp-field">
          Título da tarefa
          <input
            value={data.taskTitle ?? ""}
            onChange={(event) => onChange({ taskTitle: event.target.value })}
            placeholder="Primeiro contato com {{name}}"
          />
        </label>
      );
    case "add_tag":
      return (
        <label className="fxp-field">
          Etiqueta
          <input value={data.tagName ?? ""} onChange={(event) => onChange({ tagName: event.target.value })} />
        </label>
      );
    case "http_request":
      return (
        <>
          <label className="fxp-field">
            URL
            <input
              value={data.url ?? ""}
              onChange={(event) => onChange({ url: event.target.value })}
              placeholder="https://…"
            />
            {/* Mesma regra do webhook do Work: sem TLS o corpo vai em claro. */}
            <small>Só https:// — a chamada leva dados do lead.</small>
          </label>
          <label className="fxp-field">
            Método
            <select value={data.method ?? "POST"} onChange={(event) => onChange({ method: event.target.value })}>
              {["POST", "GET", "PUT", "PATCH"].map((metodo) => (
                <option key={metodo} value={metodo}>
                  {metodo}
                </option>
              ))}
            </select>
          </label>
        </>
      );
    default:
      return null;
  }
}

export function NodePanel({
  node,
  onChange,
  onRemove,
  onClose
}: {
  node: FlowNode;
  onChange: (patch: Partial<FlowNodeData>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const data = node.data;
  return (
    <div className="fxp">
      <header className="fxp-head">
        <span className="fxp-kind">{NODE_LABEL[node.type]}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar detalhes">
          <X size={13} />
        </button>
      </header>

      <label className="fxp-field">
        Nome
        <input value={data.label ?? ""} onChange={(event) => onChange({ label: event.target.value })} />
      </label>

      {node.type === "trigger" && (
        <label className="fxp-field">
          Quando acontecer
          <select
            value={data.triggerType ?? "new_lead"}
            onChange={(event) => onChange({ triggerType: event.target.value as FlowNodeData["triggerType"] })}
          >
            {TRIGGERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} — {item.hint}
              </option>
            ))}
          </select>
        </label>
      )}

      {node.type === "condition" && (
        <>
          <label className="fxp-field">
            Campo
            <select value={data.field ?? "budget"} onChange={(event) => onChange({ field: event.target.value })}>
              {FIELDS.map((campo) => (
                <option key={campo} value={campo}>
                  {campo}
                </option>
              ))}
            </select>
          </label>
          <label className="fxp-field">
            Comparação
            <select
              value={data.operator ?? "equals"}
              onChange={(event) => onChange({ operator: event.target.value as FlowNodeData["operator"] })}
            >
              {OPERATORS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {/* "está vazio" não tem valor a comparar — o campo some em vez de
              ficar ali pedindo algo que será ignorado. */}
          {!OPERADOR_SEM_VALOR.has(data.operator ?? "equals") && (
            <label className="fxp-field">
              Valor
              <input
                value={String(data.value ?? "")}
                onChange={(event) => {
                  const bruto = event.target.value;
                  const numero = Number(bruto.replace(",", "."));
                  onChange({ value: bruto !== "" && Number.isFinite(numero) ? numero : bruto });
                }}
              />
            </label>
          )}
        </>
      )}

      {node.type === "action" && (
        <>
          <label className="fxp-field">
            O que fazer
            <select
              value={data.actionType ?? "send_whatsapp"}
              onChange={(event) => onChange({ actionType: event.target.value as FlowNodeData["actionType"] })}
            >
              {ACTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} — {item.hint}
                </option>
              ))}
            </select>
          </label>
          <CamposDaAcao data={data} onChange={onChange} />
        </>
      )}

      {node.type === "wait" && (
        <div className="fxp-row">
          <label className="fxp-field">
            Esperar
            <input
              type="number"
              min={1}
              value={data.waitAmount ?? 1}
              onChange={(event) => onChange({ waitAmount: Math.max(1, Number(event.target.value) || 1) })}
            />
          </label>
          <label className="fxp-field">
            Unidade
            <select
              value={data.waitUnit ?? "hours"}
              onChange={(event) => onChange({ waitUnit: event.target.value as FlowNodeData["waitUnit"] })}
            >
              <option value="minutes">minutos</option>
              <option value="hours">horas</option>
              <option value="days">dias</option>
            </select>
          </label>
        </div>
      )}

      <button type="button" className="lg-button ghost fxp-remove" onClick={onRemove}>
        <Trash2 size={13} />
        Remover nó
      </button>
    </div>
  );
}
