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

import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";

import { Glyph } from "./icons";
import {
  isPtyAvailable,
  ptyKill,
  ptyListen,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type ShellKind
} from "../lib/pty";
import { ansiCssVars, termPalette, xtermTheme } from "../lib/termTheme";
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
  const [alvo, setAlvo] = useState("");
  const [erro, setErro] = useState("");
  const [vivo, setVivo] = useState(false);
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
      if (id) void ptyWrite(id, data);
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
      if (id) void ptyResize(id, cols, rows);
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
      setErro("O terminal interativo existe só no app desktop.");
      return;
    }
    const term = termRef.current;
    if (!term) return;

    let cancelado = false;
    let desinscrever: (() => void) | undefined;

    (async () => {
      setErro("");
      try {
        fitRef.current?.fit();
      } catch {
        // sem medida ainda: o spawn usa o padrão e o resize corrige depois
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
        setAlvo(target);
        setVivo(true);
        desinscrever = await ptyListen(id, {
          onData: (evento) => term.write(evento.data),
          onExit: (evento) => {
            setVivo(false);
            idRef.current = null;
            // O código de saída aparece na tela, como em terminal de verdade.
            const codigo = evento.exitCode ?? 0;
            term.write(
              `\r\n\u001b[2m[processo encerrado \u00b7 ${evento.reason}` +
                `${evento.exitCode === undefined ? "" : ` \u00b7 c\u00f3digo ${codigo}`}]\u001b[0m\r\n`
            );
          },
          onError: (evento) => setErro(`${evento.code}: ${evento.message}`)
        });
      } catch (causa) {
        if (cancelado) return;
        // Rota bloqueada (VPS sem servidor) chega aqui com o motivo escrito —
        // cair para local em silêncio seria rodar na máquina errada.
        setErro(causa instanceof Error ? causa.message : String(causa));
        setVivo(false);
      }
    })();

    return () => {
      cancelado = true;
      desinscrever?.();
      const id = idRef.current;
      idRef.current = null;
      // Fechar a aba mata o shell: deixá-lo vivo sem tela seria um processo
      // órfão consumindo a máquina sem ninguém para vê-lo.
      if (id) void ptyKill(id);
      setVivo(false);
    };
  }, [cwd, shell, environment, nonce]);

  return (
    <div className="xterm-host" data-alive={vivo ? "1" : "0"}>
      <header className="xterm-bar">
        <span className="xterm-alvo" title={`Os comandos rodam em ${alvo || "…"}`}>
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
      </header>

      {erro ? (
        <p className="xterm-erro">
          <Glyph name="status/warning" size={12} />
          {erro}
        </p>
      ) : null}

      <div className="xterm-tela" ref={hostRef} />
    </div>
  );
}
