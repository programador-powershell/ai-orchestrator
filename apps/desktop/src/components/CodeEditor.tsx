/**
 * CodeEditor — wrapper React do CodeMirror 6 com tema transparente que herda a
 * superfície. A view é recriada quando o arquivo muda (fileName); mudanças
 * externas de valor são aplicadas via dispatch para não recriar o histórico do
 * documento ativo. Suporta sugestão inline (texto fantasma) aceita com Tab.
 *
 * As cores de sintaxe vêm de `codeSyntaxTheme` (lib/cmTheme.ts), em tokens do
 * tema — antes o editor herdava o `defaultHighlightStyle` do CodeMirror, feito
 * para fundo claro e ilegível no tema escuro.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { codeSyntaxTheme } from "../lib/cmTheme";
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

/** Entrada do gancho de sugestão inline: buffer inteiro + offset do cursor. */
export interface InlineSuggestionContext {
  text: string;
  cursor: number;
  /** Abortado quando a pessoa continua digitando — cancele a requisição. */
  signal?: AbortSignal;
}

/** Estado da sugestão por modelo, para a barra de status mostrar. */
export type SuggestState = "idle" | "loading" | "ready";

export interface CodeEditorProps {
  value: string;
  fileName: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Recebe a API imperativa enquanto a view existir (null ao desmontar). */
  apiRef?: MutableRefObject<CodeEditorApi | null>;
  /**
   * Sugestão fantasma exibida à direita do cursor e aceita com Tab. Deve
   * devolver só o trecho que falta (não o token inteiro) ou null.
   */
  inlineSuggestion?: (context: InlineSuggestionContext) => string | null;
  /**
   * Sugestão por MODELO (fill-in-the-middle). Só é chamada quando a sugestão
   * síncrona não achou nada — a do buffer é instantânea e de graça, e trocar
   * uma pela outra depois de exibida faria o fantasma piscar.
   */
  modelSuggestion?: (context: InlineSuggestionContext) => Promise<string | null>;
  /** Avisa a UI que existe uma chamada de modelo em curso. */
  onSuggestState?: (state: SuggestState) => void;
}

/** Acima disso a sugestão inline é desligada (custo por tecla). */
const MAX_SUGGEST_DOC = 200_000;

/**
 * Silêncio antes de chamar o modelo.
 *
 * Sem esta pausa haveria uma requisição por tecla: caro, e a resposta chegaria
 * sempre desatualizada em relação ao que já foi digitado.
 */
const MODEL_DELAY_MS = 400;

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

/**
 * Cromo do editor em tokens do terminal — fundo transparente (herda
 * `.codex-editor`), texto e medianiz na ramp cinza, e o acento da aba só no
 * que é interação (caret, seleção, colchete casado).
 */
const glassTheme = EditorView.theme({
  "&": {
    position: "relative",
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--term-fg)",
    fontSize: "var(--fs-small)"
  },
  ".cm-inline-ghost": {
    position: "absolute",
    display: "none",
    zIndex: "2",
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "pre",
    color: "var(--term-gray-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-small)",
    lineHeight: "1.7"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--term-gray-dim)",
    border: "none",
    fontSize: "var(--fs-micro)"
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--term-bg-highlight)",
    border: "none",
    color: "var(--term-gray)"
  },
  ".cm-activeLine": { backgroundColor: "var(--term-bg-highlight)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--term-fg-dim)" },
  ".cm-selectionBackground": { backgroundColor: "var(--term-bg-visual)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--term-bg-hover)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--term-selection-border)"
  },
  /* Painel de busca do basicSetup: nascia com o cinza de fábrica do CodeMirror. */
  ".cm-panels": {
    backgroundColor: "var(--term-bg-dark)",
    color: "var(--term-fg)",
    borderColor: "var(--term-selection-border)"
  },
  ".cm-panels input, .cm-panels button": {
    backgroundColor: "var(--term-bg)",
    color: "var(--term-fg)",
    border: "1px solid var(--term-prompt-border)",
    borderRadius: "var(--radius-xs)"
  },
  ".cm-tooltip": {
    backgroundColor: "var(--term-bg-dark)",
    color: "var(--term-fg)",
    border: "1px solid var(--term-selection-border)",
    borderRadius: "var(--radius-xs)"
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--term-fg)"
  }
});

