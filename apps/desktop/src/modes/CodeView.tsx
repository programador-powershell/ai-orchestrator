/**
 * CODE — IDE agêntica reestruturada: explorer + sessões vivem no rail lateral
 * (CodeRail), o centro é um terminal liquid glass estilo CLI do composer
 * (com arquivo aberto o editor CodeMirror assume e o terminal vira dock),
 * o orquestrador abre em popup na toolbar e Quick Open (Ctrl+P), busca no
 * projeto (Ctrl+Shift+F), diff e aplicação de código da IA seguem intactos.
 * Rail e view compartilham estado via store zustand de módulo (useCode).
 */
import "../styles/modes/code.css";
import "../styles/modes/ship.css";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { create } from "zustand";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  Merge,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Terminal as TerminalIcon,
  WandSparkles,
  X
} from "lucide-react";
import type { FsEntry, OrchestrationGraph } from "@ai-orchestrator/contracts";
import { CodeEditor, type CodeEditorApi, type InlineSuggestionContext } from "../components/CodeEditor";
import { FloatingPulse, Surface, TopbarActions, VBody, VCenter, VStatus } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { ShipPanel } from "../components/ShipPanel";
import { computeDiff, diffStats, toHunks, type DiffLine } from "../lib/diff";
import { applySelectedHunks, splitIntoHunks, type Hunk } from "../lib/hunks";
import { suggestIdentifier } from "../lib/inlineSuggest";
import { describeSelection } from "../lib/engine";
import { composerBus } from "../lib/ops";
import { collectFiles, fsList, fsRead, fsWrite, isTauriFs } from "../lib/fsx";
import { detectByFileName, detectLanguage, isRunnableFileInput } from "../lib/langDetect";
import { fuzzyRank } from "../lib/fuzzy";
import { validateOrchestration } from "../lib/gateway";
import { parseMarkdown, type BlockToken } from "../lib/markdown";
import { useApp } from "../lib/store";
import { terminal } from "../lib/terminal";

const isTauriHost = isTauriFs;
const ROOT_STORAGE_KEY = "code.root";
const INDEX_LIMITS = { maxEntries: 500, maxDepth: 4 } as const;
const SEARCH_FILE_LIMIT = 200;
const SEARCH_RESULT_LIMIT = 200;

interface OpenFile {
  path: string;
  name: string;
  content: string;
  /** Último conteúdo conhecido em disco — base do diff de não salvos. */
  savedContent: string;
  dirty: boolean;
  loading: boolean;
}

interface SearchResult {
  path: string;
  line: number;
  preview: string;
}

interface DiffModal {
  title: string;
  lines: DiffLine[];
  note?: string;
  /** Presente só quando o diff é aplicável (base + blocos escolhíveis). */
  patch?: {
    before: string;
    after: string;
    hunks: Hunk[];
    apply: (next: string) => void;
  };
}

/** Sugestão inline do editor: identificador já usado no buffer, aceito com Tab. */
const inlineSuggestion = (context: InlineSuggestionContext) => suggestIdentifier(context.text, context.cursor);

/* Cabeçalho de hunk selecionável — superfícies planas, só tokens do tema. */
const HUNK_BLOCK: CSSProperties = { marginBottom: 10 };
const HUNK_HEAD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "var(--panel-2)",
  borderBottom: "1px solid var(--line)",
  color: "var(--muted)",
  cursor: "pointer"
};
const HUNK_HEAD_ON: CSSProperties = { background: "var(--hover)", color: "var(--ink)" };
const HUNK_CHECK: CSSProperties = { accentColor: "var(--accent)", cursor: "pointer" };
const HUNK_HEADER_TEXT: CSSProperties = { flex: 1, minWidth: 0, fontSize: "var(--fs-micro)" };
const HUNK_COUNTER: CSSProperties = { marginRight: "auto" };

/** Extensões tratadas como texto na busca literal do projeto. */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "markdown", "css", "html", "htm",
  "rs", "py", "go", "java", "cs", "php", "sql", "toml", "yaml", "yml", "txt", "sh", "ps1",
  "xml", "svg", "env", "gitignore", "editorconfig", "lock"
]);

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/* ------------------ Estado compartilhado rail ⇄ centro ----------------- */

interface CodeStore {
  root: string;
  rootDraft: string;
  tree: Record<string, FsEntry[]>;
  expanded: ReadonlySet<string>;
  files: OpenFile[];
  activePath: string;
  saveState: "idle" | "saving" | "saved" | "error";
}

const initialRoot = window.localStorage.getItem(ROOT_STORAGE_KEY) ?? ".";

/** Store de módulo: o rail (árvore) e o centro (editor/terminal) leem os dois lados. */
const useCode = create<CodeStore>()(() => ({
  root: initialRoot,
  rootDraft: initialRoot,
  tree: {},
  expanded: new Set<string>(),
  files: [],
  activePath: "",
  saveState: "idle"
}));

/** Cache do índice (Quick Open + busca) — invalidado em refresh/troca de raiz. */
let indexCache: FsEntry[] | null = null;

async function loadDir(sub: string): Promise<void> {
  const { root } = useCode.getState();
  const entries = await fsList(root, sub).catch(() => [] as FsEntry[]);
  // Descarta a resposta se a raiz mudou enquanto a listagem estava em voo.
  useCode.setState((state) => (state.root === root ? { tree: { ...state.tree, [sub]: entries } } : {}));
}

