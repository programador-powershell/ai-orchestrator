/**
 * Superfície do especialista de código — agora uma IDE de verdade.
 *
 * O que mudou de fundamento: "Salvar" deixou de ser um pedido em texto ao
 * especialista e virou GRAVAÇÃO pela rota /v1/tools/call (fs.write). O portão
 * de aprovação continua o mesmo do turno — o cartão chega pelo WebSocket e a
 * barra mostra "aguardando aprovação" enquanto o POST espera a decisão.
 *
 * Sem CodeMirror — dependência fora da lista permitida. O editor segue um
 * `<textarea>` mono com calha de números sincronizada no scroll: imitar um
 * editor de verdade com regex custa caro e entrega pouco. O que importa é
 * abrir, ajustar, salvar — e navegar: Ctrl+P abre a paleta difusa de arquivos,
 * Ctrl+Shift+F busca no projeto (fs.search) com resultado clicável em
 * arquivo:linha, Ctrl+S grava.
 *
 * As abas moram no store da IDE (lib/ide/ideStore), compartilhado com o
 * FilesRail: clicar na árvore abre aba aqui. A conversa continua ao lado — é
 * ela quem opera o projeto junto com a pessoa — e arquivo que uma ferramenta
 * do especialista leu continua virando aba (a ponte abrirVindoDaConversa).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent
} from "react";
import {
  AlertTriangle,
  Check,
  FileCode2,
  GitCompare,
  Hourglass,
  Save,
  Search,
  Terminal,
  Wand2,
  X
} from "lucide-react";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { lastFencedBlock } from "../lib/markdown";
import { fuzzyRank } from "../lib/ide/fuzzy";
import { nomeBase, type EntradaProjeto, type OcorrenciaBusca } from "../lib/ide/projeto";
import {
  abrirArquivo,
  abrirVindoDaConversa,
  agendarAberturaDoBot,
  ativarArquivo,
  buscarNoProjeto,
  editarAtivo,
  fecharArquivo,
  indiceDeArquivos,
  indiceEmCache,
  salvarAtivo,
  sincronizarSessao,
  useIde
} from "../lib/ide/ideStore";
import { IconeDoArquivo } from "../shell/rails/FilesRail";
import { TopbarActions } from "../shell/TopbarActions";
import { SurfaceStatus } from "../shell/StatusBar";
import { ConversationSurface } from "./ConversationSurface";

/* ------------------------- leitura do que está no store ------------------- */

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

/**
 * A ponte conversa→abas: arquivo que uma ferramenta do ESPECIALISTA leu neste
 * turno também vira aba, com o conteúdo devolvido pela ferramenta. A pessoa e
 * o bot trabalham no mesmo palco — e quem manda no rascunho local continua
 * sendo a pessoa (a regra de não sobrescrever sujeira mora no ideStore).
 */
function coletarDaConversa(lines: ConversationLine[]): Array<{ path: string; content: string }> {
  const mapa = new Map<string, string>();
  for (const line of lines) {
    const resultados = new Map<string, ToolResult>();
    for (const resultado of line.toolResults ?? []) resultados.set(resultado.callId, resultado);
    for (const call of line.toolCalls ?? []) {
      const path = pathFromArgs(call.args);
      if (path === "" || !isReadTool(call.tool)) continue;
      const resultado = resultados.get(call.callId);
      if (resultado && resultado.ok) mapa.set(path, resultado.output ?? "");
    }
  }
  return [...mapa.entries()].map(([path, content]) => ({ path, content }));
}

/**
 * As gravações CONFIRMADAS do bot nesta conversa, em ordem de chegada — o
 * caminho vem do tool.call (o result só carrega callId e desfecho). Recusa
 * (ok:false) fica de fora: gravação que não aconteceu não abre arquivo nenhum.
 * É o gêmeo do contarGravacoesDoBot do FilesRail, só que com o PATH: a árvore
 * só precisa saber QUE o disco mudou; o editor precisa saber ONDE.
 */
