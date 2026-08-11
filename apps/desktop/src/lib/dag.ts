/**
 * dag.ts — modelo de grafo dirigido acíclico (DAG) puro e testável.
 *
 * É a fonte de verdade do modo Agent: o documento é editado por funções
 * imutáveis (addNode/removeNode/connect/disconnect/updateNode), validado por
 * detectCycle (DFS que devolve o ciclo real) e planejado por topoWaves
 * (ondas de execução em camadas). toJson/fromJson fazem round-trip com
 * validação estrutural completa para import/export de fluxos.
 */

export const DAG_NODE_KINDS = ["input", "agent", "tool", "gate", "human", "merge"] as const;
export type DagNodeKind = (typeof DAG_NODE_KINDS)[number];

export interface DagNode {
  id: string;
  name: string;
  kind: DagNodeKind;
  /** Para "agent": instrução executada via engine. Para "input": conteúdo literal. */
  prompt?: string;
  /** Ids dos nós dos quais este depende (arestas de entrada). */
  dependsOn: string[];
}

export interface DagDoc {
  schemaVersion: 1;
  name: string;
  maxConcurrency: number;
  nodes: DagNode[];
}

/* ------------------------------ criação ------------------------------ */

export function createDoc(name: string, maxConcurrency = 4): DagDoc {
  return { schemaVersion: 1, name, maxConcurrency, nodes: [] };
}

function byId(doc: DagDoc): Map<string, DagNode> {
  return new Map(doc.nodes.map((node) => [node.id, node]));
}

/** Gera um id único e estável no doc para um novo nó do tipo dado. */
export function nextId(doc: DagDoc, kind: DagNodeKind): string {
  const ids = new Set(doc.nodes.map((node) => node.id));
  let index = 1;
  while (ids.has(`${kind}-${index}`)) index += 1;
  return `${kind}-${index}`;
}

export function addNode(
  doc: DagDoc,
  node: { id: string; name: string; kind: DagNodeKind; prompt?: string; dependsOn?: string[] }
): DagDoc {
  if (!node.id.trim()) throw new Error("Nó precisa de id.");
  const map = byId(doc);
  if (map.has(node.id)) throw new Error(`Id duplicado: "${node.id}".`);
  const deps = [...new Set(node.dependsOn ?? [])];
  if (deps.includes(node.id)) throw new Error(`Auto-referência: "${node.id}" não pode depender de si mesmo.`);
  for (const dep of deps) {
    if (!map.has(dep)) throw new Error(`Dependência desconhecida: "${dep}".`);
  }
  const entry: DagNode = {
    id: node.id,
    name: node.name || node.id,
    kind: node.kind,
    dependsOn: deps,
    ...(node.prompt !== undefined ? { prompt: node.prompt } : {})
  };
  return { ...doc, nodes: [...doc.nodes, entry] };
}

/** Remove o nó e limpa TODAS as arestas que apontavam para ele. */
export function removeNode(doc: DagDoc, id: string): DagDoc {
  if (!byId(doc).has(id)) throw new Error(`Nó inexistente: "${id}".`);
  return {
    ...doc,
    nodes: doc.nodes
      .filter((node) => node.id !== id)
      .map((node) =>
        node.dependsOn.includes(id) ? { ...node, dependsOn: node.dependsOn.filter((dep) => dep !== id) } : node
      )
  };
}

export function updateNode(doc: DagDoc, id: string, patch: { name?: string; prompt?: string }): DagDoc {
  if (!byId(doc).has(id)) throw new Error(`Nó inexistente: "${id}".`);
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.id !== id) return node;
      const next = { ...node };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.prompt !== undefined) next.prompt = patch.prompt;
      return next;
    })
  };
}

