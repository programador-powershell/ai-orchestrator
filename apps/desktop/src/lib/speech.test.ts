import { describe, expect, it, vi } from "vitest";
import {
  createDictation,
  isDictationSupported,
  isSpeechOutputSupported,
  isSpeechSupported,
  speak,
  speechWindow,
  stopSpeaking,
  type SpeechErrorEvent,
  type SpeechRecognitionLike,
  type SpeechResultEvent,
  type SpeechUtteranceLike,
  type SpeechWindow
} from "./speech";

/* --------------------------- Dublês do navegador --------------------------- */

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  starts = 0;
  stops = 0;
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: SpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  /** Como no motor real: a lista é cumulativa e o interino é sobrescrito. */
  private results: { 0: { transcript: string }; length: number; isFinal: boolean }[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.starts += 1;
  }

  stop() {
    this.stops += 1;
  }

  /** Simula um evento do motor a partir do índice informado. */
  emit(parts: { transcript: string; isFinal: boolean }[], resultIndex = this.results.length) {
    parts.forEach((part, offset) => {
      this.results[resultIndex + offset] = { 0: { transcript: part.transcript }, length: 1, isFinal: part.isFinal };
    });
    this.onresult?.({ resultIndex, results: this.results });
  }
}

class FakeUtterance implements SpeechUtteranceLike {
  lang = "";
  rate = 1;
  voice: { lang: string; name: string } | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechErrorEvent) => void) | null = null;
  constructor(public text: string) {}
}

function fakeWindow(options: { voices?: { lang: string; name: string }[]; failWith?: string } = {}) {
  FakeRecognition.instances = [];
  const spoken: FakeUtterance[] = [];
  let canceled = 0;
  const win = {
    SpeechRecognition: FakeRecognition,
    speechSynthesis: {
      speak(utterance: SpeechUtteranceLike) {
        spoken.push(utterance as FakeUtterance);
        setTimeout(() => {
          if (options.failWith) utterance.onerror?.({ error: options.failWith });
          else utterance.onend?.();
        }, 0);
      },
      cancel() {
        canceled += 1;
      },
      getVoices: () => options.voices ?? []
    },
    SpeechSynthesisUtterance: FakeUtterance
  } as unknown as SpeechWindow;
  return { win, spoken, canceled: () => canceled, recognitions: () => FakeRecognition.instances };
}

/* --------------------------------- Suporte --------------------------------- */

describe("isSpeechSupported", () => {
  it("reconhece o ambiente completo", () => {
    expect(isSpeechSupported(fakeWindow().win)).toBe(true);
  });

  it("aceita o prefixo webkit do Chrome", () => {
    const { win } = fakeWindow();
    const webkit = { ...win, SpeechRecognition: undefined, webkitSpeechRecognition: FakeRecognition } as SpeechWindow;
    expect(isDictationSupported(webkit)).toBe(true);
  });

  it("sem reconhecimento não há ditado", () => {
    const { win } = fakeWindow();
    const sem = { ...win, SpeechRecognition: undefined } as SpeechWindow;
    expect(isDictationSupported(sem)).toBe(false);
    expect(isSpeechSupported(sem)).toBe(false);
    expect(isSpeechOutputSupported(sem)).toBe(true);
  });

  it("sem síntese não há fala", () => {
    const { win } = fakeWindow();
    const sem = { ...win, speechSynthesis: undefined } as SpeechWindow;
    expect(isSpeechOutputSupported(sem)).toBe(false);
    expect(isSpeechSupported(sem)).toBe(false);
  });

  it("window ausente não quebra", () => {
    expect(isSpeechSupported(null)).toBe(false);
    expect(isSpeechSupported(undefined)).toBe(false);
  });
});

describe("speechWindow", () => {
  it("devolve null fora do navegador (render no servidor)", () => {
    expect(speechWindow()).toBe(null);
  });

  it("devolve a janela quando existe", () => {
    const { win } = fakeWindow();
    vi.stubGlobal("window", win);
    expect(speechWindow()).toBe(win);
    vi.unstubAllGlobals();
  });
});

/* --------------------------------- Ditado ---------------------------------- */

