/**
 * Histórico de desfazer/refazer do canvas — pilha com teto de 50 estados.
 *
 * No AI-Orchestrator a pilha vivia como variável de módulo ao lado do store
 * (modes/DesignView.tsx: pushHistory/undo), porque rail e view compartilhavam
 * o mesmo singleton. Aqui ela vira ESTRUTURA PURA: quem decide onde o
 * histórico mora é a superfície (o store do AI-BOT tem shape próprio), e uma
 * variável de módulo não é testável nem sobrevive a duas instâncias.
 *
 * Guardar o DOCUMENTO INTEIRO por estado (e não um diff) é deliberado: as
 * operações do canvasDoc são imutáveis, então cada entrada da pilha é só uma
 * referência compartilhando os nós não alterados — barato — e o undo vira
 * uma troca de ponteiro impossível de corromper. O teto de 50 vem do
 * orquestrador: segura ~1 min de edição intensa sem deixar um doc grande
 * multiplicar memória sem limite.
 */
import type { CanvasDoc } from "./canvasDoc";

export const HISTORY_LIMIT = 50;

/**
 * Janela de coalescência das edições digitadas (mesmo valor do orquestrador).
 * Sem ela, digitar "320" no Inspect gera três entradas — e desfazer vira
 * apertar Ctrl+Z uma vez por tecla.
 */
export const COALESCE_WINDOW_MS = 800;

export interface DocHistory {
  /** Estados anteriores, do mais antigo (0) ao mais recente (fim). */
  past: readonly CanvasDoc[];
  /** Estados desfeitos; o fim do array é o próximo redo. */
  future: readonly CanvasDoc[];
  /** Quando foi o último push — a coalescência lê daqui. */
  lastPushAt: number;
}

export function createHistory(): DocHistory {
  return { past: [], future: [], lastPushAt: 0 };
}

export const canUndo = (history: DocHistory): boolean => history.past.length > 0;
export const canRedo = (history: DocHistory): boolean => history.future.length > 0;

/** Um passo de undo/redo: o histórico novo e o documento a exibir. */
export interface HistoryStep {
  history: DocHistory;
  doc: CanvasDoc;
}

/** Empilha respeitando o teto (o mais antigo cai primeiro). */
function pushCapped(past: readonly CanvasDoc[], doc: CanvasDoc): CanvasDoc[] {
  const next = [...past, doc];
  if (next.length > HISTORY_LIMIT) next.shift();
  return next;
}

/**
 * Registra o estado ATUAL antes de uma edição — mesmo contrato do
 * orquestrador: chama-se pushHistory e SÓ DEPOIS aplica a operação.
 *
 * Um push novo apaga o `future`: depois de desfazer e editar por outro
 * caminho, "refazer" restauraria um ramo que não existe mais — o padrão de
 * todo editor é descartar, não bifurcar.
 *
 * `now` é parâmetro (com default) para a coalescência ser testável sem
 * relógio de verdade.
 */
export function pushHistory(history: DocHistory, current: CanvasDoc, now: number = Date.now()): DocHistory {
  // lastPushAt ZERADO de propósito: só a variante coalescida arma a janela.
  // Se o push comum armasse, uma tecla no Inspect até 800ms depois de um
  // arrasto seria engolida pela entrada do arrasto — e um único Ctrl+Z
  // desfaria as DUAS edições de uma vez.
  void now;
  return { past: pushCapped(history.past, current), future: [], lastPushAt: 0 };
}

/**
 * Igual a pushHistory, mas agrupa edições em sequência (digitação no
 * Inspect): dentro da janela o push é ignorado e a entrada anterior — que já
 * guarda o estado de antes da primeira tecla — segue valendo.
 */
export function pushHistoryCoalesced(
  history: DocHistory,
  current: CanvasDoc,
  now: number = Date.now()
): DocHistory {
  // A janela só considera pushes COALESCIDOS anteriores (lastPushAt vem só
  // daqui): um arrasto ou stencil imediatamente antes não engole a primeira
  // tecla do Inspect — cada tipo de edição desfaz por si.
  if (history.lastPushAt !== 0 && now - history.lastPushAt < COALESCE_WINDOW_MS) return history;
  return { past: pushCapped(history.past, current), future: [], lastPushAt: now };
}

/**
 * Desfaz: devolve o topo do `past` como documento e move o atual para o
 * `future`. null quando não há o que desfazer — a superfície desabilita o
 * botão com canUndo, mas o Ctrl+Z chega mesmo assim.
 *
 * `lastPushAt` zera de propósito: a primeira edição depois de um undo NÃO
 * pode ser engolida pela coalescência, senão ela fica sem entrada própria e
 * o próximo undo pula um passo.
 */
export function undo(history: DocHistory, current: CanvasDoc): HistoryStep | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
      lastPushAt: 0
    },
    doc: previous
  };
}

/** Refaz o último undo — a contraparte simétrica; o teto vale aqui também. */
export function redo(history: DocHistory, current: CanvasDoc): HistoryStep | null {
  const next = history.future[history.future.length - 1];
  if (!next) return null;
  return {
    history: {
      past: pushCapped(history.past, current),
      future: history.future.slice(0, -1),
      lastPushAt: 0
    },
    doc: next
  };
}
