/**
 * Árvore de delegação — o núcleo do ACIONAMENTO de agentes.
 *
 * A diferença para o flow builder (lib/dag.ts): lá o grafo é desenhado à mão e
 * cada nó é uma chamada isolada, decidida ANTES de executar. Aqui existe um
 * objetivo e um agente raiz; quem decide se o trabalho precisa ser dividido, em
 * quantas partes e em que ordem é o **modelo**, em tempo de execução, chamando
 * a ferramenta `delegate`. Cada subordinado recebe contexto próprio e devolve
 * um relatório ao superior.
 *
 * Por que os limites vivem aqui e são de verdade: um agente que pode criar
 * agentes é uma recursão dirigida por modelo. Sem teto de profundidade, de
 * filhos e de total, um erro de julgamento vira gasto exponencial — e a conta
 * chega em tokens pagos. Os três tetos são checados no núcleo, não na UI, e a
 * recusa volta para o modelo como resultado da ferramenta, para ele se adaptar
 * em vez de travar.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por agentTree.test.ts.
 */

export type TaskStatus = "running" | "waiting-children" | "done" | "failed" | "cancelled";

export interface AgentTask {
  id: string;
  /** null só na raiz. */
  parentId: string | null;
  /** Rótulo curto para a árvore na tela. */
  title: string;
  /** Instrução autocontida que o subordinado recebe. */
  prompt: string;
  depth: number;
  status: TaskStatus;
  /** Relatório devolvido ao superior (ou a mensagem de erro). */
  report: string;
  /** Saída parcial enquanto roda — alimenta o streaming na árvore. */
  output: string;
  childIds: string[];
  startedAt: number;
  finishedAt?: number;
}

export interface TreeState {
  rootId: string;
  tasks: Record<string, AgentTask>;
  /** Total já criado nesta execução — inclui os que terminaram. */
  spawned: number;
}

export interface DelegationLimits {
  /** Quantos níveis abaixo da raiz. 0 = raiz não delega. */
  maxDepth: number;
  /** Filhos diretos por agente. */
  maxChildren: number;
  /** Teto absoluto da execução inteira. */
  maxTotal: number;
}

/**
 * Padrões conservadores de propósito. 3 níveis e 5 filhos já permitem
 * 1 + 5 + 25 + 125 agentes na teoria; o teto total é que segura a conta.
 */
export const DEFAULT_LIMITS: DelegationLimits = {
  maxDepth: 3,
  maxChildren: 5,
  maxTotal: 20
};

export function clampLimits(limits: Partial<DelegationLimits>): DelegationLimits {
  return {
    maxDepth: Math.max(0, Math.min(Math.floor(limits.maxDepth ?? DEFAULT_LIMITS.maxDepth), 5)),
    maxChildren: Math.max(1, Math.min(Math.floor(limits.maxChildren ?? DEFAULT_LIMITS.maxChildren), 10)),
    maxTotal: Math.max(1, Math.min(Math.floor(limits.maxTotal ?? DEFAULT_LIMITS.maxTotal), 60))
  };
}

/* ------------------------------ construção --------------------------- */

export function createTree(rootTitle: string, goal: string, now: number, id = "a1"): TreeState {
  return {
    rootId: id,
    spawned: 1,
    tasks: {
      [id]: {
        id,
        parentId: null,
        title: rootTitle,
        prompt: goal,
        depth: 0,
        status: "running",
        report: "",
        output: "",
        childIds: [],
        startedAt: now
      }
    }
  };
}

export type SpawnRefusal =
  | { ok: false; reason: "sem-pai"; message: string }
  | { ok: false; reason: "profundidade"; message: string }
  | { ok: false; reason: "filhos"; message: string }
  | { ok: false; reason: "total"; message: string };

export type SpawnCheck = { ok: true } | SpawnRefusal;

/**
 * Pode delegar? A recusa carrega o MOTIVO porque ela volta para o modelo como
 * resultado de ferramenta: "não posso mais dividir, resolva você mesmo" é uma
 * instrução acionável; um erro genérico faria o modelo insistir em loop.
 */
export function canSpawn(state: TreeState, parentId: string, limits: DelegationLimits): SpawnCheck {
  const parent = state.tasks[parentId];
  if (!parent) {
    return { ok: false, reason: "sem-pai", message: "agente solicitante não existe nesta execução" };
  }
  if (state.spawned >= limits.maxTotal) {
    return {
      ok: false,
      reason: "total",
      message: `teto de ${limits.maxTotal} agentes nesta execução foi atingido — conclua a tarefa você mesmo`
    };
  }
  if (parent.depth >= limits.maxDepth) {
    return {
      ok: false,
      reason: "profundidade",
      message: `profundidade máxima de delegação (${limits.maxDepth}) atingida — execute a tarefa diretamente`
    };
  }
  if (parent.childIds.length >= limits.maxChildren) {
    return {
      ok: false,
      reason: "filhos",
      message: `este agente já delegou ${limits.maxChildren} tarefas — reúna os resultados em vez de dividir mais`
    };
  }
  return { ok: true };
}

