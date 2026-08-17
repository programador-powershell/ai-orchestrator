import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryItem } from "@ai-bot/contracts";

import { loadCache, missingVectors, sameSpace, saveCache, textHash, vectorScores } from "./memoryVectors";
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

const ESPACO = "https://gw.exemplo|ws-1";

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
    saveCache(storage, { space: ESPACO, canary: [1, 0], vectors: { a: [1, 2, 3] } });
    expect(loadCache(storage, ESPACO).vectors).toEqual({ a: [1, 2, 3] });
  });

  it("cache de OUTRO workspace/gateway não é reaproveitado", () => {
    // Cosseno entre espaços diferentes é ruído com cara de nota.
    const storage = fakeStorage();
    saveCache(storage, { space: ESPACO, canary: [1, 0], vectors: { a: [1, 2] } });
    expect(loadCache(storage, "https://gw.exemplo|ws-2").vectors).toEqual({});
  });

  it("cache corrompido vira vazio em vez de derrubar a busca", () => {
    expect(loadCache(fakeStorage({ "aio.memory.vectors.v2": "{{{" }), ESPACO).vectors).toEqual({});
  });

  it("descarta entrada que não é vetor de números", () => {
    const storage = fakeStorage({
      "aio.memory.vectors.v2": JSON.stringify({
        space: ESPACO,
        canary: [1],
        vectors: { bom: [1, 2], ruim: ["x"], pior: 5 }
      })
    });
    expect(loadCache(storage, ESPACO).vectors).toEqual({ bom: [1, 2] });
  });

  it("poda o cache no teto, mantendo as últimas", () => {
    const storage = fakeStorage();
    const grande: Record<string, number[]> = {};
    for (let i = 0; i < 500; i += 1) grande[`k${i}`] = [i];
    saveCache(storage, { space: ESPACO, canary: [1], vectors: grande });
    const lido = loadCache(storage, ESPACO).vectors;
    expect(Object.keys(lido)).toHaveLength(400);
    expect(lido.k499).toEqual([499]);
    expect(lido.k0).toBeUndefined();
  });

  it("storage cheio não propaga exceção", () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(() => saveCache(storage, { space: ESPACO, canary: [], vectors: { a: [1] } })).not.toThrow();
  });
});

describe("sameSpace", () => {
  it("sem canário anterior aceita — não há o que comparar", () => {
    expect(sameSpace([], [1, 0])).toBe(true);
  });

  it("mesmo vetor, mesmo espaço", () => {
    expect(sameSpace([1, 0], [1, 0])).toBe(true);
  });

  it("canário diferente com a MESMA dimensão denuncia a troca de modelo", () => {
    // É o caso que a guarda de dimensão não pegava: ada-002 → 3-small.
    expect(sameSpace([1, 0], [0, 1])).toBe(false);
  });

  it("dimensão diferente também é outro espaço", () => {
    expect(sameSpace([1, 0], [1, 0, 0])).toBe(false);
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

  it("pede o canário, a consulta e as memórias sem vetor numa chamada só", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    await vectorScores({
      items: [item("1", "deploy"), item("2", "ferias")],
      query: "publicar",
      storage,
      space: ESPACO,
      embed
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toHaveLength(4);
    expect(embed.mock.calls[0][0][1]).toBe("publicar");
  });

  it("devolve o cosseno por id", async () => {
    const embed = async (inputs: string[]) =>
      inputs.map((texto) => (texto === "publicar" ? [1, 0] : [0, 1]));
    const notas = await vectorScores({
      items: [item("1", "deploy")],
      query: "publicar",
      storage,
      space: ESPACO,
      embed
    });
    expect(notas?.get("1")).toBeCloseTo(0, 5);
  });

  it("guarda o vetor e não repede na consulta seguinte", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    const items = [item("1", "deploy")];
    await vectorScores({ items, query: "a", storage, space: ESPACO, embed });
    await vectorScores({ items, query: "b", storage, space: ESPACO, embed });
    // Segunda volta: canário + consulta, sem a memória.
    expect(embed.mock.calls[1][0]).toHaveLength(2);
  });

  it("editar a memória invalida o vetor sozinho", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    await vectorScores({ items: [item("1", "deploy")], query: "a", storage, space: ESPACO, embed });
    await vectorScores({
      items: [item("1", "deploy alterado")],
      query: "a",
      storage,
      space: ESPACO,
      embed
    });
    expect(embed.mock.calls[1][0]).toHaveLength(3);
  });

  it("limita quantos vetores novos por consulta", async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]));
    const muitos = Array.from({ length: 50 }, (_, index) => item(String(index), `m${index}`));
    await vectorScores({ items: muitos, query: "a", storage, space: ESPACO, embed, maxNew: 5 });
    expect(embed.mock.calls[0][0]).toHaveLength(7);
  });

  it("sem embeddings devolve null — a busca cai na camada morfológica", async () => {
    const notas = await vectorScores({
      items: [item("1", "deploy")],
      query: "a",
      storage,
      space: ESPACO,
      embed: async () => null
    });
    expect(notas).toBeNull();
  });

  it("consulta vazia nem chama o gateway", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    expect(
      await vectorScores({ items: [item("1", "d")], query: "  ", storage, space: ESPACO, embed })
    ).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("memória vazia nem chama o gateway", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    expect(await vectorScores({ items: [], query: "a", storage, space: ESPACO, embed })).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("troca do modelo de embedding com dimensão diferente não produz nota sem sentido", async () => {
    const items = [item("1", "deploy")];
    await vectorScores({
      items,
      query: "a",
      storage,
      space: ESPACO,
      embed: async (inputs) => inputs.map(() => [1, 0])
    });
    const notas = await vectorScores({
      items,
      query: "a",
      storage,
      space: ESPACO,
      embed: async (inputs) => inputs.map(() => [1, 0, 0])
    });
    // Sem nota é melhor que nota inventada: a morfológica decide esta volta.
    expect(notas).toBeNull();
  });

  it("troca de provedor com a MESMA dimensão descarta o cache", async () => {
    // O caso que passava batido: cosseno entre espaços diferentes devolvia
    // valor arbitrário e, com peso 0,65 na nota, enterrava memória relevante.
    const items = [item("1", "deploy")];
    await vectorScores({
      items,
      query: "consulta",
      storage,
      space: ESPACO,
      embed: async (inputs) => inputs.map(() => [1, 0])
    });
    // Provedor novo: mesmo tamanho de vetor, espaço outro.
    const embedNovo = vi.fn(async (inputs: string[]) => inputs.map(() => [0, 1]));
    // Volta 1: o vetor velho ainda estava no cache quando a lista foi montada,
    // então ele não é repedido — mas é jogado fora ao ver o canário novo, e a
    // busca cai na morfológica em vez de pontuar com lixo.
    expect(
      await vectorScores({ items, query: "consulta", storage, space: ESPACO, embed: embedNovo })
    ).toBeNull();
    expect(loadCache(storage, ESPACO).vectors).toEqual({});

    // Volta 2: a memória volta a ser calculada, já no espaço novo.
    const notas = await vectorScores({
      items,
      query: "consulta",
      storage,
      space: ESPACO,
      embed: embedNovo
    });
    expect(embedNovo.mock.calls[1][0]).toHaveLength(3);
    expect(notas?.get("1")).toBeCloseTo(1, 5);
    expect(Object.values(loadCache(storage, ESPACO).vectors)[0]).toEqual([0, 1]);
  });
});
