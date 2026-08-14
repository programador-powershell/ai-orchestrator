"use client";

/**
 * O TERMINAL de verdade — emulador, não log com cores.
 *
 * O que existia era um scrollback de linhas tipadas: cada linha guardava um
 * papel ("comando", "erro", "agente") e recebia uma cor do app. Isso lê bem um
 * `git status` e não é um terminal — `vim`, `htop`, `nano`, `top`, um menu de
 * instalador, qualquer coisa que desenhe posicionando o cursor numa grade,
 * saía como lixo ou como nada. Nem `\r` de barra de progresso funcionava.
 *
 * Agora quem desenha é o xterm.js, ligado direto no PTY. Ele mantém a grade,
 * o cursor, as regiões de rolagem, os modos de teclado — o contrato que os
 * programas de terminal assumem há quarenta anos.
 *
 * ## Quem digita é a PESSOA
 *
 * `ptyWrite` entrega tecla ao shell sem passar por aprovação, e isso é correto
 * enquanto as mãos são humanas. Nenhum caminho daqui é exposto como ferramenta
 * de agente: um modelo com acesso a `write` num shell aberto contornaria todos
 * os gates de uma vez só. Ver o cabeçalho de `src-tauri/src/pty.rs`.
 *
 * ## O destino é o do rodapé
 *
 * `ptySpawn` resolve o ambiente selecionado (`resolveRoute`): com VPS ativo, o
 * shell é o do servidor. A faixa do topo diz qual é — um terminal que não
 * mostra em qual máquina está é um convite a rodar o comando certo no lugar
 * errado.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";

import { Glyph } from "./icons";
import {
  isPtyAvailable,
  ptyAck,
  ptyKill,
  ptyListenPendente,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type ShellKind
} from "../lib/pty";
import { ansiCssVars, termPalette, xtermTheme } from "../lib/termTheme";
import { describeSession, emptySession, reduceSession } from "../lib/ptySession";
import { useApp } from "../lib/store";

/** Teto do scrollback. Terminal de verdade também tem — memória é finita. */
const SCROLLBACK = 5000;

const SHELLS: Array<{ id: ShellKind; label: string }> = [
  { id: "default", label: "Padrão" },
  { id: "powerShell", label: "PowerShell" },
  { id: "cmd", label: "cmd" },
  { id: "bash", label: "bash" }
];

