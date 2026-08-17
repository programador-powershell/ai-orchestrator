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
  useCallback,
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
  Hash,
  Merge,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  WandSparkles,
  X
} from "lucide-react";
import type { FsEntry, OrchestrationGraph } from "@orchestrator/contracts";
import {
  CodeEditor,
  type CodeEditorApi,
  type InlineSuggestionContext,
  type SuggestState
} from "../components/CodeEditor";
import { FloatingPulse, Surface, TopbarActions, VBody, VCenter, VStatus } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { Terminal } from "../components/Terminal";
import { computeDiff, diffStats, toHunks, type DiffLine } from "../lib/diff";
import { applySelectedHunks, splitIntoHunks, type Hunk } from "../lib/hunks";
import { suggestIdentifier } from "../lib/inlineSuggest";
import {
  buildFimContext,
  buildFimRequest,
  completionKey,
  sanitizeCompletion,
  shouldComplete
} from "../lib/fim";
import { buildIndex, searchSymbols, type CodeSymbol } from "../lib/symbols";
import { chatOnce, describeSelection } from "../lib/engine";
import { composerBus } from "../lib/ops";
import { collectFiles, fsList, fsRead, fsRemove, fsWrite, isTauriFs } from "../lib/fsx";
import { detectByFileName, detectLanguage, isRunnableFileInput } from "../lib/langDetect";
import { fuzzyRank } from "../lib/fuzzy";
import { validateOrchestration } from "../lib/gateway";
import { parseMarkdown, type BlockToken } from "../lib/markdown";
import { useApp } from "../lib/store";
import { terminal } from "../lib/terminal";
import { emptyHistory, recallNext, recallPrev, remember } from "../lib/termHistory";
import { exitLine, line, pushLines, splitOutput, type TermLine } from "../lib/termLog";

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
  /**
   * A raiz de onde o arquivo VEIO.
   *
   * Sem isto, trocar o projeto no rail e apertar Ctrl+S gravava o conteúdo do
   * projeto antigo dentro do novo — `src/config.json` de A sobrescrevia o
   * `src/config.json` de B em silêncio, porque a gravação usava a raiz
   * corrente. O caminho relativo coincide com frequência (README.md,
   * package.json); o arquivo, não. Cada aba grava onde nasceu.
   */
  root: string;
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
  background: "var(--term-bg-dark)",
  borderBottom: "1px solid var(--term-selection-border)",
  color: "var(--term-gray)",
  cursor: "pointer"
};
const HUNK_HEAD_ON: CSSProperties = { background: "var(--term-bg-highlight)", color: "var(--term-fg)" };
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
      { path: entry.path, name: entry.name, content: "", savedContent: "", dirty: false, loading: true, root }
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
    // `file.root`, não a raiz corrente: a aba pertence ao projeto de onde foi
    // aberta, mesmo que o rail já aponte para outro.
    await fsWrite(file.root, file.path, file.content);
    patchFile(file.path, (atual) => ({
      // Editar durante o await é possível (gravação lenta, rota SSH). Marcar
      // limpo ali apagava o indicador de sujo com o texto já diferente do que
      // foi gravado, e a pessoa fechava a aba confiando no chip "salvo".
      dirty: atual.content !== file.content,
      savedContent: file.content
    }));
    useCode.setState({ saveState: "saved" });
    scheduleSavedReset();
  } catch {
    useCode.setState({ saveState: "error" });
  }
}

