/**
 * Memória persistente independente de fornecedor (inspirado em akitaonrails/ai-memory).
 *
 * O núcleo é agnóstico de armazenamento: no desktop usa SQLite via comandos Rust
 * (`memory_*`); fora do Tauri (ou se o comando não existir) cai para IndexedDB.
 * Assim a memória sobrevive à troca do modelo/fornecedor que estiver no "motor".
 */
import { invoke } from "@tauri-apps/api/core";
import type { MemoryItem, MemoryKind, MemorySearchHit } from "@ai-orchestrator/contracts";
import { buildIdf, memoryText, semanticScore } from "./semantic";

const isTauriHost = "__TAURI_INTERNALS__" in window;

export interface MemoryInput {
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  source?: string;
}

interface MemoryAdapter {
  add(input: MemoryInput): Promise<MemoryItem>;
  update(item: MemoryItem): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<MemoryItem[]>;
  touch(ids: string[]): Promise<void>;
}

/* ----------------------------- pontuação ---------------------------- */

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

/** Relevância textual + recência + importância + frequência de uso. Puro, testável. */
export function scoreMemory(item: MemoryItem, queryTokens: string[], now = Date.now()): number {
  const haystack = new Set(tokenize(`${item.title} ${item.content} ${item.tags.join(" ")}`));
  let overlap = 0;
  for (const token of queryTokens) if (haystack.has(token)) overlap += 1;
  const relevance = queryTokens.length ? overlap / queryTokens.length : 0;
  const ageDays = Math.max(0, (now - Date.parse(item.updatedAt)) / 86_400_000);
  const recency = Math.exp(-ageDays / 45);
  const usage = Math.min(1, item.uses / 12);
  return relevance * 3 + recency * 0.8 + (item.importance / 5) * 0.9 + usage * 0.3;
}

/**
 * Ordena por relevância SEMÂNTICA.
 *
 * A versão anterior casava token exato: quem perguntasse "como publico o
 * sistema" não achava a memória escrita como "procedimento de deploy" e
 * concluía que a memória não tinha guardado nada — falha silenciosa, a pior
 * delas. Agora a relevância vem de `semanticScore`, que radicaliza a palavra,
 * pesa termo raro acima de termo comum e usa o vetor do gateway quando o
 * chamador conseguiu calculá-lo.
 *
 * Recência, importância e uso continuam pesando: uma memória de dois anos
 * atrás não deve ganhar de uma de ontem só por empatar no texto.
 */
export function rankMemories(
  items: MemoryItem[],
  query: string,
  k: number,
  vectors?: Map<string, number>
): MemorySearchHit[] {
  if (!items.length) return [];
  const textos = items.map((item) => memoryText(item));
  const idf = buildIdf(textos);
  const now = Date.now();
  return items
    .map((item, index) => {
      const relevance = semanticScore({
        query,
        document: textos[index],
        idf,
        vector: vectors?.get(item.id)
      });
      const ageDays = Math.max(0, (now - Date.parse(item.updatedAt)) / 86_400_000);
      const recency = Math.exp(-ageDays / 45);
      const usage = Math.min(1, item.uses / 12);
      return {
        item,
        score: relevance * 3 + recency * 0.8 + (item.importance / 5) * 0.9 + usage * 0.3,
        relevance
      };
    })
    // O corte é na RELEVÂNCIA, não na nota final: sem isso, uma memória
    // recente e importante entraria em toda consulta, inclusive nas que não
    // têm nada a ver com ela.
    .filter((hit) => hit.relevance >= 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ item, score }) => ({ item, score }));
}

/** Preâmbulo de sistema injetado em qualquer fornecedor. */
export function memoryPreamble(hits: MemorySearchHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map(({ item }) => `- [${item.kind}] ${item.title}: ${item.content}`);
  return `Memórias persistentes do usuário (contexto entre sessões e fornecedores):\n${lines.join("\n")}`;
}

/* --------------------------- IndexedDB ------------------------------ */

const DB_NAME = "orchestrator-memory";
const STORE = "memories";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB indisponível"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha na transação de memória"));
  });
}

