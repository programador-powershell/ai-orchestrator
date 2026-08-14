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

/**
 * Confirma blocos já desenhados — devolve fôlego à leitura do PTY.
 *
 * O Rust emite no máximo `JANELA_BLOCOS` blocos sem confirmação e, passando
 * disso, PARA de ler o PTY; o freio chega ao processo filho, que bloqueia na
 * escrita, como em qualquer terminal. Sem confirmar, um comando tagarela
 * congelaria em vez de correr — por isso o `Terminal` chama esta função no
 * callback do `term.write`, que é o instante em que o xterm.js realmente
 * processou aquele pedaço.
 *
 * Erro aqui é engolido de propósito: sessão que acabou de encerrar devolve
 * SESSION_NOT_FOUND, e transformar isso em faixa vermelha na tela seria
 * ruído sobre algo que já terminou bem.
 */
export async function ptyAck(id: string, blocos = 1): Promise<void> {
  if (!isTauriHost) return;
  try {
    await invoke("pty_ack", { id, blocos });
  } catch {
    // sessão já encerrada — nada a confirmar
  }
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
  const inscricao = await ptyListenPendente(listeners);
  inscricao.amarrar(id);
  return inscricao.parar;
}

/** Inscrição feita ANTES de existir id — ver `ptyListenPendente`. */
export interface PtyInscricaoPendente {
  /** Passa a filtrar por esta sessão e ENTREGA o que chegou antes, em ordem. */
  amarrar: (id: string) => void;
  parar: UnlistenFn;
}

/**
 * Assina os três eventos ANTES de saber o id, guardando o que chegar.
 *
 * Existe por uma corrida real: a thread de leitura do Rust começa a emitir
 * `pty-data` no instante em que o filho nasce, e o front só consegue assinar
 * depois que `pty_spawn` volta — mais três round-trips de IPC do `listen`.
 * Evento do Tauri sem ouvinte é DESCARTADO, não enfileirado; o que se perdia
 * era justamente o começo: a faixa do PowerShell, o primeiro prompt, a
 * primeira linha de um comando passado na abertura. Dava um terminal em
 * branco que só reagia depois do primeiro Enter — parecendo travado.
 *
 * Assinando antes, nada se perde. O que chega antes de `amarrar` fica numa
 * fila; ao amarrar, o que é da sessão é entregue na ordem e o resto é
 * descartado (com dois terminais abertos, cada um vê a fila dos dois).
 *
 * A fila tem teto. Se `amarrar` nunca vier — spawn que falhou, efeito
 * cancelado —, ela para de crescer em vez de segurar a saída inteira de um
 * processo tagarela na memória.
 */
const MAX_EVENTOS_PENDENTES = 512;

export async function ptyListenPendente(listeners: PtyListeners): Promise<PtyInscricaoPendente> {
  if (!isTauriHost) return { amarrar: () => undefined, parar: () => undefined };

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
      // estiver ouvindo é melhor que engolir.
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
