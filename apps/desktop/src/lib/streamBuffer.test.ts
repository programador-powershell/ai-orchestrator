import { describe, expect, it } from "vitest";
import { createStreamBuffer } from "./streamBuffer";

/** Agendador manual: controla o "frame" para o teste ser determinístico. */
function manualScheduler() {
  let queued: (() => void) | null = null;
  let handle = 0;
  return {
    schedule: (callback: () => void) => {
      queued = callback;
      return ++handle;
    },
    cancel: () => {
      queued = null;
    },
    frame: () => {
      const run = queued;
      queued = null;
      run?.();
    },
    get pending() {
      return queued !== null;
    }
  };
}

describe("createStreamBuffer", () => {
  it("agrupa vários deltas num único flush por frame", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);

    buffer.push("Olá");
    buffer.push(", ");
    buffer.push("mundo");
    // Antes do frame, nada foi pintado (é isso que evita o congelamento).
    expect(emitted).toEqual([]);

    scheduler.frame();
    expect(emitted).toEqual(["Olá, mundo"]);
  });

  it("agenda um novo frame para deltas que chegam depois do flush", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);

    buffer.push("a");
    scheduler.frame();
    buffer.push("b");
    scheduler.frame();
    expect(emitted).toEqual(["a", "b"]);
  });

  it("flush() despeja o pendente na hora (fim do stream)", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);

    buffer.push("final");
    buffer.flush();
    expect(emitted).toEqual(["final"]);
    // E não repinta no frame seguinte.
    scheduler.frame();
    expect(emitted).toEqual(["final"]);
  });

  it("flush sem nada pendente não emite", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);
    buffer.flush();
    expect(emitted).toEqual([]);
  });

  it("dispose descarta o pendente (abortar não pinta resto)", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);

    buffer.push("descartado");
    buffer.dispose();
    scheduler.frame();
    expect(emitted).toEqual([]);
  });

  it("ignora delta vazio (não agenda frame à toa)", () => {
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer(() => undefined, scheduler);
    buffer.push("");
    expect(scheduler.pending).toBe(false);
  });
});
