/**
 * Superfície do especialista de código.
 *
 * Sem CodeMirror — dependência fora da lista permitida. O editor é um
 * `<textarea>` mono com uma calha de números sincronizada no scroll, e sem
 * destaque de sintaxe: imitar um editor de verdade com regex custa caro e
 * entrega pouco. O que importa aqui é ler, ajustar e devolver.
 *
 * Nada nesta tela escreve em disco nem executa processo. Quem faz isso é o
 * especialista, do outro lado da conversa — por isso a conversa fica visível na
 * coluna ao lado, e por isso "Salvar" é um pedido, não uma gravação.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import { FileCode2, GitCompare, Save, Terminal, Wand2 } from "lucide-react";
import type { ConversationLine, ToolResult } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { lastFencedBlock } from "../lib/markdown";
import { TopbarActions } from "../shell/TopbarActions";
import { SurfaceStatus } from "../shell/StatusBar";
import { ConversationSurface } from "./ConversationSurface";

/* ------------------------- leitura do que está no store ------------------- */

interface OpenFile {
  path: string;
  /** O conteúdo como o especialista leu — a base contra a qual medimos sujeira. */
  content: string;
}

function pathFromArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "filename", "target"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/** Ferramenta que devolve o conteúdo do arquivo no resultado. */
function isReadTool(tool: string): boolean {
  return /(^|\.)(read|open|cat)$/.test(tool);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * As abas saem da conversa: arquivo que alguma ferramenta tocou está aberto.
 * O contrário — uma lista própria de arquivos abertos — dessincronizaria da
 * sessão no primeiro reload, e o editor mostraria um arquivo que a conversa
 * não conhece.
 */
function collectFiles(lines: ConversationLine[]): OpenFile[] {
  const map = new Map<string, OpenFile>();

  for (const line of lines) {
    const results = new Map<string, ToolResult>();
    for (const result of line.toolResults ?? []) results.set(result.callId, result);

    for (const call of line.toolCalls ?? []) {
      const path = pathFromArgs(call.args);
      if (path === "") continue;
      const result = results.get(call.callId);
      const fresh = result && result.ok && isReadTool(call.tool) ? result.output ?? "" : undefined;
      const previous = map.get(path);
      map.set(path, { path, content: fresh ?? previous?.content ?? "" });
    }
  }

  return [...map.values()];
}

interface OutputEntry {
  key: string;
  tool: string;
  ok: boolean;
  text: string;
  elapsedMs?: number;
}

function isOutputTool(tool: string): boolean {
  return tool.startsWith("proc.") || tool.startsWith("diagnostics.");
}

/** O painel de saída é uma janela sobre o store, não um log paralelo. */
function collectOutput(lines: ConversationLine[]): OutputEntry[] {
  const entries: OutputEntry[] = [];
  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      if (!isOutputTool(result.tool)) continue;
      entries.push({
        key: `${line.id}:${result.callId}`,
        tool: result.tool,
        ok: result.ok,
        text: result.ok ? result.output ?? "" : result.error ?? "",
        elapsedMs: result.elapsedMs
      });
    }
  }
  return entries.slice(-6);
}

function lastSuggestion(lines: ConversationLine[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || line.role !== "assistant") continue;
    const block = lastFencedBlock(line.text);
    if (block !== "") return block;
  }
  return "";
}

/* -------------------------------- superfície ------------------------------ */

