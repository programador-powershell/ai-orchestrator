/**
 * Persistência e resume de execuções do DAG do modo Agent.
 *
 * Antes, uma execução vivia só na memória da aba: erro de provedor no meio de
 * um fluxo de 12 nós, recarregou a página, perdeu tudo — e reexecutar refazia
 * (e recobrava) os nós que já tinham dado certo.
 *
 * Aqui a execução vira um documento serializável, e o resume só reaproveita o
 * que TERMINOU BEM. Nó falho, pulado, em aprovação ou interrompido volta para
 * a fila, junto com tudo que depende dele.
 *
 * Regra dura: o resume é recusado se o DAG mudou desde a execução salva
 * (fingerprint). Reaproveitar saída de um nó cujo prompt foi editado seria
 * mentir sobre o que foi executado.
 *
 * Módulo puro (sem DOM, sem storage) — quem lê/escreve o localStorage é a view.
 * Coberto por agentRun.test.ts.
 */
import type { DagDoc } from "./dag";

export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed" | "skipped";

export interface NodeRun {
  status: RunStatus;
  output: string;
  note?: string;
  durationMs?: number;
}

/** Estado terminal da execução inteira. */
export type RunState = "running" | "done" | "aborted";

export interface PersistedRun {
  version: 1;
  /** Impede resume contra um DAG diferente do que gerou estas saídas. */
  fingerprint: string;
  docName: string;
  startedAt: number;
  finishedAt?: number;
  state: RunState;
  runs: Record<string, NodeRun>;
}

export const RUN_STORAGE_KEY = "aio.agent.run.v1";

const STATUSES: RunStatus[] = ["queued", "running", "waiting", "done", "failed", "skipped"];
const STATES: RunState[] = ["running", "done", "aborted"];

/* --------------------------- fingerprint --------------------------- */

/**
 * Identidade do que será executado: id, tipo, prompt e dependências de cada
 * nó, em ordem estável. Nome do nó e posição no canvas ficam de fora de
 * propósito — renomear ou arrastar um cartão não invalida a execução.
 */
export function docFingerprint(doc: DagDoc): string {
  const parts = [...doc.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => `${node.id}:${node.kind}:${[...node.dependsOn].sort().join(",")}:${node.prompt ?? ""}`);
  return djb2(parts.join("|"));
}

/** Hash curto e determinístico — só precisa detectar mudança, não resistir a ataque. */
function djb2(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/* ------------------------- serialização ---------------------------- */

export function makeRun(doc: DagDoc, startedAt: number): PersistedRun {
  return {
    version: 1,
    fingerprint: docFingerprint(doc),
    docName: doc.name,
    startedAt,
    state: "running",
    runs: {}
  };
}

export function serializeRun(run: PersistedRun): string {
  return JSON.stringify(run);
}

/** Valida e restaura uma execução salva. `null` se ausente, corrompida ou de outra versão. */
export function parseRun(json: string): PersistedRun | null {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const run = raw as Partial<PersistedRun>;
    if (run.version !== 1) return null;
    if (typeof run.fingerprint !== "string" || typeof run.docName !== "string") return null;
    if (typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt)) return null;
    if (!STATES.includes(run.state as RunState)) return null;
    if (run.finishedAt !== undefined && typeof run.finishedAt !== "number") return null;
    if (!run.runs || typeof run.runs !== "object" || Array.isArray(run.runs)) return null;

    const runs: Record<string, NodeRun> = {};
    for (const [id, entry] of Object.entries(run.runs as Record<string, unknown>)) {
      const node = entry as Partial<NodeRun>;
      if (!node || typeof node !== "object") return null;
      if (!STATUSES.includes(node.status as RunStatus)) return null;
      if (typeof node.output !== "string") return null;
      if (node.note !== undefined && typeof node.note !== "string") return null;
      if (node.durationMs !== undefined && typeof node.durationMs !== "number") return null;
      runs[id] = {
        status: node.status as RunStatus,
        output: node.output,
        ...(node.note !== undefined ? { note: node.note } : {}),
        ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {})
      };
    }
    return {
      version: 1,
      fingerprint: run.fingerprint,
      docName: run.docName,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      state: run.state as RunState,
      runs
    };
  } catch {
    return null;
  }
}

/* ----------------------------- resume ------------------------------ */

export interface ResumePlan {
  /** Nós que não serão reexecutados — já terminaram bem. */
  reuse: string[];
  /** Saídas aproveitadas, para alimentar o contexto dos nós seguintes. */
  outputs: Map<string, string>;
  /** Nós que vão rodar de novo. */
  rerun: string[];
}

export interface ResumeRefusal {
  reason: "sem-execucao" | "dag-mudou" | "nada-a-retomar";
  message: string;
}

/**
 * Decide o que reaproveitar. Só nó `done` conta, e só se TODAS as suas
 * dependências também forem reaproveitadas: se um pai vai reexecutar, a saída
 * do filho foi produzida a partir de um contexto que não existe mais.
 */
export function planResume(doc: DagDoc, saved: PersistedRun | null): ResumePlan | ResumeRefusal {
  if (!saved) {
    return { reason: "sem-execucao", message: "Nenhuma execução salva para retomar." };
  }
  if (saved.fingerprint !== docFingerprint(doc)) {
    return {
      reason: "dag-mudou",
      message: "O fluxo mudou desde a execução salva — retomar reaproveitaria saídas de outro grafo."
    };
  }

  const reuse: string[] = [];
  const rerun: string[] = [];
  const outputs = new Map<string, string>();
  const reused = new Set<string>();

  // Ordem topológica: um nó só é avaliado depois das suas dependências.
  for (const node of topoOrder(doc)) {
    const previous = saved.runs[node.id];
    const parentsOk = node.dependsOn.every((dep) => reused.has(dep));
    if (previous?.status === "done" && parentsOk) {
      reuse.push(node.id);
      reused.add(node.id);
      outputs.set(node.id, previous.output);
    } else {
      rerun.push(node.id);
    }
  }

  if (!reuse.length) {
    return { reason: "nada-a-retomar", message: "Nenhum nó concluído para reaproveitar — use Executar." };
  }
  return { reuse, outputs, rerun };
}

export function isRefusal(plan: ResumePlan | ResumeRefusal): plan is ResumeRefusal {
  return "reason" in plan;
}

/**
 * Ordem topológica estável. Nó com dependência ausente entra no fim: o
 * executor já trata isso, aqui só não pode travar o laço.
 */
function topoOrder(doc: DagDoc) {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const done = new Set<string>();
  const order: typeof doc.nodes = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of doc.nodes) {
      if (done.has(node.id)) continue;
      if (node.dependsOn.every((dep) => done.has(dep) || !byId.has(dep))) {
        order.push(node);
        done.add(node.id);
        progressed = true;
      }
    }
  }
  // Sobra = ciclo; devolve na ordem do documento para não perder nó.
  for (const node of doc.nodes) if (!done.has(node.id)) order.push(node);
  return order;
}

/** Resumo humano do que a retomada vai fazer. */
export function describeResume(plan: ResumePlan): string {
  return `Retomando: ${plan.reuse.length} nó(s) reaproveitado(s), ${plan.rerun.length} para executar.`;
}
