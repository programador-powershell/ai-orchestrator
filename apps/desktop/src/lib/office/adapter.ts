/**
 * Office Adapter — interface comum a todos os formatos.
 *
 * O agente NÃO sabe se está num .docx ou num .xlsx: ele chama getStructure()
 * e apply(command). Trocar o motor de edição (ONLYOFFICE, WOPI, nativo) não
 * muda o resto do Orchestrator — só a implementação de um adapter.
 */
import type { OfficeCommand, OfficeFormat } from "./commands";

/** Nó da estrutura do documento — o que a IA "enxerga" para decidir o alvo. */
export interface DocNode {
  type: "heading" | "paragraph" | "table" | "sheet" | "slide" | "element";
  /** Texto/rótulo do nó (título da seção, nome da aba, texto do slide). */
  text: string;
  /** Posição do nó no documento (índice do slide, linha da tabela). */
  index: number;
  children?: DocNode[];
}

export interface DocStructure {
  format: OfficeFormat;
  nodes: DocNode[];
}

/** Seleção atual do usuário — dá contexto ao chat ("essa tabela"). */
export interface DocSelection {
  /** Aba/slide/seção onde está a seleção. */
  scope?: string;
  /** Referência (A1 no xlsx, seletor no html, offset no texto). */
  ref?: string;
  /** Texto selecionado, quando aplicável. */
  text?: string;
}

export interface ApplyResult {
  ok: boolean;
  /** Conteúdo resultante (para o change log guardar o antes/depois). */
  content?: string;
  /** Quantos elementos foram tocados — alimenta o "14 células modificadas". */
  touched?: number;
  error?: string;
}

/** Contrato que todo adapter implementa. */
export interface OfficeAdapter {
  readonly format: OfficeFormat;
  /** Conteúdo atual serializado (texto, markdown, html, csv…). */
  read(): string;
  /** Estrutura navegável para a IA escolher alvos. */
  getStructure(): DocStructure;
  /** Aplica UMA operação já validada pelo Command Engine. */
  apply(command: OfficeCommand): ApplyResult;
  /** Seleção corrente (definida pela UI). */
  getSelection(): DocSelection;
  setSelection(selection: DocSelection): void;
}

/**
 * Adapter de texto puro / markdown / csv / html — funciona sem dependência
 * externa e serve de base para os formatos Office (que trocam só o motor).
 */
export class TextAdapter implements OfficeAdapter {
  private content: string;
  private selection: DocSelection = {};

  constructor(
    readonly format: OfficeFormat,
    initial: string
  ) {
    this.content = initial;
  }

  read(): string {
    return this.content;
  }

  getSelection(): DocSelection {
    return this.selection;
  }

  setSelection(selection: DocSelection): void {
    this.selection = selection;
  }

  getStructure(): DocStructure {
    const nodes: DocNode[] = [];
    const lines = this.content.split("\n");
    for (const [index, line] of lines.entries()) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        nodes.push({ type: "heading", text: heading[2].trim(), index });
        continue;
      }
      if (line.trim()) nodes.push({ type: "paragraph", text: line.trim(), index });
    }
    return { format: this.format, nodes };
  }

  apply(command: OfficeCommand): ApplyResult {
    const before = this.content;
    switch (command.action) {
      case "replace_text": {
        const needle = command.target.ref ?? this.selection.text ?? "";
        const value = typeof command.value === "string" ? command.value : "";
        if (!needle) {
          // Sem alvo textual: troca o primeiro heading (caso "troque o título").
          const replaced = before.replace(/^(#{1,6}\s+).*/m, `$1${value}`);
          if (replaced === before) return { ok: false, error: "nenhum título encontrado para substituir" };
          this.content = replaced;
          return { ok: true, content: replaced, touched: 1 };
        }
        if (!before.includes(needle)) return { ok: false, error: `texto não encontrado: "${needle}"` };
        const occurrences = before.split(needle).length - 1;
        this.content = before.split(needle).join(value);
        return { ok: true, content: this.content, touched: occurrences };
      }
      case "insert_text": {
        const value = typeof command.value === "string" ? command.value : "";
        if (!value) return { ok: false, error: "insert_text sem valor" };
        this.content = before ? `${before}\n${value}` : value;
        return { ok: true, content: this.content, touched: 1 };
      }
      case "delete": {
        const needle = command.target.ref ?? this.selection.text ?? "";
        if (!needle) return { ok: false, error: "delete exige alvo" };
        if (!before.includes(needle)) return { ok: false, error: `texto não encontrado: "${needle}"` };
        const occurrences = before.split(needle).length - 1;
        this.content = before.split(needle).join("");
        return { ok: true, content: this.content, touched: occurrences };
      }
      default:
        return { ok: false, error: `ação não suportada neste formato: ${command.action}` };
    }
  }
}

/** Formato deduzido da extensão — define o adapter e as ações permitidas. */
export function formatFromPath(path: string): OfficeFormat {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, OfficeFormat> = {
    docx: "docx",
    xlsx: "xlsx",
    xls: "xlsx",
    pptx: "pptx",
    pdf: "pdf",
    html: "html",
    htm: "html",
    md: "markdown",
    markdown: "markdown",
    csv: "csv"
  };
  return map[ext] ?? "text";
}