/** Cria a aresta origem → destino (o destino passa a depender da origem). */
export function connect(doc: DagDoc, from: string, to: string): DagDoc {
  if (from === to) throw new Error(`Auto-referência: "${from}" não pode conectar a si mesmo.`);
  const map = byId(doc);
  if (!map.has(from)) throw new Error(`Nó inexistente: "${from}".`);
  const target = map.get(to);
  if (!target) throw new Error(`Nó inexistente: "${to}".`);
  if (target.dependsOn.includes(from)) throw new Error(`Aresta já existe: ${from} → ${to}.`);
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === to ? { ...node, dependsOn: [...node.dependsOn, from] } : node))
  };
}

/** Remove a aresta origem → destino. */
export function disconnect(doc: DagDoc, from: string, to: string): DagDoc {
  if (from === to) throw new Error(`Auto-referência: "${from}" não conecta a si mesmo.`);
  const target = byId(doc).get(to);
  if (!target) throw new Error(`Nó inexistente: "${to}".`);
  if (!target.dependsOn.includes(from)) throw new Error(`Aresta inexistente: ${from} → ${to}.`);
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === to ? { ...node, dependsOn: node.dependsOn.filter((dep) => dep !== from) } : node
    )
  };
}

export function edgeCount(doc: DagDoc): number {
  return doc.nodes.reduce((total, node) => total + node.dependsOn.length, 0);
}

/* ------------------------------ análise ------------------------------ */

/**
 * DFS com coloração (branco/cinza/preto). Devolve o ciclo real encontrado
 * como lista de ids fechada (primeiro === último), ou null se acíclico.
 */
export function detectCycle(doc: DagDoc): string[] | null {
  const map = byId(doc);
  const state = new Map<string, 1 | 2>(); // 1 = em visita (cinza), 2 = concluído (preto)
  const stack: string[] = [];
  let found: string[] | null = null;

  function visit(id: string): boolean {
    state.set(id, 1);
    stack.push(id);
    for (const dep of map.get(id)?.dependsOn ?? []) {
      if (!map.has(dep)) continue;
      const color = state.get(dep);
      if (color === 1) {
        const start = stack.indexOf(dep);
        found = [...stack.slice(start), dep];
        return true;
      }
      if (color === undefined && visit(dep)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  }

  for (const node of doc.nodes) {
    if (!state.has(node.id) && visit(node.id)) return found;
  }
  return null;
}

/**
 * Ondas de execução (Kahn em camadas): cada onda contém os nós cujas
 * dependências já foram todas resolvidas nas ondas anteriores.
 * Lança erro com o ciclo se o grafo não for acíclico.
 */
export function topoWaves(doc: DagDoc): string[][] {
  const ids = new Set(doc.nodes.map((node) => node.id));
  const pending = new Map(doc.nodes.map((node) => [node.id, node.dependsOn.filter((dep) => ids.has(dep))]));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (pending.size) {
    const wave: string[] = [];
    for (const [id, deps] of pending) {
      if (deps.every((dep) => done.has(dep))) wave.push(id);
    }
    if (!wave.length) {
      const cycle = detectCycle(doc);
      throw new Error(`Ciclo no grafo: ${(cycle ?? [...pending.keys()]).join(" → ")}`);
    }
    for (const id of wave) {
      pending.delete(id);
      done.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

/* --------------------------- serialização ---------------------------- */

export function toJson(doc: DagDoc): string {
  return JSON.stringify(doc, null, 2);
}

function fail(message: string): never {
  throw new Error(`DAG inválido: ${message}`);
}

/** Parse + validação estrutural completa. Lança erro descritivo se inválido. */
export function fromJson(text: string): DagDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("JSON malformado.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("esperado objeto raiz.");
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== 1) fail(`schemaVersion deve ser 1 (recebido ${String(data.schemaVersion)}).`);
  if (typeof data.name !== "string" || !data.name.trim()) fail("name deve ser string não vazia.");
  const maxConcurrency = data.maxConcurrency === undefined ? 4 : data.maxConcurrency;
  if (typeof maxConcurrency !== "number" || !Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
    fail("maxConcurrency deve ser número >= 1.");
  }
  if (!Array.isArray(data.nodes)) fail("nodes deve ser um array.");

  const nodes: DagNode[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (data.nodes as unknown[]).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`nodes[${index}] deve ser objeto.`);
    const node = entry as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id.trim()) fail(`nodes[${index}].id deve ser string não vazia.`);
    if (seen.has(node.id)) fail(`id duplicado "${node.id}".`);
    seen.add(node.id);
    if (typeof node.name !== "string" || !node.name.trim()) fail(`nó "${node.id}": name deve ser string não vazia.`);
    if (typeof node.kind !== "string" || !(DAG_NODE_KINDS as readonly string[]).includes(node.kind)) {
      fail(`nó "${node.id}": kind "${String(node.kind)}" desconhecido (use ${DAG_NODE_KINDS.join(", ")}).`);
    }
    if (node.prompt !== undefined && typeof node.prompt !== "string") fail(`nó "${node.id}": prompt deve ser string.`);
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some((dep) => typeof dep !== "string")) {
      fail(`nó "${node.id}": dependsOn deve ser array de strings.`);
    }
    const deps = [...new Set(node.dependsOn as string[])];
    if (deps.includes(node.id)) fail(`nó "${node.id}": auto-referência em dependsOn.`);
    nodes.push({
      id: node.id,
      name: node.name,
      kind: node.kind as DagNodeKind,
      dependsOn: deps,
      ...(node.prompt !== undefined ? { prompt: node.prompt as string } : {})
    });
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!seen.has(dep)) fail(`nó "${node.id}": dependência "${dep}" não existe.`);
    }
  }
  return { schemaVersion: 1, name: data.name, maxConcurrency, nodes };
}

