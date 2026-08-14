/**
 * A regra das ligações do ERD, sem DOM.
 *
 * Mora fora do componente porque é a parte que erra em silêncio: um id de alça
 * lido errado liga o campo errado, e uma escolha de lado errada faz a linha
 * dar a volta por fora do cartão. As duas coisas passam despercebidas numa
 * inspeção visual rápida e são triviais de cobrir com teste.
 */

import type { SchemaTable } from "@multiplike/contracts";

/** Sufixo da alça da TABELA — ligar por aqui deixa o campo para a soltura. */
export const SUFIXO_TABELA = "tbl";

export type PapelDaAlca = "s" | "t";
export type LadoDaAlca = "l" | "r";

/**
 * Id de uma alça: papel (`s`aída / `t`arget), lado (`l`eft / `r`ight) e campo.
 * Ex.: `sr3` = saída pela direita do campo 3; `tl-tbl` = entrada pela esquerda
 * no cabeçalho.
 */
export function alca(papel: PapelDaAlca, lado: LadoDaAlca, campo: number | "tbl"): string {
  return `${papel}${lado}${campo === "tbl" ? `-${SUFIXO_TABELA}` : campo}`;
}

/** Índice do campo pelo id da alça; `null` quando a alça é a do cabeçalho. */
export function campoDaAlca(handle: string | null | undefined): number | null {
  if (!handle || handle.length < 3) return null;
  const resto = handle.slice(2);
  if (resto === `-${SUFIXO_TABELA}`) return null;
  // `Number("")` é 0 e `Number(" 1")` é 1: os dois passariam por um teste
  // ingênuo de inteiro e apontariam para um campo que ninguém escolheu.
  if (!/^\d+$/.test(resto)) return null;
  return Number(resto);
}

/**
 * De que lado cada ponta sai.
 *
 * A linha aponta para o alvo: com a saída fixa na direita, toda relação com o
 * destino à esquerda contornava o cartão inteiro antes de chegar.
 */
export function ladosDaLigacao(origemX: number, destinoX: number): { origem: LadoDaAlca; destino: LadoDaAlca } {
  return origemX <= destinoX ? { origem: "r", destino: "l" } : { origem: "l", destino: "r" };
}

/** Primeira coluna que não é chave — o candidato natural a virar FK. */
export function indiceDeFkProvavel(table: SchemaTable): number {
  const indice = table.fields.findIndex((field) => !field.primaryKey);
  return indice >= 0 ? indice : 0;
}

/** Chave primária do alvo; sem PK declarada, a primeira coluna. */
export function indiceDaChave(table: SchemaTable): number {
  const indice = table.fields.findIndex((field) => field.primaryKey);
  return indice >= 0 ? indice : 0;
}

export interface ParDaLigacao {
  campoOrigem: number;
  campoDestino: number;
}

/**
 * Resolve a ligação em par de campos.
 *
 * Puxar do CABEÇALHO não escolhe campo nenhum, e é o gesto mais natural de
 * "liga esta tabela naquela": a origem vira a primeira coluna que ainda não é
 * chave e o destino, a chave primária do alvo — a convenção das ferramentas de
 * ERD. Quem quiser outro par arrasta do campo.
 */
export function resolverLigacao(
  origem: SchemaTable,
  destino: SchemaTable,
  alcaOrigem: string | null | undefined,
  alcaDestino: string | null | undefined
): ParDaLigacao | null {
  if (!origem.fields.length || !destino.fields.length) return null;
  // Auto-referência por arrasto quase sempre é o gesto escapando, e desfazer
  // sairia mais caro do que não fazer.
  if (origem.id === destino.id) return null;
  const campoOrigem = campoDaAlca(alcaOrigem) ?? indiceDeFkProvavel(origem);
  const campoDestino = campoDaAlca(alcaDestino) ?? indiceDaChave(destino);
  if (campoOrigem >= origem.fields.length || campoDestino >= destino.fields.length) return null;
  return { campoOrigem, campoDestino };
}
