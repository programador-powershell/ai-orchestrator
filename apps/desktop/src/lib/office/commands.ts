/**
 * Office Command Engine — a IA NUNCA edita o arquivo diretamente.
 *
 * O modelo emite uma OPERAÇÃO estruturada; este módulo valida, normaliza e só
 * então o adapter aplica. Isso dá segurança (nada fora do vocabulário roda),
 * previsibilidade, undo/redo e auditoria — nesta ordem de importância.
 */

export type OfficeFormat = "docx" | "xlsx" | "pptx" | "pdf" | "html" | "markdown" | "csv" | "text";

/** Alvo de uma operação: onde no documento ela age. */
export interface OfficeTarget {
  /** Tipo do elemento — o adapter traduz para o modelo do formato. */
  type: "heading" | "paragraph" | "text" | "range" | "sheet" | "slide" | "table" | "selection" | "element";
  /** Texto a localizar (replace_text), seletor CSS (html) ou referência A1 (xlsx). */
  ref?: string;
  /** Índice quando o alvo é posicional (slide 7, tabela 2). */
  index?: number;
}

export type OfficeAction =
  | "replace_text"
  | "insert_text"
  | "delete"
  | "set_cells"
  | "apply_formula"
  | "insert_table"
  | "insert_slide"
  | "apply_format"
  | "comment";

export interface OfficeCommand {
  action: OfficeAction;
  target: OfficeTarget;
  /** Valor da operação (texto novo, fórmula, matriz de células…). */
  value?: unknown;
  /** Descrição curta para o change log e para o preview. */
  label?: string;
}

export interface CommandValidation {
  ok: boolean;
  issues: string[];
  /** Comando normalizado (só quando ok). */
  command?: OfficeCommand;
}

const ACTIONS = new Set<OfficeAction>([
  "replace_text",
  "insert_text",
  "delete",
  "set_cells",
  "apply_formula",
  "insert_table",
  "insert_slide",
  "apply_format",
  "comment"
]);

const TARGET_TYPES = new Set<OfficeTarget["type"]>([
  "heading",
  "paragraph",
  "text",
  "range",
  "sheet",
  "slide",
  "table",
  "selection",
  "element"
]);

/** Ações permitidas por formato — evita "inserir slide" num .xlsx. */
const ALLOWED: Record<OfficeFormat, OfficeAction[]> = {
  docx: ["replace_text", "insert_text", "delete", "insert_table", "apply_format", "comment"],
  xlsx: ["set_cells", "apply_formula", "apply_format", "delete", "comment", "insert_table"],
  pptx: ["insert_slide", "replace_text", "insert_text", "delete", "apply_format", "comment"],
  pdf: ["comment"],
  html: ["replace_text", "insert_text", "delete", "apply_format", "insert_table"],
  markdown: ["replace_text", "insert_text", "delete", "insert_table"],
  csv: ["set_cells", "delete"],
  text: ["replace_text", "insert_text", "delete"]
};

/** true quando a ação faz sentido para o formato aberto. */
export function isActionAllowed(action: OfficeAction, format: OfficeFormat): boolean {
  return (ALLOWED[format] ?? []).includes(action);
}

/**
 * Valida e normaliza a operação emitida pelo modelo. Rejeita ação fora do
 * vocabulário, alvo inválido e ação incompatível com o formato aberto.
 */
export function validateCommand(input: unknown, format: OfficeFormat): CommandValidation {
  const issues: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, issues: ["comando não é um objeto"] };
  const raw = input as Partial<OfficeCommand>;

  if (typeof raw.action !== "string" || !ACTIONS.has(raw.action as OfficeAction)) {
    issues.push(`ação desconhecida: ${String(raw.action)}`);
  } else if (!isActionAllowed(raw.action as OfficeAction, format)) {
    issues.push(`ação "${raw.action}" não se aplica a ${format}`);
  }

  const target = raw.target;
  if (!target || typeof target !== "object") {
    issues.push("comando sem alvo (target)");
  } else if (!TARGET_TYPES.has(target.type)) {
    issues.push(`tipo de alvo inválido: ${String(target.type)}`);
  }

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    command: {
      action: raw.action as OfficeAction,
      target: {
        type: (target as OfficeTarget).type,
        ...((target as OfficeTarget).ref !== undefined ? { ref: String((target as OfficeTarget).ref) } : {}),
        ...(typeof (target as OfficeTarget).index === "number" ? { index: (target as OfficeTarget).index } : {})
      },
      ...(raw.value !== undefined ? { value: raw.value } : {}),
      label: raw.label?.trim() || describeCommand(raw.action as OfficeAction, target as OfficeTarget)
    }
  };
}

/** Descrição legível da operação — usada no preview e no change log. */
export function describeCommand(action: OfficeAction, target: OfficeTarget): string {
  const where = target.ref ? ` "${target.ref}"` : target.index !== undefined ? ` #${target.index + 1}` : "";
  const verbs: Record<OfficeAction, string> = {
    replace_text: "Substituir texto",
    insert_text: "Inserir texto",
    delete: "Remover",
    set_cells: "Alterar células",
    apply_formula: "Aplicar fórmula",
    insert_table: "Inserir tabela",
    insert_slide: "Inserir slide",
    apply_format: "Formatar",
    comment: "Comentar"
  };
  return `${verbs[action]} em ${target.type}${where}`.trim();
}

/** Extrai comandos de um bloco ```office``` emitido pelo modelo. */
export function parseCommands(text: string, format: OfficeFormat): { commands: OfficeCommand[]; issues: string[] } {
  const commands: OfficeCommand[] = [];
  const issues: string[] = [];
  for (const match of text.matchAll(/```office\s*([\s\S]*?)```/g)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        const validation = validateCommand(item, format);
        if (validation.ok && validation.command) commands.push(validation.command);
        else issues.push(...validation.issues);
      }
    } catch {
      issues.push("bloco office com JSON inválido");
    }
  }
  return { commands, issues };
}

export interface ChangePreview {
  /** Resumo por tipo: "+3 slides", "~12 textos". */
  lines: string[];
  total: number;
}

/** Prévia agregada das operações — o usuário aprova ANTES de aplicar. */
export function previewChanges(commands: OfficeCommand[]): ChangePreview {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const key = command.action;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const signs: Partial<Record<OfficeAction, string>> = {
    insert_slide: "+",
    insert_table: "+",
    insert_text: "+",
    delete: "−"
  };
  const nouns: Record<OfficeAction, string> = {
    replace_text: "texto(s)",
    insert_text: "inserção(ões)",
    delete: "remoção(ões)",
    set_cells: "célula(s)",
    apply_formula: "fórmula(s)",
    insert_table: "tabela(s)",
    insert_slide: "slide(s)",
    apply_format: "formatação(ões)",
    comment: "comentário(s)"
  };
  const lines = [...counts.entries()].map(
    ([action, count]) => `${signs[action as OfficeAction] ?? "~"} ${count} ${nouns[action as OfficeAction]}`
  );
  return { lines, total: commands.length };
}
