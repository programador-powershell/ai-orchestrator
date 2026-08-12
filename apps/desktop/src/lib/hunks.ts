/**
 * hunks — fatia um diff em blocos aplicáveis de forma independente.
 * Reusa computeDiff (lib/diff) e acrescenta a âncora no texto base (aStart/aCount)
 * para que a aplicação parcial seja um splice determinístico, sem reprocessar diff.
 */
import { computeDiff, type DiffLine, type DiffOptions } from "./diff";

export interface Hunk {
  /** Identificador estável dentro do diff que o gerou (`h1`, `h2`, …). */
  id: string;
  /** Cabeçalho unified diff: `@@ -aStart,aCount +bStart,bCount @@`. */
  header: string;
  /** Linhas do bloco: contexto + adições + remoções, na ordem do diff. */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Primeira linha coberta no texto base (1-based); ponto de inserção quando aCount = 0. */
  aStart: number;
  /** Quantas linhas do texto base este hunk substitui. */
  aCount: number;
}

export interface HunkOptions extends DiffOptions {
  /** Linhas inalteradas mantidas ao redor de cada mudança. */
  context?: number;
}

const DEFAULT_CONTEXT = 3;

/** Divide o diff entre dois textos em hunks separados por trechos sem alteração. */
export function splitIntoHunks(before: string, after: string, options: HunkOptions = {}): Hunk[] {
  const context = Math.max(0, Math.trunc(options.context ?? DEFAULT_CONTEXT));
  const lines = computeDiff(before, after, options);

  // Janela de contexto ao redor de cada mudança; trechos contíguos viram um hunk.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].type === "context") continue;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  }

  const hunks: Hunk[] = [];
  let aConsumed = 0;
  let bConsumed = 0;
  let index = 0;
  while (index < lines.length) {
    if (!keep[index]) {
      if (lines[index].type !== "add") aConsumed += 1;
      if (lines[index].type !== "remove") bConsumed += 1;
      index += 1;
      continue;
    }
    const aStart = aConsumed + 1;
    const bStart = bConsumed + 1;
    const group: DiffLine[] = [];
    let aCount = 0;
    let bCount = 0;
    let added = 0;
    let removed = 0;
    while (index < lines.length && keep[index]) {
      const line = lines[index];
      group.push(line);
      if (line.type !== "add") {
        aCount += 1;
        aConsumed += 1;
      }
      if (line.type !== "remove") {
        bCount += 1;
        bConsumed += 1;
      }
      if (line.type === "add") added += 1;
      else if (line.type === "remove") removed += 1;
      index += 1;
    }
    hunks.push({
      id: `h${hunks.length + 1}`,
      header: `@@ -${aStart},${aCount} +${bStart},${bCount} @@`,
      lines: group,
      added,
      removed,
      aStart,
      aCount
    });
  }
  return hunks;
}

/** Texto que o hunk grava no lugar das linhas que ele cobre no base. */
function replacementOf(hunk: Hunk): string[] {
  return hunk.lines.filter((line) => line.type !== "remove").map((line) => line.text);
}

/**
 * Aplica apenas os hunks escolhidos sobre o texto base. Os hunks são aplicados
 * do fim para o começo para que os índices dos anteriores continuem válidos.
 * Ids desconhecidos ou repetidos são ignorados; seleção vazia devolve o base.
 */
export function applySelectedHunks(before: string, hunks: Hunk[], selectedIds: Iterable<string>): string {
  const selected = new Set(selectedIds);
  if (selected.size === 0) return before;
  const out = before.split("\n");
  const targets = hunks.filter((hunk) => selected.has(hunk.id)).sort((a, b) => b.aStart - a.aStart);
  for (const hunk of targets) {
    out.splice(hunk.aStart - 1, hunk.aCount, ...replacementOf(hunk));
  }
  return out.join("\n");
}
