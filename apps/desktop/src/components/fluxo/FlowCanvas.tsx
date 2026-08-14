"use client";

/**
 * O canvas — React Flow ligado ao store da aba.
 *
 * A fonte da verdade é o `draft` do store, não o estado interno do canvas:
 * três coisas mexem no fluxo ao mesmo tempo (arraste, painel de detalhes e
 * stream do assistente) e, com o estado dentro do componente, a última a
 * escrever ganhava — um nó que o assistente acabara de criar sumia no
 * próximo arraste.
 *
 * ## Por que o nó vai com tamanho e alças DECLARADOS
 *
 * O React Flow só desenha uma aresta quando os dois nós estão
 * "inicializados": com dimensão conhecida E com os limites das alças já
 * lidos. Ele descobre as duas coisas medindo o DOM — e, ao receber um nó sem
 * `measured`, entende que ele foi reinicializado e **joga fora os limites das
 * alças**. Como aqui os nós nascem em tempo de execução (uma operação do
 * assistente por vez), esse ciclo se repetia a cada linha e o resultado era o
 * pior tipo de falha: os cartões apareciam na tela, **nenhuma linha entre
 * eles**, e nenhum erro em lugar nenhum.
 *
 * Como o cartão tem tamanho fixo no CSS e as alças têm posição fixa (entrada
 * à esquerda, saída à direita, condição com dois ramos), os dois são
 * informados aqui. Deixa de depender de medição, e o desenho para de variar
 * conforme o quadro em que a medição chegou.
 */

import { useCallback, useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { nodeTypes } from "./FlowNodes";
import { applyOp } from "../../lib/fluxo/ops";
import { useFluxo } from "../../lib/fluxo/store";
import type { FlowDefinition } from "../../lib/fluxo/types";

/** Tamanho do cartão — fixo no CSS (`.fxn`), declarado aqui para o React Flow. */
const LARGURA_NO = 214;
const ALTURA_NO = 64;

/**
 * As alças de cada tipo de nó, DECLARADAS.
 *
 * O React Flow normalmente descobre as alças medindo o DOM. Aqui elas são
 * informadas: a posição é fixa (entrada à esquerda, saída à direita, e a
 * condição com dois ramos), e depender da medição automática deixava o canvas
 * num estado em que **nenhuma aresta era desenhada** — o nó só é considerado
 * pronto quando os limites das alças existem, e sem eles toda linha é
 * descartada em silêncio.
 *
 * Declarar também é mais estável: o desenho não muda porque a medição chegou
 * meio quadro atrasada.
 */
function alcasDe(tipo: string, id: string) {
  const meio = ALTURA_NO / 2;
  const alca = (
    type: "source" | "target",
    position: Position,
    x: number,
    y: number,
    idAlca?: string
  ) => ({ id: idAlca ?? null, nodeId: id, type, position, x, y, width: 9, height: 9 });

  if (tipo === "trigger") return [alca("source", Position.Right, LARGURA_NO, meio)];
  if (tipo === "end") return [alca("target", Position.Left, 0, meio)];
  if (tipo === "condition") {
    return [
      alca("target", Position.Left, 0, meio),
      // Mesmas frações usadas no CSS das alças (38% e 76%).
      alca("source", Position.Right, LARGURA_NO, ALTURA_NO * 0.38, "true"),
      alca("source", Position.Right, LARGURA_NO, ALTURA_NO * 0.76, "false")
    ];
  }
  return [alca("target", Position.Left, 0, meio), alca("source", Position.Right, LARGURA_NO, meio)];
}

const CORES: Record<string, string> = {
  trigger: "var(--tone-green, #22c55e)",
  condition: "var(--tone-purple, #a855f7)",
  action: "var(--accent)",
  wait: "var(--tone-amber, #f59e0b)",
  end: "var(--faint)"
};

function Canvas({ definition, destaque }: { definition: FlowDefinition; destaque: Set<string> }) {
  const selectedNode = useFluxo((state) => state.selectedNode);
  const select = useFluxo((state) => state.select);
  const setDraft = useFluxo((state) => state.setDraft);
  const moveNode = useFluxo((state) => state.moveNode);

  const [nodes, setNodes, aplicarMudancasDeNo] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  /** Store → canvas (o porquê do tamanho e das alças está no topo do arquivo). */
  useEffect(() => {
    setNodes((atuais) => {
      const porId = new Map(atuais.map((node) => [node.id, node]));
      return definition.nodes.map((node) => {
        const anterior = porId.get(node.id);
        return {
          ...anterior,
          id: node.id,
          type: node.type,
          position: node.position,
          selected: node.id === selectedNode,
          width: LARGURA_NO,
          height: ALTURA_NO,
          measured: { width: LARGURA_NO, height: ALTURA_NO },
          handles: alcasDe(node.type, node.id),
          // `hit` acende o caminho que o teste percorreu — é o feedback que
          // transforma "rodou" em "rodou por AQUI".
          data: { ...node.data, hit: destaque.has(node.id) }
        } as Node;
      });
    });
  }, [definition.nodes, selectedNode, destaque, setNodes]);

  useEffect(() => {
    setEdges(
      definition.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        label: edge.label,
        type: "smoothstep",
        animated: destaque.has(edge.source) && destaque.has(edge.target),
        className: edge.sourceHandle === "false" ? "fxe fxe--no" : "fxe"
      }))
    );
  }, [definition.edges, destaque, setEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      // TODAS as mudanças vão para o React Flow (é ele quem mede e seleciona);
      // só a posição do arraste concluído volta para o store, porque é a única
      // que pertence ao documento salvo.
      aplicarMudancasDeNo(changes);
      for (const change of changes) {
        if (change.type === "position" && change.position && change.dragging === false) {
          moveNode(change.id, change.position);
        }
      }
    },
    [aplicarMudancasDeNo, moveNode]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const branch =
        connection.sourceHandle === "true" || connection.sourceHandle === "false"
          ? (connection.sourceHandle as "true" | "false")
          : undefined;
      setDraft(
        applyOp(useFluxo.getState().draft, {
          op: "connect",
          from: connection.source,
          to: connection.target,
          branch
        })
      );
    },
    [setDraft]
  );

  const onEdgesDelete = useCallback((removidas: Edge[]) => {
    let atual = useFluxo.getState().draft;
    for (const edge of removidas) {
      atual = applyOp(atual, { op: "disconnect", from: edge.source, to: edge.target });
    }
    useFluxo.getState().setDraft(atual);
  }, []);

  return (
    <div className="fx-host">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_, node) => select(node.id)}
        onPaneClick={() => select(null)}
        defaultEdgeOptions={{ type: "smoothstep" }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => CORES[node.type ?? "action"] ?? "var(--faint)"} />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: { definition: FlowDefinition; destaque: Set<string> }) {
  return <Canvas {...props} />;
}
