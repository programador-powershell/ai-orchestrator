/**
 * Posicionamento automático dos nós.
 *
 * O assistente não manda coordenada, e é proposital: pedir `x`/`y` ao modelo
 * dava fluxo torto — nós empilhados no mesmo ponto, seta cruzando o próprio
 * nó — e gastava tokens numa conta que o layout faz melhor. Aqui a posição é
 * derivada da ESTRUTURA: coluna = distância do gatilho, linha = ordem dentro
 * da coluna.
 *
 * O que o layout NÃO toca: nó que a pessoa arrastou (`pinned`). Recolocar o
 * que alguém posicionou à mão seria desfazer trabalho a cada nova frase no
 * assistente.
 *
 * Módulo puro. Coberto por layout.test.ts.
 */

import type { FlowDefinition, FlowNode } from "./types";

const COLUNA = 300;
const LINHA = 150;
const MARGEM_X = 80;
const MARGEM_Y = 80;

/**
 * Distância de cada nó até o gatilho mais próximo (em saltos).
 *
 * Quem não é alcançável a partir de nenhum gatilho — nó solto que a pessoa
 * acabou de criar — fica na coluna 0, junto dos gatilhos, em vez de sumir.
 */
export function ranks(definition: FlowDefinition): Map<string, number> {
  const saidas = new Map<string, string[]>();
  for (const edge of definition.edges) {
    saidas.set(edge.source, [...(saidas.get(edge.source) ?? []), edge.target]);
  }
  const rank = new Map<string, number>();
  const raizes = definition.nodes.filter((node) => node.type === "trigger");
  const fila: Array<{ id: string; nivel: number }> = (raizes.length ? raizes : definition.nodes.slice(0, 1)).map(
    (node) => ({ id: node.id, nivel: 0 })
  );
  for (const inicio of fila) rank.set(inicio.id, 0);

  while (fila.length) {
    const atual = fila.shift();
    if (!atual) break;
    for (const destino of saidas.get(atual.id) ?? []) {
      const nivel = atual.nivel + 1;
      // `>` e não `>=`: com dois caminhos até o mesmo nó, vale o MAIS LONGO —
      // senão a junção ficaria à esquerda de quem a alimenta.
      if (!rank.has(destino) || (rank.get(destino) ?? 0) < nivel) {
        rank.set(destino, nivel);
        fila.push({ id: destino, nivel });
      }
    }
  }
  for (const node of definition.nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  return rank;
}

/** Recoloca os nós não fixados. Devolve uma definição nova. */
export function autoLayout(definition: FlowDefinition): FlowDefinition {
  if (!definition.nodes.length) return definition;
  const rank = ranks(definition);
  const porColuna = new Map<number, FlowNode[]>();
  for (const node of definition.nodes) {
    const coluna = rank.get(node.id) ?? 0;
    porColuna.set(coluna, [...(porColuna.get(coluna) ?? []), node]);
  }

  const posicoes = new Map<string, { x: number; y: number }>();
  for (const [coluna, nos] of porColuna) {
    const alturaTotal = (nos.length - 1) * LINHA;
    nos.forEach((node, indice) => {
      posicoes.set(node.id, {
        x: MARGEM_X + coluna * COLUNA,
        // Centraliza a coluna na vertical: uma condição com dois ramos fica
        // com a entrada no meio, e não colada no topo.
        y: MARGEM_Y + indice * LINHA - alturaTotal / 2 + 200
      });
    });
  }

  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.data.pinned ? node : { ...node, position: posicoes.get(node.id) ?? node.position }
    )
  };
}

/** Marca o nó como posicionado à mão — o layout automático passa a respeitá-lo. */
export function pin(definition: FlowDefinition, id: string, position: { x: number; y: number }): FlowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === id ? { ...node, position, data: { ...node.data, pinned: true } } : node
    )
  };
}