export function EditorSurface(): ReactNode {
  const lines = useApp((state) => state.lines);
  const busy = useApp((state) => state.busy);
  const send = useApp((state) => state.send);

  const files = useMemo(() => collectFiles(lines), [lines]);
  const output = useMemo(() => collectOutput(lines), [lines]);
  const suggestion = useMemo(() => lastSuggestion(lines), [lines]);

  /**
   * O rascunho é o único estado local, e é local por natureza: texto digitado e
   * ainda não enviado não existe do outro lado. Abas, conteúdo e saída são
   * derivados do store.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState("");

  const gutter = useRef<HTMLDivElement | null>(null);

  const activePath = useMemo(() => {
    if (picked !== "" && files.some((file) => file.path === picked)) return picked;
    const last = files[files.length - 1];
    return last ? last.path : "";
  }, [picked, files]);

  const active = files.find((file) => file.path === activePath);
  const saved = active ? active.content : "";
  const draft = drafts[activePath];
  const buffer = draft ?? saved;
  const dirty = draft !== undefined && draft !== saved;
  const hasFile = activePath !== "";

  const lineCount = buffer === "" ? 1 : buffer.split("\n").length;

  /**
   * A calha é UM nó de texto, não um elemento por linha: arquivo de dez mil
   * linhas viraria dez mil spans e a rolagem morreria. O alinhamento vem do
   * `line-height` igual entre a calha e o textarea.
   */
  const numbers = useMemo(() => {
    const out: string[] = [];
    for (let line = 1; line <= lineCount; line += 1) out.push(String(line));
    return out.join("\n");
  }, [lineCount]);

  // A calha é um painel separado para ter fundo próprio; o preço é sincronizar
  // o scroll na mão.
  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const element = gutter.current;
    if (!element) return;
    element.scrollTop = event.currentTarget.scrollTop;
  }, []);

  function edit(text: string): void {
    if (!hasFile) return;
    setDrafts((current) => ({ ...current, [activePath]: text }));
  }

  function save(): void {
    if (!hasFile) return;
    send(`Salve o arquivo ${activePath} com este conteúdo exato:\n\n\`\`\`\n${buffer}\n\`\`\``);
  }

  function showDiff(): void {
    if (!hasFile) return;
    if (dirty) {
      send(`Compare ${activePath} como está salvo com este conteúdo e mostre o diff:\n\n\`\`\`\n${buffer}\n\`\`\``);
      return;
    }
    send(`Mostre o diff de ${activePath} em relação ao último commit.`);
  }

  function applySuggestion(): void {
    if (suggestion === "" || !hasFile) return;
    edit(suggestion);
  }

  return (
    <div className="surface">
      {/* Os botões da superfície moram na barra superior do app, por portal —
          o palco não desenha barra própria (ver shell/TopbarActions). */}
      <TopbarActions>
        <button
          type="button"
          className="btn"
          onClick={save}
          disabled={!hasFile || busy}
          title="O aplicativo não grava em disco por conta própria: o pedido vai para o especialista, que aplica a escrita."
        >
          <Save aria-hidden="true" />
          Salvar
        </button>
        <button
          type="button"
          className="btn"
          onClick={showDiff}
          disabled={!hasFile || busy}
          title={dirty ? "compara o que está no editor com o que está salvo" : "pede o diff do arquivo"}
        >
          <GitCompare aria-hidden="true" />
          Ver alterações
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={applySuggestion}
          disabled={!hasFile || suggestion === ""}
          title={
            suggestion === ""
              ? "nenhum bloco de código nas respostas ainda"
              : "joga o último bloco de código da conversa no editor — só aqui; salvar é outro passo"
          }
        >
          <Wand2 aria-hidden="true" />
          Aplicar sugestão
        </button>
      </TopbarActions>

      {/*
        O rodapé do app, por portal (ver shell/StatusBar).

        "Salvo" aqui NÃO significa gravado em disco: significa que o que está no
        editor é igual ao que a ferramenta leu. Quem grava é o especialista, do
        outro lado da conversa — por isso o texto diz "no editor" e a métrica só
        aparece quando há arquivo aberto.
      */}
      {hasFile ? (
        <SurfaceStatus>
          <span className="statusbar-item" title={activePath}>
            <FileCode2 aria-hidden />
            <b>{baseName(activePath)}</b>
          </span>
          <span className="statusbar-item">
            {dirty ? "com edições não enviadas" : "igual ao que foi lido"}
          </span>
          <span className="statusbar-item">
            <b>{lineCount}</b> {lineCount === 1 ? "linha" : "linhas"}
          </span>
        </SurfaceStatus>
      ) : null}

      <div className="surface-toolbar" role="tablist" aria-label="arquivos abertos">
        {files.length === 0 ? (
          <span className="surface-title">nenhum arquivo aberto</span>
        ) : (
          files.map((file) => {
            const isActive = file.path === activePath;
            const fileDraft = drafts[file.path];
            const isDirty = fileDraft !== undefined && fileDraft !== file.content;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="chip"
                data-active={isActive ? "true" : "false"}
                key={file.path}
                onClick={() => setPicked(file.path)}
                title={file.path}
              >
                <FileCode2 aria-hidden="true" />
                {baseName(file.path)}
                {isDirty ? <b aria-label="com edições não enviadas">•</b> : null}
              </button>
            );
          })
        )}
        <span className="surface-toolbar-spacer" />
      </div>

      <div className="split">
        <div className="split-main">
          <div className="editor-pane">
            <div className="editor-gutter" ref={gutter} aria-hidden="true">
              <pre className="editor-linenums">{numbers}</pre>
            </div>
            <textarea
              className="editor-area"
              value={buffer}
              onChange={(event) => edit(event.target.value)}
              onScroll={syncScroll}
              spellCheck={false}
              /* `wrap="off"` é o que mantém a calha honesta: com quebra
                 automática uma linha lógica ocuparia várias visuais e os
                 números sairiam do lugar. */
              wrap="off"
              disabled={!hasFile}
              placeholder={hasFile ? "" : "Peça na conversa para abrir um arquivo — ele vira aba aqui."}
              aria-label={hasFile ? `conteúdo de ${activePath}` : "editor sem arquivo"}
            />
          </div>

          <section className="editor-output" aria-label="saída">
            <header className="editor-output-head">
              <Terminal aria-hidden="true" />
              <span className="surface-title">saída</span>
              <span className="card-eyebrow">
                somente leitura — o terminal interativo roda no aplicativo nativo, não nesta tela
              </span>
            </header>
            {output.length === 0 ? (
              <p className="card-body">nada executado nesta sessão ainda</p>
            ) : (
              <ul className="editor-output-list">
                {output.map((entry) => (
                  <li className="card" key={entry.key}>
                    <div className="card-head">
                      <span className="card-title">{entry.tool}</span>
                      <span className="chip" data-active={entry.ok ? "true" : "false"}>
                        {entry.ok ? "ok" : "erro"}
                      </span>
                      {typeof entry.elapsedMs === "number" ? (
                        <span className="card-eyebrow">{entry.elapsedMs} ms</span>
                      ) : null}
                    </div>
                    <pre className="editor-output-text">{entry.text}</pre>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* A conversa não sai de cena: é ela quem opera o arquivo. */}
        <aside className="split-aside" aria-label="conversa">
          <ConversationSurface compact />
        </aside>
      </div>

      <div className="surface-status">
        <span>
          <b>{hasFile ? activePath : "—"}</b>
        </span>
        <span>{lineCount} linhas</span>
        {dirty ? <span>editado aqui, ainda não enviado</span> : null}
        <span>terminal interativo: só no aplicativo nativo</span>
      </div>
    </div>
  );
}

export default EditorSurface;
