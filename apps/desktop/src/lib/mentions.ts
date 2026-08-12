/**
 * @-mentions de arquivo no composer — o usuário digita `@caminho` e o conteúdo
 * do arquivo entra no contexto, em vez de precisar colar na marra.
 *
 * Lógica pura: detecção do token em digitação, filtragem por relevância e
 * montagem do contexto. A leitura de disco fica com quem chama (fsx).
 */

export interface MentionQuery {
  /** Texto após o "@" até o cursor. */
  term: string;
  /** Índice do "@" no texto (para substituir ao completar). */
  start: number;
}

/**
 * Detecta se o cursor está dentro de uma menção em digitação. Só considera "@"
 * no início do texto ou precedido de espaço — e-mails e decorators não viram
 * menção por acidente.
 */
export function detectMention(text: string, cursor: number): MentionQuery | null {
  const upToCursor = text.slice(0, cursor);
  const at = upToCursor.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upToCursor[at - 1];
  if (before && !/\s/.test(before)) return null;
  const term = upToCursor.slice(at + 1);
  // Espaço encerra a menção — evita capturar a frase inteira depois do arquivo.
  if (/\s/.test(term)) return null;
  return { term, start: at };
}

/** Substitui a menção em digitação pelo caminho escolhido, com espaço ao final. */
export function applyMention(text: string, query: MentionQuery, path: string): { text: string; cursor: number } {
  const after = text.slice(query.start + 1 + query.term.length);
  const next = `${text.slice(0, query.start)}@${path} ${after.replace(/^\s+/, "")}`;
  return { text: next, cursor: query.start + path.length + 2 };
}

/** Pontua um caminho contra o termo (nome do arquivo pesa mais que a pasta). */
function score(path: string, term: string): number {
  const lowered = path.toLowerCase();
  const file = lowered.split("/").pop() ?? lowered;
  if (!term) return 0;
  if (file === term) return 100;
  if (file.startsWith(term)) return 80;
  if (file.includes(term)) return 60;
  if (lowered.includes(term)) return 30;
  return -1;
}

/** Melhores candidatos para o termo digitado (vazio = primeiros arquivos). */
export function rankMentions(paths: string[], term: string, limit = 8): string[] {
  const lowered = term.trim().toLowerCase();
  if (!lowered) return paths.slice(0, limit);
  return paths
    .map((path) => ({ path, points: score(path, lowered) }))
    .filter((item) => item.points >= 0)
    .sort((a, b) => b.points - a.points || a.path.length - b.path.length)
    .slice(0, limit)
    .map((item) => item.path);
}

/** Caminhos mencionados numa mensagem já escrita (para carregar o conteúdo). */
export function extractMentionedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([\w./\\-]+)/g)) {
    const path = match[1];
    // Precisa parecer arquivo (tem extensão ou barra) — evita capturar @alguem.
    if (/[./\\]/.test(path)) found.add(path);
  }
  return [...found];
}

const MAX_MENTION_CHARS = 20_000;

/** Monta a mensagem de sistema com o conteúdo dos arquivos mencionados. */
export function mentionContext(files: Array<{ path: string; content: string }>): string {
  return files
    .map((file) => {
      const body =
        file.content.length > MAX_MENTION_CHARS
          ? `${file.content.slice(0, MAX_MENTION_CHARS)}\n… (arquivo truncado)`
          : file.content;
      return `Arquivo mencionado pelo usuário — ${file.path}:\n\n${body}`;
    })
    .join("\n\n---\n\n");
}
