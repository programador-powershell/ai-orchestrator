/**
 * Scrollback do terminal da aba Code — linhas TIPADAS.
 *
 * Antes o scrollback era `string[]`: comando, caminho, stdout, stderr, resposta
 * do agente e o rodapé `[exit …]` saíam todos na mesma cor. Não havia como
 * varrer a tela procurando onde o comando começou nem se ele falhou — e
 * `[exit 1]` era visualmente idêntico a `[exit 0]`.
 *
 * Cada linha passa a declarar O QUE ELA É; a cor vem de um token semântico do
 * tema (`--term-*`), na mesma divisão de papéis do TUI de referência
 * (ver docs/creditos-inspiracao.md). Módulo puro: sem DOM, sem rede.
 */

/**
 * Papel da linha no scrollback. É o que decide a cor — não o conteúdo.
 *
 * - `note` texto do app (banner, dica, aviso de modo demonstração)
 * - `command` o eco do que foi digitado (`$ pnpm test`)
 * - `output` stdout
 * - `stderr` stderr — separado de `output` porque a ferramenta os separa
 * - `error` falha do app (exceção, runtime ausente, comando recusado)
 * - `warning` pede conferência antes de seguir (prévia de código colado)
 * - `success` confirmação (`[exit 0 …]`)
 * - `path` caminho de arquivo
 * - `tool` ação de ferramenta do app (`↳ ultra: python → …`)
 * - `agent` resposta do modelo
 * - `meta` rodapé neutro (duração sem código de saída, `^C`)
 * - `paste` prévia do que foi colado e AINDA NÃO executado
 */
export type TermKind =
  | "note"
  | "command"
  | "output"
  | "stderr"
  | "error"
  | "warning"
  | "success"
  | "path"
  | "tool"
  | "agent"
  | "meta"
  | "paste";

export interface TermLine {
  kind: TermKind;
  text: string;
}

/**
 * Teto do scrollback.
 *
 * O array crescia sem limite: um `cat` de arquivo grande, um build verboso ou
 * uma sessão longa faziam o React reconciliar dezenas de milhares de `<span>`
 * a cada linha nova, e a aba ia ficando lenta até travar. Terminal de verdade
 * também tem teto de scrollback — este é o nosso.
 */
export const MAX_TERM_LINES = 2_000;

export function line(kind: TermKind, text: string): TermLine {
  return { kind, text };
}

/**
 * Quebra a saída de um comando em uma linha por entrada.
 *
 * Empurrar o blob inteiro como UMA entrada fazia a animação de entrada valer
 * para o bloco todo e impedia colorir linha a linha. O `\n` final que todo
 * shell emite é descartado (senão cada comando abriria um buraco no
 * scrollback), mas linha vazia no MEIO é separador de parágrafo da ferramenta
 * e fica.
 */
export function splitOutput(raw: string, kind: TermKind): TermLine[] {
  if (!raw) return [];
  const normalizado = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!normalizado) return [];
  return normalizado.split("\n").map((text) => line(kind, text));
}

/** Rodapé de execução: verde quando passou, vermelho quando não. */
export function exitLine(exitCode: number | undefined, durationMs: number): TermLine {
  if (exitCode === undefined) return line("meta", `[exit n/a · ${durationMs} ms]`);
  return line(exitCode === 0 ? "success" : "error", `[exit ${exitCode} · ${durationMs} ms]`);
}

/** Acrescenta ao scrollback respeitando o teto (mantém sempre a cauda). */
export function pushLines(current: readonly TermLine[], incoming: readonly TermLine[]): TermLine[] {
  const juntos = [...current, ...incoming];
  return juntos.length > MAX_TERM_LINES ? juntos.slice(juntos.length - MAX_TERM_LINES) : juntos;
}
