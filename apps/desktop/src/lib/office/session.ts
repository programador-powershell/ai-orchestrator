/**
 * Sessão do Office — o documento aberto, a seleção e o histórico.
 *
 * Vive fora da view para o Composer poder injetar o CONTEXTO do arquivo no
 * pedido ao modelo ("arquivo X, seleção B12:F24") sem importar a UI.
 */
import { create } from "zustand";
import type { DocSelection } from "./adapter";
import { TextAdapter } from "./adapter";
import type { OfficeCommand, OfficeFormat } from "./commands";
import { emptyChangeLog, recordChange, type ChangeLogState } from "./changeLog";

export interface OfficeSession {
  root: string;
  files: string[];
  path: string;
  content: string;
  /** true quando o conteudo veio de extracao OOXML (leitura, nao edicao). */
  extracted: boolean;
  format: OfficeFormat;
  selection: DocSelection;
  log: ChangeLogState;
  /** Operações aguardando aprovação (alterações grandes). */
  pending: OfficeCommand[] | null;
  setRoot: (root: string) => void;
}

const ROOT_KEY = "office.root";

export const useOffice = create<OfficeSession>()((set) => ({
  root: typeof localStorage === "undefined" ? "" : (localStorage.getItem(ROOT_KEY) ?? ""),
  files: [],
  path: "",
  content: "",
  extracted: false,
  format: "text",
  selection: {},
  log: emptyChangeLog(),
  pending: null,
  setRoot: (root) => {
    try {
      localStorage.setItem(ROOT_KEY, root);
    } catch {
      // storage indisponível: segue em memória
    }
    set({ root, files: [] });
  }
}));

/**
 * Aplica as operações no adapter e registra cada uma no change log.
 * Retorna quantas valeram e quantos elementos foram tocados (para o status).
 */
export function applyOfficeCommands(commands: OfficeCommand[]): { applied: number; touched: number } {
  const state = useOffice.getState();
  /**
   * Texto EXTRAÍDO de binário é leitura, não edição.
   *
   * Num .docx aberto pelo extrator, o adapter mudava o texto em memória, o
   * change log registrava a alteração e a tela dizia "1 operação aplicada" —
   * mas o `save()` recusa formato não editável e o binário no disco nunca
   * mudava. A pessoa saía acreditando que o documento tinha sido editado e
   * perdia o trabalho ao reabrir. Quem edita binário é o painel de
   * substituição (que reescreve o OOXML de verdade).
   */
  if (state.extracted) return { applied: 0, touched: 0 };
  const adapter = new TextAdapter(state.format, state.content);
  adapter.setSelection(state.selection);
  let log = state.log;
  let applied = 0;
  let touched = 0;
  for (const command of commands) {
    const before = adapter.read();
    const result = adapter.apply(command);
    if (!result.ok) continue;
    applied += 1;
    touched += result.touched ?? 1;
    log = recordChange(log, {
      author: "ai",
      label: command.label ?? command.action,
      command,
      before,
      after: adapter.read()
    });
  }
  useOffice.setState({ content: adapter.read(), log, pending: null });
  return { applied, touched };
}

/** Contexto do documento aberto para o modelo — o "chat sabe o arquivo". */
export function officeContextMessage(): string | null {
  const { path, format, selection, content } = useOffice.getState();
  if (!path) return null;
  const structure = new TextAdapter(format, content).getStructure();
  const outline = structure.nodes
    .slice(0, 40)
    .map((node) => `${node.type === "heading" ? "#" : "-"} ${node.text.slice(0, 80)}`)
    .join("\n");
  return [
    `Documento aberto: ${path} (${format}).`,
    selection.text ? `Seleção atual do usuário: "${selection.text.slice(0, 200)}"` : "Sem seleção ativa.",
    "",
    "Estrutura:",
    outline || "(vazio)",
    "",
    "Para ALTERAR o documento, você NÃO escreve o arquivo: emita um bloco ```office``` com um array JSON",
    'de operações. Ex.: [{"action":"replace_text","target":{"type":"heading"},"value":"Novo título"}].',
    "Ações: replace_text, insert_text, delete (target.ref = texto a localizar; sem ref usa a seleção).",
    "Se o pedido for só uma dúvida, responda em texto normal, sem bloco office."
  ].join("\n");
}