const nowIso = () => new Date().toISOString();
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

class IndexedDbAdapter implements MemoryAdapter {
  async add(input: MemoryInput): Promise<MemoryItem> {
    const item: MemoryItem = {
      id: newId(),
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      importance: input.importance ?? 3,
      uses: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: input.source ?? "manual"
    };
    const db = await openDb();
    await tx(db, "readwrite", (store) => store.put(item));
    return item;
  }
  async update(item: MemoryItem): Promise<void> {
    const db = await openDb();
    await tx(db, "readwrite", (store) => store.put({ ...item, updatedAt: nowIso() }));
  }
  async remove(id: string): Promise<void> {
    const db = await openDb();
    await tx(db, "readwrite", (store) => store.delete(id));
  }
  async list(): Promise<MemoryItem[]> {
    const db = await openDb();
    return (await tx(db, "readonly", (store) => store.getAll())) as MemoryItem[];
  }
  async touch(ids: string[]): Promise<void> {
    const db = await openDb();
    const items = (await tx(db, "readonly", (store) => store.getAll())) as MemoryItem[];
    const marked = items.filter((item) => ids.includes(item.id));
    for (const item of marked) {
      await tx(db, "readwrite", (store) =>
        store.put({ ...item, uses: item.uses + 1, lastUsedAt: nowIso() })
      );
    }
  }
}

/* ------------------------ SQLite via Rust --------------------------- */

class TauriSqliteAdapter implements MemoryAdapter {
  async add(input: MemoryInput): Promise<MemoryItem> {
    return invoke<MemoryItem>("memory_add", { input });
  }
  async update(item: MemoryItem): Promise<void> {
    await invoke("memory_update", { item });
  }
  async remove(id: string): Promise<void> {
    await invoke("memory_delete", { id });
  }
  async list(): Promise<MemoryItem[]> {
    return invoke<MemoryItem[]>("memory_list");
  }
  async touch(ids: string[]): Promise<void> {
    await invoke("memory_touch", { ids });
  }
}

/* ------------------------------ fachada ----------------------------- */

let adapter: MemoryAdapter | null = null;
let sqliteFailed = false;

async function backend(): Promise<MemoryAdapter> {
  if (adapter) return adapter;
  if (isTauriHost && !sqliteFailed) {
    const candidate = new TauriSqliteAdapter();
    try {
      await candidate.list();
      adapter = candidate;
      return adapter;
    } catch {
      // Comando ausente (build Rust antiga): degrada para IndexedDB.
      sqliteFailed = true;
    }
  }
  adapter = new IndexedDbAdapter();
  return adapter;
}

export const memory = {
  async add(input: MemoryInput): Promise<MemoryItem> {
    return (await backend()).add(input);
  },
  async update(item: MemoryItem): Promise<void> {
    return (await backend()).update(item);
  },
  async remove(id: string): Promise<void> {
    return (await backend()).remove(id);
  },
  async list(): Promise<MemoryItem[]> {
    const items = await (await backend()).list();
    return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  },
  /**
   * Recupera as memórias relevantes.
   *
   * `vectors` é opcional de propósito: quem sabe falar com o gateway é a UI,
   * e este módulo não pode depender de sessão. Sem ele, a busca continua
   * funcionando pela camada morfológica — semântica melhor, nunca requisito.
   */
  async recall(query: string, k: number, vectors?: Map<string, number>): Promise<MemorySearchHit[]> {
    const store = await backend();
    const hits = rankMemories(await store.list(), query, k, vectors);
    if (hits.length) void store.touch(hits.map((hit) => hit.item.id)).catch(() => undefined);
    return hits;
  },
  /** Lista sem tocar em `uses` — para calcular vetores antes do recall. */
  async listForVectors(): Promise<MemoryItem[]> {
    return (await backend()).list();
  },
  async exportJson(): Promise<string> {
    return JSON.stringify({ schema: 1, exportedAt: nowIso(), memories: await (await backend()).list() }, null, 2);
  },
  async importJson(payload: string): Promise<number> {
    const parsed = JSON.parse(payload) as { memories?: MemoryItem[]; items?: MemoryItem[] } | MemoryItem[];
    // `items` também: a tela de importação já reconhece esse formato como
    // "shape próprio", e ler só `memories` fazia o arquivo inteiro ser
    // descartado com um "0 memória(s) importada(s)" de cara de sucesso.
    const items = Array.isArray(parsed) ? parsed : parsed.memories ?? parsed.items ?? [];
    const store = await backend();
    let imported = 0;
    for (const item of items) {
      if (!item.title || !item.content) continue;
      await store.add({
        kind: (item.kind as MemoryKind) ?? "fact",
        title: item.title,
        content: item.content,
        tags: item.tags ?? [],
        importance: item.importance ?? 3,
        source: item.source ?? "import-json"
      });
      imported += 1;
    }
    return imported;
  }
};

