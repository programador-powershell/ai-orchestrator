/**
 * OFFICE — o arquivo é um objeto VIVO do workspace, não um anexo do chat.
 *
 * Fluxo: você digita no composer → o agente interpreta a intenção → emite uma
 * OPERAÇÃO estruturada (bloco ```office```) → o Command Engine valida → o
 * adapter aplica → você vê a alteração acontecer no documento aberto.
 *
 * Layout: árvore de arquivos | canvas do documento ocupando a largura toda.
 * Não há coluna direita — contexto virou faixa no cabeçalho e o histórico da
 * IA abre sob demanda, porque o que importa aqui é ver o arquivo.
 */
import "../styles/modes/office.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  History,
  Presentation,
  RotateCcw,
  Save,
  Undo2
} from "lucide-react";
import { EmptyHero, PanelScroll, PanelTitle, Surface, TopbarActions, VBody, VCenter, VStatus } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { collectFiles, fsRead, fsWrite, isTauriFs } from "../lib/fsx";
import { opsBus } from "../lib/ops";
import { useApp } from "../lib/store";
import { TextAdapter, formatFromPath } from "../lib/office/adapter";
import { applyOfficeCommands as applyCommands, useOffice } from "../lib/office/session";
import { parseCommands, previewChanges, type OfficeCommand, type OfficeFormat } from "../lib/office/commands";
import { aiChangeCount, emptyChangeLog, revertEntry, timeline, undoLast } from "../lib/office/changeLog";

/** Formatos que o TextAdapter edita de verdade hoje (sem motor externo). */
const EDITABLE: OfficeFormat[] = ["html", "markdown", "csv", "text"];


const iconFor = (path: string) => {
  const format = formatFromPath(path);
  if (format === "xlsx" || format === "csv") return FileSpreadsheet;
  if (format === "pptx") return Presentation;
  if (format === "html" || format === "markdown") return FileCode2;
  return FileText;
};

/** Só arquivos que a aba sabe abrir — evita listar binário irrelevante. */
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|pdf|html?|md|markdown|csv|txt)$/i;

async function indexFiles() {
  const { root } = useOffice.getState();
  if (!root.trim()) return;
  const entries = await collectFiles(root.trim(), { maxEntries: 500 }).catch(() => []);
  useOffice.setState({ files: entries.map((entry) => entry.path).filter((path) => OFFICE_EXT.test(path)) });
}

async function openFile(path: string) {
  const { root } = useOffice.getState();
  const content = await fsRead(root.trim() || ".", path).catch(() => "");
  useOffice.setState({
    path,
    content,
    format: formatFromPath(path),
    selection: {},
    log: emptyChangeLog(),
    pending: null
  });
}


/** Rail: pasta do projeto, arquivos e sessões. */
export function OfficeRail() {
  const root = useOffice((state) => state.root);
  const files = useOffice((state) => state.files);
  const path = useOffice((state) => state.path);
  const { setRoot } = useOffice.getState();

  useEffect(() => {
    if (root.trim() && !files.length) void indexFiles();
  }, [root, files.length]);

  return (
    <>
      <span className="eyebrow">ARQUIVOS</span>
      <label className="rail-search">
        <FolderOpen size={13} />
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="pasta do projeto"
          aria-label="Pasta do projeto"
        />
      </label>
      {!root.trim() && <p className="rail-empty">Defina a pasta para listar os documentos.</p>}
      {files.map((file) => {
        const Icon = iconFor(file);
        return (
          <button
            key={file}
            className={`row-item ${file === path ? "active" : ""}`}
            onClick={() => void openFile(file)}
            title={file}
          >
            <Icon size={14} />
            <span className="grow">{file.split("/").pop()}</span>
          </button>
        );
      })}
      <span className="eyebrow">SESSÕES</span>
      <RailConversations mode="office" />
    </>
  );
}

