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
import { OfficeReplacePanel } from "../components/OfficeReplacePanel";
import { collectFiles, fsRead, fsWrite, isTauriFs } from "../lib/fsx";
import { opsBus } from "../lib/ops";
import { useApp } from "../lib/store";
import { TextAdapter, formatFromPath } from "../lib/office/adapter";
import { applyOfficeCommands as applyCommands, useOffice } from "../lib/office/session";
import { parseCommands, previewChanges, type OfficeCommand, type OfficeFormat } from "../lib/office/commands";
import { aiChangeCount, emptyChangeLog, revertEntry, timeline, undoLast } from "../lib/office/changeLog";
import { extractOffice, isExtractable } from "../lib/office/extract";

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
  const format = formatFromPath(path);
  const base = { path, format, selection: {}, log: emptyChangeLog(), pending: null } as const;

  // DOCX/XLSX/PPTX: extrai o TEXTO real do binário (leitura). Antes o app lia
  // como UTF-8 bruto e mostrava lixo.
  if (isExtractable(format)) {
    const extract = await extractOffice(root.trim() || ".", path);
    useOffice.setState({
      ...base,
      // O MOTIVO vai para a tela: "protegido por senha" e "digitalizado, sem
      // texto" pedem ações diferentes, e virariam a mesma tela vazia se o
      // erro fosse engolido.
      content: extract.ok ? extract.data.text : `Não foi possível ler este arquivo:\n\n${extract.reason}`,
      extracted: extract.ok
    });
    return;
  }

  const content = await fsRead(root.trim() || ".", path).catch(() => "");
  useOffice.setState({ ...base, content, extracted: false });
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
  const extracted = useOffice((state) => state.extracted);
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
  // XLSX fica de fora: a célula é resolvida por tabela compartilhada e aba
  // nomeada em workbook.xml — outro projeto. Recusar é melhor que errar.
  const canReplace = format === "docx" || format === "pptx";
  /** Relê o binário depois de editar, para o texto na tela bater com o disco. */
  const reload = () => void openFile(path);
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
    // Nunca gravar por cima de um binário extraído: escreveria o TEXTO no
    // lugar do OOXML e corromperia o arquivo. Só formatos realmente editáveis.
    if (!path || !isTauriFs || !editable) return;
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
        <button
          className="lg-button primary"
          disabled={!path || !isTauriFs || !editable}
          title={editable ? "Salvar" : "Somente leitura — não sobrescreve o binário"}
          onClick={() => void save()}
        >
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
                  {extracted ? (
                    <>
                      {/* Texto REAL extraído do OOXML. O painel abaixo edita o
                          BINÁRIO por substituição — sem motor externo. */}
                      <p className="offx-note">
                        <strong>{format.toUpperCase()}</strong> — texto extraído do binário.{" "}
                        {canReplace
                          ? "Substituir texto reescreve o arquivo de verdade, preservando formatação, estilos e numeração."
                          : "Edição de XLSX ainda não é suportada (a célula é resolvida por tabela compartilhada)."}
                      </p>
                      {canReplace ? <OfficeReplacePanel root={root.trim() || "."} path={path} onDone={reload} /> : null}
                      <pre className="offx-extract">{content || "(sem texto extraível)"}</pre>
                    </>
                  ) : (
                    <p className="offx-note">
                      <strong>{format.toUpperCase()}</strong> ainda não é suportado. PDF depende de um extrator próprio;
                      a edição de DOCX/XLSX/PPTX depende do motor em <code>docs/adr-office-motor-wopi.md</code>. Hoje a
                      aba edita HTML, Markdown, CSV e TXT.
                    </p>
                  )}
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
