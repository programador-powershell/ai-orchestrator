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

import { useCallback, useEffect, useMemo, useRef } from "react";
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

/** Lado do quadrado da alça — o React Flow soma `width`/`height` ao ler `x`/`y`. */
const LADO_ALCA = 8;

/**
 * As alças de uma tabela, DECLARADAS (o porquê está no topo do arquivo).
 *
 * Quatro por campo (entrada e saída de cada lado) mais as do cabeçalho — o
 * motivo de serem quatro está no `TableNode`. As posições batem com as do CSS
 * porque as duas saem de `TABLE_GEOMETRY`.
 */
function alcasDe(table: SchemaTable) {
  /*
   * `x`/`y` são o CANTO SUPERIOR-ESQUERDO do retângulo da alça, não o centro:
   * o React Flow calcula o ponto da aresta como `x + width / 2`. Declarando o
   * centro, toda ponta de linha saía 4px para baixo e para a direita do lugar.
   */
  const nova = (type: "source" | "target", position: Position, centroX: number, centroY: number, id: string) => ({
    id,
    nodeId: table.id,
    type,
    position,
    x: centroX - LADO_ALCA / 2,
    y: centroY - LADO_ALCA / 2,
    width: LADO_ALCA,
    height: LADO_ALCA
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
  /*
   * A tabela vive num ref, e não nas dependências.
   *
   * O objeto troca de identidade a CADA mudança dela — renomear um campo,
   * mudar o tipo, arrastar. Com `tabela` na lista, o efeito rodava de novo e a
   * tela ia sozinha para o centro dela no meio da edição, sem ninguém pedir.
   * O gatilho é o `nonce`, que só o rail incrementa.
   */
  const alvo = useRef(tabela);
  alvo.current = tabela;

  useEffect(() => {
    const table = alvo.current;
    if (!nonce || !table) return;
    setCenter(table.x + LARGURA / 2, table.y + tableHeight(table) / 2, {
      zoom: Math.max(getZoom(), 0.8),
      duration: 320
    });
    // `nonce` é o gatilho: pedir foco na MESMA tabela duas vezes precisa
    // mover de novo, e comparar só o id não dispararia na segunda.
  }, [nonce, setCenter, getZoom]);
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
  /** Soltou o arrasto: TODAS as tabelas movidas, e o documento de antes dele. */
  onMove: (movidas: Array<{ id: string; x: number; y: number }>, antes: SchemaDocExt) => void;
  /** Delete com seleção: tabelas e relações somem no MESMO passo de histórico. */
  onDelete: (tabelas: SchemaTable[], relationIds: string[]) => void;
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
  onDelete
}: ErdCanvasProps) {
  const [nodes, setNodes, aplicarMudancasDeNo] = useNodesState<Node>([]);
  const [edges, setEdges, aplicarMudancasDeAresta] = useEdgesState<Edge>([]);

  const porNome = useMemo(() => new Map(doc.tables.map((table) => [table.name, table])), [doc.tables]);

  /**
   * Documento → nós. Tamanho e alças declarados; ver o topo do arquivo.
   *
   * A SELEÇÃO não vem daqui. Ela é do canvas: forçar `selected` a cada
   * sincronia desfazia a seleção múltipla (Ctrl+clique ou laço) no quadro
   * seguinte, e o retângulo de seleção que o `canvas.css` desenha nunca
   * chegava a existir. O que o efeito faz com o estado anterior é
   * PRESERVÁ-LO, para uma operação do chat no meio da seleção não limpar o
   * que a pessoa tinha marcado.
   */
  useEffect(() => {
    setNodes((atuais) => {
      const porId = new Map(atuais.map((node) => [node.id, node]));
      return doc.tables.map((table) => {
        const anterior = porId.get(table.id);
        const altura = tableHeight(table);
        return {
          ...anterior,
          id: table.id,
          type: "table",
          position: { x: table.x, y: table.y },
          selected: anterior?.selected ?? false,
          width: LARGURA,
          height: altura,
          measured: { width: LARGURA, height: altura },
          handles: alcasDe(table),
          data: { ...anterior?.data, table }
        } as Node;
      });
    });
  }, [doc.tables, setNodes]);

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

  /**
   * O documento de ANTES do arrasto, para o commit virar uma entrada só.
   *
   * Um ref simples basta porque o React Flow só permite um arrasto por vez —
   * e ele chama `onNodeDragStop` UMA vez por gesto, passando no terceiro
   * argumento todos os nós que se moveram.
   */
  const antesDoArrasto = useRef<SchemaDocExt | null>(null);

  const aoIniciarArrasto = useCallback(() => {
    antesDoArrasto.current = doc;
  }, [doc]);

  const aoMoverFim = useCallback(
    (_: unknown, node: Node, arrastados: Node[]) => {
      /*
       * `arrastados` traz TODOS os nós do gesto — com seleção múltipla, o
       * segundo argumento é só o que estava sob o cursor. Persistindo só ele,
       * as outras tabelas voltavam para a posição antiga no próximo quadro,
       * porque a sincronia relê a posição do documento.
       */
      const movidos = arrastados.length ? arrastados : [node];
      onMove(
        movidos.map((item) => ({
          id: item.id,
          x: Math.max(0, Math.round(item.position.x)),
          y: Math.max(0, Math.round(item.position.y))
        })),
        antesDoArrasto.current ?? doc
      );
      antesDoArrasto.current = null;
    },
    [doc, onMove]
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
        /*
         * `onDelete` e não o par `onNodesDelete`/`onEdgesDelete`: apagar uma
         * tabela apaga em cascata as arestas ligadas a ela, e os dois
         * callbacks disparavam em sequência, cada um com seu commit. Uma
         * exclusão virava N+1 entradas de histórico, e um Ctrl+Z devolvia um
         * estado do meio — a tabela de volta sem as relações. `onDelete`
         * entrega tudo de uma vez, num commit só.
         */
        onDelete={({ nodes: apagados, edges: apagadas }) => {
          const tabelas = apagados
            .map((node) => doc.tables.find((item) => item.id === node.id))
            .filter((table): table is SchemaTable => Boolean(table));
          // Aresta de tabela que já vai embora não precisa perder a FK antes.
          const idsApagados = new Set(apagados.map((node) => node.id));
          const soltas = apagadas.filter((edge) => !idsApagados.has(edge.source) && !idsApagados.has(edge.target));
          onDelete(tabelas, soltas.map((edge) => edge.id));
        }}
        /* O padrão do React Flow 12 é só Backspace; a interface promete Delete. */
        deleteKeyCode={["Delete", "Backspace"]}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        {/*
         * No topo, e não no rodapé como na aba Fluxo: aqui os cantos de baixo
         * já são da barra de ações da aba (esquerda) e do "Pedir ao agente"
         * (direita), que ficariam por cima do zoom e do minimapa.
         */}
        <Controls showInteractive={false} position="top-left" />
        <MiniMap pannable zoomable position="top-right" nodeColor={() => "var(--accent)"} />
        <FocoNaTabela tabela={doc.tables.find((table) => table.id === focusId) ?? null} nonce={focusNonce} />
      </ReactFlow>
    </div>
  );
}
