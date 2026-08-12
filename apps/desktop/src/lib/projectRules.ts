/**
 * Regras por projeto — lê o arquivo de convenções que o repositório já usa
 * (AGENTS.md, CLAUDE.md, .cursorrules, instruções do Copilot) e o transforma
 * numa mensagem de sistema. São regras do PROJETO: valem mais que as
 * preferências gerais do usuário.
 *
 * A leitura entra por injeção (mesma assinatura de `fsRead` do fsx), então a
 * lógica é pura e testável sem tocar no disco.
 */
import type { ChatMessage } from "./gateway";

export interface ProjectRules {
  /** Caminho relativo do arquivo encontrado (ex.: "AGENTS.md"). */
  source: string;
  content: string;
}

/** Assinatura compatível com `fsRead(root, path)` do fsx. */
export type ProjectFileReader = (root: string, path: string) => Promise<string>;

/** Ordem de precedência: o primeiro que existir vence. */
export const RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md"
] as const;

/** Teto de caracteres enviado ao modelo (o excedente é cortado com aviso). */
export const RULES_MAX_CHARS = 8000;

/** Corta o excesso preservando o início e deixando explícito que houve corte. */
export function truncateRules(content: string, limit = RULES_MAX_CHARS): string {
  if (content.length <= limit) return content;
  return (
    `${content.slice(0, limit)}\n\n` +
    `[... regras truncadas: o arquivo tem ${content.length} caracteres e só os ${limit} primeiros foram enviados ...]`
  );
}

/**
 * Procura o arquivo de regras do projeto na ordem de precedência.
 * Arquivo ausente (leitura falha) ou em branco é ignorado.
 */
export async function loadProjectRules(
  root: string,
  read: ProjectFileReader
): Promise<ProjectRules | null> {
  for (const source of RULE_FILES) {
    const content = await read(root, source).catch(() => "");
    if (!content.trim()) continue;
    return { source, content: truncateRules(content) };
  }
  return null;
}

/** Regras do projeto como mensagem de sistema, acima das preferências gerais. */
export function rulesSystemMessage(rules: ProjectRules): ChatMessage {
  return {
    role: "system",
    content:
      `Regras deste PROJETO, declaradas em ${rules.source}. Elas têm precedência sobre ` +
      "preferências gerais e sobre seus padrões: em caso de conflito, siga o projeto e " +
      "avise o usuário da divergência.\n\n" +
      `--- ${rules.source} ---\n${rules.content}\n--- fim das regras ---`
  };
}