/* --------------------- importadores de terceiros --------------------- */

/**
 * Converte memórias no formato Claude (arquivos markdown com frontmatter
 * `name`/`description`) ou MEMORY.md (linhas de índice) em MemoryInput. Puro.
 */
export function parseClaudeMemoryMarkdown(fileName: string, content: string): MemoryInput[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const front = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(trimmed);
  if (front) {
    const head = front[1];
    const body = front[2].trim();
    const name = /name:\s*(.+)/.exec(head)?.[1]?.trim() ?? fileName.replace(/\.md$/i, "");
    const description = /description:\s*(.+)/.exec(head)?.[1]?.trim() ?? "";
    const type = /type:\s*(\w+)/.exec(head)?.[1]?.trim();
    const kind: MemoryKind =
      type === "user" ? "preference" : type === "project" ? "project" : type === "reference" ? "reference" : "fact";
    return [{ kind, title: name, content: body || description, tags: ["claude-import"], source: "import-claude" }];
  }
  if (/^memory\.md$/i.test(fileName)) {
    return [...trimmed.matchAll(/^-\s*\[(.+?)\]\(.+?\)\s*[—-]\s*(.+)$/gm)].map((match) => ({
      kind: "fact" as MemoryKind,
      title: match[1].trim(),
      content: match[2].trim(),
      tags: ["claude-import"],
      source: "import-claude"
    }));
  }
  return [
    {
      kind: "fact",
      title: fileName.replace(/\.md$/i, ""),
      content: trimmed.slice(0, 4000),
      tags: ["claude-import"],
      source: "import-claude"
    }
  ];
}

/** Converte o export de memória do ChatGPT/OpenAI (JSON de strings ou objetos). Puro. */
export function parseOpenAiMemoryExport(payload: string): MemoryInput[] {
  const data = JSON.parse(payload) as unknown;
  const entries: MemoryInput[] = [];
  const push = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    entries.push({
      kind: "fact",
      title: clean.length > 64 ? `${clean.slice(0, 61)}…` : clean,
      content: clean,
      tags: ["openai-import"],
      source: "import-openai"
    });
  };
  if (Array.isArray(data)) {
    for (const row of data) {
      if (typeof row === "string") push(row);
      else if (row && typeof row === "object") {
        const record = row as Record<string, unknown>;
        push(String(record.memory ?? record.content ?? record.text ?? ""));
      }
    }
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const list = (record.memories ?? record.items ?? []) as unknown[];
    for (const row of list) {
      if (typeof row === "string") push(row);
      else if (row && typeof row === "object") {
        const inner = row as Record<string, unknown>;
        push(String(inner.memory ?? inner.content ?? inner.text ?? ""));
      }
    }
  }
  return entries;
}

/** Heurística de captura automática pós-conversa: frases marcadas pelo modelo. */
export function extractMemoryCandidates(assistantText: string): MemoryInput[] {
  const matches = [...assistantText.matchAll(/\[memorizar:\s*([^\]]{8,240})\]/gi)];
  return matches.map((match) => ({
    kind: "fact" as MemoryKind,
    title: match[1].slice(0, 64),
    content: match[1],
    tags: ["auto"],
    source: "conversa"
  }));
}