describe("createDictation", () => {
  it("configura idioma e resultados intermediários ao iniciar", () => {
    const fake = fakeWindow();
    createDictation(fake.win, { lang: "pt-BR" }).start();
    const recognition = fake.recognitions()[0];
    expect(recognition.lang).toBe("pt-BR");
    expect(recognition.interimResults).toBe(true);
    expect(recognition.starts).toBe(1);
  });

  it("acumula transcrições finais entre eventos", () => {
    const fake = fakeWindow();
    const textos: string[] = [];
    const dictation = createDictation(fake.win, { onText: (text) => textos.push(text) });
    dictation.start();
    const recognition = fake.recognitions()[0];
    recognition.emit([{ transcript: "Bom dia", isFinal: true }]);
    recognition.emit([{ transcript: "tudo certo", isFinal: true }], 1);
    expect(textos).toEqual(["Bom dia", "Bom dia tudo certo"]);
  });

  it("mostra o intermediário sem gravá-lo na transcrição final", () => {
    const fake = fakeWindow();
    const textos: string[] = [];
    const dictation = createDictation(fake.win, { onText: (text) => textos.push(text) });
    dictation.start();
    const recognition = fake.recognitions()[0];
    recognition.emit([{ transcript: "Bom dia", isFinal: true }]);
    recognition.emit([{ transcript: "tudo", isFinal: false }], 1);
    recognition.emit([{ transcript: "tudo certo", isFinal: true }], 1);
    expect(textos).toEqual(["Bom dia", "Bom dia tudo", "Bom dia tudo certo"]);
  });

  it("ignora resultado intermediário vazio", () => {
    const fake = fakeWindow();
    const textos: string[] = [];
    createDictation(fake.win, { onText: (text) => textos.push(text) }).start();
    fake.recognitions()[0].emit([{ transcript: "   ", isFinal: false }]);
    expect(textos).toEqual([]);
  });

  it("marca isFinal só quando não há intermediário pendente", () => {
    const fake = fakeWindow();
    const finais: boolean[] = [];
    createDictation(fake.win, { onText: (_text, isFinal) => finais.push(isFinal) }).start();
    const recognition = fake.recognitions()[0];
    recognition.emit([{ transcript: "oi", isFinal: false }], 0);
    recognition.emit([{ transcript: "oi tudo bem", isFinal: true }], 0);
    expect(finais).toEqual([false, true]);
  });

  it("reporta erro do motor em português", () => {
    const fake = fakeWindow();
    const erros: string[] = [];
    createDictation(fake.win, { onError: (message) => erros.push(message) }).start();
    fake.recognitions()[0].onerror?.({ error: "not-allowed" });
    expect(erros).toHaveLength(1);
    expect(erros[0]).toContain("microfone");
  });

  it("não reporta o aborted que a própria parada provoca", () => {
    const fake = fakeWindow();
    const erros: string[] = [];
    createDictation(fake.win, { onError: (message) => erros.push(message) }).start();
    fake.recognitions()[0].onerror?.({ error: "aborted" });
    expect(erros).toEqual([]);
  });

  it("reporta ausência de suporte no start, sem lançar", () => {
    const erros: string[] = [];
    const dictation = createDictation({} as SpeechWindow, { onError: (message) => erros.push(message) });
    expect(() => dictation.start()).not.toThrow();
    expect(() => dictation.stop()).not.toThrow();
    expect(erros).toHaveLength(1);
  });

  it("start repetido não abre um segundo reconhecimento", () => {
    const fake = fakeWindow();
    const dictation = createDictation(fake.win);
    dictation.start();
    dictation.start();
    expect(fake.recognitions()).toHaveLength(1);
  });

  it("stop encerra o reconhecimento e avisa uma única vez", () => {
    const fake = fakeWindow();
    let fins = 0;
    const dictation = createDictation(fake.win, { onEnd: () => (fins += 1) });
    dictation.start();
    const recognition = fake.recognitions()[0];
    dictation.stop();
    dictation.stop();
    expect(recognition.stops).toBe(1);
    expect(fins).toBe(1);
  });

  it("fim natural do motor avisa e libera um novo start", () => {
    const fake = fakeWindow();
    let fins = 0;
    const dictation = createDictation(fake.win, { onEnd: () => (fins += 1) });
    dictation.start();
    fake.recognitions()[0].onend?.();
    dictation.start();
    expect(fins).toBe(1);
    expect(fake.recognitions()).toHaveLength(2);
  });

  it("start que estoura no motor vira erro reportado", () => {
    const fake = fakeWindow();
    const erros: string[] = [];
    const dictation = createDictation(fake.win, { onError: (message) => erros.push(message) });
    FakeRecognition.prototype.start = function quebrado() {
      throw new Error("InvalidStateError");
    };
    expect(() => dictation.start()).not.toThrow();
    FakeRecognition.prototype.start = function ok(this: FakeRecognition) {
      this.starts += 1;
    };
    expect(erros).toEqual(["InvalidStateError"]);
    dictation.start();
    expect(fake.recognitions()).toHaveLength(2);
  });
});

/* ---------------------------------- Fala ----------------------------------- */

describe("speak", () => {
  it("resolve quando a locução termina", async () => {
    const fake = fakeWindow();
    await expect(speak(fake.win, "Olá", { lang: "pt-BR", rate: 1.2 })).resolves.toBeUndefined();
    expect(fake.spoken).toHaveLength(1);
    expect(fake.spoken[0].text).toBe("Olá");
    expect(fake.spoken[0].lang).toBe("pt-BR");
    expect(fake.spoken[0].rate).toBe(1.2);
  });

  it("escolhe a voz do idioma pedido", async () => {
    const fake = fakeWindow({ voices: [{ lang: "en-US", name: "Alex" }, { lang: "pt-BR", name: "Maria" }] });
    await speak(fake.win, "Olá", { lang: "pt-BR" });
    expect(fake.spoken[0].voice?.name).toBe("Maria");
  });

  it("texto vazio nem chega a falar", async () => {
    const fake = fakeWindow();
    await speak(fake.win, "   ");
    expect(fake.spoken).toHaveLength(0);
  });

  it("ambiente sem síntese resolve em silêncio", async () => {
    await expect(speak({} as SpeechWindow, "Olá")).resolves.toBeUndefined();
    await expect(speak(null, "Olá")).resolves.toBeUndefined();
  });

  it("erro real da síntese rejeita", async () => {
    const fake = fakeWindow({ failWith: "synthesis-failed" });
    await expect(speak(fake.win, "Olá")).rejects.toThrow(/synthesis-failed/);
  });

  it("interrupção proposital não é erro", async () => {
    const fake = fakeWindow({ failWith: "interrupted" });
    await expect(speak(fake.win, "Olá")).resolves.toBeUndefined();
  });

  it("stopSpeaking cancela a fila da síntese", () => {
    const fake = fakeWindow();
    stopSpeaking(fake.win);
    stopSpeaking(null);
    expect(fake.canceled()).toBe(1);
  });
});
