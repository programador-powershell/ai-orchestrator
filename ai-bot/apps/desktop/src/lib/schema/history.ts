/**
 * Histórico de desfazer/refazer do schema — pilha com teto de 50 estados.
 *
 * É o MESMO desenho de lib/canvas/history.ts, generalizado por tipo em vez de
 * importado: aquele módulo é tipado para CanvasDoc, e fazê-lo genérico exigiria
 * tocar num arquivo que pertence ao estúdio de Design (e a outra frente de
 * trabalho). Copiar o padrão custa menos que criar um acoplamento entre duas
 * superfícies que só coincidem na mecânica.
 *
 * Guardar o DOCUMENTO INTEIRO por estado (e não um diff) é deliberado: as
 * operações de schemaDoc.ts são imutáveis, então cada entrada da pilha
 * compartilha por referência as tabelas não alteradas — barato — e o undo é
 * uma troca de ponteiro impossível de corromper. O teto de 50 vem do
 * orquestrador (DataView.tsx, HISTORY_LIMIT).
 *
 * Não há variante coalescida aqui de propósito: no editor de schema os nomes
 * comprometem no blur/Enter (padrão do orquestrador), então cada edição já
 * nasce como UMA entrada — não existe o caso "uma tecla, um push" que obrigou
 * o canvas a agrupar digitação.
 */

export const HISTORY_LIMIT = 50;

export interface DocHistory<T> {
  /** Estados anteriores, do mais antigo (0) ao mais recente (fim). */
  past: readonly T[];
  /** Estados desfeitos; o fim do array é o próximo redo. */
  future: readonly T[];
}

export function createHistory<T>(): DocHistory<T> {
  return { past: [], future: [] };
}

export const canUndo = <T>(history: DocHistory<T>): boolean => history.past.length > 0;
export const canRedo = <T>(history: DocHistory<T>): boolean => history.future.length > 0;

/** Um passo de undo/redo: o histórico novo e o documento a exibir. */
export interface HistoryStep<T> {
  history: DocHistory<T>;
  doc: T;
}

/** Empilha respeitando o teto (o mais antigo cai primeiro). */
function pushCapped<T>(past: readonly T[], doc: T): T[] {
  const next = [...past, doc];
  if (next.length > HISTORY_LIMIT) next.shift();
  return next;
}

/**
 * Registra o estado ATUAL antes de uma edição — mesmo contrato do canvas e do
 * orquestrador: chama-se pushHistory e SÓ DEPOIS aplica a operação.
 *
 * Um push novo apaga o `future`: depois de desfazer e editar por outro
 * caminho, "refazer" restauraria um ramo que não existe mais — o padrão de
 * todo editor é descartar, não bifurcar.
 */
export function pushHistory<T>(history: DocHistory<T>, current: T): DocHistory<T> {
  return { past: pushCapped(history.past, current), future: [] };
}

/**
 * Desfaz: devolve o topo do `past` como documento e move o atual para o
 * `future`. null quando não há o que desfazer — a superfície desabilita o
 * botão com canUndo, mas o Ctrl+Z chega mesmo assim.
 */
export function undo<T>(history: DocHistory<T>, current: T): HistoryStep<T> | null {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [...history.future, current] },
    doc: previous
  };
}

/** Refaz o último undo — a contraparte simétrica; o teto vale aqui também. */
export function redo<T>(history: DocHistory<T>, current: T): HistoryStep<T> | null {
  const next = history.future[history.future.length - 1];
  if (next === undefined) return null;
  return {
    history: { past: pushCapped(history.past, current), future: history.future.slice(0, -1) },
    doc: next
  };
}
