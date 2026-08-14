/**
 * Histórico de comandos do terminal da aba Code (↑ / ↓).
 *
 * O prompt não tinha histórico: repetir o comando anterior exigia digitar tudo
 * de novo, e num terminal isso é a operação mais frequente que existe. Estado
 * imutável para o React comparar por referência; módulo puro, testável sem
 * montar componente.
 */

export interface TermHistory {
  /** Do mais antigo para o mais recente. */
  entries: readonly string[];
  /**
   * Posição sendo lida. `cursor === entries.length` significa "editando uma
   * linha nova", que é o estado de repouso — é por isso que o ↓ no fim
   * esvazia a linha em vez de dar a volta.
   */
  cursor: number;
}

/** Teto do histórico — o mesmo motivo do teto do scrollback. */
export const MAX_HISTORY = 200;

export const emptyHistory: TermHistory = { entries: [], cursor: 0 };

/** Registra um comando executado e volta ao repouso (cursor no fim). */
export function remember(history: TermHistory, command: string): TermHistory {
  const limpo = command.trim();
  if (!limpo) return { ...history, cursor: history.entries.length };
  // Repetir o mesmo comando cinco vezes não deve exigir cinco ↑ para passar
  // dele — só a repetição IMEDIATA é descartada, o histórico não é um Set.
  if (history.entries.at(-1) === limpo) {
    return { entries: history.entries, cursor: history.entries.length };
  }
  const entries = [...history.entries, limpo];
  const cortado = entries.length > MAX_HISTORY ? entries.slice(entries.length - MAX_HISTORY) : entries;
  return { entries: cortado, cursor: cortado.length };
}

/**
 * ↑ — comando anterior. `value: null` significa "não há nada a recuperar",
 * e quem chama deve deixar o que está digitado em paz.
 */
export function recallPrev(history: TermHistory): { history: TermHistory; value: string | null } {
  if (!history.entries.length) return { history, value: null };
  const cursor = Math.max(0, history.cursor - 1);
  return { history: { ...history, cursor }, value: history.entries[cursor] ?? null };
}

/** ↓ — comando seguinte; passando do último, devolve a linha em branco. */
export function recallNext(history: TermHistory): { history: TermHistory; value: string | null } {
  if (history.cursor >= history.entries.length) return { history, value: null };
  const cursor = history.cursor + 1;
  return {
    history: { ...history, cursor },
    value: cursor >= history.entries.length ? "" : history.entries[cursor]
  };
}
