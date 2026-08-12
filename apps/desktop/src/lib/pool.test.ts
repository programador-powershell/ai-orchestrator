import { describe, expect, it } from "vitest";
import { effectiveConcurrency, runWithLimit } from "./pool";

/** Tarefa que registra quando entra/sai, para medir a concorrência REAL. */
function tracked(log: number[], live: { now: number; peak: number }, value: number, delay = 0) {
  return async () => {
    live.now += 1;
    live.peak = Math.max(live.peak, live.now);
    await new Promise((resolve) => setTimeout(resolve, delay));
    live.now -= 1;
    log.push(value);
    return value;
  };
}

describe("runWithLimit", () => {
  it("preserva a ordem dos resultados mesmo terminando fora de ordem", async () => {
    const results = await runWithLimit(
      [
        async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "lento";
        },
        async () => "rápido"
      ],
      2
    );
    expect(results).toEqual([
      { ok: true, value: "lento" },
      { ok: true, value: "rápido" }
    ]);
  });

  it("respeita o teto — nunca mais que `limit` em voo", async () => {
    const log: number[] = [];
    const live = { now: 0, peak: 0 };
    const tasks = Array.from({ length: 8 }, (_, i) => tracked(log, live, i, 5));
    await runWithLimit(tasks, 3);
    expect(live.peak).toBe(3);
    expect(log).toHaveLength(8);
  });

  it("roda DE FATO em paralelo (mais rápido que série)", async () => {
    const tasks = Array.from({ length: 4 }, () => async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const started = Date.now();
    await runWithLimit(tasks, 4);
    // em série seriam ~120ms; com 4 em paralelo, perto de 30ms
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("uma tarefa que rejeita não derruba as outras", async () => {
    const results = await runWithLimit(
      [async () => "a", async () => { throw new Error("estourou"); }, async () => "c"],
      2
    );
    expect(results[0]).toEqual({ ok: true, value: "a" });
    expect(results[1].ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: "c" });
  });

  it("teto inválido não trava — vira 1", async () => {
    for (const limit of [0, -5, Number.NaN]) {
      const results = await runWithLimit([async () => 1, async () => 2], limit);
      expect(results.map((r) => (r.ok ? r.value : null))).toEqual([1, 2]);
    }
  });

  it("lista vazia devolve vazio sem pendurar", async () => {
    expect(await runWithLimit([], 4)).toEqual([]);
  });

  it("teto maior que a lista não cria worker à toa", () => {
    expect(effectiveConcurrency(2, 10)).toBe(2);
    expect(effectiveConcurrency(10, 3)).toBe(3);
    expect(effectiveConcurrency(0, 4)).toBe(0);
  });
});
