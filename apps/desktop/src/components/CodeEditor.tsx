/**
 * CodeEditor — wrapper React do CodeMirror 6 com tema transparente que herda o
 * liquid glass da superfície. A view é recriada quando o arquivo muda
 * (fileName); mudanças externas de valor são aplicadas via dispatch para não
 * recriar o histórico do documento ativo.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";

/** API imperativa mínima para a view (seleção e navegação por linha). */
export interface CodeEditorApi {
  /** Seleção atual (from/to em offsets do documento + texto). */
  getSelection: () => { from: number; to: number; text: string };
  /** Move o cursor para a linha (1-based), centraliza e foca o editor. */
  revealLine: (line: number) => void;
}

export interface CodeEditorProps {
  value: string;
  fileName: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Recebe a API imperativa enquanto a view existir (null ao desmontar). */
  apiRef?: MutableRefObject<CodeEditorApi | null>;
}

/** Extensão de linguagem escolhida pela extensão do arquivo. */
function languageFor(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "py":
      return python();
    case "rs":
      return rust();
    case "sql":
      return sql();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    case "md":
    case "markdown":
      return markdown();
    default:
      return [];
  }
}

/** Tema mínimo: fundo transparente (herda o glass), seleção no acento da aba. */
const glassTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
    fontSize: "var(--fs-small)"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--faint)",
    border: "none",
    fontSize: "var(--fs-micro)"
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent-strong)" },
  ".cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "none"
  }
});

export function CodeEditor({ value, fileName, onChange, readOnly = false, apiRef }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  // Recria a view quando o arquivo muda (linguagem e histórico novos).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      doc: valueRef.current,
      parent: host,
      extensions: [
        basicSetup,
        languageFor(fileName),
        glassTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        })
      ]
    });
    viewRef.current = view;
    if (apiRef) {
      apiRef.current = {
        getSelection: () => {
          const range = view.state.selection.main;
          return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
        },
        revealLine: (line) => {
          const doc = view.state.doc;
          const clamped = Math.min(Math.max(1, Math.trunc(line)), doc.lines);
          const pos = doc.line(clamped).from;
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "center" })
          });
          view.focus();
        }
      };
    }
    return () => {
      view.destroy();
      viewRef.current = null;
      if (apiRef) apiRef.current = null;
    };
  }, [fileName, readOnly, apiRef]);

  // Sincroniza valor vindo de fora (ex.: leitura assíncrona do arquivo).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="codex-editor-host" aria-label={`Editor: ${fileName}`} />;
}
