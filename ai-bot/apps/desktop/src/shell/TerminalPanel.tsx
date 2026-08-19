/**
 * O terminal da PESSOA — xterm.js ligado nos comandos `pty_*` do Rust.
 *
 * Não é um log com cores: é um emulador de verdade. Quem desenha a grade, o
 * cursor e as regiões de rolagem é o xterm.js, ligado direto no ConPTY que o
 * Rust abre (`src-tauri/src/pty.rs`). `vim`, `htop`, barra de progresso com
 * `\r` — tudo que assume o contrato de terminal dos últimos quarenta anos
 * funciona, o que um painel de "saída de comando" nunca atenderia.
 *
 * # REGRA DE SEGURANÇA INEGOCIÁVEL: `pty_write` NÃO é ferramenta de modelo
 *
 * Este painel escreve no shell SEM portão de aprovação, e isso só é aceitável
 * porque quem digita é a pessoa — são as mãos dela. O modelo continua rodando
 * comando por `proc.run`, que passa pela aprovação no gateway. Nenhum caminho
 * deste arquivo pode entrar no catálogo/registry de ferramentas do agente
 * (`services/gateway/internal/supervisor/tools.go`): um modelo com acesso a
 * `pty_write` num shell já aberto contornaria todos os portões de uma vez —
 * bastaria escrever `rm -rf .\n` — e contornaria em silêncio, porque tudo
 * continuaria funcionando. Ver o cabeçalho de `src-tauri/src/pty.rs`, que é a
 * outra metade desta regra.
 *
 * # Fora do Tauri o painel é HONESTO
 *
 * No navegador (`pnpm dev` sem a casca nativa) não existe processo para abrir.
 * O painel diz isso em vez de fingir um terminal vazio — um emulador mudo é
 * indistinguível de defeito, e a pessoa perderia tempo depurando o que não
 * existe.
 *
 * Portado da referência do orquestrador (`apps/desktop/src/components/
 * Terminal.tsx` + `lib/pty.ts` + `lib/ptySession.ts` + `lib/termTheme.ts`),
 * lida inteira antes do porte. O que NÃO veio junto, de propósito:
 *   - `pty_ack` (controle de fluxo): o Rust deste app não o expõe — inventar a
 *     chamada aqui viraria erro SESSION_NOT_FOUND a cada bloco;
 *   - a rota SSH/VPS: este app não tem seletor de ambiente para o PTY; o shell
 *     é sempre o da estação, e o rótulo do painel diz isso;
 *   - o painel de diagnóstico completo: aqui o redutor guarda o essencial
 *     (status, código de saída, último erro) e o resto fica no scrollback.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, Eraser, RotateCw, Terminal as TerminalIcon, X } from "lucide-react";
import { useApp } from "../lib/store";

/* ------------------------------- transporte ------------------------------- */

/**
 * Função, e não constante de módulo: os testes ligam e desligam a bandeira
 * `__TAURI_INTERNALS__` entre casos, e uma constante congelaria a resposta no
 * primeiro import. Na janela real o valor nunca muda durante a vida do app.
 */
