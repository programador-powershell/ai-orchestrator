"use client";

/**
 * A área de trabalho do diagrama — o MESMO motor da aba Fluxo.
 *
 * Antes o pan, o arrasto e o traço da FK eram programados aqui, à mão: cada
 * um funcionava, mas o conjunto não tinha a inércia, o zoom no cursor nem a
 * seleção múltipla de um canvas de verdade — e as duas áreas de trabalho do
 * app respondiam de jeitos diferentes ao mesmo gesto. Passar as duas pelo
 * React Flow resolve isso de uma vez, e o que sobrou de código aqui é só a
 * tradução entre o documento do schema e o grafo.
 *
 * ## Por que a tabela vai com tamanho e alças DECLARADOS
 *
 * O React Flow só desenha uma aresta quando os dois nós estão inicializados:
 * com dimensão conhecida E com os limites das alças lidos. Ao receber um nó
 * sem `measured`, ele entende que houve reinicialização e JOGA FORA os limites
 * das alças. Como as tabelas nascem em tempo de execução (uma operação do chat
 * por vez), esse ciclo se repetia a cada mudança — cartões na tela, nenhuma
 * linha entre eles, silêncio total.
 *
 * A altura sai de `tableHeight(table)` e as alças de `alcasDe`, as duas a
 * partir da mesma `TABLE_GEOMETRY` que o CSS usa.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SchemaTable } from "@ai-orchestrator/contracts";

import { alturaDoCampo, nodeTypes } from "./TableNode";
import { alca, ladosDaLigacao, resolverLigacao } from "../../lib/erdLinks";
import { TABLE_GEOMETRY, tableHeight, type SchemaDocExt } from "../../lib/schema";

const LARGURA = TABLE_GEOMETRY.width;

/** Onde escolher o campo quando a ligação partiu do CABEÇALHO da tabela. */
export interface LigacaoResolvida {
  origem: SchemaTable;
  campoOrigem: number;
  destino: SchemaTable;
  campoDestino: number;
}

/**
 * As alças de uma tabela, DECLARADAS (o porquê está no topo do arquivo).
 *
 * Quatro por campo (entrada e saída de cada lado) mais as do cabeçalho — o
 * motivo de serem quatro está no `TableNode`. As posições batem com as do CSS
 * porque as duas saem de `TABLE_GEOMETRY`.
 */
function alcasDe(table: SchemaTable) {
  const nova = (type: "source" | "target", position: Position, x: number, y: number, id: string) => ({
    id,
    nodeId: table.id,
    type,
    position,
    x,
    y,
    width: 8,
    height: 8
  });

  const meioCabecalho = TABLE_GEOMETRY.headerHeight / 2;
  const alcas = [
    nova("target", Position.Left, 0, meioCabecalho, alca("t", "l", "tbl")),
    nova("source", Position.Left, 0, meioCabecalho, alca("s", "l", "tbl")),
    nova("target", Position.Right, LARGURA, meioCabecalho, alca("t", "r", "tbl")),
    nova("source", Position.Right, LARGURA, meioCabecalho, alca("s", "r", "tbl"))
  ];
  table.fields.forEach((_, indice) => {
    const y = alturaDoCampo(indice);
    alcas.push(nova("target", Position.Left, 0, y, alca("t", "l", indice)));
    alcas.push(nova("source", Position.Left, 0, y, alca("s", "l", indice)));
    alcas.push(nova("target", Position.Right, LARGURA, y, alca("t", "r", indice)));
    alcas.push(nova("source", Position.Right, LARGURA, y, alca("s", "r", indice)));
  });
  return alcas;
}

/**
 * Centraliza a tabela pedida pelo rail.
 *
 * É um componente, e não um efeito no pai, porque `useReactFlow` só enxerga o
 * canvas de DENTRO dele — chamado de fora, conversaria com outra instância do
 * estado e não moveria nada.
 */
function FocoNaTabela({ tabela, nonce }: { tabela: SchemaTable | null; nonce: number }) {
  const { setCenter, getZoom } = useReactFlow();
  useEffect(() => {
    if (!nonce || !tabela) return;
    setCenter(tabela.x + LARGURA / 2, tabela.y + tableHeight(tabela) / 2, {
      zoom: Math.max(getZoom(), 0.8),
      duration: 320
    });
    // `nonce` é o gatilho: pedir foco na MESMA tabela duas vezes precisa
    // mover de novo, e comparar só o id não dispararia na segunda.
  }, [nonce, tabela, setCenter, getZoom]);
  return null;
}

export interface ErdCanvasProps {
  doc: SchemaDocExt;
  selectedId: string | null;
  /** Tabela que o rail pediu para enquadrar, e o contador que dispara o pedido. */
  focusId: string | null;
  focusNonce: number;
  onSelect: (id: string | null) => void;
  /** Ligou dois campos com o mouse — vira FK. */
  onConnect: (ligacao: LigacaoResolvida) => void;
  /** Apagou uma relação (Delete na aresta selecionada). */
  onDisconnect: (relationId: string) => void;
  /** Soltou a tabela em outro lugar; `antes` é o documento do começo do arrasto. */
  onMove: (id: string, x: number, y: number, antes: SchemaDocExt) => void;
  onDeleteTable: (table: SchemaTable) => void;
}

