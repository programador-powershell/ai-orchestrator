/**
 * runLog — cliente do log local do run (comandos Rust `run_*`).
 *
 * É a FONTE de verdade do local-first: o run grava aqui primeiro e sincroniza
 * para o gateway depois. Escrever no gateway primeiro tornaria a rede
 * requisito para o agente dar um passo.
 *
 * No navegador (ou numa build sem os comandos) cai em memória, claramente
 * rotulado — a UI segue navegável, mas nada disso sobrevive ao refresh. Não é
 * "persistência degradada"; é ausência de persistência, e quem consome precisa
 * saber a diferença.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RunEvent } from "./wsProtocol";

const isTauriHost = "__TAURI_INTERNALS__" in window;

/** true = log real em SQLite; false = memória volátil do navegador. */
export const isDurableRunLog = isTauriHost;

export interface SessionRow {
  id: string;
  mode: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  runs: number;
}

export interface RunRow {
  id: string;
  sessionId: string;
  status: RunStatus;
  lastSeq: number;
  /** Até onde o gateway confirmou. `lastSeq - syncedSeq` é o que falta subir. */
  syncedSeq: number;
  graph: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  nodeId: string;
  tool: string;
  args: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
}

export type RunStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "canceled";

/* --------------------------- Espelho em memória ------------------------ */
/*
 * Só para o navegador. Mantém a MESMA semântica do SQLite nas duas coisas que
 * importam: `seq` monotônico por run e primeira decisão de aprovação vence —
 * senão a tela se comportaria diferente nos dois hosts e o bug apareceria só
 * no desktop.
 */
const demoSessions = new Map<string, SessionRow>();
const demoRuns = new Map<string, RunRow>();
const demoEvents = new Map<string, RunEvent[]>();
const demoApprovals = new Map<string, ApprovalRow>();

function agora(): string {
  return new Date().toISOString();
}

