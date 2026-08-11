/**
 * diff — diff textual linha a linha, puro e determinístico.
 * Estratégia: apara prefixo/sufixo comuns e aplica LCS (programação dinâmica,
 * equivalente ao Myers simplificado) no miolo. Para miolos gigantes acima de
 * `maxArea` usa fallback linear (tudo remove + tudo add) para não travar a UI.
 */

export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Número da linha no texto original (presente em context/remove). */
  aLine?: number;
  /** Número da linha no texto novo (presente em context/add). */
  bLine?: number;
}

/** Linha de hunk: linha do diff ou marcador de trecho de contexto colapsado. */
export type DiffHunkPart = DiffLine | { type: "skip"; count: number };

export interface DiffOptions {
  /** Área máxima (linhas A × linhas B) do miolo para o LCS exato. */
  maxArea?: number;
}

const DEFAULT_MAX_AREA = 2_000_000;

/** Diff linha a linha entre dois textos. Textos idênticos → só context. */
export function computeDiff(aText: string, bText: string, options: DiffOptions = {}): DiffLine[] {
  const maxArea = options.maxArea ?? DEFAULT_MAX_AREA;
  const a = aText.split("\n");
  const b = bText.split("\n");

  // Prefixo comum.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  // Sufixo comum (sem invadir o prefixo).
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) {
    out.push({ type: "context", text: a[i], aLine: i + 1, bLine: i + 1 });
  }

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= maxArea) {
    // LCS por DP: dp[i][j] = tamanho do LCS de midA[i..] × midB[j..].
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          a[start + i] === b[start + j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ type: "context", text: a[start + i], aLine: start + i + 1, bLine: start + j + 1 });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        out.push({ type: "remove", text: a[start + i], aLine: start + i + 1 });
        i += 1;
      } else {
        out.push({ type: "add", text: b[start + j], bLine: start + j + 1 });
        j += 1;
      }
    }
    while (i < n) {
      out.push({ type: "remove", text: a[start + i], aLine: start + i + 1 });
      i += 1;
    }
    while (j < m) {
      out.push({ type: "add", text: b[start + j], bLine: start + j + 1 });
      j += 1;
    }
  } else {
    // Miolo só de um lado, ou grande demais → substituição em bloco.
    for (let i = start; i < endA; i += 1) out.push({ type: "remove", text: a[i], aLine: i + 1 });
    for (let j = start; j < endB; j += 1) out.push({ type: "add", text: b[j], bLine: j + 1 });
  }

  for (let k = 0; k < a.length - endA; k += 1) {
    out.push({ type: "context", text: a[endA + k], aLine: endA + k + 1, bLine: endB + k + 1 });
  }
  return out;
}

/** Contagem de linhas adicionadas/removidas de um diff. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added += 1;
    else if (line.type === "remove") removed += 1;
  }
  return { added, removed };
}

/**
 * Colapsa trechos longos de contexto, mantendo `context` linhas ao redor de
 * cada mudança. Trechos ocultos viram { type: "skip", count }.
 */
export function toHunks(lines: DiffLine[], context = 2): DiffHunkPart[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].type === "context") continue;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  }
  const out: DiffHunkPart[] = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      if (skipped) {
        out.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      out.push(lines[index]);
    } else {
      skipped += 1;
    }
  }
  if (skipped) out.push({ type: "skip", count: skipped });
  return out;
}