export function ErdCanvas({
  doc,
  selectedId,
  focusId,
  focusNonce,
  onSelect,
  onConnect,
  onDisconnect,
  onMove,
  onDeleteTable
}: ErdCanvasProps) {
  const [nodes, setNodes, aplicarMudancasDeNo] = useNodesState<Node>([]);
  const [edges, setEdges, aplicarMudancasDeAresta] = useEdgesState<Edge>([]);

  const porNome = useMemo(() => new Map(doc.tables.map((table) => [table.name, table])), [doc.tables]);

  /** Documento → nós. Tamanho e alças declarados; ver o topo do arquivo. */
  useEffect(() => {
    setNodes(
      doc.tables.map((table) => {
        const altura = tableHeight(table);
        return {
          id: table.id,
          type: "table",
          position: { x: table.x, y: table.y },
          selected: table.id === selectedId,
          width: LARGURA,
          height: altura,
          measured: { width: LARGURA, height: altura },
          handles: alcasDe(table),
          data: { table, selecionada: table.id === selectedId }
        } as Node;
      })
    );
  }, [doc.tables, selectedId, setNodes]);

  /**
   * Documento → arestas. A FK mora no campo; a relação é o espelho dela.
   *
   * O LADO de cada ponta é escolhido aqui, pela posição das tabelas: a linha
   * sai pela borda que aponta para o alvo. Fixando a saída na direita, toda
   * relação com o destino à esquerda dava a volta por fora do cartão.
   */
  useEffect(() => {
    setEdges(
      doc.relations.flatMap((relation) => {
        const origem = porNome.get(relation.fromTable);
        const destino = porNome.get(relation.toTable);
        if (!origem || !destino) return [];
        const iOrigem = origem.fields.findIndex((field) => field.name === relation.fromField);
        const iDestino = destino.fields.findIndex((field) => field.name === relation.toField);
        if (iOrigem < 0 || iDestino < 0) return [];
        const lados = ladosDaLigacao(origem.x, destino.x);
        const aceso = origem.id === selectedId || destino.id === selectedId;
        return [
          {
            id: relation.id,
            source: origem.id,
            sourceHandle: alca("s", lados.origem, iOrigem),
            target: destino.id,
            targetHandle: alca("t", lados.destino, iDestino),
            label: relation.cardinality,
            className: aceso ? "datax-e hot" : "datax-e"
          } as Edge
        ];
      })
    );
  }, [doc.relations, porNome, selectedId, setEdges]);

  /** A regra de qual campo liga em qual está em `lib/erdLinks`, com teste. */
  const aoConectar = useCallback(
    (connection: Connection) => {
      const origem = doc.tables.find((table) => table.id === connection.source);
      const destino = doc.tables.find((table) => table.id === connection.target);
      if (!origem || !destino) return;
      const par = resolverLigacao(origem, destino, connection.sourceHandle, connection.targetHandle);
      if (!par) return;
      onConnect({ origem, destino, ...par });
    },
    [doc.tables, onConnect]
  );

  const aoMoverFim = useCallback(
    (_: unknown, node: Node) => {
      // O documento do começo do arrasto vem do próprio nó: guardá-lo aqui em
      // um ref daria o valor errado quando duas tabelas são movidas juntas.
      const antes = (node.data as { antes?: SchemaDocExt }).antes;
      onMove(node.id, Math.max(0, Math.round(node.position.x)), Math.max(0, Math.round(node.position.y)), antes ?? doc);
    },
    [doc, onMove]
  );

  const aoIniciarArrasto = useCallback(
    (_: unknown, node: Node) => {
      // Carimba o estado atual no nó para o `commitMove` ter o "antes" certo,
      // e o arrasto inteiro virar UMA entrada de histórico.
      setNodes((atuais) =>
        atuais.map((item) => (item.id === node.id ? { ...item, data: { ...item.data, antes: doc } } : item))
      );
    },
    [doc, setNodes]
  );

  return (
    <div className="datax-host aio-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={aplicarMudancasDeNo}
        onEdgesChange={aplicarMudancasDeAresta}
        onConnect={aoConectar}
        onNodeDragStart={aoIniciarArrasto}
        onNodeDragStop={aoMoverFim}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onEdgesDelete={(apagadas) => apagadas.forEach((edge) => onDisconnect(edge.id))}
        onNodesDelete={(apagados) => {
          for (const node of apagados) {
            const table = doc.tables.find((item) => item.id === node.id);
            if (table) onDeleteTable(table);
          }
        }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => "var(--accent)"} />
        <FocoNaTabela tabela={doc.tables.find((table) => table.id === focusId) ?? null} nonce={focusNonce} />
      </ReactFlow>
    </div>
  );
}