export function Terminal({ cwd }: { cwd: string }) {
  const theme = useApp((state) => state.theme);
  const environment = useApp((state) => state.settings.environment ?? "local");

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);

  const [shell, setShell] = useState<ShellKind>("default");
  /**
   * O estado da sessão vem do REDUTOR, não de `useState` avulso.
   *
   * Antes eram três sinais soltos (`alvo`, `erro`, `vivo`) que não sabiam
   * responder a pergunta que importa quando um terminal fecha sozinho: POR QUE.
   * Chave recusada no SSH, shell inexistente, processo morto pelo sistema — os
   * três viravam "sumiu" na tela, indistinguíveis de defeito nosso. O redutor
   * guarda status, código de saída, tráfego e um log com horário, e tem a regra
   * que o `useState` não tinha: **status terminal não volta atrás** (um
   * `pty-data` atrasado, que chega depois do `pty-exit` porque as duas
   * threads do Rust são independentes, não ressuscita a sessão).
   */
  const [sessao, despachar] = useReducer(reduceSession, undefined, emptySession);
  /** Painel de diagnóstico aberto — fechado por padrão, é para quando dá errado. */
  const [detalhes, setDetalhes] = useState(false);
  const [alvo, setAlvo] = useState("");

  const vivo = sessao.status === "running";
  /*
   * O erro mostrado é a ÚLTIMA entrada de nível `error` do log.
   *
   * Antes era um `useState` que a próxima mensagem sobrescrevia e o próximo
   * spawn limpava — o motivo de uma sessão ter morrido desaparecia da tela
   * antes de a pessoa conseguir ler. Agora ele vive no log, com horário, e o
   * painel de detalhes mostra a sequência inteira.
   */
  const erro = [...sessao.logs].reverse().find((item) => item.level === "error")?.message ?? "";
  /** Incrementar reabre a sessão — é o "novo terminal" e o "reconectar". */
  const [nonce, setNonce] = useState(0);

  const escuro = theme === "dark";
  const palette = useMemo(() => termPalette(escuro), [escuro]);

  /**
   * Monta o emulador UMA vez.
   *
   * Separado do efeito da sessão de propósito: recriar o `Xterm` a cada troca
   * de tema ou de shell jogaria fora o scrollback inteiro, que é justamente o
   * que a pessoa quer manter ao mexer nessas coisas.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      scrollback: SCROLLBACK,
      cursorBlink: true,
      convertEol: false,
      fontSize: 12,
      // Fonte monoespaçada do app, com as de sistema atrás: caixa desalinhada
      // desmancha qualquer desenho de caixa (`tree`, `htop`, tabela de `git`).
      fontFamily: 'var(--font-mono), "Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // A tecla vai para o shell; o eco é dele. Ecoar aqui duplicaria tudo, e
    // pior: mostraria a senha que o `sudo` está pedindo para esconder.
    const disposeData = term.onData((data) => {
      const id = idRef.current;
      if (!id) return;
      despachar({ type: "write", at: new Date().toISOString(), bytes: data.length });
      void ptyWrite(id, data);
    });

    /*
     * O tamanho da grade é do CONTAINER, e precisa ir para o outro lado.
     * Sem `ptyResize`, o shell continua achando que tem 80 colunas: o `less`
     * quebra na coluna errada e o `vim` desenha metade da tela.
     */
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // painel com altura zero durante a transição de aba
      }
    });
    observer.observe(host);

    const disposeResize = term.onResize(({ cols, rows }) => {
      const id = idRef.current;
      if (!id) return;
      despachar({ type: "resize", at: new Date().toISOString(), cols, rows });
      void ptyResize(id, cols, rows);
    });

    return () => {
      observer.disconnect();
      disposeData.dispose();
      disposeResize.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  /** Tema: troca a paleta sem recriar nada. */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(palette);
    // As mesmas cores viram variáveis CSS para o resto da aba (o interpretador
    // do `lib/ansi.ts`) pintar igual ao emulador.
    const host = hostRef.current;
    if (host) {
      for (const [nome, valor] of Object.entries(ansiCssVars(palette))) host.style.setProperty(nome, valor);
    }
  }, [palette]);

  /** Abre a sessão e liga os eventos. Refaz ao trocar shell, pasta ou destino. */
  useEffect(() => {
    if (!isPtyAvailable) {
      despachar({
        type: "spawn:fail",
        at: new Date().toISOString(),
        message: "O terminal interativo existe só no app desktop."
      });
      return;
    }
    const term = termRef.current;
    if (!term) return;

    let cancelado = false;
    let desinscrever: (() => void) | undefined;
    /*
     * O id que ESTE efeito abriu — não o do ref.
     *
     * O `onExit` zera `idRef` (é o certo: teclar num shell morto não deve ir
     * a lugar nenhum), e a limpeza lia justamente esse ref. Depois de uma
     * saída espontânea ela via `null` e não chamava `ptyKill`, deixando a
     * entrada no mapa do Rust — oito ciclos de "encerrou, reabri" e o painel
     * batia no limite de sessões com nenhum shell vivo.
     */
    let idAberto: string | null = null;

    (async () => {
      // `spawn:start` ZERA a sessão: reabrir não pode herdar o log nem os
      // contadores da anterior, senão o diagnóstico mistura duas execuções.
      despachar({
        type: "spawn:start",
        at: new Date().toISOString(),
        cwd,
        target: "…",
        cols: term.cols,
        rows: term.rows
      });
      try {
        fitRef.current?.fit();
      } catch {
        // sem medida ainda: o spawn usa o padrão e o resize corrige depois
      }

      /*
       * A inscrição vem ANTES do spawn.
       *
       * A thread de leitura do Rust emite `pty-data` assim que o filho nasce,
       * e evento do Tauri sem ouvinte é descartado — assinar depois do
       * `await ptySpawn` perdia o começo da sessão (faixa do shell, primeiro
       * prompt). `ptyListenPendente` guarda o que chegar e entrega ao
       * `amarrar`, quando o id finalmente existe.
       */
      const inscricao = await ptyListenPendente({
        /*
         * O segundo argumento do `write` é o freio.
         *
         * Ele dispara quando o xterm.js processou ESTE bloco — não quando o
         * enfileirou. Confirmando aí, o Rust volta a ler o PTY; sem
         * confirmar, ele para na janela e o processo filho bloqueia na
         * escrita, que é o comportamento certo. Antes não havia nada
         * segurando o produtor, e o buffer do xterm descarta em silêncio
         * acima de 5×10⁷ bytes pendentes: a saída não ficava lenta, ficava
         * FALTANDO pedaço no meio.
         */
        onData: (evento) => {
          // O contador de tráfego é por BYTE, não por bloco: é o número que
          // responde "o processo estava mesmo escrevendo?" quando a tela
          // parece parada.
          despachar({ type: "data", at: new Date().toISOString(), bytes: evento.data.length });
          term.write(evento.data, () => void ptyAck(evento.id));
        },
        onExit: (evento) => {
          despachar({
            type: "exit",
            at: new Date().toISOString(),
            exitCode: evento.exitCode,
            reason: evento.reason
          });
          idRef.current = null;
          // O código de saída aparece na tela, como em terminal de verdade.
          const codigo = evento.exitCode ?? 0;
          term.write(
            `
[2m[processo encerrado · ${evento.reason}` +
              `${evento.exitCode === undefined ? "" : ` · código ${codigo}`}][0m
`
          );
        },
        onError: (evento) =>
          despachar({
            type: "error",
            at: new Date().toISOString(),
            code: evento.code,
            message: evento.message
          })
      });
      // A limpeza já pode desinscrever a partir daqui — antes desta linha ela
      // via `undefined` e os três handlers de janela ficavam vivos para sempre.
      desinscrever = inscricao.parar;
      if (cancelado) {
        inscricao.parar();
        return;
      }

      try {
        const { id, target } = await ptySpawn({
          cwd,
          cols: term.cols,
          rows: term.rows,
          shell
        });
        if (cancelado) {
          void ptyKill(id);
          return;
        }
        idRef.current = id;
        idAberto = id;
        despachar({ type: "spawn:ok", at: new Date().toISOString(), id });
        // O destino real só se conhece depois do spawn (a rota pode ser SSH).
        setAlvo(target);
        inscricao.amarrar(id);
      } catch (causa) {
        if (cancelado) return;
        // Rota bloqueada (VPS sem servidor) chega aqui com o motivo escrito —
        // cair para local em silêncio seria rodar na máquina errada.
        despachar({
          type: "spawn:fail",
          at: new Date().toISOString(),
          message: causa instanceof Error ? causa.message : String(causa)
        });
      }
    })();

    return () => {
      cancelado = true;
      desinscrever?.();
      idRef.current = null;
      // Fechar a aba mata o shell: deixá-lo vivo sem tela seria um processo
      // órfão consumindo a máquina sem ninguém para vê-lo. Em sessão que já
      // encerrou, o `pty_kill` é idempotente e serve para tirar a entrada do
      // mapa — por isso vai o id local, e não o do ref.
      if (idAberto) {
        despachar({ type: "kill", at: new Date().toISOString() });
        void ptyKill(idAberto);
      }
    };
  }, [cwd, shell, environment, nonce]);

  return (
    <div className="xterm-host" data-alive={vivo ? "1" : "0"}>
      <header className="xterm-bar">
        <span className="xterm-alvo" title={`Os comandos rodam em ${alvo || "…"} · ${describeSession(sessao)}`}>
          <Glyph name={environment === "vps" ? "environments/vps" : "environments/local"} size={12} />
          {alvo || "abrindo…"}
        </span>

        <div className="segmented segmented--acoes xterm-shells">
          {SHELLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={shell === item.id ? "active" : ""}
              onClick={() => setShell(item.id)}
              title={`Abrir com ${item.label}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="icon-button"
          onClick={() => setNonce((valor) => valor + 1)}
          title={vivo ? "Reiniciar o shell" : "Abrir de novo"}
          aria-label={vivo ? "Reiniciar o shell" : "Abrir de novo"}
        >
          <Glyph name="actions/refresh" size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => termRef.current?.clear()}
          title="Limpar a tela (o histórico do shell continua)"
          aria-label="Limpar a tela"
        >
          <Glyph name="ui/close" size={13} />
        </button>

        <button
          type="button"
          className={`icon-button${detalhes ? " active" : ""}`}
          onClick={() => setDetalhes((valor) => !valor)}
          title="Diagnóstico da sessão"
          aria-label="Diagnóstico da sessão"
          aria-expanded={detalhes}
        >
          <Glyph name="features/diagnostics" size={13} />
        </button>
      </header>

      {erro ? (
        <p className="xterm-erro">
          <Glyph name="status/warning" size={12} />
          {erro}
        </p>
      ) : null}

      {detalhes ? (
        /*
         * O que responde "por que aquele terminal morreu".
         *
         * Chave recusada no SSH, shell inexistente, processo morto pelo
         * sistema: os três davam a MESMA tela vazia, indistinguível de defeito
         * nosso. Aqui está o status, o código de saída, o tráfego (que diz se o
         * processo chegou a escrever) e a sequência de eventos com horário.
         */
        <div className="xterm-diag">
          <dl>
            <div>
              <dt>Estado</dt>
              <dd>{describeSession(sessao)}</dd>
            </div>
            <div>
              <dt>Sessão</dt>
              <dd>{sessao.id || "—"}</dd>
            </div>
            <div>
              <dt>Tráfego</dt>
              <dd>
                {sessao.bytesIn} B lidos · {sessao.bytesOut} B escritos em {sessao.writeCount}
              </dd>
            </div>
            <div>
              <dt>Grade</dt>
              <dd>
                {sessao.cols}×{sessao.rows} · {sessao.resizeCount} ajuste(s)
              </dd>
            </div>
          </dl>
          <ol className="xterm-diag-log">
            {sessao.logs.map((item, indice) => (
              <li key={indice} className={`n-${item.level}`}>
                <time>{item.at.slice(11, 19)}</time>
                <span>{item.message}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="xterm-tela" ref={hostRef} />
    </div>
  );
}
