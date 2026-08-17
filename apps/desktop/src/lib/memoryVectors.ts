/**
 * Vetores da memória — cache local e cálculo sob demanda.
 *
 * O `semantic.ts` sabe pontuar com vetor; o `gateway.ts` sabe pedi-lo. Falta
 * decidir QUANDO pedir, e essa é a decisão que evita a conta absurda: pedir o
 * vetor de todas as memórias a cada pergunta multiplicaria o custo por
 * mensagem pelo tamanho da memória.
 *
 * Regras:
 *
 * - o vetor é calculado UMA vez por conteúdo e guardado no `localStorage`,
 *   com a chave derivada do texto — editar a memória invalida sozinho;
 * - a consulta precisa do vetor dela toda vez (é texto novo), e é uma chamada
 *   só;
 * - o cache pertence a um ESPAÇO VETORIAL: trocar de workspace ou de provedor
 *   de embeddings joga fora tudo (ver `canário` abaixo);
 * - sem gateway, sem provedor de embeddings ou sem rede, tudo isto some e a
 *   busca cai na camada morfológica, que não depende de nada.
 *
 * Coberto por memoryVectors.test.ts.
 */

import type { MemoryItem } from "@orchestrator/contracts";

import { cosine, memoryText } from "./semantic";

const STORAGE_KEY = "aio.memory.vectors.v2";
/** Teto do cache: memória grande não pode encher o localStorage sozinha. */
const MAX_ENTRIES = 400;

/**
 * Frase fixa embutida em toda chamada — o canário do espaço vetorial.
 *
 * Cosseno só faz sentido DENTRO de um espaço. Trocar o provedor de embeddings
 * por outro de mesma dimensão (ada-002 → 3-small, ambos 1536) deixava os
 * vetores velhos no cache e os novos vindos do modelo novo: o cosseno passava
 * a devolver valor arbitrário, e como ele pesa 0,65 na nota, memória
 * irrelevante era injetada no prompt e memória certa era enterrada — sem
 * nenhum sinal. A guarda de dimensão não pega isso (a dimensão é a mesma).
 *
 * Então toda chamada calcula o vetor desta frase e compara com o guardado: se
 * mudou, o espaço mudou e o cache inteiro é descartado. Custa um item a mais
 * na requisição que já ia acontecer.
 */
const CANARIO = "âncora do espaço vetorial da memória";
/** Abaixo disto o vetor não é o mesmo — é outro modelo. */
const CANARIO_MIN = 0.999;

/**
 * Hash estável do texto (FNV-1a de 32 bits).
 *
 * Serve de chave do cache: se o conteúdo mudou, a chave muda e o vetor velho
 * simplesmente não é encontrado — não há invalidação a fazer à mão, que é onde
 * esse tipo de cache costuma errar.
 */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

type VectorCache = Record<string, number[]>;

interface CacheFile {
  /** Workspace + gateway de onde os vetores vieram. */
  space: string;
  /** Vetor da frase-canário nesse espaço. */
  canary: number[];
  vectors: VectorCache;
}

const vazio = (space: string): CacheFile => ({ space, canary: [], vectors: {} });

export function loadCache(storage: Storage, space: string): CacheFile {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return vazio(space);
    const parsed = JSON.parse(raw) as Partial<CacheFile> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return vazio(space);
    // Outro workspace/gateway: outro espaço, outro cache.
    if (parsed.space !== space) return vazio(space);
    const vectors: VectorCache = {};
    for (const [chave, valor] of Object.entries(parsed.vectors ?? {})) {
      if (Array.isArray(valor) && valor.every((item) => typeof item === "number")) {
        vectors[chave] = valor as number[];
      }
    }
    const canary = Array.isArray(parsed.canary) ? (parsed.canary as number[]) : [];
    return { space, canary, vectors };
  } catch {
    // Cache corrompido não pode derrubar a memória: recalcula.
    return vazio(space);
  }
}

