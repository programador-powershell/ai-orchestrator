"use client";

/**
 * Os nós desenhados no canvas.
 *
 * Um componente por tipo, e não um genérico com `if`: o que muda entre eles é
 * o que a pessoa precisa LER de relance (o gatilho mostra o evento, a
 * condição mostra a comparação, a ação mostra o texto que vai sair). Um nó
 * genérico mostraria o rótulo e obrigaria a abrir o painel para saber o que
 * ele faz.
 *
 * As alças (`Handle`) ficam onde a ligação faz sentido: entrada à esquerda,
 * saída à direita — e a condição tem DUAS saídas rotuladas, porque "sim" e
 * "não" precisam ser distinguíveis sem clicar.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bell, Clock, Flag, GitBranch, Zap, type LucideIcon } from "lucide-react";

import { labelFor, NODE_LABEL } from "../../lib/fluxo/catalog";
import type { FlowNodeData } from "../../lib/fluxo/types";

function Moldura({
  tipo,
  icone: Icone,
  kicker,
  titulo,
  detalhe,
  data,
  selected,
  children
}: {
  tipo: string;
  icone: LucideIcon;
  kicker: string;
  titulo: string;
  detalhe?: string;
  data: FlowNodeData;
  selected?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`fxn fxn--${tipo} ${selected ? "is-selected" : ""} ${data.fresh ? "is-fresh" : ""} ${
        data.hit ? "is-hit" : ""
      }`}
    >
      <span className="fxn-kicker">
        <Icone size={12} />
        {kicker}
      </span>
      <strong className="fxn-title">{titulo}</strong>
      {detalhe ? <span className="fxn-detail">{detalhe}</span> : null}
      {children}
    </div>
  );
}

export function TriggerNode({ data, selected }: NodeProps) {
  const dados = data as FlowNodeData;
  return (
    <>
      <Moldura
        tipo="trigger"
        icone={Zap}
        kicker={NODE_LABEL.trigger}
        titulo={dados.label || labelFor("trigger", dados.triggerType)}
        detalhe={dados.description ?? labelFor("trigger", dados.triggerType)}
        data={dados}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} className="fxh" />
    </>
  );
}

export function ConditionNode({ data, selected }: NodeProps) {
  const dados = data as FlowNodeData;
  const comparacao = [dados.field, dados.operator, dados.value].filter((parte) => parte !== undefined).join(" ");
  return (
    <>
      <Handle type="target" position={Position.Left} className="fxh" />
      <Moldura
        tipo="condition"
        icone={GitBranch}
        kicker={NODE_LABEL.condition}
        titulo={dados.label || "Condição"}
        detalhe={comparacao || "sem regra definida"}
        data={dados}
        selected={selected}
      >
        {/* Rótulo ao lado da alça: sem ele, os dois ramos ficam iguais e só
            clicando dá para saber qual é o "sim". */}
        <span className="fxn-branch fxn-branch--yes">sim</span>
        <span className="fxn-branch fxn-branch--no">não</span>
      </Moldura>
      <Handle id="true" type="source" position={Position.Right} style={{ top: "38%" }} className="fxh fxh--yes" />
      <Handle id="false" type="source" position={Position.Right} style={{ top: "76%" }} className="fxh fxh--no" />
    </>
  );
}

export function ActionNode({ data, selected }: NodeProps) {
  const dados = data as FlowNodeData;
  const detalhe = dados.message ?? dados.taskTitle ?? dados.tagName ?? dados.url ?? labelFor("action", dados.actionType);
  return (
    <>
      <Handle type="target" position={Position.Left} className="fxh" />
      <Moldura
        tipo="action"
        icone={Bell}
        kicker={NODE_LABEL.action}
        titulo={dados.label || labelFor("action", dados.actionType)}
        detalhe={detalhe}
        data={dados}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} className="fxh" />
    </>
  );
}

export function WaitNode({ data, selected }: NodeProps) {
  const dados = data as FlowNodeData;
  const unidade = { minutes: "minuto(s)", hours: "hora(s)", days: "dia(s)" }[dados.waitUnit ?? "hours"];
  return (
    <>
      <Handle type="target" position={Position.Left} className="fxh" />
      <Moldura
        tipo="wait"
        icone={Clock}
        kicker={NODE_LABEL.wait}
        titulo={dados.label || "Aguardar"}
        detalhe={`${dados.waitAmount ?? 1} ${unidade}`}
        data={dados}
        selected={selected}
      />
      <Handle type="source" position={Position.Right} className="fxh" />
    </>
  );
}

export function EndNode({ data, selected }: NodeProps) {
  const dados = data as FlowNodeData;
  return (
    <>
      <Handle type="target" position={Position.Left} className="fxh" />
      <Moldura
        tipo="end"
        icone={Flag}
        kicker={NODE_LABEL.end}
        titulo={dados.label || "Fim"}
        data={dados}
        selected={selected}
      />
    </>
  );
}

export const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
  wait: WaitNode,
  end: EndNode
};