/** Primeira carga da árvore — rail e view chamam; só a primeira ganha. */
function bootstrapTree(): void {
  if (!useCode.getState().tree[""]) void loadDir("");
}

function refreshTree(): void {
  indexCache = null;
  useCode.setState({ tree: {}, expanded: new Set<string>() });
  void loadDir("");
}

function applyRoot(): void {
  const next = useCode.getState().rootDraft.trim() || ".";
  window.localStorage.setItem(ROOT_STORAGE_KEY, next);
  useCode.setState({ rootDraft: next, root: next });
  refreshTree();
}

function toggleDir(path: string): void {
  useCode.setState((state) => {
    const next = new Set(state.expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { expanded: next };
  });
  if (!useCode.getState().tree[path]) void loadDir(path);
}

async function ensureIndex(): Promise<FsEntry[]> {
  if (indexCache) return indexCache;
  indexCache = await collectFiles(useCode.getState().root, INDEX_LIMITS);
  return indexCache;
}

function activeFile(): OpenFile | undefined {
  const { files, activePath } = useCode.getState();
  return files.find((file) => file.path === activePath);
}

function patchFile(path: string, patch: (file: OpenFile) => Partial<OpenFile>): void {
  useCode.setState((state) => ({
    files: state.files.map((file) => (file.path === path ? { ...file, ...patch(file) } : file))
  }));
}

function setActivePath(path: string): void {
  useCode.setState({ activePath: path, saveState: "idle" });
}

function openFile(entry: Pick<FsEntry, "name" | "path">): void {
  const { files, root } = useCode.getState();
  setActivePath(entry.path);
  if (files.some((file) => file.path === entry.path)) return;
  useCode.setState((state) => ({
    files: [
      ...state.files,
      { path: entry.path, name: entry.name, content: "", savedContent: "", dirty: false, loading: true }
    ]
  }));
  void fsRead(root, entry.path)
    .then((content) => patchFile(entry.path, () => ({ content, savedContent: content, loading: false })))
    .catch((cause: unknown) => {
      const message = `// Não foi possível ler ${entry.path}: ${cause instanceof Error ? cause.message : String(cause)}`;
      patchFile(entry.path, () => ({ content: message, savedContent: message, loading: false }));
    });
}

function closeFile(path: string): void {
  useCode.setState((state) => {
    const files = state.files.filter((file) => file.path !== path);
    return {
      files,
      activePath: state.activePath === path ? files.at(-1)?.path ?? "" : state.activePath
    };
  });
}

function changeActive(value: string): void {
  const { activePath } = useCode.getState();
  useCode.setState((state) => ({
    saveState: "idle",
    files: state.files.map((file) =>
      file.path === activePath ? { ...file, content: value, dirty: value !== file.savedContent } : file
    )
  }));
}

/** Some com o chip "salvo" depois do brilho de confirmação. */
function scheduleSavedReset(): void {
  window.setTimeout(
    () => useCode.setState((state) => (state.saveState === "saved" ? { saveState: "idle" } : {})),
    2200
  );
}

async function saveActive(): Promise<void> {
  const file = activeFile();
  if (!file || file.loading || useCode.getState().saveState === "saving") return;
  useCode.setState({ saveState: "saving" });
  try {
    await fsWrite(useCode.getState().root, file.path, file.content);
    patchFile(file.path, () => ({ dirty: false, savedContent: file.content }));
    useCode.setState({ saveState: "saved" });
    scheduleSavedReset();
  } catch {
    useCode.setState({ saveState: "error" });
  }
}

async function applyContent(path: string, next: string): Promise<void> {
  if (isTauriHost) {
    useCode.setState({ saveState: "saving" });
    try {
      await fsWrite(useCode.getState().root, path, next);
      patchFile(path, () => ({ content: next, savedContent: next, dirty: false }));
      useCode.setState({ saveState: "saved" });
      scheduleSavedReset();
    } catch {
      patchFile(path, () => ({ content: next, dirty: true }));
      useCode.setState({ saveState: "error" });
    }
    return;
  }
  // Navegador: só o buffer muda (fica sujo); o aviso já foi dado no preview.
  patchFile(path, () => ({ content: next, dirty: true }));
}

/* ------------------------------ CodeRail -------------------------------- */

/** Rail dinâmico da aba Code: raiz do projeto, árvore de arquivos e sessões. */
export function CodeRail() {
  const root = useCode((state) => state.root);
  const rootDraft = useCode((state) => state.rootDraft);
  const tree = useCode((state) => state.tree);
  const expanded = useCode((state) => state.expanded);
  const files = useCode((state) => state.files);
  const activePath = useCode((state) => state.activePath);

  useEffect(bootstrapTree, []);

  function renderEntries(sub: string, depth: number): ReactNode {
    const entries = tree[sub];
    if (!entries) {
      return (
        <span className="codex-tree-note" style={{ "--depth": depth } as CSSProperties} key={`${sub}#loading`}>
          carregando…
        </span>
      );
    }
    if (!entries.length) {
      return (
        <span className="codex-tree-note" style={{ "--depth": depth } as CSSProperties} key={`${sub}#empty`}>
          vazio
        </span>
      );
    }
    return entries.map((entry) => {
      const depthStyle = { "--depth": depth } as CSSProperties;
      if (entry.isDir) {
        const isOpen = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button className="codex-tree-row" style={depthStyle} onClick={() => toggleDir(entry.path)} title={entry.path}>
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {isOpen ? <FolderOpen size={12} /> : <Folder size={12} />}
              <span>{entry.name}</span>
            </button>
            {isOpen && renderEntries(entry.path, depth + 1)}
          </div>
        );
      }
      const opened = files.find((file) => file.path === entry.path);
      return (
        <button
          key={entry.path}
          className={`codex-tree-row ${activePath === entry.path ? "active" : ""}`}
          style={depthStyle}
          onClick={() => openFile(entry)}
          title={entry.path}
        >
          <FileCode2 size={12} />
          <span>{entry.name}</span>
          {opened?.dirty ? <i className="codex-dirty" /> : <small>{Math.max(1, Math.round(entry.size / 1024))}k</small>}
        </button>
      );
    });
  }

  return (
    <>
      <span className="eyebrow">PROJETO</span>
      <div className="codex-root">
        <input
          value={rootDraft}
          onChange={(event) => useCode.setState({ rootDraft: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyRoot();
          }}
          placeholder="raiz do projeto (ex.: .)"
          aria-label="Raiz do projeto"
        />
        <button className="icon-button" onClick={applyRoot} aria-label="Abrir raiz" title="Abrir raiz">
          <ChevronRight size={13} />
        </button>
        <button className="icon-button" onClick={refreshTree} aria-label="Recarregar árvore" title="Recarregar árvore">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="codex-rail-tree">{renderEntries("", 0)}</div>
      <span className="eyebrow">BUILD & DEPLOY</span>
      <ShipPanel root={root} />
      <span className="eyebrow">SESSÕES</span>
      <RailConversations mode="code" />
    </>
  );
}

/* ------------------------------- CodeView ------------------------------- */

export function CodeView() {
  const sending = useApp((state) => state.threads.code.sending);
  const codeMessages = useApp((state) => state.threads.code.messages);
  const stage = useApp((state) => state.stage);
  const session = useApp((state) => state.session);
  const settings = useApp((state) => state.settings);

  const root = useCode((state) => state.root);
  const files = useCode((state) => state.files);
  const activePath = useCode((state) => state.activePath);
  const saveState = useCode((state) => state.saveState);
  const active = files.find((file) => file.path === activePath);

  useEffect(bootstrapTree, []);

  const editorApiRef = useRef<CodeEditorApi | null>(null);
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);

  /* ------------------------ Quick Open (Ctrl+P) --------------------- */
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickIndex, setQuickIndex] = useState(0);
  const [quickFiles, setQuickFiles] = useState<FsEntry[] | null>(null);

  function openQuick() {
    setQuickOpen(true);
    setQuickQuery("");
    setQuickIndex(0);
    setQuickFiles(indexCache);
    void ensureIndex().then(setQuickFiles);
  }

  const quickPaths = useMemo(() => (quickFiles ?? []).map((file) => file.path), [quickFiles]);
  const quickHits = useMemo(() => fuzzyRank(quickQuery, quickPaths, 50), [quickQuery, quickPaths]);

  function openQuickHit(path: string) {
    setQuickOpen(false);
    openFile({ name: baseName(path), path });
  }

  function onQuickKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setQuickIndex((index) => Math.min(index + 1, Math.max(quickHits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setQuickIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = quickHits[quickIndex] ?? quickHits[0];
      if (hit) openQuickHit(hit.path);
    } else if (event.key === "Escape") {
      setQuickOpen(false);
    }
  }

  /* ------------------- Busca global (Ctrl+Shift+F) ------------------ */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [searchScanned, setSearchScanned] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  /** Busca na toolbar: icon-button que expande em campo (Enter abre resultados). */
  const [toolSearch, setToolSearch] = useState(false);
  const toolSearchRef = useRef<HTMLInputElement>(null);

  function expandToolbarSearch() {
    setToolSearch(true);
    window.setTimeout(() => toolSearchRef.current?.focus(), 80);
  }

  async function runProjectSearch(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query || searchBusy) return;
    setSearchBusy(true);
    setSearchDone(false);
    setSearchResults([]);
    try {
      const all = await ensureIndex();
      const targets = all.filter((file) => isTextFile(file.name)).slice(0, SEARCH_FILE_LIMIT);
      setSearchScanned(targets.length);
      const needle = query.toLowerCase();
      const currentRoot = useCode.getState().root;
      const results: SearchResult[] = [];
      outer: for (const file of targets) {
        const content = await fsRead(currentRoot, file.path).catch(() => "");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(needle)) continue;
          results.push({ path: file.path, line: index + 1, preview: lines[index].trim().slice(0, 160) });
          if (results.length >= SEARCH_RESULT_LIMIT) break outer;
        }
      }
      setSearchResults(results);
    } finally {
      setSearchBusy(false);
      setSearchDone(true);
    }
  }

  function submitToolbarSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setToolSearch(false);
    setSearchOpen(true);
    void runProjectSearch(query);
  }

  function openSearchResult(result: SearchResult) {
    pendingRevealRef.current = { path: result.path, line: result.line };
    setSearchOpen(false);
    const state = useCode.getState();
    const alreadyActive =
      state.activePath === result.path &&
      state.files.some((file) => file.path === result.path && !file.loading);
    openFile({ name: baseName(result.path), path: result.path });
    if (alreadyActive) {
      pendingRevealRef.current = null;
      editorApiRef.current?.revealLine(result.line);
    }
  }

  // Revela a linha pendente quando o arquivo terminar de abrir/carregar.
  useEffect(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    const file = files.find((item) => item.path === pending.path);
    if (!file || file.loading || activePath !== pending.path) return;
    pendingRevealRef.current = null;
    window.setTimeout(() => editorApiRef.current?.revealLine(pending.line), 30);
  }, [files, activePath]);

  /* --------------------- Diff + aplicar código da IA ---------------- */
  const [diffView, setDiffView] = useState<DiffModal | null>(null);
  /** Hunks marcados no modal — aceitar o diff é por bloco, não tudo ou nada. */
  const [pickedHunks, setPickedHunks] = useState<ReadonlySet<string>>(new Set());

  function openDiff(modal: DiffModal) {
    setDiffView(modal);
    setPickedHunks(new Set(modal.patch?.hunks.map((hunk) => hunk.id) ?? []));
  }

  function toggleHunk(id: string) {
    setPickedHunks((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Blocos de código da última resposta de assistente do thread code. */
  const aiBlocks = useMemo(() => {
    const last = [...codeMessages].reverse().find((message) => message.role === "assistant");
    if (!last) return [] as Array<Extract<BlockToken, { kind: "code" }>>;
    return parseMarkdown(last.content).filter(
      (block): block is Extract<BlockToken, { kind: "code" }> => block.kind === "code"
    );
  }, [codeMessages]);

  function showLocalDiff() {
    const file = activeFile();
    if (!file || file.loading) return;
    openDiff({
      title: `Alterações não salvas — ${file.name}`,
      lines: computeDiff(file.savedContent, file.content)
    });
  }

  function previewApplyAi() {
    const file = activeFile();
    const block = aiBlocks.at(-1);
    if (!file || file.loading || !block) return;
    const code = block.text.replace(/\n$/, "");
    const selection = editorApiRef.current?.getSelection();
    const hasSelection = !!selection && selection.from !== selection.to;
    const next =
      hasSelection && selection
        ? file.content.slice(0, selection.from) + code + file.content.slice(selection.to)
        : code;
    openDiff({
      title: `Aplicar código da IA — ${file.name} (${hasSelection ? "seleção" : "arquivo inteiro"})`,
      lines: computeDiff(file.content, next),
      note: isTauriHost
        ? "Ao aplicar, o arquivo é gravado no disco via fs_write."
        : "Navegador: aplica apenas no buffer aberto — a persistência em disco requer o app desktop.",
      patch: {
        before: file.content,
        after: next,
        hunks: splitIntoHunks(file.content, next),
        apply: (result) => {
          setDiffView(null);
          void applyContent(file.path, result);
        }
      }
    });
  }


  /* --------------------------- Atalhos globais ---------------------- */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.shiftKey && key === "s") {
        event.preventDefault();
        void saveActive();
      } else if (event.ctrlKey && !event.shiftKey && key === "p") {
        event.preventDefault();
        openQuick();
      } else if (event.ctrlKey && event.shiftKey && key === "f") {
        event.preventDefault();
        setSearchOpen(true);
        setSearchDone(false);
      } else if (key === "escape") {
        setQuickOpen(false);
        setSearchOpen(false);
        setDiffView(null);
        setOrcOpen(false);
        setToolSearch(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ Terminal ------------------------- */
  const [command, setCommand] = useState("");
  const [termLines, setTermLines] = useState<string[]>([
    isTauriHost
      ? "composer cli — comandos executam na raiz do projeto · Ctrl+P abre arquivos"
      : "modo demonstração — comandos reais no app desktop"
  ]);
  const [termBusy, setTermBusy] = useState(false);
  /** Último bloco de código vindo da IA — `run` executa com detecção ultra. */
  const [lastAiCode, setLastAiCode] = useState<{ code: string; hint: string } | null>(null);
  const termRef = useRef<HTMLPreElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [termLines]);

  /** Executa código-fonte: detecta a linguagem, grava temporário real e roda. */
  async function runDetectedSource(source: string, hintedLanguage?: string) {
    const detected = detectLanguage(hintedLanguage ? `x.${hintedLanguage}` : source) ?? detectLanguage(source);
    if (!detected) {
      setTermLines((lines) => [...lines, "ultra: não reconheci a linguagem — cole código ou informe um arquivo."]);
      return;
    }
    if (!detected.run) {
      setTermLines((lines) => [
        ...lines,
        `ultra: ${detected.language} detectado (${detected.via}) — sem runner direto; use a aba Data para SQL.`
      ]);
      return;
    }
    const tempFile = `.ultra_tmp.${detected.extension}`;
    const command = detected.run(tempFile);
    setTermLines((lines) => [...lines, `↳ ultra: ${detected.language} (${detected.via}) → ${command}`]);
    if (!isTauriHost) {
      setTermLines((lines) => [...lines, "modo demonstração — a execução real acontece no app desktop."]);
      return;
    }
    setTermBusy(true);
    try {
      const currentRoot = useCode.getState().root;
      await fsWrite(currentRoot, tempFile, source);
      const result = await terminal.execute(command, currentRoot === "." ? undefined : currentRoot);
      const output = [result.stdout, result.stderr].filter(Boolean).join("");
      setTermLines((lines) => [...lines, output || "(sem saída)", `[exit ${result.exitCode ?? "n/a"} · ${result.durationMs} ms]`, ""]);
    } catch (cause) {
      setTermLines((lines) => [...lines, cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setTermBusy(false);
    }
  }

  async function runCommandText(raw: string) {
    const cmd = raw.trim();
    if (!cmd || termBusy) return;
    // `ai <pergunta>` — CLI agêntico nativo (estilo opencode): a pergunta vai
    // ao motor da aba; a resposta é espelhada e blocos de código ficam
    // prontos para `run` (execução com detecção ultra de linguagem).
    if (/^ai\s+\S/i.test(cmd)) {
      const question = cmd.replace(/^ai\s+/i, "");
      // Evita inscrição dupla no store (sairia duplicado) enquanto o agente responde.
      if (useApp.getState().threads.code.sending) {
        setTermLines((lines) => [...lines, `$ ${cmd}`, "o agente ainda está respondendo — aguarde a resposta anterior."]);
        return;
      }
      setTermLines((lines) => [...lines, `$ ${cmd}`, `→ agente (${engineLabel})…`]);
      const unsubscribe = useApp.subscribe((state, previous) => {
        if (previous.threads.code.sending && !state.threads.code.sending) {
          const last = state.threads.code.messages.at(-1);
          if (last?.role === "assistant" && last.content) {
            const codeBlocks = parseMarkdown(last.content).filter(
              (block): block is Extract<BlockToken, { kind: "code" }> => block.kind === "code"
            );
            const chosen = codeBlocks.at(-1);
            if (chosen?.text.trim()) {
              setLastAiCode({ code: chosen.text, hint: chosen.language });
              setTermLines((lines) => [
                ...lines,
                last.content,
                `↳ bloco de código recebido — digite "run" para executar com detecção automática.`,
                ""
              ]);
            } else {
              setTermLines((lines) => [...lines, last.content, ""]);
            }
          }
          unsubscribe();
        }
      });
      composerBus.send(question);
      return;
    }

    // `run` — executa o último bloco de código da IA (ultra-terminal).
    if (/^run$/i.test(cmd)) {
      setTermLines((lines) => [...lines, `$ ${cmd}`]);
      if (!lastAiCode) {
        setTermLines((lines) => [...lines, 'nada para executar — peça código com "ai <pergunta>" primeiro.']);
        return;
      }
      await runDetectedSource(lastAiCode.code, lastAiCode.hint || undefined);
      return;
    }

    // Arquivo executável direto (ex.: "main.py") — roda com o runtime certo.
    if (isRunnableFileInput(cmd)) {
      const detected = detectByFileName(cmd.replace(/^["']|["']$/g, ""));
      if (detected?.run) {
        const command = detected.run(cmd.replace(/^["']|["']$/g, ""));
        setTermLines((lines) => [...lines, `↳ ultra: ${detected.language} (extensão) → executando`]);
        await runCommandText(command);
        return;
      }
    }
    setTermBusy(true);
    setTermLines((lines) => [...lines, `$ ${cmd}`]);
    try {
      if (isTauriHost) {
        const currentRoot = useCode.getState().root;
        const result = await terminal.execute(cmd, currentRoot === "." ? undefined : currentRoot);
        const output = [result.stdout, result.stderr].filter(Boolean).join("");
        const missing = result.runtimeRequired
          ? `Runtime "${result.runtimeRequired}" não instalado — instale em Configurações.\n`
          : "";
        setTermLines((lines) => [
          ...lines,
          `${output}${missing}[exit ${result.exitCode ?? "n/a"} · ${result.durationMs} ms]`
        ]);
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        setTermLines((lines) => [...lines, `modo demonstração — "${cmd}" executa no app desktop.`]);
      }
    } catch (cause) {
      setTermLines((lines) => [...lines, cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setTermBusy(false);
    }
  }

  function onPromptKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const cmd = command;
    setCommand("");
    void runCommandText(cmd);
  }

  /* ------------------- Orquestrador (popup na toolbar) -------------- */
  const [orcOpen, setOrcOpen] = useState(false);
  const orcRef = useRef<HTMLDivElement>(null);
  const [stages, setStages] = useState<Array<{ name: string; engine: string }>>([
    { name: "Tickets", engine: "Planner" },
    { name: "Implement", engine: "Code agents" },
    { name: "Review", engine: "CI + revisor" },
    { name: "Merge", engine: "Gate humano" }
  ]);
  const [validation, setValidation] = useState("Pronto para validar");
  const [validating, setValidating] = useState(false);

  // Fecha o popup ao clicar fora do botão/menu.
  useEffect(() => {
    if (!orcOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (orcRef.current && event.target instanceof Node && !orcRef.current.contains(event.target)) {
        setOrcOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [orcOpen]);

  async function validatePipeline() {
    if (!session) {
      setValidation("Conecte o gateway para validar o pipeline.");
      return;
    }
    const graph: OrchestrationGraph = {
      schemaVersion: 1,
      name: "code-pipeline",
      maxConcurrency: 4,
      nodes: stages.map((item, index) => ({
        id: `code-${index + 1}`,
        name: item.name,
        kind:
          index === 0
            ? "input"
            : item.engine.toLowerCase().includes("humano")
              ? "human"
              : index === stages.length - 1
                ? "gate"
                : "agent",
        mode: "code",
        dependsOn: index ? [`code-${index}`] : [],
        config: { model: item.engine, retries: 2, timeoutMs: 1_200_000 }
      }))
    };
    setValidating(true);
    setValidation("Calculando ondas e caminho crítico…");
    try {
      const plan = await validateOrchestration(session, graph);
      setValidation(
        `${plan.waves.length} ondas · paralelo ${plan.maxParallelism} · crítico ${plan.criticalPath.length}`
      );
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setValidating(false);
    }
  }

  const engineSelection = settings.engines.code;
  const engineLabel = describeSelection(engineSelection, settings.fusionPresets, settings.modelCatalog);
  const activePreset =
    engineSelection.kind === "fusion"
      ? settings.fusionPresets.find((preset) => preset.id === engineSelection.presetId)
      : undefined;

  /* ------------------------------- Render --------------------------- */
  const rootLabel = root === "." ? "ai-orchestrator" : root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? root;
  const diffChanges = diffView ? diffStats(diffView.lines) : null;
  const diffHasChanges = !!diffChanges && diffChanges.added + diffChanges.removed > 0;
  const patch = diffView?.patch;
  const pickedCount = patch ? patch.hunks.filter((hunk) => pickedHunks.has(hunk.id)).length : 0;

  function applyPicked() {
    if (!patch) return;
    patch.apply(applySelectedHunks(patch.before, patch.hunks, pickedHunks));
  }

  return (
    <Surface className="codex-surface">
      <TopbarActions>
        {saveState === "saved" && (
          <span
            className="chip ok codex-saved"
            title={isTauriHost ? "Gravado em disco via fs_write" : "Navegador: só o buffer aberto — disco real no app desktop"}
          >
            <Check size={11} />
            {isTauriHost ? "salvo" : "salvo no buffer (demo)"}
          </span>
        )}
        {saveState === "error" && <span className="chip danger codex-saved">erro ao salvar</span>}
        <div className={`codex-toolbar-search ${toolSearch ? "open" : ""}`}>
          <button
            className="icon-button"
            onClick={expandToolbarSearch}
            title="Busca literal no projeto (Ctrl+Shift+F)"
            aria-label="Buscar no projeto"
            aria-expanded={toolSearch}
          >
            <Search size={14} />
          </button>
          <input
            ref={toolSearchRef}
            value={searchQuery}
            disabled={!toolSearch}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitToolbarSearch();
              else if (event.key === "Escape") setToolSearch(false);
            }}
            onBlur={() => setToolSearch(false)}
            placeholder="buscar no projeto…"
            aria-label="Busca literal no projeto"
          />
        </div>
        {aiBlocks.length > 0 && (
          <button
            className="lg-button"
            onClick={previewApplyAi}
            disabled={!active || active.loading}
            title={`Aplica o último dos ${aiBlocks.length} bloco(s) de código da resposta da IA — preview em diff antes`}
          >
            <WandSparkles size={13} />
            Aplicar IA
          </button>
        )}
        <button
          className="lg-button ghost"
          onClick={showLocalDiff}
          disabled={!active || active.loading}
          title="Diff do buffer atual vs conteúdo salvo em disco"
        >
          <FileDiff size={13} />
          Ver alterações
        </button>
        <button
          className="lg-button"
          onClick={() => void saveActive()}
          disabled={!active || active.loading || saveState === "saving"}
          title={
            isTauriHost
              ? "Salvar arquivo ativo (Ctrl+S)"
              : "Salvar (Ctrl+S) — navegador: atualiza só o buffer; gravação em disco no app desktop"
          }
        >
          <Save size={13} />
          {saveState === "saving" ? "Salvando…" : "Salvar"}
        </button>
        <div className="codex-orc-anchor" ref={orcRef}>
          <button
            className={`lg-button ghost ${orcOpen ? "codex-orc-on" : ""}`}
            onClick={() => setOrcOpen((open) => !open)}
            aria-expanded={orcOpen}
            aria-haspopup="dialog"
            title="Configuração do pipeline de orquestração"
          >
            <Network size={13} />
            Orquestrador
          </button>
          {orcOpen && (
            <div className="codex-orc-menu" role="dialog" aria-label="Configuração do orquestrador">
              <header className="codex-orc-head">
                <Network size={13} />
                <strong>Pipeline de código</strong>
                <small>{stages.length} estágios</small>
              </header>
              <div className="codex-orc-scroll">
                <div className="codex-stages">
                  {stages.map((item, index) => (
                    <div className="codex-stage" key={`${item.name}-${index}`}>
                      <span className={`codex-stage-index s${index % 4}`}>{String(index + 1).padStart(2, "0")}</span>
                      <span className="codex-stage-copy">
                        <strong>{item.name}</strong>
                        <small>{item.engine}</small>
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  className="codex-add-stage"
                  onClick={() =>
                    setStages((items) => [...items, { name: `Gate ${items.length + 1}`, engine: "Aprovação humana" }])
                  }
                >
                  <Plus size={12} />
                  Adicionar estágio
                </button>
                <button
                  className="lg-button primary codex-validate"
                  onClick={() => void validatePipeline()}
                  disabled={validating}
                >
                  <ShieldCheck size={13} />
                  {validating ? "Validando…" : "Validar pipeline"}
                </button>
                <span className="codex-validation">
                  <ShieldCheck size={11} />
                  {validation}
                </span>
                <div className="codex-fusion">
                  <header>
                    <span>
                      <Merge size={13} />
                    </span>
                    <div>
                      <strong>{engineLabel}</strong>
                      <small>motor da aba Code</small>
                    </div>
                  </header>
                  {activePreset ? (
                    <p>
                      Estratégia {activePreset.strategy} · orquestrador {activePreset.orchestrator.model} ·{" "}
                      {activePreset.executors.length} executor(es).
                    </p>
                  ) : (
                    <p>
                      {engineSelection.kind === "workspace"
                        ? "Roteado pelo gateway do workspace, com fallbacks configurados."
                        : engineSelection.kind === "local"
                          ? "Executa no runtime local GGUF, sem sair da máquina."
                          : "Modelo direto via chave no keyring nativo (BYOK)."}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </TopbarActions>

      <VBody>
        <VCenter className="codex-center">
          {sending && <FloatingPulse label={stage || "Processando"} detail="Gerando patch e validando mudanças" />}

          {files.length > 0 && (
            <div className="codex-tabs" role="tablist" aria-label="Arquivos abertos">
              {files.map((file) => (
                <div
                  key={file.path}
                  role="tab"
                  tabIndex={0}
                  aria-selected={activePath === file.path}
                  className={`codex-tab ${activePath === file.path ? "active" : ""}`}
                  onClick={() => setActivePath(file.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setActivePath(file.path);
                  }}
                  title={file.path}
                >
                  <FileCode2 size={12} />
                  {file.name}
                  {file.dirty && <i className="codex-dirty" />}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      closeFile(file.path);
                    }}
                    aria-label={`Fechar ${file.name}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {active && (
            <div className="codex-editor">
              <CodeEditor
                value={active.content}
                fileName={active.name}
                onChange={changeActive}
                apiRef={editorApiRef}
                inlineSuggestion={inlineSuggestion}
              />
              {active.loading && <div className="codex-editor-loading">lendo {active.path}…</div>}
            </div>
          )}

          <div
            className={`glass-terminal codex-term ${active ? "dock" : "full"}`}
            onClick={() => promptRef.current?.focus()}
          >
            <pre ref={termRef} aria-live="polite">
              {termLines.map((line, index) => (
                <span className="codex-term-line" key={index}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
            <div className="codex-prompt">
              <span className="codex-prompt-sign">$</span>
              <span className="codex-prompt-line">
                {!command && <i className="codex-caret" aria-hidden="true" />}
                <input
                  ref={promptRef}
                  className={command ? "" : "no-caret"}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={onPromptKeyDown}
                  disabled={termBusy}
                  aria-label="Comando do terminal — ai fala com o agente; arquivos e código rodam com detecção automática"
                  placeholder='comando, arquivo (auto-detect) ou "ai <pergunta>"'
                  onPaste={(event) => {
                    const text = event.clipboardData.getData("text");
                    if (text.includes("\n") && detectLanguage(text)) {
                      // Código multilinha colado: ultra-terminal detecta e executa.
                      event.preventDefault();
                      setTermLines((lines) => [...lines, "$ (código colado)"]);
                      void runDetectedSource(text);
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>
            </div>
          </div>

          {quickOpen && (
            <div className="codex-overlay top" onClick={() => setQuickOpen(false)}>
              <div className="codex-quick" role="dialog" aria-label="Quick Open" onClick={(event) => event.stopPropagation()}>
                <header>
                  <Search size={13} />
                  <input
                    autoFocus
                    value={quickQuery}
                    onChange={(event) => {
                      setQuickQuery(event.target.value);
                      setQuickIndex(0);
                    }}
                    onKeyDown={onQuickKeyDown}
                    placeholder="Buscar arquivo pelo nome…"
                    aria-label="Quick Open — busca fuzzy de arquivos"
                  />
                  {!isTauriHost && <span className="chip warn">demo</span>}
                </header>
                <div className="codex-quick-list">
                  {quickFiles === null ? (
                    <span className="codex-tree-note">indexando arquivos…</span>
                  ) : !quickHits.length ? (
                    <span className="codex-tree-note">nenhum arquivo corresponde</span>
                  ) : (
                    quickHits.map((hit, index) => (
                      <button
                        key={hit.path}
                        className={`codex-quick-item ${index === quickIndex ? "active" : ""}`}
                        onMouseEnter={() => setQuickIndex(index)}
                        onClick={() => openQuickHit(hit.path)}
                        title={hit.path}
                      >
                        <FileCode2 size={12} />
                        <strong>{baseName(hit.path)}</strong>
                        <small>{hit.path}</small>
                      </button>
                    ))
                  )}
                </div>
                <footer>
                  ↑↓ navega · Enter abre · Esc fecha
                  {quickFiles
                    ? ` · ${quickFiles.length} arquivo(s) indexados (máx. ${INDEX_LIMITS.maxEntries}, profundidade ${INDEX_LIMITS.maxDepth})`
                    : ""}
                  {!isTauriHost && " · árvore demo — o app desktop indexa o projeto real"}
                </footer>
              </div>
            </div>
          )}

          {searchOpen && (
            <div className="codex-overlay top" onClick={() => setSearchOpen(false)}>
              <div
                className="codex-quick"
                role="dialog"
                aria-label="Busca no projeto"
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <Search size={13} />
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void runProjectSearch(searchQuery);
                      else if (event.key === "Escape") setSearchOpen(false);
                    }}
                    placeholder="Busca literal no projeto…"
                    aria-label="Busca literal no projeto"
                  />
                  {!isTauriHost && <span className="chip warn">demo</span>}
                  <button
                    className="lg-button"
                    onClick={() => void runProjectSearch(searchQuery)}
                    disabled={searchBusy || !searchQuery.trim()}
                  >
                    {searchBusy ? "Buscando…" : "Buscar"}
                  </button>
                </header>
                <div className="codex-quick-list">
                  {searchBusy && <span className="codex-tree-note">varrendo arquivos…</span>}
                  {!searchBusy && searchDone && !searchResults.length && (
                    <span className="codex-tree-note">nenhuma ocorrência</span>
                  )}
                  {searchResults.map((result, index) => (
                    <button
                      key={`${result.path}:${result.line}:${index}`}
                      className="codex-quick-item"
                      onClick={() => openSearchResult(result)}
                      title={`${result.path}:${result.line}`}
                    >
                      <FileCode2 size={12} />
                      <strong>
                        {baseName(result.path)}:{result.line}
                      </strong>
                      <small>{result.preview || " "}</small>
                    </button>
                  ))}
                </div>
                <footer>
                  {searchDone
                    ? `${searchResults.length} ocorrência(s) em ${searchScanned} arquivo(s) de texto (máx. ${SEARCH_FILE_LIMIT})`
                    : "Enter busca · Esc fecha · clique abre em arquivo:linha"}
                  {!isTauriHost && " · arquivos demo — o app desktop varre o projeto real"}
                </footer>
              </div>
            </div>
          )}

          {diffView && (
            <div className="codex-overlay" onClick={() => setDiffView(null)}>
              <div
                className="codex-quick codex-modal"
                role="dialog"
                aria-label={diffView.title}
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <FileDiff size={13} />
                  <strong className="codex-modal-title">{diffView.title}</strong>
                  <span className={`chip ${diffHasChanges ? "warn" : "ok"}`}>
                    {diffChanges && diffHasChanges
                      ? `+${diffChanges.added} −${diffChanges.removed}`
                      : "sem alterações"}
                  </span>
                  <button className="icon-button" onClick={() => setDiffView(null)} aria-label="Fechar diff">
                    <X size={13} />
                  </button>
                </header>
                <div className="codex-diff-scroll">
                  {patch && patch.hunks.length > 0 ? (
                    patch.hunks.map((hunk) => {
                      const picked = pickedHunks.has(hunk.id);
                      return (
                        <div className="diff-block" style={HUNK_BLOCK} key={hunk.id}>
                          <label style={{ ...HUNK_HEAD, ...(picked ? HUNK_HEAD_ON : null) }}>
                            <input
                              type="checkbox"
                              checked={picked}
                              onChange={() => toggleHunk(hunk.id)}
                              style={HUNK_CHECK}
                              aria-label={`Selecionar bloco ${hunk.header}`}
                            />
                            <code style={HUNK_HEADER_TEXT}>{hunk.header}</code>
                            <span className="chip">
                              +{hunk.added} −{hunk.removed}
                            </span>
                          </label>
                          {hunk.lines.map((line, index) => (
                            <div
                              className={`diff-line ${line.type === "add" ? "add" : line.type === "remove" ? "remove" : ""}`}
                              key={index}
                            >
                              <span>{line.type === "add" ? line.bLine : line.aLine}</span>
                              <code>{line.text || " "}</code>
                            </div>
                          ))}
                        </div>
                      );
                    })
                  ) : (
                    <div className="diff-block">
                      {toHunks(diffView.lines, 2).map((part, index) =>
                        part.type === "skip" ? (
                          <div className="diff-line codex-diff-skip" key={index}>
                            <span>···</span>
                            <code>{part.count} linha(s) sem alteração</code>
                          </div>
                        ) : (
                          <div
                            className={`diff-line ${part.type === "add" ? "add" : part.type === "remove" ? "remove" : ""}`}
                            key={index}
                          >
                            <span>{part.type === "add" ? part.bLine : part.aLine}</span>
                            <code>{part.text || " "}</code>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
                {diffView.note && <p className="codex-modal-note">{diffView.note}</p>}
                <footer className="codex-modal-actions">
                  {patch && patch.hunks.length > 0 && (
                    <span className="chip" style={HUNK_COUNTER}>
                      {pickedCount} de {patch.hunks.length} bloco(s)
                    </span>
                  )}
                  <button className="lg-button ghost" onClick={() => setDiffView(null)}>
                    Fechar
                  </button>
                  {patch && (
                    <>
                      <button
                        className="lg-button"
                        onClick={applyPicked}
                        disabled={pickedCount === 0}
                        title="Grava só os blocos marcados — o resto do arquivo fica como está"
                      >
                        <Check size={13} />
                        Aplicar selecionados
                      </button>
                      <button
                        className="lg-button primary"
                        onClick={() => patch.apply(patch.after)}
                        disabled={!diffHasChanges}
                        title="Grava o arquivo inteiro como a IA propôs"
                      >
                        <Check size={13} />
                        Aplicar tudo
                      </button>
                    </>
                  )}
                </footer>
              </div>
            </div>
          )}
        </VCenter>
      </VBody>

      <VStatus>
        <span title={`Raiz do projeto: ${root} — configurável no rail`}>
          <FolderOpen size={11} />
          {rootLabel}
        </span>
        <span>
          <FileCode2 size={11} />
          {active ? active.name : "nenhum arquivo aberto"}
          {active?.dirty && <i className="codex-dirty" />}
        </span>
        <span title="Estado do terminal integrado desta aba">
          <TerminalIcon size={11} />
          terminal {termBusy ? "executando…" : "ocioso"}
        </span>
        <span title="Motor real da aba Code (settings.engines.code) — altere em Configurações → Motores">
          <Merge size={11} />
          {engineLabel}
        </span>
        <span
          className="chip accent"
          title={'CLI agêntico nativo: "ai <pergunta>" fala com o motor da aba; "run" executa o último código da IA; arquivos e código colado rodam com detecção automática de linguagem (extensão → shebang → conteúdo)'}
        >
          cli · ultra{lastAiCode ? " · run pronto" : ""}
        </span>
      </VStatus>
    </Surface>
  );
}
