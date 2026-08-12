/**
 * Execução concorrente com teto — usado pelo executor do DAG.
 *
 * Nós da MESMA onda topológica não dependem entre si (é a definição de onda),
 * então podem rodar em paralelo. Antes o executor rodava tudo em série mesmo
 * tendo calculado as ondas, e o `maxConcurrency` do documento era decorativo.
 */

/**
 * Roda as tarefas com no máximo `limit` em voo, preservando a ORDEM dos
 * resultados. Uma tarefa que rejeita não derruba as outras: o erro vem no
 * lugar dela, para o chamador decidir (o executor marca o nó como falho).
 */
export async function runWithLimit<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(tasks.length);
  // Teto < 1 seria travamento: nenhuma tarefa iniciaria.
  const ceiling = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: ceiling }, worker));
  return results;
}

/** Quantas tarefas rodariam de fato em paralelo, dado o teto. */
export function effectiveConcurrency(taskCount: number, limit: number): number {
  if (taskCount <= 0) return 0;
  return Math.max(1, Math.min(Math.floor(limit) || 1, taskCount));
}
