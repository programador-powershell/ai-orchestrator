"use client";

/**
 * O cartão de tabela no diagrama.
 *
 * Cada campo tem QUATRO alças — entrada e saída de cada lado — e o cabeçalho
 * tem as suas. Parece exagero e não é: a ligação sai pelo lado que aponta para
 * o alvo, e com uma alça por lado toda relação da direita para a esquerda
 * saía pela direita, dava a volta por fora do cartão e voltava. O par certo é
 * escolhido na hora de montar a aresta (`ErdCanvas`), comparando as posições.
 *
 * As alças ficam invisíveis até o cartão receber atenção: um diagrama de vinte
 * tabelas com todas à mostra vira uma parede de bolinhas.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { KeyRound, Link2, Table2 } from "lucide-react";
import type { SchemaTable } from "@orchestrator/contracts";

import { alca } from "../../lib/erdLinks";
import { TABLE_GEOMETRY } from "../../lib/schema";

export interface TableNodeData extends Record<string, unknown> {
  table: SchemaTable;
}

/** Y da alça de um campo dentro do cartão — mesma conta do CSS. */
export function alturaDoCampo(indice: number): number {
  return TABLE_GEOMETRY.headerHeight + indice * TABLE_GEOMETRY.rowHeight + TABLE_GEOMETRY.rowHeight / 2;
}

export const TableNode = memo(function TableNode({ data }: NodeProps) {
  const { table } = data as unknown as TableNodeData;

  /* O realce de seleção vem do canvas (`.react-flow__node.selected`, em
     data.css): assim ele acompanha a seleção múltipla, que é do React Flow
     e não do store. */
  return (
    <article className="datax-table" data-tone={table.tone}>
      <header>
        <Table2 size={11} />
        <strong>{table.name}</strong>
        <small>{table.fields.length}</small>
        <Handle type="target" position={Position.Left} id={alca("t", "l", "tbl")} className="datax-h datax-h--tabela" />
        <Handle type="source" position={Position.Left} id={alca("s", "l", "tbl")} className="datax-h datax-h--tabela" />
        <Handle type="target" position={Position.Right} id={alca("t", "r", "tbl")} className="datax-h datax-h--tabela" />
        <Handle type="source" position={Position.Right} id={alca("s", "r", "tbl")} className="datax-h datax-h--tabela" />
      </header>
      {table.fields.map((field, index) => (
        <div className={`datax-field ${field.primaryKey ? "pk" : ""}`} key={`${table.id}-${index}`}>
          <span>
            {field.primaryKey ? <KeyRound size={10} /> : field.references ? <Link2 size={10} /> : <i />}
            {field.name}
          </span>
          <small>{field.type}</small>
          {(
            [
              ["t", "l", Position.Left],
              ["s", "l", Position.Left],
              ["t", "r", Position.Right],
              ["s", "r", Position.Right]
            ] as const
          ).map(([papel, lado, position]) => (
            <Handle
              key={`${papel}${lado}`}
              type={papel === "s" ? "source" : "target"}
              position={position}
              id={alca(papel, lado, index)}
              className="datax-h"
              style={{ top: alturaDoCampo(index) }}
              title={`Arraste até um campo de outra tabela para ligar ${table.name}.${field.name}`}
            />
          ))}
        </div>
      ))}
    </article>
  );
});

export const nodeTypes = { table: TableNode };