export const runLog = {
  async sessionCreate(input: {
    id: string;
    mode?: string;
    title?: string;
    cwd?: string;
    parentId?: string;
  }): Promise<string> {
    if (isTauriHost) {
      return invoke<string>("run_session_create", {
        id: input.id,
        mode: input.mode,
        title: input.title,
        cwd: input.cwd,
        parentId: input.parentId
      });
    }
    const existente = demoSessions.get(input.id);
    demoSessions.set(input.id, {
      id: input.id,
      mode: input.mode ?? "agent",
      title: input.title ?? "",
      cwd: input.cwd ?? "",
      createdAt: existente?.createdAt ?? agora(),
      updatedAt: agora(),
      runs: existente?.runs ?? 0
    });
    return input.id;
  },

  async sessionsList(): Promise<SessionRow[]> {
    if (isTauriHost) return invoke<SessionRow[]>("run_sessions_list");
    return [...demoSessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async runCreate(input: { id: string; sessionId: string; graph: unknown }): Promise<string> {
    if (isTauriHost) {
      return invoke<string>("run_create", {
        id: input.id,
        sessionId: input.sessionId,
        graph: input.graph
      });
    }
    if (!demoRuns.has(input.id)) {
      demoRuns.set(input.id, {
        id: input.id,
        sessionId: input.sessionId,
        status: "pending",
        lastSeq: 0,
        syncedSeq: 0,
        graph: input.graph,
        createdAt: agora(),
        updatedAt: agora()
      });
      demoEvents.set(input.id, []);
      const sessao = demoSessions.get(input.sessionId);
      if (sessao) sessao.runs += 1;
    }
    return input.id;
  },

  /** Grava um evento e devolve o `seq` atribuído. */
  async append(input: {
    runId: string;
    kind: string;
    nodeId?: string;
    payload?: unknown;
  }): Promise<number> {
    if (isTauriHost) {
      return invoke<number>("run_append", {
        runId: input.runId,
        kind: input.kind,
        nodeId: input.nodeId,
        payload: input.payload
      });
    }
    const lista = demoEvents.get(input.runId) ?? [];
    const seq = (lista.at(-1)?.seq ?? 0) + 1;
    lista.push({
      seq,
      kind: input.kind,
      nodeId: input.nodeId ?? "",
      payload: input.payload ?? {},
      ts: agora()
    });
    demoEvents.set(input.runId, lista);
    const run = demoRuns.get(input.runId);
    if (run) {
      run.lastSeq = Math.max(run.lastSeq, seq);
      run.updatedAt = agora();
    }
    return seq;
  },

  async eventsSince(runId: string, fromSeq = 0, limit = 500): Promise<RunEvent[]> {
    if (isTauriHost) {
      return invoke<RunEvent[]>("run_events_since", { runId, fromSeq, limit });
    }
    return (demoEvents.get(runId) ?? []).filter((event) => event.seq > fromSeq).slice(0, limit);
  },

  async get(runId: string): Promise<RunRow | null> {
    if (isTauriHost) return (await invoke<RunRow | null>("run_get", { runId })) ?? null;
    return demoRuns.get(runId) ?? null;
  },

  async list(sessionId?: string): Promise<RunRow[]> {
    if (isTauriHost) return invoke<RunRow[]>("run_list", { sessionId });
    const todos = [...demoRuns.values()];
    const filtrados = sessionId ? todos.filter((run) => run.sessionId === sessionId) : todos;
    return filtrados.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async setStatus(runId: string, status: RunStatus, error?: string): Promise<void> {
    if (isTauriHost) {
      await invoke("run_set_status", { runId, status, error });
      return;
    }
    const run = demoRuns.get(runId);
    if (run) {
      run.status = status;
      run.updatedAt = agora();
    }
  },

  /** Avança o cursor de sincronização — chamado no `ack` do WebSocket. */
  async markSynced(runId: string, seq: number): Promise<void> {
    if (isTauriHost) {
      await invoke("run_mark_synced", { runId, seq });
      return;
    }
    const run = demoRuns.get(runId);
    // `Math.max` pelo mesmo motivo do SQLite: ack atrasado não anda para trás.
    if (run) run.syncedSeq = Math.max(run.syncedSeq, seq);
  },

  /** Runs com evento pendente de subir — a fila do sincronizador. */
  async pendingSync(): Promise<string[]> {
    if (isTauriHost) return invoke<string[]>("run_pending_sync");
    return [...demoRuns.values()]
      .filter((run) => run.lastSeq > run.syncedSeq)
      .map((run) => run.id);
  },

  async approvalAsk(input: {
    id: string;
    runId: string;
    nodeId?: string;
    tool: string;
    args?: unknown;
  }): Promise<string> {
    if (isTauriHost) {
      return invoke<string>("run_approval_ask", {
        id: input.id,
        runId: input.runId,
        nodeId: input.nodeId,
        tool: input.tool,
        args: input.args
      });
    }
    if (!demoApprovals.has(input.id)) {
      demoApprovals.set(input.id, {
        id: input.id,
        runId: input.runId,
        nodeId: input.nodeId ?? "",
        tool: input.tool,
        args: input.args ?? {},
        status: "pending",
        createdAt: agora()
      });
    }
    return input.id;
  },

  /** Decide e devolve o status que VALEU (a primeira decisão vence). */
  async approvalDecide(id: string, approved: boolean): Promise<string> {
    if (isTauriHost) return invoke<string>("run_approval_decide", { id, approved });
    const pedido = demoApprovals.get(id);
    if (!pedido) throw new Error(`aprovação inexistente: ${id}`);
    if (pedido.status === "pending") pedido.status = approved ? "approved" : "denied";
    return pedido.status;
  },

  async approvalsPending(runId: string): Promise<ApprovalRow[]> {
    if (isTauriHost) return invoke<ApprovalRow[]>("run_approvals_pending", { runId });
    return [...demoApprovals.values()].filter(
      (item) => item.runId === runId && item.status === "pending"
    );
  }
};