function coletarGravacoesDoBot(lines: ConversationLine[]): string[] {
  const porCall = new Map<string, string>();
  for (const line of lines) {
    for (const call of line.toolCalls ?? []) {
      if (call.tool !== "fs.write" && call.tool !== "fs.patch") continue;
      const path = pathFromArgs(call.args);
      if (path !== "") porCall.set(call.callId, path);
    }
  }
  const out: string[] = [];
  for (const line of lines) {
    for (const resultado of line.toolResults ?? []) {
      if (!resultado.ok) continue;
      if (resultado.tool !== "fs.write" && resultado.tool !== "fs.patch") continue;
      const path = porCall.get(resultado.callId);
      if (path !== undefined) out.push(path);
    }
  }
  return out;
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
  const session = useApp((state) => state.session);
  const pendingApprovals = useApp((state) => state.pendingApprovals);

  const files = useIde((state) => state.files);
  const activePath = useIde((state) => state.activePath);
  const saveState = useIde((state) => state.saveState);
  const saveErro = useIde((state) => state.saveErro);
  const avisoDoBot = useIde((state) => state.avisoDoBot);

  // O projeto é o da SESSÃO: trocar de conversa troca de projeto, e as abas da
  // anterior não podem sobreviver apontando para arquivos de outro workspace.
  useEffect(() => {
    sincronizarSessao(session ?? "");
  }, [session]);

  const output = useMemo(() => collectOutput(lines), [lines]);
  const suggestion = useMemo(() => lastSuggestion(lines), [lines]);
  const daConversa = useMemo(() => coletarDaConversa(lines), [lines]);

  useEffect(() => {
    for (const item of daConversa) abrirVindoDaConversa(item.path, item.content);
  }, [daConversa]);

  /*
   * EDITOR AO VIVO: fs.write/fs.patch CONFIRMADO do bot na sessão aberta abre
   * o arquivo no palco — é aqui que o "nenhum arquivo aberto" morre quando o
   * especialista trabalha na janela dele. A guarda de turno-vivo é a mesma do
   * FilesRail: a primeira observação (montagem) só ANCORA o contador, queda
   * (troca de sessão zera as linhas) reancora, e só o AUMENTO abre. Reabrir
   * uma conversa antiga não pode sair abrindo abas que ninguém pediu.
   * A rajada vira UMA abertura (o último arquivo) — debounce no ideStore.
   *
   * Ancorar SÓ na montagem não basta: na ordem real do fio o `ready` remonta a
   * superfície com as linhas zeradas e o histórico chega DEPOIS, num flush de
   * replay (store.ts) — o crescimento pós-montagem é indistinguível de turno
   * vivo pelas linhas. O flush se anuncia em `replaysAssentados`: quando o
   * contador andou junto, foi histórico — só reancora.
   */
  const replays = useApp((state) => state.replaysAssentados);
  const gravacoesDoBot = useMemo(() => coletarGravacoesDoBot(lines), [lines]);
  const gravacoesVistas = useRef(-1);
  const replaysVistos = useRef(-1);
  useEffect(() => {
    const antes = gravacoesVistas.current;
    const replaysAntes = replaysVistos.current;
    gravacoesVistas.current = gravacoesDoBot.length;
    replaysVistos.current = replays;
    if (antes < 0 || replaysAntes !== replays) return;
    if (gravacoesDoBot.length <= antes) return;
    const ultimo = gravacoesDoBot[gravacoesDoBot.length - 1];
    if (ultimo !== undefined) agendarAberturaDoBot(ultimo);
  }, [gravacoesDoBot, replays]);

  const active = files.find((arquivo) => arquivo.path === activePath);
  const buffer = active ? active.content : "";
  const dirty = active?.dirty === true;
  const hasFile = active !== undefined;
  const editavel = hasFile && !active.loading && active.erro === "";

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

  const gutter = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // A calha é um painel separado para ter fundo próprio; o preço é sincronizar
  // o scroll na mão.
  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const element = gutter.current;
    if (!element) return;
    element.scrollTop = event.currentTarget.scrollTop;
  }, []);

  /* ------------------------- salvar (fs.write real) ----------------------- */

  // O cartão de aprovação da escrita chega pelo WebSocket enquanto o POST
  // espera — a barra tem de dizer que a bola está com a pessoa, senão o
  // "Salvando…" parece a tela travada.
  const aguardandoAprovacao =
    saveState === "salvando" &&
    pendingApprovals.some((pedido) => pedido.tool === "fs.write" || pedido.tool === "fs.patch");

  function verAlteracoes(): void {
    if (!hasFile) return;
    if (dirty) {
      send(
        `Compare ${activePath} como está salvo com este conteúdo e mostre o diff:\n\n\`\`\`\n${buffer}\n\`\`\``
      );
      return;
    }
    send(`Mostre o diff de ${activePath} em relação ao último commit.`);
  }

  function aplicarSugestao(): void {
    if (suggestion === "" || !editavel) return;
    editarAtivo(suggestion);
  }

  /* ---------------------- revelar linha (busca → editor) ------------------ */

  const revelarPendente = useRef<{ path: string; line: number } | null>(null);

  const revelarLinha = useCallback((linha: number) => {
    const elemento = area.current;
    if (!elemento) return;
    const linhas = elemento.value.split("\n");
    let inicio = 0;
    for (let i = 0; i < linha - 1 && i < linhas.length; i += 1) {
      inicio += (linhas[i]?.length ?? 0) + 1;
    }
    const alvo = linhas[linha - 1] ?? "";
    elemento.focus();
    // Selecionar a linha inteira é o que faz o salto ser VISÍVEL num textarea
    // sem destaque de sintaxe — o scroll sozinho não diz onde a ocorrência está.
    elemento.setSelectionRange(inicio, inicio + alvo.length);
    const alturaDeLinha = Number.parseFloat(window.getComputedStyle(elemento).lineHeight);
    const altura = Number.isFinite(alturaDeLinha) ? alturaDeLinha : 19;
    // Duas linhas de contexto acima: a ocorrência colada no topo esconde o
    // que vem antes dela — que costuma ser exatamente o que se quer ver.
    elemento.scrollTop = Math.max(0, (linha - 3) * altura);
    if (gutter.current) gutter.current.scrollTop = elemento.scrollTop;
  }, []);

  // Consome a pendência quando o arquivo terminar de abrir/carregar.
  useEffect(() => {
    const pendente = revelarPendente.current;
    if (!pendente) return;
    const arquivo = files.find((item) => item.path === pendente.path);
    if (!arquivo || arquivo.loading || activePath !== pendente.path) return;
    revelarPendente.current = null;
    window.setTimeout(() => revelarLinha(pendente.line), 30);
  }, [files, activePath, revelarLinha]);

  /* ------------------------- Quick Open (Ctrl+P) --------------------------- */

  const [quickAberto, setQuickAberto] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickIndice, setQuickIndice] = useState(0);
  const [quickArquivos, setQuickArquivos] = useState<EntradaProjeto[] | null>(null);
  const [quickErro, setQuickErro] = useState("");

  function abrirQuick(): void {
    setQuickAberto(true);
    setQuickQuery("");
    setQuickIndice(0);
    setQuickErro("");
    // Abre com o cache (resposta instantânea) enquanto o índice revalida.
    setQuickArquivos(indiceEmCache());
    indiceDeArquivos()
      .then(setQuickArquivos)
      .catch((causa: unknown) => {
        // Índice indisponível é MENSAGEM, não paleta vazia fingindo projeto
        // sem arquivos — a regra de nunca inventar árvore vale aqui também.
        setQuickErro(causa instanceof Error ? causa.message : String(causa));
      });
  }

  const quickCaminhos = useMemo(
    () => (quickArquivos ?? []).map((arquivo) => arquivo.path),
    [quickArquivos]
  );
  const quickHits = useMemo(() => fuzzyRank(quickQuery, quickCaminhos, 50), [quickQuery, quickCaminhos]);

  function abrirDoQuick(path: string): void {
    setQuickAberto(false);
    void abrirArquivo({ name: nomeBase(path), path });
  }

  function aoTeclarNoQuick(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setQuickIndice((indice) => Math.min(indice + 1, Math.max(quickHits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setQuickIndice((indice) => Math.max(indice - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = quickHits[quickIndice] ?? quickHits[0];
      if (hit) abrirDoQuick(hit.path);
    } else if (event.key === "Escape") {
      setQuickAberto(false);
    }
  }

  /* --------------------- busca no projeto (Ctrl+Shift+F) ------------------- */

  const [buscaAberta, setBuscaAberta] = useState(false);
  const [buscaQuery, setBuscaQuery] = useState("");
  const [buscaOcupada, setBuscaOcupada] = useState(false);
  const [buscaFeita, setBuscaFeita] = useState(false);
  const [buscaErro, setBuscaErro] = useState("");
  const [ocorrencias, setOcorrencias] = useState<OcorrenciaBusca[]>([]);

  async function executarBusca(consulta: string): Promise<void> {
    const query = consulta.trim();
    if (query === "" || buscaOcupada) return;
    setBuscaOcupada(true);
    setBuscaFeita(false);
    setBuscaErro("");
    setOcorrencias([]);
    try {
      setOcorrencias(await buscarNoProjeto(query));
    } catch (causa) {
      setBuscaErro(causa instanceof Error ? causa.message : String(causa));
    } finally {
      setBuscaOcupada(false);
      setBuscaFeita(true);
    }
  }

  function abrirOcorrencia(ocorrencia: OcorrenciaBusca): void {
    setBuscaAberta(false);
    revelarPendente.current = { path: ocorrencia.path, line: ocorrencia.line };
    const estado = useIde.getState();
    const jaAberto = estado.files.some(
      (arquivo) => arquivo.path === ocorrencia.path && !arquivo.loading
    );
    if (jaAberto && estado.activePath === ocorrencia.path) {
      // Arquivo já no palco: nem `files` nem `activePath` mudam, o efeito da
      // pendência não roda — revela agora e desarma, senão a pendência ficava
      // ARMADA e disparava no meio da digitação seguinte.
      revelarPendente.current = null;
      revelarLinha(ocorrencia.line);
      return;
    }
    void abrirArquivo({ name: nomeBase(ocorrencia.path), path: ocorrencia.path });
  }

  /* ---------------------------- atalhos globais ---------------------------- */

  useEffect(() => {
    function aoTeclar(event: KeyboardEvent): void {
      const tecla = event.key.toLowerCase();
      const combo = event.ctrlKey || event.metaKey;
      /*
       * Guarda contra roubo de foco (o padrão do estúdio de design): tecla
       * SOLTA pertence a quem está digitando — este handler só reage a combos
       * com modificador, que nunca inserem texto. O preventDefault é a outra
       * metade da guarda: sem ele o NAVEGADOR rouba o gesto (Ctrl+S abre
       * "salvar página", Ctrl+P abre impressão) e o arquivo não é salvo.
       */
      if (combo && !event.shiftKey && !event.altKey && tecla === "s") {
        event.preventDefault();
        void salvarAtivo();
        return;
      }
      if (combo && !event.shiftKey && !event.altKey && tecla === "p") {
        event.preventDefault();
        abrirQuick();
        return;
      }
      if (combo && event.shiftKey && !event.altKey && tecla === "f") {
        event.preventDefault();
        setBuscaAberta(true);
        setBuscaFeita(false);
        return;
      }
      if (event.key === "Escape") {
        setQuickAberto(false);
        setBuscaAberta(false);
      }
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
    // As funções usadas aqui só tocam setters estáveis e ações de módulo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------- render -------------------------------- */

  return (
    <div className="surface">
      {/* Os botões da superfície moram na barra superior do app, por portal —
          o palco não desenha barra própria (ver shell/TopbarActions). */}
      <TopbarActions>
        {saveState === "salvo" && (
          <span className="chip editor-chip" data-tone="ok" title="Gravado no projeto via fs.write">
            <Check aria-hidden="true" />
            salvo
          </span>
        )}
        {saveState === "erro" && (
          <span className="chip editor-chip" data-tone="erro" title={saveErro}>
            <X aria-hidden="true" />
            erro ao salvar
          </span>
        )}
        {aguardandoAprovacao && (
          <span
            className="chip editor-chip"
            data-tone="espera"
            title="A escrita passa pelo portão de aprovação — decida no cartão da conversa."
          >
            <Hourglass aria-hidden="true" />
            aguardando aprovação
          </span>
        )}
        {avisoDoBot !== "" && (
          <span
            className="chip editor-chip editor-chip-bot"
            data-tone="espera"
            title={`O bot gravou ${avisoDoBot} no disco enquanto este arquivo tinha edições não salvas aqui. Seu rascunho local ficou intacto — salvar (Ctrl+S) sobrescreve a versão do bot.`}
          >
            <AlertTriangle aria-hidden="true" />
            o bot gravou por cima no disco
          </span>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => setBuscaAberta(true)}
          title="Busca literal no projeto (Ctrl+Shift+F)"
        >
          <Search aria-hidden="true" />
          Buscar
        </button>
        <button
          type="button"
          className="btn"
          onClick={verAlteracoes}
          disabled={!hasFile || busy}
          title={dirty ? "compara o que está no editor com o que está salvo" : "pede o diff do arquivo"}
        >
          <GitCompare aria-hidden="true" />
          Ver alterações
        </button>
        <button
          type="button"
          className="btn"
          onClick={aplicarSugestao}
          disabled={!editavel || suggestion === ""}
          title={
            suggestion === ""
              ? "nenhum bloco de código nas respostas ainda"
              : "joga o último bloco de código da conversa no editor — só aqui; salvar é outro passo"
          }
        >
          <Wand2 aria-hidden="true" />
          Aplicar sugestão
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void salvarAtivo()}
          disabled={!editavel || saveState === "salvando"}
          title="Grava no disco via fs.write (Ctrl+S) — escrita pede aprovação; o cartão aparece na conversa."
        >
          <Save aria-hidden="true" />
          {saveState === "salvando" ? "Salvando…" : "Salvar"}
        </button>
      </TopbarActions>

      {/* O rodapé do app, por portal (ver shell/StatusBar). "Salvo" agora
          significa gravado de verdade: o fs.write desta tela é quem grava. */}
      {hasFile ? (
        <SurfaceStatus>
          <span className="statusbar-item" title={activePath}>
            <FileCode2 aria-hidden />
            <b>{nomeBase(activePath)}</b>
          </span>
          <span className="statusbar-item">
            {dirty ? "com edições não salvas" : "igual ao que está em disco"}
          </span>
          <span className="statusbar-item">
            <b>{lineCount}</b> {lineCount === 1 ? "linha" : "linhas"}
          </span>
        </SurfaceStatus>
      ) : null}

      <div className="surface-toolbar" role="tablist" aria-label="arquivos abertos">
        {files.length === 0 ? (
          <span className="surface-title">
            nenhum arquivo aberto — clique na árvore do projeto, ou Ctrl+P
          </span>
        ) : (
          files.map((arquivo) => {
            const isActive = arquivo.path === activePath;
            return (
              // A aba é um div com role=tab, e o fechar é um botão DENTRO dela:
              // botão dentro de botão é HTML inválido e o clique dos dois briga.
              <div
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                className="chip editor-tab"
                data-active={isActive ? "true" : "false"}
                key={arquivo.path}
                onClick={() => ativarArquivo(arquivo.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") ativarArquivo(arquivo.path);
                }}
                title={arquivo.path}
              >
                <IconeDoArquivo name={arquivo.name} />
                {arquivo.name}
                {arquivo.dirty ? <b aria-label="com edições não salvas">•</b> : null}
                <button
                  type="button"
                  className="editor-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    fecharArquivo(arquivo.path);
                  }}
                  aria-label={`Fechar ${arquivo.name}`}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })
        )}
        <span className="surface-toolbar-spacer" />
      </div>

      <div className="split">
        <div className="split-main">
          {active && active.erro !== "" ? (
            <p className="editor-erro" title={active.erro}>
              {active.erro}
            </p>
          ) : null}
          <div className="editor-pane">
            <div className="editor-gutter" ref={gutter} aria-hidden="true">
              <pre className="editor-linenums">{numbers}</pre>
            </div>
            <textarea
              ref={area}
              className="editor-area"
              value={buffer}
              onChange={(event) => editarAtivo(event.target.value)}
              onScroll={syncScroll}
              spellCheck={false}
              /* `wrap="off"` é o que mantém a calha honesta: com quebra
                 automática uma linha lógica ocuparia várias visuais e os
                 números sairiam do lugar. */
              wrap="off"
              disabled={!editavel}
              placeholder={
                hasFile
                  ? active.loading
                    ? `lendo ${activePath}…`
                    : ""
                  : "Abra um arquivo pela árvore do projeto ou pelo Ctrl+P."
              }
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

        {/* A conversa não sai de cena: é ela quem opera o projeto junto. */}
        <aside className="split-aside" aria-label="conversa">
          <ConversationSurface compact />
        </aside>
      </div>

      {quickAberto && (
        <div className="ide-overlay" onClick={() => setQuickAberto(false)}>
          <div
            className="ide-quick"
            role="dialog"
            aria-label="Quick Open"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <Search aria-hidden="true" />
              <input
                autoFocus
                value={quickQuery}
                onChange={(event) => {
                  setQuickQuery(event.target.value);
                  setQuickIndice(0);
                }}
                onKeyDown={aoTeclarNoQuick}
                placeholder="Buscar arquivo pelo nome…"
                aria-label="Quick Open — busca difusa de arquivos do projeto"
              />
            </header>
            <div className="ide-quick-list">
              {quickErro !== "" ? (
                <span className="ide-quick-note">{quickErro}</span>
              ) : quickArquivos === null ? (
                <span className="ide-quick-note">indexando arquivos…</span>
              ) : quickHits.length === 0 ? (
                <span className="ide-quick-note">nenhum arquivo corresponde</span>
              ) : (
                quickHits.map((hit, indice) => (
                  <button
                    type="button"
                    key={hit.path}
                    className="ide-quick-item"
                    data-active={indice === quickIndice ? "true" : "false"}
                    onMouseEnter={() => setQuickIndice(indice)}
                    onClick={() => abrirDoQuick(hit.path)}
                    title={hit.path}
                  >
                    <IconeDoArquivo name={nomeBase(hit.path)} />
                    <strong>{nomeBase(hit.path)}</strong>
                    <small>{hit.path}</small>
                  </button>
                ))
              )}
            </div>
            <footer>
              ↑↓ navega · Enter abre · Esc fecha
              {quickArquivos
                ? ` · ${quickArquivos.length} arquivo(s) indexado(s)`
                : ""}
            </footer>
          </div>
        </div>
      )}

      {buscaAberta && (
        <div className="ide-overlay" onClick={() => setBuscaAberta(false)}>
          <div
            className="ide-quick"
            role="dialog"
            aria-label="Busca no projeto"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <Search aria-hidden="true" />
              <input
                autoFocus
                value={buscaQuery}
                onChange={(event) => setBuscaQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void executarBusca(buscaQuery);
                  else if (event.key === "Escape") setBuscaAberta(false);
                }}
                placeholder="Busca literal no projeto…"
                aria-label="Busca literal no projeto"
              />
              <button
                type="button"
                className="btn"
                onClick={() => void executarBusca(buscaQuery)}
                disabled={buscaOcupada || buscaQuery.trim() === ""}
              >
                {buscaOcupada ? "Buscando…" : "Buscar"}
              </button>
            </header>
            <div className="ide-quick-list">
              {buscaErro !== "" && <span className="ide-quick-note">{buscaErro}</span>}
              {buscaOcupada && <span className="ide-quick-note">varrendo o projeto…</span>}
              {!buscaOcupada && buscaFeita && buscaErro === "" && ocorrencias.length === 0 && (
                <span className="ide-quick-note">nenhuma ocorrência</span>
              )}
              {ocorrencias.map((ocorrencia, indice) => (
                <button
                  type="button"
                  key={`${ocorrencia.path}:${ocorrencia.line}:${indice}`}
                  className="ide-quick-item"
                  onClick={() => abrirOcorrencia(ocorrencia)}
                  title={`${ocorrencia.path}:${ocorrencia.line}`}
                >
                  <IconeDoArquivo name={nomeBase(ocorrencia.path)} />
                  <strong>
                    {nomeBase(ocorrencia.path)}:{ocorrencia.line}
                  </strong>
                  <small>{ocorrencia.preview || " "}</small>
                </button>
              ))}
            </div>
            <footer>
              {buscaFeita && buscaErro === ""
                ? `${ocorrencias.length} ocorrência(s) — a busca roda no gateway (fs.search)`
                : "Enter busca · Esc fecha · clique abre em arquivo:linha"}
            </footer>
          </div>
        </div>
      )}

      <div className="surface-status">
        <span>
          <b>{hasFile ? activePath : "—"}</b>
        </span>
        <span>{lineCount} linhas</span>
        {dirty ? <span>editado aqui, ainda não salvo — Ctrl+S grava</span> : null}
        <span>Ctrl+P arquivos · Ctrl+Shift+F busca</span>
      </div>
    </div>
  );
}

export default EditorSurface;
