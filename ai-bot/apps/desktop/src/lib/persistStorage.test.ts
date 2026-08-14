/**
 * O contrato do armazenamento coalescido.
 *
 * Os quatro comportamentos aqui não são otimização de gosto — cada um cobre um
 * defeito que já apareceu na tela: a rajada de gravação por token, a gravação
 * inútil de valor igual, a preferência perdida no fechamento e, o pior, a
 * exceção de cota subindo de dentro do `setState` e matando o ENVIO da
 * mensagem.
 *
 * O relógio é injetado (`schedule`/`cancel`) em vez de usar timer falso: o que
 * importa provar é que a gravação foi ADIADA e que só uma saiu no fim da
 * janela, e isso fica explícito quando o teste é quem dispara a janela.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createCoalescedStorage, type RawStorage } from "./persistStorage";

interface Recorder extends RawStorage {
  writes: Array<[string, string]>;
  removals: string[];
  data: Map<string, string>;
  /** Faz a próxima gravação estourar a cota. */
  failNextWithQuota: () => void;
}

function recorder(): Recorder {
  const data = new Map<string, string>();
  let quotaOnce = false;
  return {
    data,
    writes: [],
    removals: [],
    failNextWithQuota() {
      quotaOnce = true;
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (quotaOnce) {
        quotaOnce = false;
        // O WebView entrega um Error comum com este `name`; não é DOMException.
        const failure = new Error("cota estourada");
        failure.name = "QuotaExceededError";
        throw failure;
      }
      this.writes.push([key, value]);
      data.set(key, value);
    },
    removeItem(key) {
      this.removals.push(key);
      data.delete(key);
    }
  };
}

/** Relógio de mentira: guarda a ação da janela para o teste disparar na mão. */
function clock() {
  let action: (() => void) | null = null;
  let cancelled = 0;
  return {
    get pending() {
      return action !== null;
    },
    get cancelled() {
      return cancelled;
    },
    schedule(next: () => void) {
      action = next;
      return 1;
    },
    cancel() {
      cancelled += 1;
      action = null;
    },
    /** Fecha a janela de coalescência. */
    tick() {
      const run = action;
      action = null;
      run?.();
    }
  };
}

describe("createCoalescedStorage", () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("junta a rajada de gravações numa só, com o último valor", () => {
    const raw = recorder();
    const time = clock();
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel
    });

    // A rajada que o `persist` produz num turno: um `setItem` por `set`.
    for (let token = 1; token <= 800; token += 1) {
      storage.setItem("aibot.v1", `{"tokens":${token}}`);
    }

    // Nada tocou o disco ainda — é justamente esse o ponto.
    expect(raw.writes).toHaveLength(0);
    // …mas quem lê já vê o valor mais novo.
    expect(storage.getItem("aibot.v1")).toBe('{"tokens":800}');

    time.tick();

    expect(raw.writes).toEqual([["aibot.v1", '{"tokens":800}']]);
  });

  it("não grava valor idêntico ao que já está no disco", () => {
    const raw = recorder();
    const time = clock();
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel
    });

    storage.setItem("aibot.v1", '{"theme":"dark"}');
    time.tick();
    expect(raw.writes).toHaveLength(1);

    // O caso comum: cem `set` seguidos em que NADA do que é persistido mudou.
    for (let i = 0; i < 100; i += 1) storage.setItem("aibot.v1", '{"theme":"dark"}');

    // Nem sequer agendou a janela: não há o que gravar.
    expect(time.pending).toBe(false);
    time.tick();
    expect(raw.writes).toHaveLength(1);

    // Mudança de verdade volta a gravar.
    storage.setItem("aibot.v1", '{"theme":"light"}');
    time.tick();
    expect(raw.writes).toEqual([
      ["aibot.v1", '{"theme":"dark"}'],
      ["aibot.v1", '{"theme":"light"}']
    ]);
  });

  it("descarrega o pendente no fechamento da janela", () => {
    const raw = recorder();
    const time = clock();
    const page = new EventTarget();
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel,
      lifecycle: [{ target: page, event: "pagehide" }]
    });

    storage.setItem("aibot.v1", '{"theme":"dark"}');
    expect(raw.writes).toHaveLength(0);

    // A pessoa fecha o app antes de a janela de coalescência vencer.
    page.dispatchEvent(new Event("pagehide"));

    expect(raw.writes).toEqual([["aibot.v1", '{"theme":"dark"}']]);
    // O timer pendente foi cancelado: descarregar duas vezes gravaria de novo.
    expect(time.cancelled).toBe(1);
    time.tick();
    expect(raw.writes).toHaveLength(1);

    storage.dispose();
    storage.setItem("aibot.v1", '{"theme":"light"}');
    page.dispatchEvent(new Event("pagehide"));
    // Depois do `dispose` o ouvinte saiu: quem descarrega é o `flush`.
    expect(raw.writes).toHaveLength(1);
  });

  it("só descarrega no `visibilitychange` quando a condição bate", () => {
    const raw = recorder();
    const time = clock();
    const page = new EventTarget();
    let hidden = false;
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel,
      lifecycle: [{ target: page, event: "visibilitychange", when: () => hidden }]
    });

    storage.setItem("aibot.v1", '{"theme":"dark"}');
    // A aba VOLTOU: o mesmo evento dispara, e gravar aqui seria escrita à toa.
    page.dispatchEvent(new Event("visibilitychange"));
    expect(raw.writes).toHaveLength(0);

    hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(raw.writes).toEqual([["aibot.v1", '{"theme":"dark"}']]);
  });

  it("engole o estouro de cota em vez de derrubar a ação de quem gravou", () => {
    const raw = recorder();
    const time = clock();
    const quota: string[] = [];
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel,
      onQuotaExceeded: (message) => quota.push(message)
    });

    raw.failNextWithQuota();
    storage.setItem("aibot.v1", '{"theme":"dark"}');

    // A descarga acontece dentro do `set` do zustand: se a exceção subisse
    // daqui, ela mataria o envio da mensagem por causa do tema.
    expect(() => time.tick()).not.toThrow();
    expect(quota).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    // A gravação seguinte não é tratada como repetida: a anterior não entrou.
    storage.setItem("aibot.v1", '{"theme":"dark"}');
    time.tick();
    expect(raw.writes).toEqual([["aibot.v1", '{"theme":"dark"}']]);
  });

  it("propaga erro que não é de cota — esse é defeito de verdade", () => {
    const raw = recorder();
    const time = clock();
    const storage = createCoalescedStorage(
      {
        ...raw,
        setItem() {
          throw new TypeError("storage quebrado");
        }
      },
      { schedule: time.schedule, cancel: time.cancel }
    );

    storage.setItem("aibot.v1", '{"theme":"dark"}');
    expect(() => time.tick()).toThrow(TypeError);
  });

  it("`removeItem` apaga o pendente e o marco do último gravado", () => {
    const raw = recorder();
    const time = clock();
    const storage = createCoalescedStorage(raw, {
      schedule: time.schedule,
      cancel: time.cancel
    });

    storage.setItem("aibot.v1", '{"theme":"dark"}');
    time.tick();
    storage.removeItem("aibot.v1");
    expect(raw.removals).toEqual(["aibot.v1"]);
    expect(storage.getItem("aibot.v1")).toBeNull();

    // Sem esquecer o marco, este valor seria considerado "igual ao gravado" e
    // nunca voltaria ao disco depois do apagamento.
    storage.setItem("aibot.v1", '{"theme":"dark"}');
    time.tick();
    expect(raw.writes).toHaveLength(2);
  });
});