/* ------------------------- documento inicial ------------------------- */

/**
 * "Release train" — documento inicial REAL construído via as próprias
 * primitivas do modelo (não JSX fixo). Todo nó agent tem prompt executável.
 */
export function releaseTrainDoc(): DagDoc {
  let doc = createDoc("Release train", 4);
  doc = addNode(doc, {
    id: "idea",
    name: "Idea",
    kind: "input",
    prompt:
      "Feature: exportar conversas do AI Orchestrator como arquivo Markdown com metadados " +
      "(modo, motor usado, data) e anexos referenciados por nome."
  });
  doc = addNode(doc, {
    id: "scope",
    name: "Scope",
    kind: "agent",
    prompt:
      "Você é o PM. A partir do brief recebido, escreva o escopo mínimo em até 10 linhas, " +
      "com 3 critérios de aceitação verificáveis."
  });
  doc = addNode(doc, {
    id: "planner",
    name: "Planner",
    kind: "agent",
    prompt:
      "Divida o escopo em exatamente 2 tickets independentes (A e B), cada um com título, " +
      "arquivos prováveis e passos de implementação."
  });
  doc = addNode(doc, {
    id: "code-a",
    name: "Code agent A",
    kind: "agent",
    prompt: "Implemente o ticket A do plano: descreva as mudanças por arquivo e um esboço do diff."
  });
  doc = addNode(doc, {
    id: "code-b",
    name: "Code agent B",
    kind: "agent",
    prompt: "Implemente o ticket B do plano: descreva as mudanças por arquivo e um esboço do diff."
  });
  doc = addNode(doc, {
    id: "review",
    name: "Reviewer",
    kind: "agent",
    prompt:
      "Revise as duas implementações recebidas: liste riscos, conflitos entre A e B, e dê um " +
      "veredito aprovar/reprovar por ticket."
  });
  doc = addNode(doc, { id: "ci", name: "CI + revisões", kind: "gate" });
  doc = addNode(doc, { id: "human-merge", name: "Human merge", kind: "human" });
  doc = connect(doc, "idea", "scope");
  doc = connect(doc, "scope", "planner");
  doc = connect(doc, "planner", "code-a");
  doc = connect(doc, "planner", "code-b");
  doc = connect(doc, "code-a", "review");
  doc = connect(doc, "code-b", "review");
  doc = connect(doc, "review", "ci");
  doc = connect(doc, "ci", "human-merge");
  return doc;
}