async function applyContent(path: string, next: string): Promise<void> {
  if (isTauriHost) {
    const alvo = useCode.getState().files.find((file) => file.path === path);
    useCode.setState({ saveState: "saving" });
    try {
      await fsWrite(alvo?.root ?? useCode.getState().root, path, next);
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

  // O completar por modelo vive num callback estável (o editor guarda a
  // referência): ler o estado por ref evita capturar uma sessão vencida.
  const runtimeRunning = useApp((state) => state.runtimeStatus.running);
  const settingsRef = useRef(settings);
  const sessionRef = useRef(session);
  const runtimeRef = useRef(runtimeRunning);
  settingsRef.current = settings;
  sessionRef.current = session;
  runtimeRef.current = runtimeRunning;

  /* ---------------------- Índice de símbolos ------------------------ */
  /**
   * Indexa os arquivos ABERTOS. Varrer o projeto inteiro exigiria ler todo o
   * disco a cada abertura da paleta; os arquivos abertos são os que a pessoa
   * está de fato navegando, e o custo é proporcional ao que ela mexeu.
   */
  const symbolIndex = useMemo(
    () => buildIndex(files.filter((file) => !file.loading).map((file) => ({ path: file.path, text: file.content }))),
    [files]
  );
  const [suggestState, setSuggestState] = useState<SuggestState>("idle");

  /**
   * Completar por MODELO no ponto do cursor.
   *
   * Só é chamado quando a sugestão do buffer não achou nada (o editor decide).
   * O cache evita pagar duas vezes pelo mesmo ponto — voltar o cursor para
   * onde já se pediu é o movimento mais comum de todos.
   */
  const fimCacheRef = useRef(new Map<string, string | null>());
  const modelSuggestion = useCallback(
    async (context: InlineSuggestionContext): Promise<string | null> => {
      if (!shouldComplete(context.text, context.cursor)) return null;
      const fim = buildFimContext(context.text, context.cursor);
      const chave = completionKey(fim);
      const cache = fimCacheRef.current;
      if (cache.has(chave)) return cache.get(chave) ?? null;

      const atual = useCode.getState();
      const arquivo = atual.files.find((file) => file.path === atual.activePath);
      const request = buildFimRequest(fim, {
        language: arquivo ? detectByFileName(arquivo.name)?.language : undefined,
        symbols: symbolIndex.symbols
      });
      try {
        const bruto = await chatOnce(
          settingsRef.current.engines.code,
          "code",
          [
            { role: "system", content: request.system },
            { role: "user", content: request.user }
          ],
          {
            session: sessionRef.current,
            runtimeRunning: runtimeRef.current,
            fusionPresets: settingsRef.current.fusionPresets
          },
          { onDelta: () => undefined },
          context.signal
        );
        const limpo = sanitizeCompletion(bruto, fim);
        // Cache com teto: um mapa que só cresce viraria vazamento numa
        // sessão longa de edição.
        if (cache.size > 200) cache.clear();
        cache.set(chave, limpo);
        return limpo;
      } catch {
        return null;
      }
    },
    [symbolIndex]
  );

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

  /**
   * `@` na mesma caixa alterna para símbolos — a convenção que quem vem de
   * outro editor já tem no dedo, e uma tecla a menos para decorar.
   */
  const symbolMode = quickQuery.startsWith("@");
  const symbolHits = useMemo(() => {
    if (!symbolMode) return [];
    const termo = quickQuery.slice(1).trim();
    // Só `@`: lista tudo, para dar para navegar o arquivo sem saber o nome.
    // Devolver vazio aqui pareceria "não achei" tendo símbolo indexado.
    if (!termo) return symbolIndex.symbols.slice(0, 50);
    return searchSymbols(symbolIndex, termo, 50);
  }, [symbolMode, quickQuery, symbolIndex]);

  function openSymbol(symbol: CodeSymbol) {
    setQuickOpen(false);
    // O arquivo já está aberto (o índice só cobre abertos), então só resta
    // ativá-lo e pular para a linha.
    const jaAtivo = useCode.getState().activePath === symbol.file;
    setActivePath(symbol.file);
    // Com o arquivo já ativo, nem `files` nem `activePath` mudam: o efeito que
    // consome a pendência não roda e ela ficava ARMADA. Na digitação seguinte
    // (que muda `files`) o efeito disparava e o editor saltava de volta para a
    // linha do símbolo, no meio da escrita.
    pendingRevealRef.current = jaAtivo ? null : { path: symbol.file, line: symbol.line };
    editorApiRef.current?.revealLine(symbol.line);
  }

  function openQuickHit(path: string) {
    setQuickOpen(false);
    openFile({ name: baseName(path), path });
  }

  function onQuickKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // A navegação precisa seguir a lista que está NA TELA: com `@` a seleção
    // andaria sobre os arquivos enquanto os símbolos são exibidos.
    const total = symbolMode ? symbolHits.length : quickHits.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setQuickIndex((index) => Math.min(index + 1, Math.max(total - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setQuickIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (symbolMode) {
        const symbol = symbolHits[quickIndex] ?? symbolHits[0];
        if (symbol) openSymbol(symbol);
        return;
      }
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
  const [termLines, setTermLines] = useState<TermLine[]>([
    line(
      "note",
      isTauriHost
        ? 'composer cli — comandos rodam na raiz do projeto · "help" lista o que existe aqui'
        : 'modo demonstração — comandos reais no app desktop · "help" lista o que existe aqui'
    )
  ]);
  const [termBusy, setTermBusy] = useState(false);
  /** Histórico do prompt (↑/↓) — imutável, para o React comparar por referência. */
  const [history, setHistory] = useState(emptyHistory);
  /** Foco do prompt: o bloco do caret não pode piscar em terminal sem foco. */
  const [promptFocus, setPromptFocus] = useState(false);
  /**
   * Qual painel do terminal está à vista.
   *
   * Nasce em "shell": quem abre um terminal espera um terminal. O assistido
   * continua a um clique, porque falar com o agente pelo prompt e o gate de
   * código colado são recursos, não rascunho.
   */
  const [abaTerm, setAbaTerm] = useState<"shell" | "assistido">("shell");

  /** Empilha respeitando o teto do scrollback. */
  const append = useCallback((incoming: TermLine[]) => {
    setTermLines((current) => pushLines(current, incoming));
  }, []);
  /** Último bloco de código vindo da IA — `run` executa com detecção ultra. */
  const [lastAiCode, setLastAiCode] = useState<{ code: string; hint: string } | null>(null);
  /**
   * Código colado, ARMADO e não executado.
   *
   * Colar não pode ser gatilho de execução: uma página hostil consegue trocar
   * o conteúdo do clipboard no evento `copy` e o que a pessoa acha que copiou
   * (um comando de uma linha) vira um script inteiro rodando ao colar.
   */
  const [pastedCode, setPastedCode] = useState<{ code: string; hint: string } | null>(null);
  const termRef = useRef<HTMLPreElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [termLines]);

  /** Executa código-fonte: detecta a linguagem, grava temporário real e roda. */
  async function runDetectedSource(source: string, hintedLanguage?: string) {
    const detected = detectLanguage(hintedLanguage ? `x.${hintedLanguage}` : source) ?? detectLanguage(source);
    if (!detected) {
      append([line("error", "ultra: não reconheci a linguagem — cole código ou informe um arquivo.")]);
      return;
    }
    if (!detected.run) {
      append([
        line(
          "note",
          `ultra: ${detected.language} detectado (${detected.via}) — sem runner direto; use a aba Data para SQL.`
        )
      ]);
      return;
    }
    const tempFile = `.ultra_tmp.${detected.extension}`;
    const command = detected.run(tempFile);
    append([line("tool", `↳ ultra: ${detected.language} (${detected.via}) → ${command}`)]);
    if (!isTauriHost) {
      append([line("note", "modo demonstração — a execução real acontece no app desktop.")]);
      return;
    }
    setTermBusy(true);
    try {
      const currentRoot = useCode.getState().root;
      await fsWrite(currentRoot, tempFile, source);
      const result = await terminal.execute(command, currentRoot === "." ? undefined : currentRoot);
      append([
        ...splitOutput(result.stdout, "output"),
        ...splitOutput(result.stderr, "stderr"),
        ...(result.stdout || result.stderr ? [] : [line("meta", "(sem saída)")]),
        exitLine(result.exitCode, result.durationMs),
        line("output", "")
      ]);
    } catch (cause) {
      append([line("error", cause instanceof Error ? cause.message : String(cause))]);
    } finally {
      /*
       * O temporário sai do projeto.
       *
       * Ele ficava no working tree com o código gerado pela IA (ou colado)
       * dentro, aparecia no `git status` e podia ser commitado por acidente —
       * e o runner do Rust ainda deixa o `ultra_tmp.exe` ao lado. Apagar é
       * best-effort: falhar aqui não pode derrubar o resultado do comando.
       */
      await fsRemove(useCode.getState().root, tempFile).catch(() => undefined);
      setTermBusy(false);
    }
  }

  async function runCommandText(raw: string) {
    const cmd = raw.trim();
    if (!cmd || termBusy) return;

    // `clear` / `help` são do PROMPT, não do shell: mandar "clear" para o
    // cmd.exe limpava um console que ninguém vê e devolvia scrollback intacto.
    if (/^(clear|cls)$/i.test(cmd)) {
      setTermLines([]);
      return;
    }
    if (/^(help|\?)$/i.test(cmd)) {
      append([
        line("command", `$ ${cmd}`),
        line("note", "embutidos deste prompt:"),
        line("tool", "  ai <pergunta>   pergunta ao motor da aba; o código da resposta fica pronto para `run`"),
        line("tool", "  run             executa o último código colado ou vindo da IA (detecta a linguagem)"),
        line("tool", "  <arquivo>       main.py, script.ps1 … rodam com o runtime da extensão"),
        line("tool", "  clear · cls     limpa o scrollback     ↑ ↓ percorrem o histórico"),
        line("tool", "  help · ?        esta lista             Ctrl+L limpa · Ctrl+C descarta a linha"),
        line("note", "qualquer outra coisa vai para o shell, na raiz do projeto."),
        line("output", "")
      ]);
      return;
    }

    // `ai <pergunta>` — CLI agêntico nativo (estilo opencode): a pergunta vai
    // ao motor da aba; a resposta é espelhada e blocos de código ficam
    // prontos para `run` (execução com detecção ultra de linguagem).
    if (/^ai\s+\S/i.test(cmd)) {
      const question = cmd.replace(/^ai\s+/i, "");
      // Evita inscrição dupla no store (sairia duplicado) enquanto o agente responde.
      if (useApp.getState().threads.code.sending) {
        append([
          line("command", `$ ${cmd}`),
          line("error", "o agente ainda está respondendo — aguarde a resposta anterior.")
        ]);
        return;
      }
      append([line("command", `$ ${cmd}`), line("tool", `→ agente (${engineLabel})…`)]);
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
              append([
                ...splitOutput(last.content, "agent"),
                line("tool", '↳ bloco de código recebido — digite "run" para executar com detecção automática.'),
                line("output", "")
              ]);
            } else {
              append([...splitOutput(last.content, "agent"), line("output", "")]);
            }
          }
          unsubscribe();
        }
      });
      composerBus.send(question);
      return;
    }

    // `run` — executa o código colado ou o último bloco vindo da IA.
    if (/^run$/i.test(cmd)) {
      append([line("command", `$ ${cmd}`)]);
      // Colado tem prioridade: é o mais recente e foi a pessoa quem trouxe.
      const alvo = pastedCode ?? lastAiCode;
      if (!alvo) {
        append([line("error", 'nada para executar — cole um código ou peça um com "ai <pergunta>".')]);
        return;
      }
      setPastedCode(null);
      await runDetectedSource(alvo.code, alvo.hint || undefined);
      return;
    }

    // Arquivo executável direto (ex.: "main.py") — roda com o runtime certo.
    if (isRunnableFileInput(cmd)) {
      const detected = detectByFileName(cmd.replace(/^["']|["']$/g, ""));
      if (detected?.run) {
        const command = detected.run(cmd.replace(/^["']|["']$/g, ""));
        append([line("tool", `↳ ultra: ${detected.language} (extensão) → executando`)]);
        await runCommandText(command);
        return;
      }
    }
    setTermBusy(true);
    append([line("command", `$ ${cmd}`)]);
    try {
      if (isTauriHost) {
        const currentRoot = useCode.getState().root;
        const result = await terminal.execute(cmd, currentRoot === "." ? undefined : currentRoot);
        append([
          ...splitOutput(result.stdout, "output"),
          ...splitOutput(result.stderr, "stderr"),
          ...(result.runtimeRequired
            ? [line("error", `Runtime "${result.runtimeRequired}" não instalado — instale em Configurações.`)]
            : []),
          exitLine(result.exitCode, result.durationMs)
        ]);
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        append([line("note", `modo demonstração — "${cmd}" executa no app desktop.`)]);
      }
    } catch (cause) {
      append([line("error", cause instanceof Error ? cause.message : String(cause))]);
    } finally {
      setTermBusy(false);
    }
  }

  function onPromptKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // ↑/↓ percorrem o histórico; `value: null` = nada a recuperar, e nesse caso
    // o que está digitado fica intacto (o ↑ não pode apagar a linha).
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const { history: next, value } = recallPrev(history);
      setHistory(next);
      if (value !== null) setCommand(value);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const { history: next, value } = recallNext(history);
      setHistory(next);
      if (value !== null) setCommand(value);
      return;
    }
    // Ctrl+C descarta a linha e ecoa `^C`, como num shell. Ele NÃO interrompe
    // comando em execução: `terminal_execute` é uma chamada única sem
    // cancelamento, e um atalho que promete matar o processo sem matá-lo é
    // pior que atalho nenhum. Enquanto roda, o campo está desabilitado.
    if (event.ctrlKey && event.key.toLowerCase() === "c" && command) {
      event.preventDefault();
      append([line("command", `$ ${command}`), line("meta", "^C")]);
      setCommand("");
      setHistory((current) => ({ ...current, cursor: current.entries.length }));
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setTermLines([]);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const cmd = command;
    setCommand("");
    // O histórico grava o que a PESSOA digitou, e é registrado aqui — não
    // dentro de `runCommandText`. Ela chama a si mesma para o atalho de
    // arquivo executável (`main.py` → `python main.py`), e gravar lá punha as
    // duas linhas no histórico: o ↑ devolvia `python main.py`, que ninguém
    // escreveu, antes do `main.py` que foi escrito.
    setHistory((current) => remember(current, cmd));
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
                  className={`codex-tab ${activePath === file.path ? "active" : ""} ${
                    file.root !== root ? "outra-raiz" : ""
                  }`}
                  onClick={() => setActivePath(file.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setActivePath(file.path);
                  }}
                  title={
                    file.root === root
                      ? file.path
                      : `${file.path}\n(de ${file.root} — salvar grava lá, não no projeto aberto)`
                  }
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
                modelSuggestion={modelSuggestion}
                onSuggestState={setSuggestState}
              />
              {active.loading && <div className="codex-editor-loading">lendo {active.path}…</div>}
            </div>
          )}

          {/*
            DUAS coisas moram neste painel, e elas não são a mesma.

            "Shell" é o terminal de verdade: xterm.js sobre o PTY, com grade,
            cursor e sequências de escape — é onde `vim`, `htop` e um build
            colorido funcionam. É o padrão, porque é o que se espera de um
            terminal.

            "Assistido" é o prompt que já existia: `ai <pergunta>` fala com o
            agente, código colado é reconhecido e ARMADO em vez de executado,
            `run` dispara. Não é terminal, é um lançador com IA — e apagá-lo
            para pôr o shell no lugar teria jogado fora recurso que funciona.
          */}
          <div className={`codex-term ${active ? "dock" : "full"} ${abaTerm === "shell" ? "is-shell" : ""}`}>
            <div className="codex-term-tabs segmented segmented--acoes">
              <button
                type="button"
                className={abaTerm === "shell" ? "active" : ""}
                onClick={() => setAbaTerm("shell")}
                title="Terminal completo, sobre o PTY"
              >
                Shell
              </button>
              <button
                type="button"
                className={abaTerm === "assistido" ? "active" : ""}
                onClick={() => setAbaTerm("assistido")}
                title="Prompt com IA, execução de arquivo e gate de código colado"
              >
                Assistido
              </button>
            </div>
            {/*
              O shell fica MONTADO, escondido — como o painel assistido logo
              abaixo. Desmontar disparava a limpeza do efeito de sessão, que
              mata o PTY: ir ver uma resposta no Assistido e voltar encontrava
              o shell fechado, com o `cd`, o histórico e o processo em execução
              perdidos. Um terminal que não sobrevive a trocar de aba não é um
              terminal.
            */}
            <div className="codex-term-shell" hidden={abaTerm !== "shell"}>
              <Terminal cwd={root} />
            </div>
            <div className="codex-term-assistido" hidden={abaTerm === "shell"} onClick={() => promptRef.current?.focus()}>
            <pre ref={termRef} aria-live="polite">
              {termLines.map((item, index) => (
                <span className={`codex-term-line k-${item.kind}`} key={index}>
                  {item.text}
                  {"\n"}
                </span>
              ))}
            </pre>
            <div className={`codex-prompt ${promptFocus ? "focus" : ""} ${termBusy ? "busy" : ""}`}>
              <span className="codex-prompt-sign">{termBusy ? "…" : "$"}</span>
              <span className="codex-prompt-line">
                {/* Bloco do caret só com foco: sem isto o terminal parado exibia
                    um cursor piscando como se estivesse esperando digitação. */}
                {!command && promptFocus && !termBusy && <i className="codex-caret" aria-hidden="true" />}
                <input
                  ref={promptRef}
                  className={command ? "" : "no-caret"}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={onPromptKeyDown}
                  onFocus={() => setPromptFocus(true)}
                  onBlur={() => setPromptFocus(false)}
                  disabled={termBusy}
                  aria-label="Comando do terminal — ai fala com o agente; arquivos e código rodam com detecção automática; setas percorrem o histórico"
                  placeholder={termBusy ? "executando…" : 'comando, arquivo, "ai <pergunta>" ou "help"'}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData("text");
                    const detectado = text.includes("\n") ? detectLanguage(text) : null;
                    if (!detectado) return;
                    /**
                     * Colar ARMA, não dispara.
                     *
                     * Antes, colar texto multilinha reconhecido gravava o
                     * arquivo e executava na hora — sem Enter, sem prévia.
                     * Uma página hostil que troque o clipboard no evento
                     * `copy` (pastejacking) punha `import os; os.system(…)`
                     * onde a pessoa achava ter copiado um comando de uma
                     * linha, e o código rodava ao colar. Terminal de verdade
                     * resolve isso com bracketed paste: o texto entra, quem
                     * executa é o Enter.
                     */
                    event.preventDefault();
                    const linhas = text.split(/\r?\n/);
                    setPastedCode({ code: text, hint: detectado.extension });
                    append([
                      line("tool", `↳ colado: ${detectado.language} · ${linhas.length} linha(s) — NÃO executado`),
                      ...linhas.slice(0, 6).map((linha) => line("paste", `  │ ${linha}`)),
                      ...(linhas.length > 6 ? [line("paste", `  │ … +${linhas.length - 6} linha(s)`)] : []),
                      line("warning", 'confira acima e digite "run" para executar.'),
                      line("output", "")
                    ]);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>
            </div>
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
                    placeholder="Buscar arquivo pelo nome… (@ para símbolos)"
                    aria-label="Quick Open — busca fuzzy de arquivos e símbolos"
                  />
                  {symbolMode && <span className="chip accent">símbolos</span>}
                  {!isTauriHost && <span className="chip warn">demo</span>}
                </header>
                <div className="codex-quick-list">
                  {symbolMode ? (
                    !symbolHits.length ? (
                      <span className="codex-tree-note">
                        {symbolIndex.symbols.length
                          ? "nenhum símbolo corresponde"
                          : "abra um arquivo para indexar os símbolos dele"}
                      </span>
                    ) : (
                      symbolHits.map((symbol, index) => (
                        <button
                          key={`${symbol.file}:${symbol.line}:${symbol.name}`}
                          className={`codex-quick-item ${index === quickIndex ? "active" : ""}`}
                          onMouseEnter={() => setQuickIndex(index)}
                          onClick={() => openSymbol(symbol)}
                          title={`${symbol.file}:${symbol.line}`}
                        >
                          <span className="codex-sym-kind">{symbol.kind}</span>
                          <strong>{symbol.name}</strong>
                          <small>
                            {symbol.container ? `${symbol.container} · ` : ""}
                            {baseName(symbol.file)}:{symbol.line}
                          </small>
                        </button>
                      ))
                    )
                  ) : quickFiles === null ? (
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
                  {symbolMode
                    ? ` · ${symbolIndex.symbols.length} símbolo(s) nos ${symbolIndex.files.length} arquivo(s) abertos`
                    : quickFiles
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
        <span className={active?.dirty ? "codex-st-warn" : undefined}>
          <FileCode2 size={11} />
          {active ? active.name : "nenhum arquivo aberto"}
          {active?.dirty && <i className="codex-dirty" />}
        </span>
        <span
          className={termBusy ? "codex-st-run" : undefined}
          title="Estado do terminal integrado desta aba"
        >
          <TerminalIcon size={11} />
          terminal {termBusy ? "executando…" : "ocioso"}
        </span>
        {/* Chamada de modelo por tecla é dinheiro: a pessoa tem direito de
            ver quando ela acontece, e não descobrir na fatura. */}
        <span
          className={
            suggestState === "loading" ? "codex-st-run" : suggestState === "ready" ? "codex-st-ok" : undefined
          }
          title={
            suggestState === "loading"
              ? "Consultando o modelo para completar no cursor"
              : suggestState === "ready"
                ? "Sugestão do modelo pronta — Tab aceita"
                : "Completar por modelo: entra quando o buffer não tem o que sugerir"
          }
        >
          <Sparkles size={11} />
          {suggestState === "loading" ? "completando…" : suggestState === "ready" ? "Tab aceita" : "completar"}
        </span>
        <span title="Símbolos indexados dos arquivos abertos — @ no Ctrl+P busca neles">
          <Hash size={11} />
          {symbolIndex.symbols.length} símbolo(s)
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
