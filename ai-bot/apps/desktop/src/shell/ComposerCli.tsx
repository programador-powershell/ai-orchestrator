/**
 * O composer cli do Código — a linha `$` no pé da IDE, portada do original
 * (`ai-orchestrator-main/apps/desktop/src/modes/CodeView.tsx`, o painel
 * glass-terminal: cabeçalho na linha 560, prompt na 997, runCommandText nas
 * 608-693). Três gestos, e só três:
 *
 *   (a) COMANDO — executa na raiz do projeto pelo caminho do TECLADO DA
 *       PESSOA que já existe: o PTY do painel de terminal. Sem portão de
 *       aprovação, porque quem digitou foi a pessoa — a mesma regra do
 *       teclado do xterm (ver o cabeçalho de `TerminalPanel.tsx`).
 *   (b) ARQUIVO (auto-detect) — um caminho que EXISTE no projeto abre no
 *       editor (o ideStore já sabe abrir; aqui só se decide que o gesto era
 *       um arquivo, consultando o índice real — nunca inventando árvore).
 *   (c) `ai <pergunta>` — vai ao modelo da sessão pelo MESMO caminho do
 *       composer (useApp.send) e a resposta é ESPELHADA aqui quando o turno
 *       fecha, como o original fazia com threads.code.
 *
 * # Por que um pane próprio, e não um "modo de linha" dentro do xterm
 *
 * O contrato do PTY é tecla crua com eco DO SHELL: impor uma disciplina de
 * linha no mesmo emulador exigiria interceptar teclado e suprimir o eco — e
 * isso quebra exatamente o que o painel existe para preservar (vim, htop,
 * senha escondida do sudo). O CLI é um pane React simples que ENCAMINHA o
 * comando ao shell vivo pela alça `TerminalPanelApi`; o PTY continua intacto,
 * e o dock e o CLI viram UMA coisa (uma seção só no pé da tela), não dois
 * rodapés disputando o mesmo espaço.
 *
 * # REGRA DE SEGURANÇA, herdada por referência
 *
 * `encaminharAoShell` escreve num shell sem portão. Só a linha `$` — mãos da
 * pessoa — pode chegar nela. Nenhum texto de MODELO passa por aqui: a resposta
 * do gesto (c) é ESPELHADA no histórico do pane, nunca escrita no PTY.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { ChevronDown, ChevronUp, SquareTerminal, Terminal as TerminalIcon } from "lucide-react";
import { useApp, type AppState } from "../lib/store";
import { semCercasDeProtocolo } from "../lib/markdown";
import { abrirArquivo, indiceDeArquivos, indiceEmCache } from "../lib/ide/ideStore";
import { nomeBase, type EntradaProjeto } from "../lib/ide/projeto";
import { ptyDisponivel, TerminalPanel, type TerminalPanelApi } from "./TerminalPanel";

/* ------------------------------ gestos (puros) ----------------------------- */

/** `ai <pergunta>` → a pergunta; qualquer outra coisa → null. */
export function perguntaDoGesto(gesto: string): string | null {
  const casada = /^ai\s+(\S[\s\S]*)$/i.exec(gesto.trim());
  return casada ? (casada[1] ?? "").trim() : null;
}

/**
 * O gesto TEM CARA de caminho de arquivo? Devolve o caminho normalizado
 * (barras de Unix, sem `./`, sem aspas) ou null. É só a triagem barata — quem
 * decide se o arquivo EXISTE é o índice do projeto, nunca esta função: um
 * `main.py` que não está no projeto continua sendo um comando legítimo.
 */
