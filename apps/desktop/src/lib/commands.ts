/**
 * Comandos de barra (slash commands) — prompts reutilizáveis expandidos antes
 * do envio ao motor. `/review foo` vira o prompt completo de revisão com o
 * argumento substituído. Lógica pura e testável; a UI só chama expandCommand.
 */

export interface SlashCommand {
  description: string;
  /** Template com $ARGS (todo o resto) ou variáveis nomeadas $NOME por posição. */
  template: string;
}

export type CommandCatalog = Record<string, SlashCommand>;

/** Comandos padrão embutidos — o usuário pode adicionar os seus nas Configurações. */
export const DEFAULT_COMMANDS: CommandCatalog = {
  review: {
    description: "Revisa o código colado e aponta problemas",
    template: "Revise o código a seguir e aponte bugs, riscos e melhorias, por severidade:\n\n$ARGS"
  },
  explain: {
    description: "Explica o que o código faz",
    template: "Explique de forma objetiva o que o código a seguir faz e por quê:\n\n$ARGS"
  },
  testgen: {
    description: "Gera testes para o código",
    template: "Gere testes unitários cobrindo casos felizes e de borda para:\n\n$ARGS"
  }
};

/** Nome do comando (sem a barra) quando a entrada é um comando; senão null. */
export function parseCommandName(input: string): string | null {
  const match = input.match(/^\/([a-zA-Z][\w-]*)/);
  return match ? match[1] : null;
}

const NAMED_VARIABLE = /\$([A-Z][A-Z0-9_]*)/g;

function fillNamedVariables(template: string, args: string[]): string {
  let index = 0;
  return template.replace(NAMED_VARIABLE, () => args[index++] ?? "");
}

/**
 * Expande `/comando args…` no prompt final. `$ARGS` recebe todo o texto após o
 * nome; variáveis nomeadas ($NOME) recebem os argumentos por posição. Retorna
 * null se a entrada não for um comando conhecido.
 */
export function expandCommand(input: string, catalog: CommandCatalog): string | null {
  const name = parseCommandName(input);
  if (!name) return null;
  // `catalog[name]` num objeto literal enxerga o protótipo: "/toString",
  // "/valueOf" e "/constructor" devolviam a função herdada, passavam pelo
  // `if (!command)` e estouravam TypeError no `.template` — antes do try do
  // envio, então a mensagem sumia sem erro nenhum na tela.
  const command = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!command || typeof command.template !== "string") return null;
  const rest = input.slice(name.length + 1).trim();
  if (command.template.includes("$ARGS")) {
    return command.template.replaceAll("$ARGS", rest);
  }
  return fillNamedVariables(command.template, rest.split(/\s+/).filter(Boolean));
}
