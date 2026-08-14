/**
 * Cliente do terminal interativo (comandos Rust `pty_*`).
 *
 * A parte pura (estado, contadores, log) está em `ptySession.ts`. Aqui só o
 * transporte: resolver a rota, abrir, assinar os eventos e encerrar.
 *
 * ## O ambiente do rodapé é resolvido AQUI
 *
 * `resolveRoute` é a mesma função que o `terminal.execute` usa. Sem passar por
 * ela, o PTY abriria sempre na estação enquanto o badge dizia "VPS" — o engano
 * que a V.9 corrigiu no comando avulso e que voltaria pela porta do terminal
 * interativo. Rota `blocked` **não cai para local**: devolve o motivo.
 *
 * ## O agente não usa este módulo
 *
 * `write` entrega tecla ao shell sem passar por aprovação. Isso é correto para
 * a pessoa (são as mãos dela) e é porta lateral para o modelo. Nada aqui deve
 * ser exposto como ferramenta de agente — ver o cabeçalho de `src-tauri/src/pty.rs`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { resolveRoute, routeLabel, toTarget } from "./ssh";
import { useApp } from "./store";

const isTauriHost = "__TAURI_INTERNALS__" in window;

/** true = PTY real; false = navegador, onde não existe processo para abrir. */
export const isPtyAvailable = isTauriHost;

/** Tipo de shell. NÃO é caminho — o Rust resolve (ver pty.rs, item 1). */
export type ShellKind = "default" | "powerShell" | "cmd" | "bash";

export interface PtyDataEvent {
  id: string;
  data: string;
}
export interface PtyExitEvent {
  id: string;
  exitCode?: number;
  reason: string;
}
export interface PtyErrorEvent {
  id?: string;
  code: string;
  message: string;
}
export interface PtySessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  target: string;
}

export interface SpawnOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: ShellKind;
}

export interface SpawnResult {
  id: string;
  /** `local` ou `user@host` — para a tela nunca afirmar o destino errado. */
  target: string;
}

/**
 * Abre uma sessão, honrando o ambiente selecionado no rodapé.
 *
 * Lança com o motivo quando a rota está bloqueada (VPS sem servidor, ou dois
 * habilitados) — cair para local em silêncio seria repetir o engano com cara
 * nova.
 */
export async function ptySpawn(options: SpawnOptions = {}): Promise<SpawnResult> {
  if (!isTauriHost) {
    throw new Error("terminal interativo requer o app desktop");
  }
  const { environment, deployServers } = useApp.getState().settings;
  const rota = resolveRoute(environment ?? "local", deployServers ?? []);
  if (rota.kind === "blocked") {
    throw new Error(rota.reason);
  }
  const id = await invoke<string>("pty_spawn", {
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    shell: options.shell ?? "default",
    ssh: rota.kind === "ssh" ? toTarget(rota.server) : null
  });
  return { id, target: routeLabel(rota) };
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  if (!isTauriHost) return;
  await invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  if (!isTauriHost) return;
  await invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  if (!isTauriHost) return;
  await invoke("pty_kill", { id });
}

/** Encerra tudo — para o app não deixar shell órfão ao fechar. */
export async function ptyKillAll(): Promise<number> {
  if (!isTauriHost) return 0;
  return invoke<number>("pty_kill_all");
}

export async function ptyList(): Promise<PtySessionInfo[]> {
  if (!isTauriHost) return [];
  return invoke<PtySessionInfo[]>("pty_list");
}

export interface PtyListeners {
  onData?: (event: PtyDataEvent) => void;
  onExit?: (event: PtyExitEvent) => void;
  onError?: (event: PtyErrorEvent) => void;
}

/**
 * Assina os eventos de UMA sessão e devolve a função de desinscrição.
 *
 * O filtro por `id` é feito aqui porque o Tauri emite para a janela inteira: com
 * dois terminais abertos, sem filtro cada um receberia a saída do outro.
 *
 * Chamar o retorno é obrigatório ao desmontar — cada `listen` deixa um handler
 * vivo, e a aba Code remonta a cada troca de aba.
 */
export async function ptyListen(id: string, listeners: PtyListeners): Promise<UnlistenFn> {
  if (!isTauriHost) return () => undefined;
  const desinscricoes: UnlistenFn[] = [];
  desinscricoes.push(
    await listen<PtyDataEvent>("pty-data", (event) => {
      if (event.payload.id !== id) return;
      listeners.onData?.(event.payload);
    })
  );
  desinscricoes.push(
    await listen<PtyExitEvent>("pty-exit", (event) => {
      if (event.payload.id !== id) return;
      listeners.onExit?.(event.payload);
    })
  );
  desinscricoes.push(
    await listen<PtyErrorEvent>("pty-error", (event) => {
      // Erro sem id é do subsistema, não de uma sessão: entregar para quem
      // estiver ouvindo é melhor que engolir.
      if (event.payload.id && event.payload.id !== id) return;
      listeners.onError?.(event.payload);
    })
  );
  return () => {
    for (const desinscrever of desinscricoes) desinscrever();
  };
}
