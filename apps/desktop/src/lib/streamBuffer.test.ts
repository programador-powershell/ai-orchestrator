import { describe, expect, it } from "vitest";
import { createStreamBuffer } from "./streamBuffer";

/** Agendador manual: simula frames sob controle do teste. */
function manualScheduler() {
  const queued: Array<() => void> = [];
  return {
    schedule: (callback: () => void) => {
      queued.push(callback);
      return queued.length;
    },
    cancel: (handle: number) => {
      queued[handle - 1] = () => undefined;
    },
    frame: () => {
      const pending = queued.splice(0, queued.length);
      for (const callback of pending) callback();
    },
    get pendingFrames() {
      return queued.length;
    }
  };
}

describe("createStreamBuffer", () => {
  it("agrupa vários tokens num único flush por frame", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);

    for (const token of ["Olá", ", ", "mundo", "!"]) buffer.push(token);
    // Nada foi emitido ainda: tudo espera o frame.
    expect(emitted).toEqual([]);
    expect(scheduler.pendingFrames).toBe(1);

    scheduler.frame();
    // 4 tokens → 1 única repintura.
    expect(emitted).toEqual(["Olá, mundo!"]);
  });

  it("agenda no máximo um frame por vez", () => {
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer(() => undefined, scheduler);
    for (let i = 0; i < 50; i += 1) buffer.push("x");
    expect(scheduler.pendingFrames).toBe(1);
  });

  it("flush entrega o pendente imediatamente (fim do stream)", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);
    buffer.push("final");
    buffer.flush();
    expect(emitted).toEqual(["final"]);
    // E não emite de novo no frame seguinte.
    scheduler.frame();
    expect(emitted).toEqual(["final"]);
  });

  it("dispose descarta o pendente (abortar não pinta texto órfão)", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);
    buffer.push("descartado");
    buffer.dispose();
    scheduler.frame();
    expect(emitted).toEqual([]);
  });

  it("ignora delta vazio e não emite chunk vazio", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);
    buffer.push("");
    buffer.flush();
    expect(emitted).toEqual([]);
  });

  it("preserva a ordem e o conteúdo total ao longo de vários frames", () => {
    const emitted: string[] = [];
    const scheduler = manualScheduler();
    const buffer = createStreamBuffer((chunk) => emitted.push(chunk), scheduler);
    buffer.push("a");
    buffer.push("b");
    scheduler.frame();
    buffer.push("c");
    scheduler.frame();
    buffer.flush();
    expect(emitted.join("")).toBe("abc");
  });
});