export function CodeEditor({
  value,
  fileName,
  onChange,
  readOnly = false,
  apiRef,
  inlineSuggestion,
  modelSuggestion,
  onSuggestState
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const suggestRef = useRef(inlineSuggestion);
  const modelRef = useRef(modelSuggestion);
  const stateRef = useRef(onSuggestState);
  valueRef.current = value;
  onChangeRef.current = onChange;
  suggestRef.current = inlineSuggestion;
  modelRef.current = modelSuggestion;
  stateRef.current = onSuggestState;

  // Recria a view quando o arquivo muda (linguagem e histórico novos).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Fantasma fora do conteúdo editável: posicionado por medição, nunca no doc.
    const ghost = document.createElement("span");
    ghost.className = "cm-inline-ghost";
    ghost.setAttribute("aria-hidden", "true");
    /** Sugestão viva — só ela habilita o Tab a interceptar. */
    let suggestion = "";
    /** Estado da chamada ao modelo: timer, cancelamento e número de série. */
    let modelTimer = 0;
    let modelAbort: AbortController | null = null;
    let modelToken = 0;

    function setSuggestState(state: SuggestState) {
      stateRef.current?.(state);
    }

    /**
     * Pede a sugestão ao modelo depois de uma pausa na digitação.
     *
     * O número de série existe porque respostas voltam fora de ordem: sem ele,
     * uma requisição lenta de dois caracteres atrás sobrescreveria a sugestão
     * atual e o fantasma piscaria com código do passado.
     */
    function scheduleModel(target: EditorView) {
      window.clearTimeout(modelTimer);
      modelAbort?.abort();
      modelAbort = null;
      const ask = modelRef.current;
      if (!ask || readOnly || !target.hasFocus) {
        setSuggestState("idle");
        return;
      }
      const range = target.state.selection.main;
      if (!range.empty || target.state.doc.length > MAX_SUGGEST_DOC) {
        setSuggestState("idle");
        return;
      }
      const token = (modelToken += 1);
      const text = target.state.doc.toString();
      const cursor = range.head;
      modelTimer = window.setTimeout(() => {
        const controller = new AbortController();
        modelAbort = controller;
        setSuggestState("loading");
        void ask({ text, cursor, signal: controller.signal })
          .then((result) => {
            // Chegou tarde, ou o documento andou: descartar em silêncio.
            if (token !== modelToken || controller.signal.aborted) return;
            const live = viewRef.current;
            if (!live || live.state.doc.toString() !== text) return;
            if (live.state.selection.main.head !== cursor) return;
            if (!result) {
              setSuggestState("idle");
              return;
            }
            suggestion = result;
            setSuggestState("ready");
            placeGhost(live);
          })
          .catch(() => setSuggestState("idle"));
      }, MODEL_DELAY_MS);
    }

    function computeSuggestion(target: EditorView): string {
      const suggest = suggestRef.current;
      if (!suggest || readOnly || !target.hasFocus) return "";
      const range = target.state.selection.main;
      // Buffer gigante: varrer a cada tecla custaria mais do que a sugestão vale.
      if (!range.empty || target.state.doc.length > MAX_SUGGEST_DOC) return "";
      return suggest({ text: target.state.doc.toString(), cursor: range.head }) ?? "";
    }

    /** Mede na fase de leitura do CodeMirror e escreve depois — sem layout thrash. */
    function placeGhost(target: EditorView) {
      target.requestMeasure<{ left: number; top: number } | null>({
        read: (measured) => {
          if (!suggestion) return null;
          const coords = measured.coordsAtPos(measured.state.selection.main.head);
          if (!coords) return null;
          const scroller = measured.scrollDOM.getBoundingClientRect();
          // Cursor rolado para fora da área visível: nada a desenhar.
          if (coords.bottom < scroller.top || coords.top > scroller.bottom) return null;
          const box = measured.dom.getBoundingClientRect();
          return { left: coords.left - box.left, top: coords.top - box.top };
        },
        write: (spot) => {
          if (!spot || !suggestion) {
            ghost.style.display = "none";
            ghost.textContent = "";
            return;
          }
          ghost.textContent = suggestion;
          ghost.style.display = "block";
          ghost.style.left = `${spot.left}px`;
          ghost.style.top = `${spot.top}px`;
        }
      });
    }

    const view = new EditorView({
      doc: valueRef.current,
      parent: host,
      extensions: [
        basicSetup,
        languageFor(fileName),
        // Depois do basicSetup de propósito: o estilo padrão dele é `fallback`,
        // então este tem precedência sem precisar desmontar o setup.
        codeSyntaxTheme,
        glassTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        EditorView.domEventHandlers({
          keydown: (event, target) => {
            const plainTab = event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
            // Sem sugestão viva o Tab segue para o comportamento padrão do editor.
            if (!plainTab || !suggestion) return false;
            const head = target.state.selection.main.head;
            const accepted = suggestion;
            suggestion = "";
            // Aceitar cancela o que estivesse a caminho: a sugestão seguinte
            // sai do texto novo, não do de antes do Tab.
            window.clearTimeout(modelTimer);
            modelAbort?.abort();
            modelToken += 1;
            setSuggestState("idle");
            target.dispatch({
              changes: { from: head, insert: accepted },
              selection: { anchor: head + accepted.length },
              scrollIntoView: true,
              userEvent: "input.complete"
            });
            event.preventDefault();
            return true;
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          if (update.docChanged || update.selectionSet || update.focusChanged) {
            suggestion = computeSuggestion(update.view);
            // A do buffer é instantânea e de graça; o modelo só entra quando
            // ela não achou nada — que é justamente o caso de código novo.
            if (suggestion) {
              window.clearTimeout(modelTimer);
              modelAbort?.abort();
              setSuggestState("idle");
            } else {
              scheduleModel(update.view);
            }
          }
          placeGhost(update.view);
        })
      ]
    });
    view.dom.appendChild(ghost);
    const onScroll = () => placeGhost(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
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
      view.scrollDOM.removeEventListener("scroll", onScroll);
      // Sem isto uma requisição em voo tentaria desenhar num editor destruído.
      window.clearTimeout(modelTimer);
      modelAbort?.abort();
      modelToken += 1;
      setSuggestState("idle");
      ghost.remove();
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