/** Cria o subordinado. Chame só depois de `canSpawn` devolver ok. */
export function spawnTask(
  state: TreeState,
  parentId: string,
  task: { title: string; prompt: string },
  now: number
): { state: TreeState; child: AgentTask } {
  const parent = state.tasks[parentId];
  if (!parent) throw new Error(`agente inexistente: ${parentId}`);
  const id = `a${state.spawned + 1}`;
  const child: AgentTask = {
    id,
    parentId,
    title: task.title.trim() || `Subtarefa ${id}`,
    prompt: task.prompt,
    depth: parent.depth + 1,
    status: "running",
    report: "",
    output: "",
    childIds: [],
    startedAt: now
  };
  return {
    state: {
      ...state,
      spawned: state.spawned + 1,
      tasks: {
        ...state.tasks,
        [parentId]: { ...parent, childIds: [...parent.childIds, id], status: "waiting-children" },
        [id]: child
      }
    },
    child
  };
}

export function patchTask(state: TreeState, id: string, patch: Partial<AgentTask>): TreeState {
  const task = state.tasks[id];
  if (!task) return state;
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...patch } } };
}

export function finishTask(
  state: TreeState,
  id: string,
  status: Extract<TaskStatus, "done" | "failed" | "cancelled">,
  report: string,
  now: number
): TreeState {
  return patchTask(state, id, { status, report, finishedAt: now });
}

/* ------------------------------- leitura ----------------------------- */

/** Caminho da raiz até o nó — usado no rótulo e no prompt do subordinado. */
export function lineage(state: TreeState, id: string): AgentTask[] {
  const path: AgentTask[] = [];
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor) {
    const task: AgentTask | undefined = state.tasks[cursor];
    // Ciclo não deveria existir (a árvore é construída só por spawn), mas um
    // laço infinito aqui travaria a UI inteira.
    if (!task || seen.has(cursor)) break;
    seen.add(cursor);
    path.unshift(task);
    cursor = task.parentId;
  }
  return path;
}

/** Nós em ordem de exibição: profundidade primeiro, na ordem de criação. */
export function flatten(state: TreeState): AgentTask[] {
  const out: AgentTask[] = [];
  const visit = (id: string, guard: Set<string>) => {
    if (guard.has(id)) return;
    guard.add(id);
    const task = state.tasks[id];
    if (!task) return;
    out.push(task);
    for (const child of task.childIds) visit(child, guard);
  };
  visit(state.rootId, new Set());
  return out;
}

export interface TreeSummary {
  total: number;
  done: number;
  failed: number;
  running: number;
  maxDepth: number;
}

export function summarize(state: TreeState): TreeSummary {
  const all = Object.values(state.tasks);
  return {
    total: all.length,
    done: all.filter((task) => task.status === "done").length,
    failed: all.filter((task) => task.status === "failed").length,
    running: all.filter((task) => task.status === "running" || task.status === "waiting-children").length,
    maxDepth: all.reduce((deepest, task) => Math.max(deepest, task.depth), 0)
  };
}

/** Marca tudo que ainda não terminou como cancelado (parada do usuário). */
export function cancelPending(state: TreeState, now: number): TreeState {
  const tasks: Record<string, AgentTask> = {};
  for (const [id, task] of Object.entries(state.tasks)) {
    tasks[id] =
      task.status === "running" || task.status === "waiting-children"
        ? { ...task, status: "cancelled", report: "execução interrompida", finishedAt: now }
        : task;
  }
  return { ...state, tasks };
}

/**
 * Relatórios dos filhos, para o superior sintetizar.
 *
 * Só entram os que terminaram BEM: mandar de volta o texto de erro como se
 * fosse resultado faria o superior tratar falha como informação.
 */
export function childReports(state: TreeState, id: string): Array<{ title: string; report: string }> {
  const task = state.tasks[id];
  if (!task) return [];
  return task.childIds
    .map((childId) => state.tasks[childId])
    .filter((child): child is AgentTask => Boolean(child) && child.status === "done")
    .map((child) => ({ title: child.title, report: child.report }));
}

/** Filhos que NÃO deram certo — o superior precisa saber, sem confundir. */
export function childFailures(state: TreeState, id: string): Array<{ title: string; reason: string }> {
  const task = state.tasks[id];
  if (!task) return [];
  return task.childIds
    .map((childId) => state.tasks[childId])
    .filter((child): child is AgentTask => Boolean(child) && (child.status === "failed" || child.status === "cancelled"))
    .map((child) => ({ title: child.title, reason: child.report || child.status }));
}