export function ptyDisponivel(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Tipo de shell. NÃO é caminho — o Rust resolve o executável (enum fechado
 *  em `pty.rs`; um caminho vindo daqui seria execução arbitrária via webview). */
export type ShellKind = "default" | "powerShell" | "cmd" | "bash";

export interface PtyDataEvent {
  id: string;
  data: string;
}
export interface PtyExitEvent {
  id: string;
  exitCode?: number;
  /** `exited` (terminou sozinho) | `killed` (pedimos) | `error`. */
  reason: string;
}
export interface PtyErrorEvent {
  id?: string;
  code: string;
  message: string;
}

interface PtyListeners {
  onData?: (event: PtyDataEvent) => void;
  onExit?: (event: PtyExitEvent) => void;
  onError?: (event: PtyErrorEvent) => void;
}

/** Inscrição feita ANTES de existir id — ver `escutarPendente`. */
export interface InscricaoPendente {
  /** Passa a filtrar por esta sessão e ENTREGA o que chegou antes, em ordem. */
  amarrar: (id: string) => void;
  parar: UnlistenFn;
}

/**
 * Teto da fila de eventos sem dono. Se `amarrar` nunca vier — spawn que
 * falhou, efeito cancelado —, a fila para de crescer em vez de segurar a
 * saída inteira de um processo tagarela na memória.
 */
export const MAX_EVENTOS_PENDENTES = 512;

/**
 * Assina os três eventos ANTES de saber o id, guardando o que chegar.
 *
 * Existe por uma corrida real: a thread de leitura do Rust emite `pty-data`
 * no instante em que o filho nasce — ANTES de `pty_spawn` retornar o id (o
 * cabeçalho de `pty.rs` avisa exatamente isso). Evento do Tauri sem ouvinte é
 * DESCARTADO, não enfileirado; assinar depois do `await` perdia o começo da
 * sessão: a faixa do PowerShell, o primeiro prompt. O resultado era um
 * terminal em branco que só reagia depois do primeiro Enter — com cara de
 * travado.
 *
 * O filtro por id é feito aqui porque o Tauri emite para a janela inteira:
 * com dois terminais abertos, sem filtro cada um veria a saída do outro.
 */
export async function escutarPendente(listeners: PtyListeners): Promise<InscricaoPendente> {
  let alvo: string | null = null;
  let fila: Array<() => void> | null = [];

  /** Antes de amarrar, enfileira; depois, executa se for da sessão. */
  const despachar = (idEvento: string | undefined, entregar: () => void, aceitaSemId = false) => {
    if (alvo === null) {
      if (fila && fila.length < MAX_EVENTOS_PENDENTES) {
        fila.push(() => {
          if (idEvento === alvo || (aceitaSemId && !idEvento)) entregar();
        });
      }
      return;
    }
    if (idEvento === alvo || (aceitaSemId && !idEvento)) entregar();
  };

  const desinscricoes: UnlistenFn[] = [];
  desinscricoes.push(
    await listen<PtyDataEvent>("pty-data", (event) =>
      despachar(event.payload.id, () => listeners.onData?.(event.payload))
    )
  );
  desinscricoes.push(
    await listen<PtyExitEvent>("pty-exit", (event) =>
      despachar(event.payload.id, () => listeners.onExit?.(event.payload))
    )
  );
  desinscricoes.push(
    await listen<PtyErrorEvent>("pty-error", (event) =>
      // Erro sem id é do subsistema, não de uma sessão: entregar para quem
      // estiver ouvindo é melhor do que engolir.
      despachar(event.payload.id, () => listeners.onError?.(event.payload), true)
    )
  );

  return {
    amarrar: (id: string) => {
      if (alvo !== null) return;
      alvo = id;
      const pendentes = fila ?? [];
      fila = null;
      for (const entregar of pendentes) entregar();
    },
    parar: () => {
      fila = null;
      for (const desinscrever of desinscricoes) desinscrever();
    }
  };
}

/* --------------------------- estado da sessão ----------------------------- */

export type StatusSessao = "abrindo" | "vivo" | "saiu" | "erro";

export interface SessaoTerminal {
  id: string;
  status: StatusSessao;
  exitCode?: number;
  /** `exited` | `killed` | `error` — o que o Rust disse no `pty-exit`. */
  motivo: string;
  /** Última mensagem de erro legível; vazia quando está tudo bem. */
  erro: string;
}

export type AcaoSessao =
  | { type: "abrir" }
  | { type: "aberto"; id: string }
  | { type: "falhou"; mensagem: string }
  | { type: "erro"; mensagem: string }
  | { type: "saiu"; exitCode?: number; motivo: string };

export function sessaoInicial(): SessaoTerminal {
  return { id: "", status: "abrindo", motivo: "", erro: "" };
}

/**
 * Redutor PURO da sessão — sem relógio, sem I/O, para o teste conseguir provar
 * a regra que importa: **status terminal não volta atrás**. A thread de
 * leitura e a de espera do Rust são independentes, então um evento atrasado
 * pode chegar DEPOIS do `pty-exit`; se ele ressuscitasse a sessão, a tela
 * diria que há shell vivo onde não há e o próximo `pty_write` falharia sem
 * explicação. Só a ação `abrir` (um novo spawn) zera o estado.
 */
export function reduzirSessao(sessao: SessaoTerminal, acao: AcaoSessao): SessaoTerminal {
  const finalizada = sessao.status === "saiu" || sessao.status === "erro";
  switch (acao.type) {
    case "abrir":
      return sessaoInicial();
    case "aberto":
      if (finalizada) return sessao;
      return { ...sessao, id: acao.id, status: "vivo" };
    case "falhou":
      return { ...sessao, status: "erro", erro: acao.mensagem };
    case "erro":
      // Erro de leitura não encerra a sessão por si: o processo pode seguir
      // vivo. Quem decide o fim é o `pty-exit`, com o código real.
      return { ...sessao, erro: acao.mensagem };
    case "saiu":
      if (finalizada) return sessao;
      return { ...sessao, status: "saiu", exitCode: acao.exitCode, motivo: acao.motivo };
    default:
      return sessao;
  }
}

/** Resumo de uma linha para a barra do painel. */
export function descreverSessao(sessao: SessaoTerminal): string {
  if (sessao.status === "abrindo") return "abrindo…";
  if (sessao.status === "vivo") return `${sessao.id} · nesta máquina`;
  if (sessao.status === "erro") return "erro";
  if (sessao.motivo === "killed") return "encerrado";
  return `saiu (código ${sessao.exitCode ?? "n/a"})`;
}

/* --------------------------------- tema ----------------------------------- */

/**
 * As 16 cores ANSI são PRÓPRIAS do terminal, não derivadas dos tokens do app.
 * Quem escreve `\e[31m` está pedindo "a cor 1 do ANSI", não "o vermelho de
 * erro do produto" — forçar a identidade visual daqui sobre a saída do `git`
 * faria o terminal mentir sobre o que o programa mandou desenhar. Contraste
 * conferido na referência: nenhuma cor abaixo de 4.5:1 sobre o fundo do tema.
 */
const ANSI_ESCURO: readonly string[] = [
  "#3b4048", // 0 preto
  "#f2686c", // 1 vermelho
  "#67d38a", // 2 verde
  "#e0c37a", // 3 amarelo
  "#6cb6ff", // 4 azul
  "#c497f0", // 5 magenta
  "#5fd7d7", // 6 ciano
  "#c9d1d9", // 7 branco
  "#6e7681", // 8 preto brilhante (cinza)
  "#ff8a8e", // 9 vermelho brilhante
  "#85e6a4", // 10 verde brilhante
  "#f0d79b", // 11 amarelo brilhante
  "#93ccff", // 12 azul brilhante
  "#d9b4ff", // 13 magenta brilhante
  "#88eaea", // 14 ciano brilhante
  "#f0f6fc" // 15 branco brilhante
];

/**
 * Clara — MESMOS matizes, escurecidos para ler sobre fundo claro. Não é a
 * paleta escura com o fundo trocado: `#67d38a` sobre branco fica ilegível.
 */
const ANSI_CLARO: readonly string[] = [
  "#24292f",
  "#cf222e",
  "#1a7f37",
  "#9a6700",
  "#0969da",
  "#8250df",
  "#1b7c83",
  "#6e7781",
  "#57606a",
  "#a40e26",
  "#116329",
  "#7d4e00",
  "#0550ae",
  "#6639ba",
  "#15606a",
  "#24292f"
];

/**
 * O SUBSTRATO (fundo, texto padrão, cursor, seleção) vem dos tokens do app —
 * é o que impede o terminal de virar um retângulo estranho no meio do tema. O
 * xterm precisa de cor CONCRETA (ele pinta com ela, não com `var()`), então os
 * tokens são lidos por `getComputedStyle` no host, que está dentro do
 * `.app-shell` onde eles moram. Os fallbacks repetem os valores de
 * `tokens.css` para o caso sem CSS carregado (testes em jsdom).
 */
export function temaXterm(escuro: boolean, host: HTMLElement | null): ITheme {
  const computado = host ? getComputedStyle(host) : null;
  const token = (nome: string, padrao: string): string => {
    const valor = computado?.getPropertyValue(nome).trim();
    return valor ? valor : padrao;
  };

  const ansi = escuro ? ANSI_ESCURO : ANSI_CLARO;
  const fundo = token("--panel", escuro ? "#1f1f1f" : "#ffffff");
  const [black, red, green, yellow, blue, magenta, cyan, white, ...brilhantes] = ansi;

  return {
    background: fundo,
    foreground: token("--ink", escuro ? "#ececec" : "#26241f"),
    cursor: token("--accent", escuro ? "hsl(158 62% 52%)" : "hsl(158 62% 40%)"),
    cursorAccent: fundo,
    selectionBackground: token(
      "--accent-glow",
      escuro ? "hsl(158 62% 52% / 0.3)" : "hsl(158 62% 40% / 0.24)"
    ),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: brilhantes[0],
    brightRed: brilhantes[1],
    brightGreen: brilhantes[2],
    brightYellow: brilhantes[3],
    brightBlue: brilhantes[4],
    brightMagenta: brilhantes[5],
    brightCyan: brilhantes[6],
    brightWhite: brilhantes[7]
  };
}

/* --------------------------------- painel --------------------------------- */

/** Teto do scrollback. Terminal de verdade também tem — memória é finita. */
const SCROLLBACK = 5000;

const SHELLS: Array<{ id: ShellKind; label: string }> = [
  { id: "default", label: "Padrão" },
  { id: "powerShell", label: "PowerShell" },
  { id: "cmd", label: "cmd" },
  { id: "bash", label: "bash" }
];

export interface TerminalPanelProps {
  /**
   * Pasta onde o shell abre. Sem valor, o Rust cai no diretório atual do
   * processo — que é a pasta de projeto padrão que o `setup` do `lib.rs`
   * registra ao abrir o app. Não há hoje comando para LER a raiz de projeto
   * escolhida depois por `set_project_root`; quando ele existir, é aqui que o
   * valor entra.
   */
  cwd?: string;
  /** Recolhe o painel (o shell continua vivo — quem mata é desmontar). */
  aoFechar?: () => void;
}

export function TerminalPanel({ cwd, aoFechar }: TerminalPanelProps): ReactNode {
  // Constante durante a vida da janela; lida no render para o teste conseguir
  // exercitar os dois mundos. Os hooks abaixo rodam SEMPRE (regra dos hooks) e
  // cada efeito se desliga sozinho quando não há PTY.
  const disponivel = ptyDisponivel();
  const theme = useApp((state) => state.theme);
  const escuro = theme === "dark";

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** O id da sessão VIVA — `null` derruba a tecla no chão em vez de mandá-la
   *  para um shell que já morreu. */
  const idRef = useRef<string | null>(null);

  const [shell, setShell] = useState<ShellKind>("default");
  const [sessao, despachar] = useReducer(reduzirSessao, undefined, sessaoInicial);
  /** Incrementar reabre a sessão — é o "reiniciar o shell". */
  const [nonce, setNonce] = useState(0);

  const vivo = sessao.status === "vivo";

  /**
   * Monta o emulador UMA vez, separado do efeito da sessão de propósito:
   * recriar o `Xterm` a cada troca de shell ou reinício jogaria fora o
   * scrollback, que é justamente o que a pessoa quer manter.
   */
  useEffect(() => {
    if (!disponivel) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      scrollback: SCROLLBACK,
      cursorBlink: true,
      // O PTY já entrega \r\n (ConPTY); converter de novo dobraria as linhas.
      convertEol: false,
      fontSize: 12,
      // A fonte mono do app, com as de sistema atrás: caixa desalinhada
      // desmancha qualquer desenho de caixa (`tree`, `htop`, tabela do git).
      fontFamily: 'var(--font-mono), "Cascadia Mono", Consolas, "Courier New", monospace'
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // A tecla vai para o shell; o eco é dele. Ecoar aqui duplicaria tudo — e
    // pior: mostraria a senha que o `sudo` está pedindo para esconder.
    const disposeData = term.onData((data) => {
      const id = idRef.current;
      if (!id) return;
      // TECLA DE HUMANO: este invoke nunca pode virar ferramenta do agente.
      void invoke("pty_write", { id, data }).catch(() => {
        // sessão morreu entre a tecla e o IPC — o pty-exit já conta a história
      });
    });

    /*
     * O tamanho da grade é do CONTAINER e precisa ir para o outro lado. Sem
     * `pty_resize` o shell continua acreditando nos 80×24 do nascimento: o
     * `less` quebra na coluna errada e o `vim` desenha metade da tela
     * (`pty.rs` avisa isso na doc do comando).
     */
    const disposeResize = term.onResize(({ cols, rows }) => {
      const id = idRef.current;
      if (!id) return;
      void invoke("pty_resize", { id, cols, rows }).catch(() => {
        // idem: redimensionar sessão que acabou de sair não é notícia
      });
    });

    // jsdom (testes) e WebView muito antigo não têm ResizeObserver; sem ele o
    // terminal só perde o ajuste automático, não a função.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // painel com altura zero durante a transição (dock recolhido)
        }
      });
      observer.observe(host);
    }

    return () => {
      observer?.disconnect();
      disposeData.dispose();
      disposeResize.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [disponivel]);

  /** Tema: troca a paleta sem recriar o emulador (o scrollback fica). */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = temaXterm(escuro, hostRef.current);
  }, [escuro, disponivel]);

  /** Abre a sessão e liga os eventos. Refaz ao trocar shell, pasta ou nonce. */
  useEffect(() => {
    if (!disponivel) return;
    const term = termRef.current;
    if (!term) return;

    let cancelado = false;
    let desinscrever: (() => void) | undefined;
    /*
     * O id que ESTE efeito abriu — não o do ref. O `onExit` zera `idRef` (é o
     * certo: teclar num shell morto não deve ir a lugar nenhum), e uma limpeza
     * que lesse o ref depois de uma saída espontânea veria `null` e não
     * chamaria `pty_kill` — deixando a entrada no mapa do Rust segurando
     * handle de ConPTY até alguém abrir outro terminal.
     */
    let idAberto: string | null = null;

    (async () => {
      despachar({ type: "abrir" });
      try {
        fitRef.current?.fit();
      } catch {
        // sem medida ainda: o spawn usa o padrão e o resize corrige depois
      }

      // A inscrição vem ANTES do spawn — ver o comentário de `escutarPendente`.
      const inscricao = await escutarPendente({
        onData: (evento) => term.write(evento.data),
        onExit: (evento) => {
          despachar({ type: "saiu", exitCode: evento.exitCode, motivo: evento.reason });
          idRef.current = null;
          // O código de saída aparece na tela, como em terminal de verdade.
          // O ESC vai como escape unicode (backslash-u001b), NUNCA como byte literal: byte de controle solto
          // no fonte some em edição e o código muda de significado calado.
          const codigo = evento.exitCode === undefined ? "" : ` · código ${evento.exitCode}`;
          term.write(`\r\n\u001b[2m[processo encerrado · ${evento.reason}${codigo}]\u001b[0m\r\n`);
        },
        onError: (evento) => despachar({ type: "erro", mensagem: `${evento.code}: ${evento.message}` })
      });
      // A limpeza já pode desinscrever a partir daqui — antes desta linha ela
      // veria `undefined` e os três handlers ficariam vivos para sempre.
      desinscrever = inscricao.parar;
      if (cancelado) {
        inscricao.parar();
        return;
      }

      try {
        const id = await invoke<string>("pty_spawn", {
          cwd,
          cols: term.cols,
          rows: term.rows,
          shell
        });
        if (cancelado) {
          void invoke("pty_kill", { id });
          return;
        }
        idRef.current = id;
        idAberto = id;
        despachar({ type: "aberto", id });
        inscricao.amarrar(id);
        term.focus();
      } catch (causa) {
        if (cancelado) return;
        // SHELL_NOT_FOUND, SESSION_LIMIT, CWD_INVALID… o Rust escreve o motivo
        // em português; engolir aqui seria a tela vazia sem explicação.
        despachar({ type: "falhou", mensagem: causa instanceof Error ? causa.message : String(causa) });
      }
    })();

    return () => {
      cancelado = true;
      desinscrever?.();
      idRef.current = null;
      // Desmontar mata o shell: deixá-lo vivo sem tela seria um processo órfão
      // rodando com os direitos da pessoa. Em sessão que já saiu, `pty_kill` é
      // idempotente e só tira a entrada do mapa — por isso vai o id local.
      if (idAberto) {
        void invoke("pty_kill", { id: idAberto });
      }
    };
  }, [disponivel, cwd, shell, nonce]);

  /* ------------------------------ apresentação --------------------------- */

  const rotuloSessao = useMemo(() => descreverSessao(sessao), [sessao]);

  if (!disponivel) {
    // O fallback honesto: no navegador NÃO existe processo para abrir, e um
    // emulador mudo aqui teria cara de defeito. O caminho do modelo continua
    // sendo `proc.run` com aprovação — isso vale nos dois mundos.
    return (
      <div className="term-panel term-panel--fora" role="note">
        <TerminalIcon aria-hidden />
        <div>
          <strong>O terminal interativo existe só no aplicativo desktop.</strong>
          <p>
            Neste navegador não há processo para abrir. No app instalado, este painel vira um shell
            de verdade — e quem digita nele é você; o agente continua pedindo aprovação para cada
            comando.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="term-panel" data-vivo={vivo ? "1" : "0"}>
      <header className="term-panel-bar">
        <span className="term-panel-status" title={rotuloSessao}>
          <TerminalIcon aria-hidden />
          {rotuloSessao}
        </span>

        <div className="term-panel-shells" role="group" aria-label="tipo de shell">
          {SHELLS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-ativo={shell === item.id ? "1" : "0"}
              onClick={() => setShell(item.id)}
              title={`Abrir com ${item.label}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="term-panel-acao"
          onClick={() => setNonce((valor) => valor + 1)}
          title={vivo ? "Reiniciar o shell" : "Abrir de novo"}
          aria-label={vivo ? "Reiniciar o shell" : "Abrir de novo"}
        >
          <RotateCw aria-hidden />
        </button>
        <button
          type="button"
          className="term-panel-acao"
          onClick={() => termRef.current?.clear()}
          title="Limpar a tela (o histórico do shell continua)"
          aria-label="Limpar a tela"
        >
          <Eraser aria-hidden />
        </button>
        {aoFechar ? (
          <button
            type="button"
            className="term-panel-acao"
            onClick={aoFechar}
            title="Recolher o painel (o shell continua rodando)"
            aria-label="Recolher o painel do terminal"
          >
            <X aria-hidden />
          </button>
        ) : null}
      </header>

      {sessao.erro !== "" ? (
        <p className="term-panel-erro" role="alert">
          {sessao.erro}
        </p>
      ) : null}

      <div className="term-panel-tela" ref={hostRef} />
    </div>
  );
}

/* ---------------------------------- dock ---------------------------------- */

export interface TerminalDockProps {
  /** Pasta onde o shell abre — ver `TerminalPanelProps.cwd`. */
  cwd?: string;
}

/**
 * O dock acoplável: uma barra fina no pé da superfície com o botão que abre e
 * fecha o painel, mais o atalho Ctrl+` (o mesmo músculo do VS Code).
 *
 * Duas decisões de ciclo de vida, e os porquês:
 *
 * 1. O painel só MONTA na primeira abertura (`jaAbriu`). Montar junto com a
 *    superfície abriria um shell que a pessoa talvez nunca use — ConPTY custa
 *    um processo, e o teto de 8 sessões do Rust é para quem usa, não para
 *    quem só passou pela aba.
 *
 * 2. Depois de aberto, fechar ESCONDE (`hidden`), não desmonta. Desmontar
 *    mata o shell (é o contrato do painel), e perder um dev server rodando
 *    porque a pessoa recolheu o painel para ler código seria punir o gesto
 *    mais comum. O CSS reafirma `display: none` para `[hidden]` porque o
 *    atributo é só folha de estilo de agente — qualquer `display` declarado
 *    depois o vence em silêncio (armadilha já vivida na referência).
 */
export function TerminalDock({ cwd }: TerminalDockProps): ReactNode {
  const [aberto, setAberto] = useState(false);
  const [jaAbriu, setJaAbriu] = useState(false);

  const alternar = useCallback(() => {
    setAberto((valor) => !valor);
    setJaAbriu(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // `code === "Backquote"` cobre o layout ABNT, onde a crase é tecla
      // morta e `event.key` chega como "Dead" — só o `key` deixaria o atalho
      // inerte exatamente nas estações do time.
      if ((event.ctrlKey || event.metaKey) && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        alternar();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alternar]);

  return (
    <section className="term-dock" data-aberto={aberto ? "1" : "0"} aria-label="terminal interativo">
      <header className="term-dock-bar">
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
          <TerminalPanel cwd={cwd} aoFechar={() => setAberto(false)} />
        </div>
      ) : null}
    </section>
  );
}

export default TerminalPanel;
