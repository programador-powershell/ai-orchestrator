/**
 * Estado de uma sessão de PTY — parte PURA.
 *
 * Existe separado do transporte porque é o que responde "por que aquele
 * terminal morreu": status, tráfego, contadores e um log de eventos com
 * horário. Sem isso, uma sessão que fecha sozinha (chave recusada no SSH,
 * shell inexistente, processo morto pelo SO) vira "sumiu" na tela, e não há
 * como distinguir de bug nosso.
 */

export type PtyStatus = "spawning" | "running" | "exited" | "killed" | "error";

export type PtyLogLevel = "info" | "warn" | "error";

export interface PtyLog {
  /** ISO. Vem de quem despacha a ação, não de `Date.now()` aqui dentro —
   *  função pura não lê relógio, senão não dá para testar. */
  at: string;
  level: PtyLogLevel;
  message: string;
}

export interface PtySession {
  id: string;
  status: PtyStatus;
  cwd: string;
  /** `local` ou `user@host`. É o rótulo que o rodapé mostra. */
  target: string;
  bytesIn: number;
  bytesOut: number;
  writeCount: number;
  resizeCount: number;
  cols: number;
  rows: number;
  exitCode?: number;
  logs: PtyLog[];
}

export type PtyAction =
  | { type: "spawn:start"; at: string; cwd: string; target: string; cols: number; rows: number }
  | { type: "spawn:ok"; at: string; id: string }
  | { type: "spawn:fail"; at: string; message: string }
  | { type: "data"; at: string; bytes: number }
  | { type: "write"; at: string; bytes: number }
  | { type: "resize"; at: string; cols: number; rows: number }
  | { type: "kill"; at: string }
  | { type: "exit"; at: string; exitCode?: number; reason: string }
  | { type: "error"; at: string; code: string; message: string };

/**
 * Teto do log de eventos.
 *
 * Mesma razão do teto do scrollback: uma sessão longa de dev server gera
 * evento sem parar, e um array que só cresce vira consumo de memória com cara
 * de diagnóstico.
 */
export const MAX_SESSION_LOGS = 200;

export function emptySession(): PtySession {
  return {
    id: "",
    status: "spawning",
    cwd: "",
    target: "local",
    bytesIn: 0,
    bytesOut: 0,
    writeCount: 0,
    resizeCount: 0,
    cols: 80,
    rows: 24,
    logs: []
  };
}

function log(session: PtySession, entry: PtyLog): PtyLog[] {
  const juntos = [...session.logs, entry];
  return juntos.length > MAX_SESSION_LOGS ? juntos.slice(juntos.length - MAX_SESSION_LOGS) : juntos;
}

/**
 * Aplica um evento ao estado. Imutável, sem relógio, sem I/O.
 *
 * A regra que importa: **status terminal não volta atrás.** Um `pty-data`
 * atrasado chegando depois do `pty-exit` (a thread de leitura e a de espera são
 * independentes) não pode ressuscitar a sessão para "running" — a tela diria
 * que há shell vivo onde não há, e o próximo `pty_write` falharia sem
 * explicação.
 */
export function reduceSession(session: PtySession, action: PtyAction): PtySession {
  const terminal = session.status === "exited" || session.status === "killed" || session.status === "error";

  switch (action.type) {
    case "spawn:start":
      return {
        ...emptySession(),
        cwd: action.cwd,
        target: action.target,
        cols: action.cols,
        rows: action.rows,
        logs: [{ at: action.at, level: "info", message: `abrindo em ${action.target}: ${action.cwd}` }]
      };
    case "spawn:ok":
      return {
        ...session,
        id: action.id,
        status: "running",
        logs: log(session, { at: action.at, level: "info", message: `sessão ${action.id} pronta` })
      };
    case "spawn:fail":
      return {
        ...session,
        status: "error",
        logs: log(session, { at: action.at, level: "error", message: action.message })
      };
    case "data":
      // Contabiliza mesmo depois do fim (o byte chegou de fato), mas não
      // reabre o status.
      return { ...session, bytesIn: session.bytesIn + Math.max(0, action.bytes) };
    case "write":
      if (terminal) return session;
      return {
        ...session,
        bytesOut: session.bytesOut + Math.max(0, action.bytes),
        writeCount: session.writeCount + 1
      };
    case "resize":
      if (terminal) return session;
      return {
        ...session,
        cols: action.cols,
        rows: action.rows,
        resizeCount: session.resizeCount + 1
      };
    case "kill":
      if (terminal) return session;
      return {
        ...session,
        logs: log(session, { at: action.at, level: "warn", message: "encerramento pedido" })
      };
    case "exit": {
      if (terminal) return session;
      // `reason` vem do Rust: `exited` | `killed` | `error`.
      const status: PtyStatus =
        action.reason === "killed" ? "killed" : action.reason === "error" ? "error" : "exited";
      const codigo = action.exitCode;
      const nivel: PtyLogLevel = codigo === 0 || status === "killed" ? "info" : "error";
      return {
        ...session,
        status,
        exitCode: codigo,
        logs: log(session, {
          at: action.at,
          level: nivel,
          message: `encerrou (${action.reason}) · exit ${codigo ?? "n/a"}`
        })
      };
    }
    case "error":
      return {
        ...session,
        // Erro de leitura não encerra a sessão por si: o processo pode seguir
        // vivo. Quem decide o fim é o `pty-exit`, com o código real.
        logs: log(session, {
          at: action.at,
          level: "error",
          message: `${action.code}: ${action.message}`
        })
      };
    default:
      return session;
  }
}

/** Resumo de uma linha para a barra de status. */
export function describeSession(session: PtySession): string {
  if (session.status === "spawning") return "abrindo…";
  if (session.status === "running") return `${session.target} · ${session.cols}×${session.rows}`;
  if (session.status === "killed") return "encerrado";
  if (session.status === "error") return "erro";
  return `saiu (${session.exitCode ?? "n/a"})`;
}
