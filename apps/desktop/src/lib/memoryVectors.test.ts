import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryItem } from "@ai-orchestrator/contracts";

import { loadCache, missingVectors, saveCache, textHash, vectorScores } from "./memoryVectors";
import { memoryText } from "./semantic";

/** localStorage de mentira, para o teste não depender do navegador. */
function fakeStorage(inicial: Record<string, string> = {}): Storage {
  const dados = new Map(Object.entries(inicial));
  return {
    get length() {
      return dados.size;
    },
    clear: () => dados.clear(),
    getItem: (chave) => dados.get(chave) ?? null,
    key: (indice) => [...dados.keys()][indice] ?? null,
    removeItem: (chave) => void dados.delete(chave),
    setItem: (chave, valor) => void dados.set(chave, valor)
  } satisfies Storage;
}

const item = (id: string, title: string, content = "corpo"): MemoryItem => ({
  id,
  kind: "fact",
  title,
  content,
  tags: [],
  importance: 3,
  uses: 0,
  source: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
});

describe("textHash", () => {
  it("é estável para o mesmo texto", () => {
    expect(textHash("deploy")).toBe(textHash("deploy"));
  });

  it("muda quando o texto muda — é a invalidação do cache", () => {
    expect(textHash("deploy")).not.toBe(textHash("deploy "));
  });

  it("texto vazio não quebra", () => {
    expect(textHash("")).toBeTypeOf("string");
  });
});

describe("cache", () => {
  it("grava e lê de volta", () => {
    const storage = fakeStorage();
    saveCache(storage, { a: [1, 2, 3] });
    expect(loadCache(storage)).toEqual({ a: [1, 2, 3] });
  });

  it("cache corrompido vira vazio em vez de derrubar a busca", () => {
    expect(loadCache(fakeStorage({ "aio.memory.vectors.v1": "{{{" }))).toEqual({});
  });

  it("descarta entrada que não é vetor de números", () => {
    const storage = fakeStorage({
      "aio.memory.vectors.v1": JSON.stringify({ bom: [1, 2], ruim: ["x"], pior: 5 })
    });
    expect(loadCache(storage)).toEqual({ bom: [1, 2] });
  });

  it("poda o cache no teto, mantendo as últimas", () => {
    const storage = fakeStorage();
    const grande: Record<string, number[]> = {};
    for (let i = 0; i < 500; i += 1) grande[`k${i}`] = [i];
    saveCache(storage, grande);
    const lido = loadCache(storage);
    expect(Object.keys(lido)).toHaveLength(400);
    expect(lido.k499).toEqual([499]);
    expect(lido.k0).toBeUndefined();
  });

  it("storage cheio não propaga exceção", () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(() => saveCache(storage, { a: [1] })).not.toThrow();
  });
});

describe("missingVectors", () => {
  it("lista só quem não tem vetor", () => {
    const a = item("1", "deploy");
    const b = item("2", "ferias");
    const cache = { [textHash(memoryText(a))]: [1, 2] };
    expect(missingVectors([a, b], cache).map((entry) => entry.id)).toEqual(["2"]);
  });
});

describe("vectorScores", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  it("pede a consulta e as memórias sem vetor numa chamada só", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    await vectorScores({ items: [item("1", "deploy"), item("2", "ferias")], query: "publicar", storage, embed });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toHaveLength(3);
    expect(embed.mock.calls[0][0][0]).toBe("publicar");
  });

  it("devolve o cosseno por id", async () => {
    const embed = async (inputs: string[]) => inputs.map((texto) => (texto === "publicar" ? [1, 0] : [0, 1]));
    const notas = await vectorScores({ items: [item("1", "deploy")], query: "publicar", storage, embed });
    expect(notas?.get("1")).toBeCloseTo(0, 5);
  });

  it("guarda o vetor e não repede na consulta seguinte", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    const items = [item("1", "deploy")];
    await vectorScores({ items, query: "a", storage, embed });
    await vectorScores({ items, query: "b", storage, embed });
    // Segunda volta: só o texto da consulta.
    expect(embed.mock.calls[1][0]).toHaveLength(1);
  });

  it("editar a memória invalida o vetor sozinho", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    await vectorScores({ items: [item("1", "deploy")], query: "a", storage, embed });
    await vectorScores({ items: [item("1", "deploy alterado")], query: "a", storage, embed });
    expect(embed.mock.calls[1][0]).toHaveLength(2);
  });

  it("limita quantos vetores novos por consulta", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    const muitos = Array.from({ length: 50 }, (_, index) => item(String(index), `m${index}`));
    await vectorScores({ items: muitos, query: "a", storage, embed, maxNew: 5 });
    expect(embed.mock.calls[0][0]).toHaveLength(6);
  });

  it("sem embeddings devolve null — a busca cai na camada morfológica", async () => {
    const notas = await vectorScores({ items: [item("1", "deploy")], query: "a", storage, embed: async () => null });
    expect(notas).toBeNull();
  });

  it("consulta vazia nem chama o gateway", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    expect(await vectorScores({ items: [item("1", "d")], query: "  ", storage, embed })).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("memória vazia nem chama o gateway", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    expect(await vectorScores({ items: [], query: "a", storage, embed })).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("troca do modelo de embedding não produz nota sem sentido", async () => {
    // Cache com vetor de 2 dimensões; a consulta nova volta com 3.
    const items = [item("1", "deploy")];
    await vectorScores({ items, query: "a", storage, embed: async (inputs) => inputs.map(() => [1, 0]) });
    const notas = await vectorScores({
      items,
      query: "a",
      storage,
      embed: async (inputs) => inputs.map(() => [1, 0, 0])
    });
    // `cosine` recusa dimensões diferentes: 0, e a morfológica decide.
    expect(notas?.get("1")).toBe(0);
  });
});
