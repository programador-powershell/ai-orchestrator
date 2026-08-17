/**
 * Diagnostics pós-edição — depois que o agente grava um arquivo de código,
 * roda o check da linguagem e devolve os erros na conversa, fechando o ciclo
 * editar → verificar → corrigir sem sair do chat. O mapeamento extensão→comando
 * é puro e testável; a execução usa o terminal do projeto.
 */
export interface DiagnosticResult {
  ok: boolean;
  output: string;
}

/**
 * O terminal roda via `cmd /S /C`, que engole aspas: caminho citado chega com
 * as aspas LITERAIS no nome do arquivo e o check falha sempre. Por isso o
 * caminho vai sem aspas — e caminhos com espaço ou metacaractere de shell não
 * ganham diagnóstico (evita comando quebrado e injeção pelo nome do arquivo).
 */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./\\-]+$/;

/** Comando de verificação para o arquivo, ou null quando não há diagnóstico. */
export function diagnosticCommand(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (path.lastIndexOf(".") < 0) return null;
  const fileScoped = SHELL_SAFE_PATH.test(path);
  switch (ext) {
    case "ts":
    case "tsx":
      // Type-check do pacote desktop (o tsconfig cobre app/ e src/).
      return "corepack pnpm --filter @ai-bot/desktop -s check";
    case "rs":
      return "cargo check --manifest-path services/gateway/Cargo.toml";
    case "py":
      return fileScoped ? `python -m py_compile ${path}` : null;
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return fileScoped ? `node --check ${path}` : null;
    default:
      return null;
  }
}

/** Formata o diagnóstico para a conversa (e para o modelo continuar). */
export function formatDiagnostics(path: string, result: DiagnosticResult): string {
  if (result.ok) return `✓ Diagnóstico de \`${path}\`: sem erros.`;
  const body = result.output.length > 1500 ? `${result.output.slice(0, 1500)}\n… (truncado)` : result.output;
  return `✗ Diagnóstico de \`${path}\` encontrou problemas:\n\`\`\`console\n${body}\n\`\`\``;
}