export function OfficeView() {
  const path = useOffice((state) => state.path);
  const content = useOffice((state) => state.content);
  const format = useOffice((state) => state.format);
  const selection = useOffice((state) => state.selection);
  const log = useOffice((state) => state.log);
  const pending = useOffice((state) => state.pending);
  const root = useOffice((state) => state.root);
  const messages = useApp((state) => state.threads.office.messages);
  const [note, setNote] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const editable = EDITABLE.includes(format);
  const entries = useMemo(() => timeline(log), [log]);

  /**
   * O agente responde com blocos ```office``` — aqui eles viram operações.
   * Poucas alterações aplicam direto (fluidez); muitas pedem aprovação.
   */
  useEffect(
    () =>
      opsBus.subscribe("office", () => undefined) &&
      (() => {
        const unsubscribe = useApp.subscribe((state, previous) => {
          const current = state.threads.office.messages;
          if (current === previous.threads.office.messages) return;
          const last = current.at(-1);
          if (!last || last.role !== "assistant" || !last.content) return;
          const { commands, issues } = parseCommands(last.content, useOffice.getState().format);
          if (issues.length) setNote(issues[0]);
          if (!commands.length) return;
          if (commands.length > 3) {
            useOffice.setState({ pending: commands });
            return;
          }
          const { applied, touched } = applyCommands(commands);
          if (applied) setNote(`${applied} operação(ões) aplicadas · ${touched} elemento(s)`);
        });
        return unsubscribe;
      })(),
    []
  );

  async function save() {
    if (!path || !isTauriFs) return;
    await fsWrite(root.trim() || ".", path, content).catch(() => undefined);
    setNote("documento salvo");
  }

  function onUndo() {
    const result = undoLast(log, content);
    if (!result.ok) {
      setNote(result.reason ?? "nada para desfazer");
      return;
    }
    useOffice.setState({ content: result.content!, log: result.state! });
    setNote("última alteração desfeita");
  }

  return (
    <Surface className="offx">
      <TopbarActions>
        <span className="chip accent" title="O agente altera o documento por operações validadas">
          {path ? format.toUpperCase() : "sem arquivo"}
        </span>
        <button className="lg-button ghost" disabled={!log.entries.length} onClick={onUndo} title="Desfazer a última alteração">
          <Undo2 size={13} />
          Desfazer
        </button>
        <button className="lg-button primary" disabled={!path || !isTauriFs} onClick={() => void save()}>
          <Save size={13} />
          Salvar
        </button>
      </TopbarActions>

      <VBody>
        <VCenter>
          {!path ? (
            <EmptyHero
              icon={<FileText size={26} />}
              kicker="OFFICE · DOCUMENTO VIVO"
              title="Converse com o arquivo"
              detail="Escolha a pasta e abra um documento no painel esquerdo. Depois peça a alteração no chat — o agente emite operações validadas e você vê o documento mudar."
            />
          ) : (
            <div className="offx-canvas v-panel">
              {/* A coluna direita saiu: o arquivo ocupa a largura toda. O que
                  era o painel "Contexto" virou esta faixa, e o histórico da IA
                  abre sob demanda pelo botão. */}
              <header className="offx-canvas-head">
                <strong>{path.split("/").pop()}</strong>
                <span className="offx-path">{path}</span>
                <span className="offx-canvas-meta">
                  <span className={`chip ${editable ? "ok" : ""}`}>{editable ? "edição" : "somente leitura"}</span>
                  {selection.text ? <span className="chip">seleção: {selection.text.slice(0, 24)}</span> : null}
                  <button
                    className={`chip accent offx-histbtn${historyOpen ? " is-open" : ""}`}
                    onClick={() => setHistoryOpen((value) => !value)}
                    aria-expanded={historyOpen}
                    title="Histórico de alterações da IA"
                  >
                    <History size={11} />
                    {aiChangeCount(log)}
                  </button>
                </span>
              </header>
              {editable ? (
                <textarea
                  ref={editorRef}
                  className="offx-editor"
                  value={content}
                  spellCheck={false}
                  onChange={(event) => useOffice.setState({ content: event.target.value })}
                  onSelect={(event) => {
                    const target = event.target as HTMLTextAreaElement;
                    const text = content.slice(target.selectionStart, target.selectionEnd);
                    useOffice.setState({ selection: text ? { text, ref: text } : {} });
                  }}
                  aria-label="Documento aberto"
                />
              ) : (
                <div className="offx-readonly">
                  {/* Não há extração de OOXML/PDF no app: o arquivo é lido como
                      UTF-8 bruto, então num binário isto é lixo. Dizer "texto
                      extraído" seria mentira — melhor avisar e não exibir. */}
                  <p className="offx-note">
                    <strong>{format.toUpperCase()}</strong> ainda não é suportado. Este formato é binário e o app ainda
                    não extrai o conteúdo dele — nem para leitura, nem para edição.
                  </p>
                  <p className="offx-note">
                    Hoje a aba edita <strong>HTML, Markdown, CSV e TXT</strong>. O suporte a DOCX, XLSX, PPTX e PDF
                    depende do motor de edição descrito em <code>docs/adr-office-motor-wopi.md</code>, ainda não
                    implementado.
                  </p>
                </div>
              )}
            </div>
          )}
        </VCenter>

        {pending && (
            <div className="offx-approval">
              <strong>Alteração proposta</strong>
              <ul>
                {previewChanges(pending).lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="offx-approval-actions">
                <button className="lg-button" onClick={() => useOffice.setState({ pending: null })}>
                  Cancelar
                </button>
                <button
                  className="lg-button primary"
                  onClick={() => {
                    const { applied, touched } = applyCommands(pending);
                    setNote(`${applied} operação(ões) · ${touched} elemento(s)`);
                  }}
                >
                  Aplicar alterações
                </button>
              </div>
            </div>
          )}

        {historyOpen && (
          <aside className="offx-history glass-strong">
          <PanelTitle icon={<History size={13} />} label="Histórico da IA" meta={`${entries.length}`} />
          <PanelScroll>
            <div className="offx-log">
              {!entries.length && <p className="offx-note">Nenhuma alteração ainda.</p>}
              {entries.map((entry) => (
                <div key={entry.id} className={`offx-log-item ${entry.reverted ? "reverted" : ""}`}>
                  <span className="offx-log-author">{entry.author === "ai" ? "✨ IA" : "👤 Você"}</span>
                  <span className="offx-log-label">{entry.label}</span>
                  {!entry.reverted && (
                    <button
                      className="icon-button"
                      title="Reverter esta alteração"
                      onClick={() => {
                        const result = revertEntry(log, entry.id, content);
                        if (!result.ok) {
                          setNote(result.reason ?? "não foi possível reverter");
                          return;
                        }
                        useOffice.setState({ content: result.content!, log: result.state! });
                        setNote("alteração revertida");
                      }}
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </PanelScroll>
          </aside>
        )}
      </VBody>

      <VStatus>
        <span>
          <FileText size={11} /> {path || "nenhum arquivo aberto"}
        </span>
        <span>{messages.length} mensagens</span>
        <div className="spacer" />
        <span>{note || (editable ? "pronto" : "abra um arquivo editável")}</span>
      </VStatus>
    </Surface>
  );
}