export function candidatoAArquivo(gesto: string): string | null {
  const semAspas = gesto.trim().replace(/^["']|["']$/g, "");
  // Espaço = comando com argumentos; caminho de arquivo do índice não tem
  // espaço porque o gesto de abrir com espaço no nome usa as aspas.
  if (semAspas === "" || /\s/.test(semAspas)) return null;
  const caminho = semAspas.replace(/\\/g, "/").replace(/^\.\//, "");
  // Sem barra E sem extensão não parece arquivo ("ls", "pnpm") — nem vale a
  // ida ao índice.
  if (!caminho.includes("/") && !/\.[A-Za-z0-9]+$/.test(caminho)) return null;
  return caminho;
}

/**
 * O arquivo do índice que o gesto aponta: caminho exato primeiro, depois o
 * sufixo (`src/app.ts` acha `apps/web/src/app.ts`), por último o nome puro.
 * Só arquivo — pasta não abre em aba.
 */
export function arquivoDoIndice(indice: EntradaProjeto[], caminho: string): EntradaProjeto | null {
  const arquivos = indice.filter((entrada) => !entrada.isDir);
  return (
    arquivos.find((entrada) => entrada.path === caminho) ??
    arquivos.find((entrada) => entrada.path.endsWith(`/${caminho}`)) ??
    arquivos.find((entrada) => entrada.name === caminho) ??
    null
  );
}

/* --------------------------------- o dock --------------------------------- */

export interface ComposerCliDockProps {
  /** Pasta onde o shell abre — ver TerminalPanelProps.cwd (raiz do projeto). */
  cwd?: string;
}

/**
 * Teto da fila de comandos esperando o shell abrir. Pequeno de propósito: a
 * fila só existe para a janela entre o Enter e o `pty_spawn` devolver o id —
 * ninguém digita dezesseis comandos nesse intervalo de propósito.
 */
export const MAX_COMANDOS_NA_FILA = 16;

export function ComposerCliDock({ cwd }: ComposerCliDockProps): ReactNode {
  const [historico, setHistorico] = useState<string[]>([]);
  const [linha, setLinha] = useState("");

  /*
   * O mesmo ciclo de vida do dock antigo, pelos mesmos motivos:
   * 1. o painel do PTY só MONTA na primeira necessidade (`jaAbriu`) — montar
   *    junto com a superfície abriria um shell que talvez ninguém use;
   * 2. fechar ESCONDE (`hidden`), não desmonta — desmontar mata o shell, e
   *    perder o dev server porque a pessoa recolheu o painel puniria o gesto
   *    mais comum.
   */
  const [aberto, setAberto] = useState(false);
  const [jaAbriu, setJaAbriu] = useState(false);

  const apiRef = useRef<TerminalPanelApi | null>(null);
  /** Comandos digitados antes de o shell existir — drenados no `aoVivo`. */
  const filaRef = useRef<string[]>([]);
  /** A desinscrição do espelho da resposta do gesto (c), viva no máximo uma. */
  const desinscreverRef = useRef<(() => void) | null>(null);
  const historicoRef = useRef<HTMLPreElement | null>(null);
  const promptRef = useRef<HTMLInputElement | null>(null);

  const alternar = useCallback(() => {
    setAberto((valor) => !valor);
    setJaAbriu(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // `code === "Backquote"` cobre o layout ABNT, onde a crase é tecla
      // morta e `event.key` chega como "Dead" — a mesma lição do dock antigo.
      if ((event.ctrlKey || event.metaKey) && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        alternar();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alternar]);

  // Desmontar no meio de um turno espelhado: a inscrição morre junto, senão o
  // callback escreveria num setState de componente que já saiu de cena.
  useEffect(
    () => () => {
      desinscreverRef.current?.();
      desinscreverRef.current = null;
    },
    []
  );

  // O histórico rola sozinho para o fim, como o pane do original.
  useEffect(() => {
    historicoRef.current?.scrollTo({ top: historicoRef.current.scrollHeight });
  }, [historico]);

  const empurrar = useCallback((...linhas: string[]) => {
    setHistorico((atual) => [...atual, ...linhas]);
  }, []);

  /** Entrega ao shell o que ficou esperando o `pty_spawn` — ver `filaRef`. */
  const drenarFila = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const pendentes = filaRef.current;
    filaRef.current = [];
    for (const data of pendentes) {
      if (!api.escrever(data)) filaRef.current.push(data);
    }
  }, []);

  /* ------------------------------- gesto (a) ------------------------------ */

  function encaminharAoShell(gesto: string): void {
    if (!ptyDisponivel()) {
      // O fallback honesto do navegador, na frase do original: não há processo
      // para abrir fora do app — fingir execução seria pior que dizer isso.
      empurrar(`modo demonstração — "${gesto}" executa no app desktop.`);
      return;
    }
    // O comando executa À VISTA: o painel do PTY abre junto com o gesto — a
    // saída aparece nele (o eco é do shell; ecoar aqui duplicaria tudo).
    setJaAbriu(true);
    setAberto(true);
    const data = `${gesto}\r`;
    const api = apiRef.current;
    if (api?.escrever(data)) return;
    // Shell ainda não existe (primeiro comando) ou morreu: o comando espera na
    // fila e a sessão nova o entrega no `aoVivo`. Teto para a fila não crescer
    // sem dono se o spawn nunca vingar.
    if (filaRef.current.length < MAX_COMANDOS_NA_FILA) filaRef.current.push(data);
    api?.reabrir();
  }

  /* ------------------------------- gesto (b) ------------------------------ */

  async function abrirSeArquivo(caminho: string): Promise<boolean> {
    // Cache primeiro (resposta no mesmo tick); sem cache, o índice real. O
    // índice indisponível (offline) NÃO é erro do gesto: o texto volta a valer
    // como comando, que é o que ele provavelmente era.
    let indice = indiceEmCache();
    if (indice === null) {
      try {
        indice = await indiceDeArquivos();
      } catch {
        return false;
      }
    }
    const alvo = arquivoDoIndice(indice, caminho);
    if (alvo === null) return false;
    empurrar(`↳ abrindo ${alvo.path} no editor`);
    void abrirArquivo({ name: nomeBase(alvo.path), path: alvo.path });
    return true;
  }

  /* ------------------------------- gesto (c) ------------------------------ */

  function espelharDesfecho(estado: AppState): void {
    if (estado.error !== "") {
      empurrar(estado.error, "");
      return;
    }
    for (let indice = estado.lines.length - 1; indice >= 0; indice -= 1) {
      const fala = estado.lines[indice];
      if (!fala || fala.role !== "assistant") continue;
      // O espelho passa pelo MESMO filtro de protocolo do renderer: um turno
      // interrompido no meio de uma cerca aibot:tool não pode vazar o JSON de
      // máquina para o pane.
      const texto = semCercasDeProtocolo(fala.text).trim();
      empurrar(texto !== "" ? texto : "(o turno terminou sem resposta em texto)", "");
      return;
    }
    empurrar("(o turno terminou sem resposta em texto)", "");
  }

  function perguntarAoAgente(pergunta: string): void {
    const app = useApp.getState();
    if (app.busy) {
      // Evita inscrição dupla (a resposta sairia espelhada duas vezes) — a
      // mesma guarda do original.
      empurrar("o agente ainda está respondendo — aguarde a resposta anterior.");
      return;
    }
    desinscreverRef.current?.();
    empurrar("→ agente da sessão…");
    const desinscrever = useApp.subscribe((estado, anterior) => {
      // O turno fecha quando busy CAI — done, erro ou stop; é aí que a última
      // fala do assistente vira espelho no pane, como o original fazia.
      if (!anterior.busy || estado.busy) return;
      desinscreverRef.current = null;
      desinscrever();
      espelharDesfecho(estado);
    });
    desinscreverRef.current = desinscrever;
    app.send(pergunta);
    if (!useApp.getState().busy) {
      // O envio nem virou turno (sem conexão, conectando): o send explica em
      // `error` e busy nunca sobe — esperar a queda esperaria para sempre.
      desinscreverRef.current = null;
      desinscrever();
      const motivo = useApp.getState().error;
      empurrar(motivo !== "" ? motivo : "o pedido não foi enviado.");
    }
  }

  /* ------------------------------ o roteamento ---------------------------- */

  async function executarGesto(bruto: string): Promise<void> {
    const gesto = bruto.trim();
    if (gesto === "") return;
    empurrar(`$ ${gesto}`);
    const pergunta = perguntaDoGesto(gesto);
    if (pergunta !== null) {
      perguntarAoAgente(pergunta);
      return;
    }
    const caminho = candidatoAArquivo(gesto);
    if (caminho !== null && (await abrirSeArquivo(caminho))) return;
    encaminharAoShell(gesto);
  }

  function aoTeclar(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const gesto = linha;
    setLinha("");
    void executarGesto(gesto);
  }

  /* --------------------------------- render ------------------------------- */

  return (
    <section
      className="term-dock cli-dock"
      data-aberto={aberto ? "1" : "0"}
      aria-label="composer cli e terminal interativo"
    >
      <header className="cli-cabecalho">
        <span className="cli-titulo">
          <SquareTerminal aria-hidden />
          composer cli
        </span>
        <span className="cli-nota">
          comandos executam na raiz do projeto · Ctrl+P abre arquivos
        </span>
        <button
          type="button"
          className="term-dock-alternar"
          onClick={alternar}
          aria-expanded={aberto}
          title="Abrir/fechar o terminal (Ctrl+`)"
        >
          <TerminalIcon aria-hidden />
          <span>Terminal</span>
          <kbd>Ctrl+`</kbd>
          {aberto ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </button>
      </header>

      {jaAbriu ? (
        <div className="term-dock-corpo" hidden={!aberto}>
          <TerminalPanel
            cwd={cwd}
            apiRef={apiRef}
            aoVivo={drenarFila}
            aoFechar={() => setAberto(false)}
          />
        </div>
      ) : null}

      <div className="cli-pane" onClick={() => promptRef.current?.focus()}>
        {historico.length > 0 ? (
          <pre className="cli-historico" ref={historicoRef} aria-live="polite">
            {historico.map((texto, indice) => (
              <span className="cli-linha" key={indice}>
                {texto}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : null}
        <div className="cli-prompt">
          <span className="cli-prompt-sinal" aria-hidden="true">
            $
          </span>
          <input
            ref={promptRef}
            className="cli-entrada"
            value={linha}
            onChange={(event) => setLinha(event.target.value)}
            onKeyDown={aoTeclar}
            placeholder='comando, arquivo (auto-detect) ou "ai <pergunta>"'
            aria-label="composer cli — comando executa no shell, caminho abre no editor, ai fala com o agente"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </section>
  );
}

export default ComposerCliDock;