export function saveCache(storage: Storage, cache: CacheFile): void {
  // Poda mantendo as últimas: `Object.entries` preserva a ordem de inserção,
  // então as mais novas ficam no fim.
  const entradas = Object.entries(cache.vectors);
  const podado = entradas.length > MAX_ENTRIES ? entradas.slice(entradas.length - MAX_ENTRIES) : entradas;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ space: cache.space, canary: cache.canary, vectors: Object.fromEntries(podado) })
    );
  } catch {
    // localStorage cheio — seguir sem cache é melhor que quebrar a busca.
  }
}

/** Quais memórias ainda não têm vetor no cache. */
export function missingVectors(items: MemoryItem[], vectors: VectorCache): MemoryItem[] {
  return items.filter((item) => !vectors[textHash(memoryText(item))]);
}

/**
 * O espaço guardado ainda é o mesmo?
 *
 * Sem canário anterior (primeira vez) a resposta é sim: não há o que comparar.
 */
export function sameSpace(anterior: number[], atual: number[]): boolean {
  if (!anterior.length) return true;
  if (anterior.length !== atual.length) return false;
  return cosine(anterior, atual) >= CANARIO_MIN;
}

export interface VectorRunOptions {
  items: MemoryItem[];
  query: string;
  storage: Storage;
  /**
   * Identidade do espaço: gateway + workspace. Trocar qualquer um dos dois
   * invalida o cache antes mesmo de perguntar ao modelo.
   */
  space: string;
  /** Devolve `null` quando não há embeddings disponíveis. */
  embed: (inputs: string[]) => Promise<number[][] | null>;
  /** Teto de vetores novos por consulta — o resto entra nas próximas. */
  maxNew?: number;
}

/**
 * Cossenos por id de memória, ou `null` quando não há como calcular.
 *
 * O teto de novos por consulta é deliberado: uma memória com 300 itens sem
 * cache não pode virar uma requisição gigante na primeira pergunta. As que
 * ficaram de fora entram nas consultas seguintes, e enquanto isso elas ainda
 * são encontradas pela camada morfológica.
 */
export async function vectorScores(options: VectorRunOptions): Promise<Map<string, number> | null> {
  const { items, query, storage, embed, space } = options;
  if (!items.length || !query.trim()) return null;

  const cache = loadCache(storage, space);
  const faltando = missingVectors(items, cache.vectors).slice(0, options.maxNew ?? 24);

  // Uma chamada só: o canário, a consulta e as memórias sem vetor.
  const entradas = [CANARIO, query, ...faltando.map((item) => memoryText(item))];
  const vetores = await embed(entradas);
  if (!vetores || vetores.length < 2) return null;

  const canario = vetores[0];
  const daConsulta = vetores[1];
  if (!sameSpace(cache.canary, canario)) {
    // Provedor de embeddings trocado: os vetores guardados são de outro
    // espaço e o cosseno contra eles seria ruído com cara de nota.
    //
    // Esta volta fica sem vetor nenhum (a lista de pendentes foi montada
    // antes de saber da troca) e a busca cai na camada morfológica; na volta
    // seguinte as memórias são recalculadas no espaço novo. Uma consulta com
    // recuperação um pouco pior é bem melhor que uma com nota inventada.
    cache.vectors = {};
  }
  cache.canary = canario;

  faltando.forEach((item, index) => {
    const vetor = vetores[index + 2];
    if (vetor) cache.vectors[textHash(memoryText(item))] = vetor;
  });
  saveCache(storage, cache);

  const notas = new Map<string, number>();
  for (const item of items) {
    const vetor = cache.vectors[textHash(memoryText(item))];
    // Dimensão diferente indica troca de modelo de embedding; o `cosine`
    // devolve 0 nesse caso, e a morfológica assume.
    if (vetor) notas.set(item.id, cosine(daConsulta, vetor));
  }
  return notas.size ? notas : null;
}
